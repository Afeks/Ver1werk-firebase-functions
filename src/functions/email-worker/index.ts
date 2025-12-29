import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import nodemailer, { Transporter } from 'nodemailer';
import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';

const EMAIL_QUEUE_COLLECTION = 'emailQueue';
const ASSOCIATIONS_COLLECTION = 'associations';
const MAX_ATTEMPTS = 5;

type EmailStatus = 'pending' | 'processing' | 'sent' | 'error' | 'failed';

interface TicketContext {
  orderId?: string;
  ticketId?: string;
  ticketName?: string;
  customerName?: string;
  seatList?: Array<{ id?: string; label?: string; number?: string }> | string;
  eventDate?: string | Date;
  quantity?: number;
  associationName?: string;
  ticketTemplatePdfUrl?: string;
  ticketTemplateQrArea?: QrArea | null;
  ticketTemplateInfoArea?: QrArea | null;
}

interface EmailQueueDocument {
  associationId?: string;
  type?: 'ticket' | 'test' | string;
  to?: string;
  subject?: string;
  body?: string;
  replyTo?: string;
  status?: EmailStatus;
  attempts?: number;
  context?: TicketContext;
  createdAt?: FirebaseFirestore.Timestamp;
  lockedAt?: FirebaseFirestore.Timestamp;
  sentAt?: FirebaseFirestore.Timestamp;
  lastError?: string;
}

interface AssociationEmailSettings {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  useTLS: boolean;
  senderName: string;
  senderEmail: string;
  replyTo?: string | null;
}

interface AssociationDocument {
  name?: string;
  emailSettings?: Partial<AssociationEmailSettings>;
}

interface TicketDesignSettings {
  templatePdfUrl?: string | null;
  templateImageUrl?: string | null;
  qrArea?: QrArea | null;
  infoArea?: QrArea | null;
}

interface QrArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_QR_AREA: QrArea = {
  x: 0.65,
  y: 0.1,
  width: 0.25,
  height: 0.25,
};

interface SendEmailParams {
  transporter: Transporter;
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string | null;
  attachments?: Array<{ filename: string; content: Buffer }>;
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const getAssociationIdFromDocRef = (
  docRef: FirebaseFirestore.DocumentReference
): string | undefined => docRef.parent?.parent?.id;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// Normalisiert allgemeine Bereichs-Koordinaten (0-1 zu Pixel)
const normalizeTemplateArea = (
  area: QrArea | null | undefined,
  pageWidth: number,
  pageHeight: number,
  fallback?: QrArea
): QrArea | null => {
  const source = area ?? fallback;
  if (!source) {
    return null;
  }
  const x = clamp(source.x ?? 0, 0, 1);
  const y = clamp(source.y ?? 0, 0, 1);
  const width = clamp(source.width ?? 0.25, 0.02, 1);
  const height = clamp(source.height ?? 0.25, 0.02, 1);
  return {
    x: x * pageWidth,
    y: y * pageHeight,
    width: width * pageWidth,
    height: height * pageHeight,
  };
};

// Normalisiert QR-Bereich-Koordinaten (0-1 zu Pixel)
const normalizeQrArea = (
  qrArea: QrArea | null | undefined,
  pageWidth: number,
  pageHeight: number
): QrArea => {
  const normalized = normalizeTemplateArea(
    qrArea,
    pageWidth,
    pageHeight,
    DEFAULT_QR_AREA
  );
  return (
    normalized || {
      x: DEFAULT_QR_AREA.x * pageWidth,
      y: DEFAULT_QR_AREA.y * pageHeight,
      width: DEFAULT_QR_AREA.width * pageWidth,
      height: DEFAULT_QR_AREA.height * pageHeight,
    }
  );
};

const toValidDate = (
  value: string | Date | FirebaseFirestore.Timestamp | undefined
): Date | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as FirebaseFirestore.Timestamp).toDate === 'function'
  ) {
    const date = (value as FirebaseFirestore.Timestamp).toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
};

// Formatiert Event-Datum für PDF-Text
const formatEventDateText = (
  eventDate: string | Date | FirebaseFirestore.Timestamp | undefined
): string => {
  const date = toValidDate(eventDate);
  if (!date) {
    return typeof eventDate === 'string' ? eventDate : '';
  }

  return date.toLocaleString('de-DE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// Sanitized Dateinamen-Segment
const sanitizeFileSegment = (str: string | undefined): string => {
  return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
};

const wrapLine = (
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
): string[] => {
  if (!text) {
    return [];
  }
  if (maxWidth <= 0) {
    return [text];
  }

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  });

  if (current) {
    lines.push(current);
  }

  return lines;
};

