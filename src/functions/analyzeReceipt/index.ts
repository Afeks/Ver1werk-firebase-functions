/**
 * Analysiert eine Rechnung/Quittung mit Google Cloud Vision API
 * HTTP Endpoint: POST /analyzeReceipt
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { PDFDocument } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

// Vision API Client initialisieren
const visionClient = new ImageAnnotatorClient();

// Firebase Admin Storage
const bucket = admin.storage().bucket();

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
    memory: '1GB' // Erhöht für Puppeteer
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
      const { receiptUrl }: ReceiptAnalysisRequest = req.body;

      if (!receiptUrl) {
        res.status(400).json({ error: 'receiptUrl ist erforderlich' });
        return;
      }

      console.log('Analysiere Rechnung:', receiptUrl.substring(0, 100));

      // Extrahiere den Storage-Pfad aus der Firebase Storage URL
      let gcsUri = receiptUrl;
      try {
        // Versuche Firebase Storage URL zu GCS URI zu konvertieren
        // Format: https://firebasestorage.googleapis.com/v0/b/BUCKET/o/PATH?alt=media&token=...
        const urlMatch = receiptUrl.match(/\/o\/([^?]+)/);
        if (urlMatch) {
          const filePath = decodeURIComponent(urlMatch[1]);
          // Bucket-Name aus URL extrahieren oder Standard verwenden
          const bucketMatch = receiptUrl.match(/\/b\/([^/]+)/);
          const bucketName = bucketMatch ? bucketMatch[1] : bucket.name;
          gcsUri = `gs://${bucketName}/${filePath}`;
          console.log('📦 Konvertierte URL zu GCS URI:', gcsUri);
          console.log('📦 Original URL:', receiptUrl);
          console.log('📦 File Path:', filePath);
          console.log('📦 Bucket Name:', bucketName);
        } else {
          console.log('⚠️ Konnte URL-Pattern nicht matchen');
        }
      } catch (urlError: any) {
        console.log('⚠️ Konnte URL nicht konvertieren:', urlError.message);
      }

      // Prüfe ob es eine PDF oder ein Bild ist
      const isPDF = receiptUrl.toLowerCase().includes('.pdf') || receiptUrl.includes('contentType=application%2Fpdf');
      
      let fullText = '';
      let confidence = 0;

      if (isPDF) {
        // Für PDFs: Versuche zuerst mit GCS URI, dann mit original URL
        console.log('📄 Erkenne PDF-Datei, versuche verschiedene Methoden');
        
        // Methode 1: Versuche documentTextDetection mit GCS URI
        try {
          console.log('🔄 Versuche documentTextDetection mit GCS URI:', gcsUri);
          const [result] = await visionClient.documentTextDetection({
            image: {
              source: { imageUri: gcsUri }
            }
          });
          
          console.log('📊 Vision API Response erhalten');
          console.log('📊 result.fullTextAnnotation:', result.fullTextAnnotation ? 'vorhanden' : 'null/undefined');
          console.log('📊 result.error:', result.error ? JSON.stringify(result.error, null, 2) : 'kein Fehler');
          console.log('📊 result.error details:', result.error?.details ? JSON.stringify(result.error.details, null, 2) : 'keine Details');
          console.log('📊 Vollständige Response (erste 500 Zeichen):', JSON.stringify(result).substring(0, 500));
          
          if (result.fullTextAnnotation) {
            fullText = result.fullTextAnnotation.text || '';
            confidence = result.fullTextAnnotation.pages?.[0]?.confidence || 0;
            console.log('✅ PDF-Text mit documentTextDetection extrahiert, Länge:', fullText.length);
            if (fullText.length > 0) {
              console.log('📝 Erste 500 Zeichen:', fullText.substring(0, 500));
            } else {
              console.log('⚠️ fullTextAnnotation.text ist leer');
            }
          } else {
            console.log('⚠️ result.fullTextAnnotation ist null/undefined, versuche nächste Methode');
            throw new Error('No fullTextAnnotation in result');
          }
        } catch (gcsError: any) {
          console.log('⚠️ GCS URI Methode fehlgeschlagen:', gcsError.message);
          console.log('⚠️ Error Details:', JSON.stringify(gcsError));
          
          // Methode 2: Lade Datei aus Firebase Storage und sende als Base64
          try {
            console.log('🔄 Versuche Datei aus Storage zu laden und als Base64 zu senden');
            const urlMatch = receiptUrl.match(/\/o\/([^?]+)/);
            if (urlMatch) {
              const filePath = decodeURIComponent(urlMatch[1]);
              const file = bucket.file(filePath);
              const [exists] = await file.exists();
              
              if (exists) {
                console.log('📥 Datei gefunden, lade herunter...');
                const [fileBuffer] = await file.download();
                const base64Content = fileBuffer.toString('base64');
                console.log('📥 Datei geladen, Größe:', fileBuffer.length, 'bytes');
                
                // Detaillierte PDF-Analyse
                try {
                  const pdfDoc = await PDFDocument.load(fileBuffer);
                  const pageCount = pdfDoc.getPageCount();
                  console.log('✅ PDF ist gültig, Seitenanzahl:', pageCount);
                  
                  // PDF-Metadaten analysieren
                  try {
                    const pdfInfo = (pdfDoc as any).catalog?.Info;
                    if (pdfInfo) {
                      console.log('📄 PDF-Info:', {
                        Title: pdfInfo.get('Title'),
                        Author: pdfInfo.get('Author'),
                        Creator: pdfInfo.get('Creator'),
                        Producer: pdfInfo.get('Producer'),
                      });
                    }
                  } catch (infoError: any) {
                    console.log('⚠️ Konnte PDF-Info nicht lesen:', infoError.message);
                  }
                  
                  // Prüfe erste Bytes, um den PDF-Typ zu erkennen
                  const firstBytes = fileBuffer.slice(0, 100).toString('ascii');
                  console.log('📄 Erste 100 Bytes der PDF:', firstBytes.substring(0, 100));
                  
                  // Prüfe, ob die PDF Bilder enthält
                  try {
                    const pages = pdfDoc.getPages();
                    if (pages.length > 0) {
                      const firstPage = pages[0];
                      const { width, height } = firstPage.getSize();
                      console.log('📏 Erste Seite: Breite:', width, 'Höhe:', height);
                    }
                  } catch (pageError: any) {
                    console.log('⚠️ Konnte Seiten-Informationen nicht lesen:', pageError.message);
                  }
                  
                  // Prüfe, ob die PDF verschlüsselt ist
                  const isEncrypted = (pdfDoc as any).isEncrypted;
                  if (isEncrypted) {
                    console.log('⚠️ PDF ist verschlüsselt - Vision API kann sie nicht verarbeiten');
                  }
                  
                  // Prüfe PDF-Version
                  const pdfVersion = (pdfDoc as any).context?.header;
                  console.log('📄 PDF-Version/Header:', pdfVersion ? pdfVersion.substring(0, 50) : 'unbekannt');
                  
                } catch (pdfError: any) {
                  console.log('⚠️ PDF-Validierung fehlgeschlagen:', pdfError.message);
                  console.log('⚠️ Error Stack:', pdfError.stack);
                  console.log('⚠️ Möglicherweise ist die PDF beschädigt oder hat ein ununterstütztes Format');
                  
                  // Prüfe die ersten Bytes trotzdem
                  try {
                    const firstBytes = fileBuffer.slice(0, 100).toString('ascii');
                    console.log('📄 Erste 100 Bytes (trotz Fehler):', firstBytes.substring(0, 100));
                    console.log('📄 Ist PDF (magic number)?', firstBytes.startsWith('%PDF'));
                  } catch (bytesError: any) {
                    console.log('⚠️ Konnte erste Bytes nicht lesen:', bytesError.message);
                  }
                }
                
                const [result] = await visionClient.documentTextDetection({
                  image: {
                    content: base64Content
                  }
                });
                
                console.log('📊 Base64 Vision API Response erhalten');
                console.log('📊 result.fullTextAnnotation:', result.fullTextAnnotation ? 'vorhanden' : 'null/undefined');
                console.log('📊 result.error:', result.error ? JSON.stringify(result.error, null, 2) : 'kein Fehler');
                console.log('📊 result.error details:', result.error?.details ? JSON.stringify(result.error.details, null, 2) : 'keine Details');
                console.log('📊 result.textAnnotations:', result.textAnnotations ? `${result.textAnnotations.length} Annotations` : 'null/undefined');
                console.log('📊 Base64 Content Länge:', base64Content.length, 'Zeichen');
                console.log('📊 Base64 Content (erste 200 Zeichen):', base64Content.substring(0, 200));
                
                if (result.fullTextAnnotation) {
                  fullText = result.fullTextAnnotation.text || '';
                  confidence = result.fullTextAnnotation.pages?.[0]?.confidence || 0;
                  console.log('✅ PDF-Text mit Base64-Methode extrahiert, Länge:', fullText.length);
                  if (fullText.length > 0) {
                    console.log('📝 Erste 500 Zeichen:', fullText.substring(0, 500));
                  }
                } else {
                  // Versuche textDetection für gescannte Bild-PDFs
                  console.log('🔄 Versuche textDetection für gescannte Bild-PDFs');
                  try {
                    const [textResult] = await visionClient.textDetection({
                      image: {
                        content: base64Content
                      }
                    });
                    
                    console.log('📊 textDetection Response erhalten');
                    console.log('📊 textResult.textAnnotations:', textResult.textAnnotations ? `${textResult.textAnnotations.length} Annotations` : 'null/undefined');
                    console.log('📊 textResult.error:', textResult.error ? JSON.stringify(textResult.error) : 'kein Fehler');
                    
                    if (textResult.textAnnotations && textResult.textAnnotations.length > 0) {
                      fullText = textResult.textAnnotations[0].description || '';
                      confidence = textResult.textAnnotations[0].score || 0;
                      console.log('✅ Text mit textDetection (Base64) extrahiert, Länge:', fullText.length);
                      if (fullText.length > 0) {
                        console.log('📝 Erste 500 Zeichen:', fullText.substring(0, 500));
                      }
                    } else {
                      throw new Error('No fullTextAnnotation in Base64 result and no textAnnotations in textDetection');
                    }
                  } catch (textDetError: any) {
                    console.log('⚠️ textDetection (Base64) fehlgeschlagen:', textDetError.message);
                    
                    // Letzter Versuch: PDF mit Puppeteer rendern und Screenshot erstellen
                    console.log('🔄 Versuche PDF mit Puppeteer zu rendern und Screenshot zu erstellen');
                    try {
                      const screenshotBuffer = await convertPdfToImage(fileBuffer, receiptUrl);
                      const screenshotBase64 = screenshotBuffer.toString('base64');
                      
                      console.log('📸 Screenshot erstellt, Größe:', screenshotBuffer.length, 'bytes');
                      
                      // Versuche textDetection mit dem Screenshot
                      const [screenshotResult] = await visionClient.textDetection({
                        image: {
                          content: screenshotBase64
                        }
                      });
                      
                      if (screenshotResult.textAnnotations && screenshotResult.textAnnotations.length > 0) {
                        fullText = screenshotResult.textAnnotations[0].description || '';
                        confidence = screenshotResult.textAnnotations[0].score || 0;
                        console.log('✅ Text mit Puppeteer-Screenshot extrahiert, Länge:', fullText.length);
                        if (fullText.length > 0) {
                          console.log('📝 Erste 500 Zeichen:', fullText.substring(0, 500));
                        }
                      } else {
                        throw new Error('No text found in screenshot');
                      }
                    } catch (puppeteerError: any) {
                      console.log('⚠️ Puppeteer-Methode fehlgeschlagen:', puppeteerError.message);
                      throw new Error('No fullTextAnnotation in Base64 result');
                    }
                  }
                }
              } else {
                throw new Error('File not found in storage');
              }
            } else {
              throw new Error('Could not extract file path from URL');
            }
          } catch (base64Error: any) {
            console.log('⚠️ Base64 Methode fehlgeschlagen:', base64Error.message);
            
            // Methode 3: Versuche documentTextDetection mit original URL
            try {
              console.log('🔄 Versuche documentTextDetection mit original URL');
              const [result] = await visionClient.documentTextDetection({
                image: {
                  source: { imageUri: receiptUrl }
                }
              });
              
              console.log('📊 URL Vision API Response erhalten');
              console.log('📊 result.fullTextAnnotation:', result.fullTextAnnotation ? 'vorhanden' : 'null/undefined');
              console.log('📊 result.error:', result.error ? JSON.stringify(result.error, null, 2) : 'kein Fehler');
              console.log('📊 result.error details:', result.error?.details ? JSON.stringify(result.error.details, null, 2) : 'keine Details');
              
              if (result.fullTextAnnotation) {
                fullText = result.fullTextAnnotation.text || '';
                confidence = result.fullTextAnnotation.pages?.[0]?.confidence || 0;
                console.log('✅ PDF-Text mit original URL extrahiert');
              } else {
                throw new Error('No fullTextAnnotation in URL result');
              }
            } catch (urlError: any) {
              console.log('⚠️ Original URL Methode fehlgeschlagen:', urlError.message);
              console.log('⚠️ URL Error Details:', JSON.stringify(urlError));
              
              // Methode 4: Fallback mit textDetection
              try {
                console.log('🔄 Versuche Fallback mit textDetection (URL)');
                const [result] = await visionClient.textDetection(receiptUrl);
                console.log('📊 textDetection (URL) Response erhalten');
                console.log('📊 result.textAnnotations:', result.textAnnotations ? `${result.textAnnotations.length} Annotations` : 'null/undefined');
                console.log('📊 result.error:', result.error ? JSON.stringify(result.error) : 'kein Fehler');
                
                const detections = result.textAnnotations;
                if (detections && detections.length > 0) {
                  fullText = detections[0].description || '';
                  confidence = detections[0].score || 0;
                  console.log('✅ Text mit textDetection (URL) gefunden, Länge:', fullText.length);
                  if (fullText.length > 0) {
                    console.log('📝 Erste 500 Zeichen:', fullText.substring(0, 500));
                  }
                } else {
                  console.log('⚠️ textDetection (URL) hat keine Ergebnisse zurückgegeben');
                }
              } catch (fallbackError: any) {
                console.error('❌ Alle Methoden fehlgeschlagen:', fallbackError.message);
                console.error('❌ Fallback Error Details:', JSON.stringify(fallbackError));
              }
            }
          }
        }
      } else {
        // Für Bilder: Verwende normale textDetection
        console.log('🖼️ Erkenne Bild-Datei, verwende textDetection');
        const [result] = await visionClient.textDetection(receiptUrl);
        const detections = result.textAnnotations;

        if (detections && detections.length > 0) {
          fullText = detections[0].description || '';
          confidence = detections[0].score || 0;
          console.log('✅ Bild-Text extrahiert, Länge:', fullText.length);
        } else {
          console.log('⚠️ Kein Text im Bild gefunden');
        }
      }

      if (!fullText || fullText.trim().length === 0) {
        // Prüfe, ob alle Methoden "Bad image data" zurückgegeben haben
        const errorMessage = isPDF 
          ? 'Die PDF-Datei konnte nicht von der Vision API verarbeitet werden. Mögliche Ursachen:\n' +
            '- Die PDF ist verschlüsselt oder passwortgeschützt\n' +
            '- Die PDF ist beschädigt oder hat ein ununterstütztes Format\n' +
            '- Die PDF ist ein gescanntes Bild mit sehr schlechter Qualität\n\n' +
            'Bitte versuchen Sie, die PDF in ein Bildformat (PNG/JPEG) zu konvertieren und erneut hochzuladen.'
          : 'Kein Text in der Rechnung gefunden. Bitte stellen Sie sicher, dass das Bild klar und gut lesbar ist.';
        
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
          message: errorMessage
        });
        return;
      }

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
 * Konvertiert eine PDF in ein Bild mit Puppeteer
 */
