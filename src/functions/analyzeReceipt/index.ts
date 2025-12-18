/**
 * Analysiert eine Rechnung/Quittung mit Google Cloud Vision API
 * HTTP Endpoint: POST /analyzeReceipt
 */

import * as functions from 'firebase-functions';
import { ImageAnnotatorClient } from '@google-cloud/vision';

// Vision API Client initialisieren
const visionClient = new ImageAnnotatorClient();

interface ReceiptAnalysisRequest {
  receiptUrl: string;
  associationId?: string;
}

interface ExtractedData {
  amount: number | null;
  date: string | null;
  description: string;
  vendor: string;
  invoiceNumber: string | null;
  vat: number | null;
}

interface ReceiptAnalysisResponse {
  text: string;
  extracted: ExtractedData;
  confidence: number;
  message?: string;
}

export const analyzeReceipt = functions
  .region('europe-west1')
  .runWith({
    timeoutSeconds: 60,
    memory: '512MB'
  })
  .https
  .onRequest(async (req, res) => {
    // CORS-Header setzen
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');

    // OPTIONS Preflight Request
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    try {
      const { receiptUrl, associationId }: ReceiptAnalysisRequest = req.body;

      if (!receiptUrl) {
        res.status(400).json({ error: 'receiptUrl ist erforderlich' });
        return;
      }

      console.log('Analysiere Rechnung:', receiptUrl.substring(0, 100));

      // OCR-Analyse mit Vision API
      const [result] = await visionClient.textDetection(receiptUrl);
      const detections = result.textAnnotations;

      if (!detections || detections.length === 0) {
        res.status(200).json({
          text: '',
          extracted: {
            amount: null,
            date: null,
            description: '',
            vendor: '',
            invoiceNumber: null,
            vat: null
          },
          confidence: 0,
          message: 'Kein Text in der Rechnung gefunden'
        });
        return;
      }

      const fullText = detections[0].description || '';
      const confidence = detections[0].score || 0;

      console.log('OCR Text extrahiert:', fullText.substring(0, 200));

      // Parse die extrahierten Daten
      const extracted = parseReceiptData(fullText);

      console.log('Extrahierte Daten:', extracted);

      const response: ReceiptAnalysisResponse = {
        text: fullText,
        extracted,
        confidence
      };

      res.status(200).json(response);

    } catch (error: any) {
      console.error('OCR Error:', error);
      res.status(500).json({
        error: 'Fehler bei der OCR-Analyse',
        message: error.message
      });
    }
  });

/**
 * Parst den OCR-Text und extrahiert relevante Felder
 */
function parseReceiptData(text: string): ExtractedData {
  const extracted: ExtractedData = {
    amount: null,
    date: null,
    description: '',
    vendor: '',
    invoiceNumber: null,
    vat: null
  };

  // Betrag extrahieren (EUR, €, verschiedene Formate)
  const amountPatterns = [
    /(?:EUR|€|Euro|Total|Summe|Gesamt|Betrag|Amount)[\s:]*(\d+[.,]\d{2})/gi,
    /(\d+[.,]\d{2})\s*(?:EUR|€)/gi,
    /(?:zu\s+zahlen|Zahlbetrag)[\s:]*(\d+[.,]\d{2})/gi
  ];

  const allAmounts: number[] = [];
  for (const pattern of amountPatterns) {
    const matches = [...text.matchAll(pattern)];
    matches.forEach(match => {
      const amount = parseFloat(match[1].replace(',', '.'));
      if (!isNaN(amount) && amount > 0) {
        allAmounts.push(amount);
      }
    });
  }

  if (allAmounts.length > 0) {
    // Nimm den höchsten Betrag (wahrscheinlich Gesamtbetrag)
    extracted.amount = Math.max(...allAmounts);
  }

  // Datum extrahieren
  const datePatterns = [
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,  // DD.MM.YYYY
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,  // DD/MM/YYYY
    /(\d{4})-(\d{2})-(\d{2})/,        // YYYY-MM-DD
    /(\d{1,2})\.(\d{1,2})\.(\d{2})/,  // DD.MM.YY
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      const [, d1, d2, d3] = match;
      if (pattern === datePatterns[0] || pattern === datePatterns[1] || pattern === datePatterns[3]) {
        // DD.MM.YYYY oder DD/MM/YYYY oder DD.MM.YY
        const year = d3.length === 2 ? `20${d3}` : d3;
        const day = d1.padStart(2, '0');
        const month = d2.padStart(2, '0');
        extracted.date = `${year}-${month}-${day}`;
      } else {
        // YYYY-MM-DD
        extracted.date = `${d1}-${d2}-${d3}`;
      }
      break;
    }
  }

  // Händlername (erste Zeile)
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  if (lines.length > 0) {
    extracted.vendor = lines[0].trim().substring(0, 100);
    // Beschreibung = erste 2-3 Zeilen
    extracted.description = lines.slice(0, 3).join(' ').substring(0, 200);
  }

  // Rechnungsnummer
  const invoicePatterns = [
    /(?:Rechnung|Invoice|Beleg|Bon|Kassenzettel)[\s#:]*([A-Z0-9\-]+)/gi,
    /(?:Nr|No|#|Nummer)[\s:]*([A-Z0-9\-]+)/gi,
    /(?:Rechnungsnummer|Invoice\s+Number)[\s:]*([A-Z0-9\-]+)/gi
  ];

  for (const pattern of invoicePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      extracted.invoiceNumber = match[1];
      break;
    }
  }

  // MwSt/USt
  const vatPatterns = [
    /(?:MwSt|USt|VAT|Umsatzsteuer|Mehrwertsteuer)[\s:]*(\d+[.,]\d{2})/gi,
    /(?:MwSt|USt)[\s:]*(\d+%)/gi
  ];

  for (const pattern of vatPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const vatValue = match[1].replace(',', '.').replace('%', '');
      const vatNumber = parseFloat(vatValue);
      if (!isNaN(vatNumber)) {
        extracted.vat = vatNumber;
        break;
      }
    }
  }

  return extracted;
}