const drawTicketInfoText = ({
  page,
  area,
  lines,
  font,
  fontSize = 12,
  lineSpacing = 4,
  padding = 8,
}: {
  page: PDFPage;
  area: QrArea;
  lines: string[];
  font: PDFFont;
  fontSize?: number;
  lineSpacing?: number;
  padding?: number;
}) => {
  if (!lines.length || !area) {
    functions.logger.warn('drawTicketInfoText: Keine Lines oder Area', {
      linesCount: lines.length,
      hasArea: !!area,
    });
    return;
  }

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const usableWidth = Math.max(area.width - padding * 2, 0);
  const startX = area.x + padding;
  const topY = pageHeight - area.y - padding;
  const bottomLimit = pageHeight - (area.y + area.height) + padding;
  const availableHeight = topY - bottomLimit;

  // Passe Schriftgröße iterativ an, bis alles passt
  let adjustedFontSize = fontSize;
  let adjustedLineSpacing = lineSpacing;
  let totalTextSegments = 0;
  let neededHeight = 0;
  
  // Maximal 10 Iterationen, um Endlosschleifen zu vermeiden
  for (let iteration = 0; iteration < 10; iteration++) {
    totalTextSegments = 0;
    for (const line of lines) {
      const wrappedLines = wrapLine(line, font, adjustedFontSize, usableWidth);
      totalTextSegments += wrappedLines.length;
    }
    
    if (totalTextSegments === 0) break;
    
    neededHeight = totalTextSegments * adjustedFontSize + (totalTextSegments - 1) * adjustedLineSpacing;
    
    if (neededHeight <= availableHeight * 0.95) {
      // Genug Platz vorhanden
      break;
    }
    
    // Reduziere Schriftgröße und Zeilenabstand proportional
    const scaleFactor = Math.max(0.75, (availableHeight * 0.95) / neededHeight);
    const newFontSize = Math.max(8, Math.floor(adjustedFontSize * scaleFactor));
    const newLineSpacing = Math.max(2, Math.floor(adjustedLineSpacing * scaleFactor));
    
    // Wenn sich nichts mehr ändert, stoppe
    if (newFontSize === adjustedFontSize && newLineSpacing === adjustedLineSpacing) {
      break;
    }
    
    adjustedFontSize = newFontSize;
    adjustedLineSpacing = newLineSpacing;
  }

  if (neededHeight > availableHeight) {
    functions.logger.warn('drawTicketInfoText: Text könnte nicht vollständig dargestellt werden', {
      neededHeight,
      availableHeight,
      adjustedFontSize,
      adjustedLineSpacing,
      totalTextSegments,
    });
  } else if (adjustedFontSize !== fontSize) {
    functions.logger.info('drawTicketInfoText: Schriftgröße angepasst', {
      originalFontSize: fontSize,
      adjustedFontSize,
      originalLineSpacing: lineSpacing,
      adjustedLineSpacing,
      neededHeight,
      availableHeight,
      totalTextSegments,
    });
  }

  let cursorY = topY - adjustedFontSize;

  functions.logger.info('drawTicketInfoText: Starte Zeichnen', {
    pageWidth,
    pageHeight,
    area,
    linesCount: lines.length,
    lines,
    fontSize: adjustedFontSize,
    padding,
    usableWidth,
    startX,
    topY,
    bottomLimit,
    availableHeight,
    initialCursorY: cursorY,
    totalTextSegments,
  });

  for (const line of lines) {
    const wrappedLines = wrapLine(line, font, adjustedFontSize, usableWidth);
    for (const segment of wrappedLines) {
      if (cursorY < bottomLimit) {
        functions.logger.warn('drawTicketInfoText: Text würde unter Bottom-Limit sein', {
          cursorY,
          bottomLimit,
          segment,
        });
        return;
      }
      functions.logger.info('drawTicketInfoText: Zeichne Text-Segment', {
        segment,
        x: startX,
        y: cursorY,
        size: adjustedFontSize,
        withinBounds: startX >= 0 && startX <= pageWidth && cursorY >= bottomLimit && cursorY <= topY,
      });
      page.drawText(segment, {
        x: startX,
        y: cursorY,
        size: adjustedFontSize,
        font,
        color: rgb(0, 0, 0),
      });
      cursorY -= adjustedFontSize + adjustedLineSpacing;
    }
  }
  
  functions.logger.info('drawTicketInfoText: Fertig', {
    finalCursorY: cursorY,
    segmentsDrawn: lines.length,
  });
};