async function convertPdfToImage(pdfBuffer: Buffer, receiptUrl: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless === true ? true : 'new',
    ignoreHTTPSErrors: true,
  });

  try {
    const page = await browser.newPage();
    
    // Versuche die PDF direkt über die URL zu öffnen (funktioniert besser als Data-URI)
    console.log('🌐 Öffne PDF über URL:', receiptUrl);
    
    try {
      // Öffne die PDF direkt als URL
      await page.goto(receiptUrl, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      
      // Warte, damit PDF gerendert wird
      await page.waitForTimeout(3000);
      
      // Erstelle Screenshot
      const screenshot = (await page.screenshot({
        type: 'png',
        fullPage: true
      })) as Buffer;
      
      await browser.close();
      
      console.log('✅ Screenshot erfolgreich erstellt');
      return screenshot;
    } catch (urlError: any) {
      console.log('⚠️ PDF-URL-Methode fehlgeschlagen:', urlError.message);
      console.log('🔄 Versuche alternativ mit PDF.js');
      
      // Fallback: Verwende PDF.js zum Rendern der PDF
      const pdfBase64 = pdfBuffer.toString('base64');
      
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
            <style>
              body {
                margin: 0;
                padding: 20px;
                background: white;
              }
              #canvas {
                border: 1px solid #ccc;
              }
            </style>
          </head>
          <body>
            <canvas id="canvas"></canvas>
            <script>
              (async function() {
                try {
                  const pdfData = atob('${pdfBase64}');
                  const loadingTask = pdfjsLib.getDocument({ data: pdfData });
                  const pdf = await loadingTask.promise;
                  const page = await pdf.getPage(1);
                  
                  const viewport = page.getViewport({ scale: 2.0 });
                  const canvas = document.getElementById('canvas');
                  const context = canvas.getContext('2d');
                  
                  canvas.height = viewport.height;
                  canvas.width = viewport.width;
                  
                  await page.render({
                    canvasContext: context,
                    viewport: viewport
                  }).promise;
                  
                  console.log('PDF rendered successfully');
                } catch (error) {
                  console.error('PDF.js error:', error);
                }
              })();
            </script>
          </body>
        </html>
      `;
      
      await page.setContent(html, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      
      // Warte auf PDF.js, bis die PDF gerendert ist
      await page.waitForFunction(() => {
        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        return canvas && canvas.width > 0 && canvas.height > 0;
      }, { timeout: 30000 });
      
      // Zusätzliche Wartezeit, damit alles gerendert wird
      await page.waitForTimeout(2000);
      
      const screenshot = (await page.screenshot({
        type: 'png',
        fullPage: true
      })) as Buffer;
      
      await browser.close();
      
      return screenshot;
    }
  } catch (error: any) {
    await browser.close();
    throw error;
  }
}

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