// Lädt Ticket-Design-Einstellungen aus dem Ticketing-Modul
const loadTicketDesignSettings = async (
  associationId: string
): Promise<TicketDesignSettings> => {
  try {
    const moduleDoc = await db
      .collection(ASSOCIATIONS_COLLECTION)
      .doc(associationId)
      .collection('modules')
      .doc('tickets')
      .get();

    if (!moduleDoc.exists) {
      return { templatePdfUrl: null, templateImageUrl: null, qrArea: null };
    }

    const data = moduleDoc.data();
    return {
      templatePdfUrl: data?.ticketEmailTemplatePdfUrl || null,
      templateImageUrl: data?.ticketEmailTemplateImageUrl || null,
      qrArea: data?.ticketEmailQrArea || null,
      infoArea: data?.ticketEmailInfoArea || null,
    };
  } catch (err) {
    functions.logger.warn(
      'Fehler beim Laden der Ticket-Design-Einstellungen:',
      err
    );
    return { templatePdfUrl: null, templateImageUrl: null, qrArea: null };
  }
};

interface TemplateAsset {
  buffer: Buffer;
  type: 'pdf' | 'png' | 'jpg';
}

// Lädt Template-Datei von URL (PDF oder Bild)
const downloadTemplateAsset = async (
  url: string
): Promise<TemplateAsset | null> => {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    const normalizedUrl = url.toLowerCase();

    let type: TemplateAsset['type'] = 'jpg';
    if (contentType.includes('pdf') || normalizedUrl.endsWith('.pdf')) {
      type = 'pdf';
    } else if (contentType.includes('png') || normalizedUrl.endsWith('.png')) {
      type = 'png';
    } else if (contentType.includes('jpg') || contentType.includes('jpeg') || normalizedUrl.endsWith('.jpg') || normalizedUrl.endsWith('.jpeg')) {
      type = 'jpg';
    }

    return { buffer, type };
  } catch (err) {
    functions.logger.warn('Fehler beim Laden der Ticket-Vorlage:', err);
    return null;
  }
};

// Generiert QR-Code als PNG-Buffer
const generateQRCodeBuffer = async (
  data: string,
  size = 200
): Promise<Buffer> => {
  try {
    const qrBuffer = await QRCode.toBuffer(data, {
      width: size,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });
    return Buffer.from(qrBuffer);
  } catch (err) {
    functions.logger.error('Fehler beim Generieren des QR-Codes:', err);
    throw err;
  }
};

// Generiert ein Ticket-PDF
const generateTicketPdf = async ({
  templateAsset,
  qrArea,
  infoArea,
  associationName,
  ticketName,
  eventDate,
  seatLabel,
  orderId,
}: {
  templateAsset: TemplateAsset | null;
  qrArea: QrArea | null;
  infoArea: QrArea | null;
  associationName: string;
  ticketName: string;
  eventDate?: string | Date | FirebaseFirestore.Timestamp;
  seatLabel: string | null;
  orderId?: string;
}): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  let pageWidth = 595;
  let pageHeight = 842;
  let page;

  if (templateAsset?.type === 'pdf') {
    try {
      const templateDoc = await PDFDocument.load(templateAsset.buffer);
      const [copiedPage] = await doc.copyPages(templateDoc, [0]);
      page = copiedPage;
      doc.addPage(page);
      pageWidth = page.getWidth();
      pageHeight = page.getHeight();
    } catch (err) {
      functions.logger.warn('Fehler beim Einbetten der PDF-Vorlage:', err);
      page = doc.addPage([pageWidth, pageHeight]);
    }
  } else if (
    templateAsset?.type === 'png' ||
    templateAsset?.type === 'jpg'
  ) {
    try {
      const image =
        templateAsset.type === 'png'
          ? await doc.embedPng(templateAsset.buffer)
          : await doc.embedJpg(templateAsset.buffer);
      pageWidth = image.width;
      pageHeight = image.height;
      page = doc.addPage([pageWidth, pageHeight]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
      });
    } catch (err) {
      functions.logger.warn('Fehler beim Einbetten der Bild-Vorlage:', err);
      page = doc.addPage([pageWidth, pageHeight]);
    }
  } else {
    page = doc.addPage([pageWidth, pageHeight]);
  }

  // QR-Code generieren und einfügen
  const normalizedEventDate = toValidDate(eventDate);

  const qrData = JSON.stringify({
    orderId,
    ticketName,
    seatLabel,
    eventDate: normalizedEventDate
      ? normalizedEventDate.toISOString()
      : typeof eventDate === 'string'
        ? eventDate
        : null,
  });
  const qrBuffer = await generateQRCodeBuffer(qrData, 200);
  const qrImage = await doc.embedPng(qrBuffer);

  // QR-Bereich normalisieren
  const normalizedQrArea = normalizeQrArea(
    qrArea || DEFAULT_QR_AREA,
    pageWidth,
    pageHeight
  );

  // QR-Code im definierten Bereich platzieren
  const qrSize = Math.min(normalizedQrArea.width, normalizedQrArea.height);
  page.drawImage(qrImage, {
    x: normalizedQrArea.x,
    y: pageHeight - normalizedQrArea.y - qrSize,
    width: qrSize,
    height: qrSize,
  });

  // Text-Informationen hinzufügen
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const textColor = rgb(0, 0, 0);
  const normalizedInfoArea = normalizeTemplateArea(
    infoArea,
    pageWidth,
    pageHeight
  );
  
  // Baue Info-Zeilen auf, wobei nur nicht-leere Werte hinzugefügt werden
  const infoLines: string[] = [];
  functions.logger.info('generateTicketPdf: Starte Info-Lines Aufbau', {
    ticketName,
    eventDate,
    eventDateType: typeof eventDate,
    eventDateValue: eventDate ? String(eventDate) : 'null/undefined',
    eventDateConstructor: eventDate ? eventDate.constructor?.name : 'null/undefined',
    seatLabel,
    seatLabelType: typeof seatLabel,
  });
  
  if (ticketName && ticketName.trim()) {
    infoLines.push(ticketName.trim());
    functions.logger.info('generateTicketPdf: Ticket-Name hinzugefügt', { ticketName: ticketName.trim() });
  }
  
  // Event-Datum formatieren
  const dateText = formatEventDateText(eventDate);
  functions.logger.info('generateTicketPdf: Date formatting', {
    eventDate,
    eventDateType: typeof eventDate,
    eventDateValue: eventDate ? String(eventDate) : 'null/undefined',
    eventDateConstructor: eventDate ? eventDate.constructor?.name : 'null/undefined',
    dateText,
    hasDateText: !!dateText && dateText.trim().length > 0,
  });
  if (dateText && dateText.trim()) {
    infoLines.push(dateText.trim());
    functions.logger.info('generateTicketPdf: Datum-Text hinzugefügt', { dateText: dateText.trim() });
  } else {
    functions.logger.warn('generateTicketPdf: Datum-Text wurde NICHT hinzugefügt', {
      dateText,
      dateTextLength: dateText?.length || 0,
      eventDate,
      eventDateType: typeof eventDate,
    });
  }
  
  // Sitzplatz-Label hinzufügen (nur wenn vorhanden)
  functions.logger.info('generateTicketPdf: Seat label', {
    seatLabel,
    seatLabelType: typeof seatLabel,
    isNull: seatLabel === null,
    isUndefined: seatLabel === undefined,
    hasSeatLabel: !!seatLabel && typeof seatLabel === 'string' && seatLabel.trim().length > 0,
  });
  if (seatLabel && typeof seatLabel === 'string' && seatLabel.trim()) {
    infoLines.push(seatLabel.trim());
    functions.logger.info('generateTicketPdf: Sitzplatz-Label hinzugefügt', { seatLabel: seatLabel.trim() });
  } else {
    functions.logger.warn('generateTicketPdf: Sitzplatz-Label wurde NICHT hinzugefügt', {
      seatLabel,
      seatLabelType: typeof seatLabel,
    });
  }
  
  functions.logger.info('generateTicketPdf: Final info lines', {
    infoLinesCount: infoLines.length,
    infoLines,
    hasNormalizedInfoArea: !!normalizedInfoArea,
    normalizedInfoArea,
  });
  
  const hasInfoArea = !!normalizedInfoArea && infoLines.length > 0;

  if (hasInfoArea && normalizedInfoArea) {
    functions.logger.info('generateTicketPdf: Zeichne Info-Lines in InfoArea', {
      area: normalizedInfoArea,
      linesCount: infoLines.length,
    });
    drawTicketInfoText({
      page,
      area: normalizedInfoArea,
      lines: infoLines,
      font,
      fontSize,
    });
  } else if (infoLines.length > 0) {
    functions.logger.info('generateTicketPdf: Keine InfoArea definiert, verwende Fallback-Position', {
      infoLinesCount: infoLines.length,
      hasTemplate: !!templateAsset,
    });
    let yPos = pageHeight - 50;

    if (associationName) {
      page.drawText(associationName, {
        x: 50,
        y: yPos,
        size: fontSize + 4,
        font,
        color: textColor,
      });
      yPos -= 30;
    }

    if (ticketName) {
      page.drawText(`Ticket: ${ticketName}`, {
        x: 50,
        y: yPos,
        size: fontSize,
        font,
        color: textColor,
      });
      yPos -= 20;
    }

    if (eventDate) {
      const dateText = formatEventDateText(eventDate);
      if (dateText) {
        page.drawText(`Datum: ${dateText}`, {
          x: 50,
          y: yPos,
          size: fontSize,
          font,
          color: textColor,
        });
        yPos -= 20;
      }
    }

    if (seatLabel && typeof seatLabel === 'string') {
      page.drawText(`Platz: ${seatLabel}`, {
        x: 50,
        y: yPos,
        size: fontSize,
        font,
        color: textColor,
      });
      yPos -= 20;
    }

    if (orderId) {
      page.drawText(`Bestellnummer: ${orderId}`, {
        x: 50,
        y: yPos,
        size: fontSize - 2,
        font,
        color: textColor,
      });
    }
  }

  if (orderId && hasInfoArea) {
    page.drawText(`Bestellnummer: ${orderId}`, {
      x: 50,
      y: 36,
      size: fontSize - 2,
      font,
      color: textColor,
    });
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
};

// Erstellt PDF-Attachments für alle Tickets einer Bestellung
const buildTicketAttachments = async (
  associationId: string,
  emailData: EmailQueueDocument
): Promise<Array<{ filename: string; content: Buffer }>> => {
  functions.logger.info('buildTicketAttachments aufgerufen', {
    type: emailData.type,
    hasContext: !!emailData.context,
    contextKeys: emailData.context ? Object.keys(emailData.context) : [],
  });

  if (emailData.type !== 'ticket' || !emailData.context) {
    functions.logger.warn('buildTicketAttachments: Bedingung nicht erfüllt', {
      type: emailData.type,
      hasContext: !!emailData.context,
    });
    return [];
  }

  const {
    orderId,
    ticketName,
    seatList,
    eventDate,
    quantity,
    associationName,
    ticketTemplatePdfUrl,
    ticketTemplateQrArea,
    ticketTemplateInfoArea,
  } = emailData.context;

  functions.logger.info('buildTicketAttachments: Context-Daten', {
    orderId,
    ticketName,
    seatListType: Array.isArray(seatList) ? 'array' : typeof seatList,
    seatListLength: Array.isArray(seatList) ? seatList.length : 0,
    eventDate,
    eventDateType: typeof eventDate,
    eventDateValue: eventDate ? String(eventDate) : 'null/undefined',
    eventDateConstructor: eventDate ? eventDate.constructor?.name : 'null/undefined',
    eventDateToString: eventDate ? eventDate.toString() : 'null/undefined',
    quantity,
    associationName,
    hasTicketTemplatePdfUrl: !!ticketTemplatePdfUrl,
    hasTicketTemplateQrArea: !!ticketTemplateQrArea,
    hasTicketTemplateInfoArea: !!ticketTemplateInfoArea,
  });

  if (!orderId || !ticketName) {
    functions.logger.warn('buildTicketAttachments: orderId oder ticketName fehlt', {
      orderId,
      ticketName,
    });
    return [];
  }

  let qrArea = ticketTemplateQrArea || null;
  let infoArea = ticketTemplateInfoArea || null;
  let templateUrl = ticketTemplatePdfUrl || null;
  let designSettings: TicketDesignSettings | null = null;

  if (!templateUrl || !qrArea || !infoArea) {
    designSettings = await loadTicketDesignSettings(associationId);
    if (!templateUrl) {
      templateUrl =
        designSettings.templatePdfUrl ||
        designSettings.templateImageUrl ||
        null;
    }
    if (!qrArea) {
      qrArea = designSettings.qrArea || null;
    }
    if (!infoArea) {
      infoArea = designSettings.infoArea || null;
    }
  }

  const templateAsset = templateUrl
    ? await downloadTemplateAsset(templateUrl)
    : null;

  const attachments: Array<{ filename: string; content: Buffer }> = [];
  const seatArray = Array.isArray(seatList) ? seatList : [];

  // Wenn mehrere Tickets, erstelle für jedes ein PDF
  const ticketCount = quantity || seatArray.length || 1;

  functions.logger.info('buildTicketAttachments: Starte PDF-Generierung', {
    ticketCount,
    quantity,
    seatArrayLength: seatArray.length,
    templateType: templateAsset?.type || 'none',
    hasQrArea: !!qrArea,
    hasInfoArea: !!infoArea,
    eventDate,
    eventDateType: typeof eventDate,
    eventDateValue: eventDate ? String(eventDate) : 'null/undefined',
  });

  for (let i = 0; i < ticketCount; i++) {
    const seat = seatArray[i];
    // Nur Sitzplatz-Label hinzufügen, wenn tatsächlich ein Sitzplatz vorhanden ist
    // Wenn kein Sitzplan vorhanden ist (seat ist undefined), sollte kein Label angezeigt werden
    const seatLabel = seat?.label || seat?.number || seat?.id || null;

    functions.logger.info(`Generiere PDF für Ticket ${i + 1}`, {
      seatLabel,
      seatLabelType: typeof seatLabel,
      seat,
      hasSeat: !!seat,
      seatKeys: seat ? Object.keys(seat) : [],
      eventDate,
      eventDateType: typeof eventDate,
      eventDateValue: eventDate ? String(eventDate) : 'null/undefined',
      eventDateConstructor: eventDate ? eventDate.constructor?.name : 'null/undefined',
      hasInfoArea: !!infoArea,
      infoArea,
    });

    try {
      const pdfBuffer = await generateTicketPdf({
        templateAsset,
        qrArea,
        infoArea,
        associationName: associationName || 'Verein',
        ticketName,
        eventDate,
        seatLabel,
        orderId,
      });

      const fileName = `Ticket_${sanitizeFileSegment(ticketName)}_${sanitizeFileSegment(seatLabel ?? undefined)}.pdf`;
      attachments.push({
        filename: fileName,
        content: pdfBuffer,
      });

      functions.logger.info(`PDF erfolgreich generiert für Ticket ${i + 1}`, {
        fileName,
        pdfSize: pdfBuffer.length,
      });
    } catch (err) {
      functions.logger.error(
        `Fehler beim Generieren des PDFs für Ticket ${i + 1}:`,
        {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          seatLabel,
        }
      );
      // Weiter mit nächstem Ticket, auch wenn eines fehlschlägt
    }
  }

  functions.logger.info('buildTicketAttachments: Fertig', {
    attachmentsGenerated: attachments.length,
    expectedCount: ticketCount,
  });

  return attachments;
};

const loadAssociationEmailSettings = async (
  associationId?: string
): Promise<AssociationEmailSettings> => {
  if (!associationId) {
    throw new Error('Association ID fehlt.');
  }

  const snap = await db
    .collection(ASSOCIATIONS_COLLECTION)
    .doc(associationId)
    .get();

  if (!snap.exists) {
    throw new Error(`Association ${associationId} nicht gefunden.`);
  }

  const data = snap.data() as AssociationDocument | undefined;
  const settings = data?.emailSettings ?? {};

  const required: Array<keyof AssociationEmailSettings> = [
    'smtpHost',
    'smtpPort',
    'smtpUser',
    'smtpPassword',
    'senderEmail',
  ];

  for (const key of required) {
    if (!settings[key]) {
      throw new Error(
        `SMTP-Einstellung "${key}" fehlt für Association ${associationId}.`
      );
    }
  }

  return {
    smtpHost: String(settings.smtpHost),
    smtpPort: Number(settings.smtpPort) || 587,
    smtpUser: String(settings.smtpUser),
    smtpPassword: String(settings.smtpPassword),
    useTLS: settings.useTLS ?? true,
    senderName: settings.senderName || data?.name || 'Ticketing',
    senderEmail: String(settings.senderEmail),
    replyTo: settings.replyTo ?? null,
  };
};

const buildTransporter = (config: AssociationEmailSettings): Transporter => {
  const isSecure = config.smtpPort === 465 && config.useTLS !== false;
  const transportOptions: nodemailer.TransportOptions & {
    requireTLS?: boolean;
  } = {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: isSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword,
    },
  } as nodemailer.TransportOptions;

  if (config.useTLS && !isSecure) {
    transportOptions.requireTLS = true;
  }

  return nodemailer.createTransport(transportOptions);
};

const sendEmail = async ({
  transporter,
  fromName,
  fromEmail,
  to,
  subject,
  body,
  replyTo,
  attachments,
}: SendEmailParams): Promise<void> => {
  const trimmedBody = body.trim();
  const mailOptions: nodemailer.SendMailOptions = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to,
    subject,
    text: trimmedBody,
  };

  const containsHtml = /<\/?[a-z][\s\S]*>/i.test(trimmedBody);
  if (containsHtml) {
    mailOptions.html = trimmedBody;
  }

  if (replyTo) {
    mailOptions.replyTo = replyTo;
  }

  functions.logger.info('sendEmail: Attachments-Status', {
    attachmentsCount: attachments?.length ?? 0,
    attachmentFilenames: attachments?.map((a) => a.filename) ?? [],
    attachmentSizes: attachments?.map((a) => a.content.length) ?? [],
  });

  if (attachments && attachments.length > 0) {
    mailOptions.attachments = attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
    }));
    functions.logger.info('Attachments zu mailOptions hinzugefügt', {
      count: mailOptions.attachments.length,
    });
  } else {
    functions.logger.warn('Keine Attachments vorhanden');
  }

  await transporter.sendMail(mailOptions);

  functions.logger.info('E-Mail erfolgreich versendet via sendEmail', {
    to,
    subject,
    attachmentsCount: attachments?.length ?? 0,
  });
};

const markAsFailed = async (
  docRef: FirebaseFirestore.DocumentReference,
  error: unknown,
  attempts: number
): Promise<void> => {
  const status: EmailStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'error';
  const errorMessage =
    error instanceof Error ? error.message : String(error ?? 'Unbekannter Fehler');

  await docRef.update({
    status,
    lastError: errorMessage,
    lockedAt: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
};

const handleEmailDocument = async (
  docRef: FirebaseFirestore.DocumentReference,
  providedAssociationId?: string
): Promise<void> => {
  let emailData: EmailQueueDocument | undefined;
  let currentAttempts = 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error('Dokument existiert nicht mehr.');
    }

    const data = snap.data() as EmailQueueDocument;
    const status: EmailStatus = data.status ?? 'pending';

    if (status === 'sent') {
      throw new Error('Bereits versendet.');
    }

    if (status === 'processing') {
      throw new Error('Wird bereits verarbeitet.');
    }

    emailData = data;
    currentAttempts = (data.attempts ?? 0) + 1;

    tx.update(docRef, {
      status: 'processing',
      attempts: FieldValue.increment(1),
      lockedAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  if (!emailData) {
    return;
  }

  try {
    const associationId =
      providedAssociationId ??
      emailData.associationId ??
      getAssociationIdFromDocRef(docRef);

    if (!associationId) {
      throw new Error('Association ID konnte nicht ermittelt werden.');
    }

    const associationConfig = await loadAssociationEmailSettings(associationId);
    const transporter = buildTransporter(associationConfig);

    const to = emailData.to?.trim();
    const subject = emailData.subject?.trim();
    const body = emailData.body ?? '';

    if (!to || !subject || !body.trim()) {
      throw new Error('E-Mail-Daten unvollständig (to/subject/body).');
    }

    // Generiere Attachments für Ticket-E-Mails
    let attachments: Array<{ filename: string; content: Buffer }> = [];

    functions.logger.info('Prüfe Attachments-Generierung', {
      docId: docRef.id,
      type: emailData.type,
      hasContext: !!emailData.context,
      associationId,
    });

    if (emailData.type === 'ticket' && associationId) {
      try {
        functions.logger.info('Starte Attachment-Generierung', {
          docId: docRef.id,
          context: emailData.context,
        });

        attachments = await buildTicketAttachments(associationId, emailData);

        functions.logger.info(
          `Generierte ${attachments.length} PDF-Attachments für Ticket-E-Mail`,
          {
            docId: docRef.id,
            attachmentFilenames: attachments.map((a) => a.filename),
          }
        );
      } catch (attachErr) {
        functions.logger.error(
          'Fehler beim Generieren der PDF-Attachments:',
          {
            docId: docRef.id,
            error: attachErr instanceof Error ? attachErr.message : String(attachErr),
            stack: attachErr instanceof Error ? attachErr.stack : undefined,
          }
        );
        // Weiter mit E-Mail-Versand, auch wenn Attachments fehlschlagen
      }
    } else {
      functions.logger.info('Keine Attachments generiert', {
        docId: docRef.id,
        reason: emailData.type !== 'ticket' ? 'type ist nicht "ticket"' : 'associationId fehlt',
        type: emailData.type,
        associationId,
      });
    }

    await sendEmail({
      transporter,
      fromName: associationConfig.senderName,
      fromEmail: associationConfig.senderEmail,
      to,
      subject,
      body,
      replyTo: emailData.replyTo ?? associationConfig.replyTo,
      attachments,
    });

    await docRef.update({
      status: 'sent',
      sentAt: FieldValue.serverTimestamp(),
      lockedAt: FieldValue.delete(),
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    functions.logger.info('E-Mail erfolgreich versendet', {
      docId: docRef.id,
      to,
      attachmentsCount: attachments.length,
    });
  } catch (error) {
    functions.logger.error('Fehler beim E-Mail-Versand', {
      docId: docRef.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await markAsFailed(docRef, error, currentAttempts);
  }
};

export const onEmailQueued = functions
  .runWith({
    memory: '512MB',
    timeoutSeconds: 120,
  })
  .region('europe-west1')
  .firestore.document(
    `${ASSOCIATIONS_COLLECTION}/{associationId}/${EMAIL_QUEUE_COLLECTION}/{emailId}`
  )
  .onCreate(async (snap, context) => {
    try {
      const { associationId } = context.params as { associationId: string };
      await handleEmailDocument(snap.ref, associationId);
    } catch (error) {
      functions.logger.warn('E-Mail konnte nicht sofort verarbeitet werden', {
        docId: snap.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const processEmailQueue = functions
  .runWith({
    memory: '512MB',
    timeoutSeconds: 120,
  })
  .region('europe-west1')
  .pubsub.schedule('every 5 minutes')
  .timeZone('Europe/Berlin')
  .onRun(async () => {
    // Führe zwei separate Queries aus und kombiniere die Ergebnisse
    // Das vermeidet Probleme mit Collection Group Queries und 'in' Operator
    const [pendingBatch, errorBatch] = await Promise.all([
      db
        .collectionGroup(EMAIL_QUEUE_COLLECTION)
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc')
        .limit(10)
        .get(),
      db
        .collectionGroup(EMAIL_QUEUE_COLLECTION)
        .where('status', '==', 'error')
        .orderBy('createdAt', 'asc')
        .limit(10)
        .get(),
    ]);

    // Kombiniere beide Batches und sortiere nach createdAt
    const allDocs = [...pendingBatch.docs, ...errorBatch.docs].sort((a, b) => {
      const aTime = a.data().createdAt?.toMillis() ?? 0;
      const bTime = b.data().createdAt?.toMillis() ?? 0;
      return aTime - bTime;
    });

    // Begrenze auf 20 Dokumente
    const docsToProcess = allDocs.slice(0, 20);

    if (docsToProcess.length === 0) {
      functions.logger.info('Keine offenen E-Mail-Aufträge gefunden.');
      return null;
    }

    for (const doc of docsToProcess) {
      try {
        await handleEmailDocument(doc.ref);
      } catch (error) {
        functions.logger.warn('Batch-Versand fehlgeschlagen', {
          docId: doc.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  });
