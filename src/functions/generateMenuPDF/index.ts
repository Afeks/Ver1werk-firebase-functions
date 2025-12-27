/**
 * Generiert ein PDF aus HTML für den MenuDesigner
 * HTTP Endpoint: POST /generateMenuPDF
 */

import * as functions from 'firebase-functions';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument } from 'pdf-lib';

export const generateMenuPDF = functions
  .region('europe-west1')
  .runWith({
    timeoutSeconds: 540,
    memory: '1GB'
  })
  .https
  .onRequest(async (req, res) => {
    // CORS-Header setzen - WICHTIG: Vor allem Response senden
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
      const { html } = req.body;

      if (!html) {
        res.status(400).json({ error: 'HTML content is required' });
        return;
      }

      console.log('Received HTML length:', html.length);
      console.log('HTML preview (first 500 chars):', html.substring(0, 500));
      
      // Extrahiere Informationen aus dem HTML, bevor wir es modifizieren
      const initialPageCount = (html.match(/class="md-print-page"/g) || []).length;
      console.log(`📄 Anzahl Print-Seiten im HTML: ${initialPageCount}`);

      // Puppeteer Browser mit optimiertem Chromium für Serverless starten
      const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless === true ? true : 'new',
        ignoreHTTPSErrors: true,
      });

      try {
        const page = await browser.newPage();
        
        // HTML setzen mit längeren Timeouts
        // WICHTIG: Viewport ZUERST setzen, bevor HTML geladen wird
        await page.setViewport({
          width: 794, // 210mm in px
          height: 1123, // 297mm in px
          deviceScaleFactor: 1
        });
        
        await page.setContent(html, {
          waitUntil: 'networkidle0',
          timeout: 30000
        });

        // Warte auf alle Bilder und externen Ressourcen
        await page.evaluate(() => {
          return Promise.all(
            Array.from(document.images).map((img): Promise<void> => {
              if (img.complete && img.naturalWidth > 0) {
                return Promise.resolve();
              }
              return new Promise<void>((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => resolve(); // Auch bei Fehler weitermachen
                setTimeout(() => resolve(), 10000); // Timeout nach 10 Sekunden
              });
            })
          );
        });

        // Zusätzliche Wartezeit für alles zu laden
        await page.waitForTimeout(2000);
        
        // WICHTIG: Stelle sicher, dass Print-Seiten sichtbar sind
        await page.evaluate(() => {
          // Stelle sicher, dass Print-Container und Seiten sichtbar sind
          const printContainer = document.querySelector('.md-print-pages-container') as HTMLElement;
          if (printContainer) {
            printContainer.style.display = 'block';
            printContainer.style.visibility = 'visible';
            printContainer.style.position = 'static';
            printContainer.style.left = 'auto';
            printContainer.style.top = 'auto';
            printContainer.style.width = 'auto';
            printContainer.style.height = 'auto';
            printContainer.style.overflow = 'visible';
            printContainer.style.zIndex = '1';
            printContainer.style.opacity = '1';
          }
          
          const printPages = document.querySelectorAll('.md-print-page');
          console.log(`Gefundene Print-Seiten: ${printPages.length}`);
          printPages.forEach((page, idx) => {
            const pageEl = page as HTMLElement;
            pageEl.style.display = 'block';
            pageEl.style.visibility = 'visible';
            pageEl.style.position = 'relative';
            pageEl.style.width = '794px';
            pageEl.style.height = '1123px';
            pageEl.style.margin = '0';
            pageEl.style.padding = '0';
            pageEl.style.overflow = 'visible';
            pageEl.style.opacity = '1';
            
            const canvases = pageEl.querySelectorAll('.md-canvas');
            console.log(`Seite ${idx}: ${canvases.length} Canvases`);
            canvases.forEach((canvas, canvasIdx) => {
              const canvasEl = canvas as HTMLElement;
              // Setze Größe in Pixel
              canvasEl.style.width = '794px';
              canvasEl.style.height = '1123px';
              canvasEl.style.minWidth = '794px';
              canvasEl.style.minHeight = '1123px';
              canvasEl.style.maxWidth = '794px';
              canvasEl.style.maxHeight = '1123px';
              canvasEl.style.display = 'block';
              canvasEl.style.visibility = 'visible';
              canvasEl.style.position = 'relative';
              canvasEl.style.overflow = 'visible';
              canvasEl.style.boxSizing = 'border-box';
              canvasEl.style.margin = '0';
              canvasEl.style.padding = '0';
              
              const rect = canvas.getBoundingClientRect();
              console.log(`  Canvas ${canvasIdx}: width=${rect.width}, height=${rect.height}, top=${rect.top}, left=${rect.left}`);
            });
          });
          
          // Setze auch Box-Styles nochmal, falls nötig
          const boxes = document.querySelectorAll('.md-box[data-box-id]');
          console.log(`Gefundene Boxen: ${boxes.length}`);
          boxes.forEach(box => {
            const boxId = box.getAttribute('data-box-id');
            const style = box.getAttribute('style');
            
            // Prüfe ob width/height vorhanden sind
            if (style && !style.includes('width:') && !style.includes('width:')) {
              console.log(`WARNUNG: Box ${boxId} hat kein width/height im style-Attribut`);
            }
            
            // Erzwinge Styles nochmal
            const computed = window.getComputedStyle(box);
            if (computed.width === '0px' || computed.height === '0px') {
              console.log(`WARNUNG: Box ${boxId} hat width/height 0, style: ${style?.substring(0, 200)}`);
            }
          });
        });
        
        // Warte kurz, damit Styles angewendet werden
        await page.waitForTimeout(500);

        // Debug: Prüfe ob Inhalt vorhanden ist
        const debugInfo = await page.evaluate(() => {
          const printPages = document.querySelectorAll('.md-print-page');
          const info = {
            pageCount: printPages.length,
            pages: [] as any[]
          };
          
          printPages.forEach((pageEl, idx) => {
            const boxes = pageEl.querySelectorAll('.md-box');
            const pageInfo = {
              index: idx,
              boxCount: boxes.length,
              boxes: [] as any[]
            };
            
            boxes.forEach((box, boxIdx) => {
              const rect = box.getBoundingClientRect();
              const computedStyle = window.getComputedStyle(box);
              const inlineStyle = box.getAttribute('style') || '';
              const parentRect = box.parentElement ? box.parentElement.getBoundingClientRect() : null;
              
              pageInfo.boxes.push({
                index: boxIdx,
                type: box.classList.contains('md-box-text') ? 'text' : 
                      box.classList.contains('md-box-image') ? 'image' : 
                      box.classList.contains('md-box-qrcode') ? 'qrcode' : 'unknown',
                position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                computedStyle: {
                  position: computedStyle.position,
                  left: computedStyle.left,
                  top: computedStyle.top,
                  width: computedStyle.width,
                  height: computedStyle.height,
                  visibility: computedStyle.visibility,
                  display: computedStyle.display,
                  opacity: computedStyle.opacity,
                  overflow: computedStyle.overflow,
                  overflowX: computedStyle.overflowX,
                  overflowY: computedStyle.overflowY
                },
                parentInfo: parentRect ? {
                  width: parentRect.width,
                  height: parentRect.height,
                  top: parentRect.top,
                  left: parentRect.left
                } : null,
                inlineStyle: inlineStyle.substring(0, 200),
                visible: rect.width > 0 && rect.height > 0,
                inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth
              });
            });
            
            info.pages.push(pageInfo);
          });
          
          return info;
        });

        console.log('Debug Info:', JSON.stringify(debugInfo, null, 2));

        if (debugInfo.pageCount === 0) {
          throw new Error('Keine Print-Seiten im HTML gefunden');
        }
        
        if (debugInfo.pages.every(p => p.boxCount === 0)) {
          throw new Error('Print-Seiten gefunden, aber keine Boxen');
        }
        
        // Prüfe ob Boxen sichtbar sind
        const visibleBoxes = debugInfo.pages.flatMap(p => p.boxes.filter((b: any) => b.visible));
        if (visibleBoxes.length === 0) {
          console.warn('WARNUNG: Alle Boxen haben width/height 0!');
          console.log('Erste Box Details:', JSON.stringify(debugInfo.pages[0]?.boxes[0], null, 2));
        } else {
          console.log(`✅ ${visibleBoxes.length} sichtbare Boxen gefunden`);
          // Prüfe erste Box-Positionen
          const firstPageBoxes = debugInfo.pages[0]?.boxes || [];
          firstPageBoxes.forEach((box: any) => {
            console.log(`Box ${box.index}: x=${box.position.x}, y=${box.position.y}, w=${box.position.width}, h=${box.position.height}`);
            console.log(`  Computed: left=${box.computedStyle.left}, top=${box.computedStyle.top}, width=${box.computedStyle.width}, height=${box.computedStyle.height}`);
          });
        }

        // Erstelle Screenshot zum Debuggen
        const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
        console.log('Screenshot erstellt:', screenshot.length, 'bytes');

        // Zähle Print-Seiten und berechne Gesamthöhe
        const pageInfo = await page.evaluate(() => {
          const printPages = document.querySelectorAll('.md-print-page');
          const pageCount = printPages.length;
          const pageHeight = 1123; // 297mm in px
          const totalHeight = pageCount * pageHeight;
          
          return { pageCount, pageHeight, totalHeight };
        });
        
        console.log(`📄 Anzahl Print-Seiten: ${pageInfo.pageCount}`);
        console.log(`📏 Gesamthöhe: ${pageInfo.totalHeight}px`);
        
        // WICHTIG: Setze Viewport auf A4-Größe für einzelne Seiten-Generierung
        await page.setViewport({
          width: 794, // 210mm in px
          height: 1123, // 297mm in px (eine Seite)
          deviceScaleFactor: 1
        });
        
        // NEUE STRATEGIE: Erstelle für jede Seite ein komplett neues HTML-Dokument
        // Das umgeht alle Probleme mit versteckten Seiten und Positionierung
        const pdfDoc = await PDFDocument.create();
        const pagePDFs: Buffer[] = [];
        
        // Extrahiere HTML für einzelne Seiten
        const singlePageHTMLs = await page.evaluate(() => {
          const printPages = document.querySelectorAll('.md-print-page');
          return Array.from(printPages).map((pageEl, idx) => {
            // Kopiere die Seite
            const clone = pageEl.cloneNode(true) as HTMLElement;
            
            // Stelle sicher, dass alles sichtbar ist
            clone.style.display = 'block';
            clone.style.visibility = 'visible';
            clone.style.position = 'relative';
            clone.style.top = '0';
            clone.style.left = '0';
            
            // Stelle sicher, dass Boxen im Clone sichtbar sind
            const boxes = clone.querySelectorAll('.md-box');
            boxes.forEach(box => {
              (box as HTMLElement).style.display = 'flex';
              (box as HTMLElement).style.visibility = 'visible';
              (box as HTMLElement).style.opacity = '1';
              (box as HTMLElement).style.position = 'absolute';
            });
            
            const html = clone.outerHTML;
            const boxCount = (html.match(/class="md-box"/g) || []).length;
            
            return {
              html,
              boxCount,
              pageIndex: idx
            };
          });
        });
        
        console.log(`📄 Extrahiert ${singlePageHTMLs.length} einzelne Seiten-HTML`);
        singlePageHTMLs.forEach((pageData, idx) => {
          console.log(`  Seite ${idx + 1}: ${pageData.boxCount} Boxen im HTML`);
        });
        
        // Für jede Seite: Erstelle neues Dokument und rendere PDF
        for (let i = 0; i < pageInfo.pageCount; i++) {
          const pageIndex = i;
          console.log(`🔄 Generiere PDF für Seite ${pageIndex + 1}/${pageInfo.pageCount}`);
          
          // Erstelle komplett neues HTML-Dokument für diese eine Seite
          const pageData = singlePageHTMLs[pageIndex];
          const singlePageHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page {
      size: A4;
      margin: 0;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      width: 794px;
      height: 1123px;
      margin: 0;
      padding: 0;
      overflow: hidden;
      position: relative;
    }
    .md-print-page {
      width: 794px !important;
      height: 1123px !important;
      display: block !important;
      visibility: visible !important;
      position: relative !important;
      margin: 0 !important;
      padding: 0 !important;
      top: 0 !important;
      left: 0 !important;
    }
    .md-canvas {
      width: 794px !important;
      height: 1123px !important;
      display: block !important;
      visibility: visible !important;
      position: relative !important;
      margin: 0 !important;
      padding: 0 !important;
      top: 0 !important;
      left: 0 !important;
    }
    .md-box {
      display: flex !important;
      visibility: visible !important;
      position: absolute !important;
      opacity: 1 !important;
    }
    .md-box-editor {
      display: block !important;
      visibility: visible !important;
      width: 100% !important;
      height: 100% !important;
      opacity: 1 !important;
    }
    .md-box-image,
    .md-box-qrcode {
      display: flex !important;
      visibility: visible !important;
      width: 100% !important;
      height: 100% !important;
      opacity: 1 !important;
    }
    .md-box img {
      display: block !important;
      visibility: visible !important;
      max-width: 100% !important;
      height: auto !important;
      object-fit: contain !important;
      opacity: 1 !important;
    }
  </style>
</head>
<body>
  ${pageData.html}
</body>
</html>`;
          
          console.log(`  📝 HTML-Länge für Seite ${pageIndex + 1}: ${singlePageHTML.length} bytes`);
          console.log(`  📦 Boxen im HTML: ${pageData.boxCount}`);

          // Öffne neues Tab für diese Seite
          const newPage = await browser.newPage();
          
          try {
            // Setze Viewport
            await newPage.setViewport({
              width: 794,
              height: 1123,
              deviceScaleFactor: 1
            });
            
            // Lade HTML
            await newPage.setContent(singlePageHTML, {
              waitUntil: 'networkidle0',
              timeout: 30000
            });
            
            // Warte auf Bilder
            await newPage.waitForTimeout(2000);
            
            // WICHTIG: Prüfe ob Boxen im gerenderten HTML sichtbar sind
            const renderCheck = await newPage.evaluate(() => {
              const boxes = document.querySelectorAll('.md-box');
              const boxDetails = Array.from(boxes).map((box, idx) => {
                const rect = box.getBoundingClientRect();
                const computed = window.getComputedStyle(box);
                return {
                  idx,
                  visible: computed.visibility === 'visible',
                  display: computed.display,
                  opacity: computed.opacity,
                  width: rect.width,
                  height: rect.height,
                  top: rect.top,
                  left: rect.left,
                  inViewport: rect.top >= 0 && rect.top < 1123 && rect.left >= 0 && rect.left < 794
                };
              });
              
              return {
                boxCount: boxes.length,
                boxDetails: boxDetails.slice(0, 3)
              };
            });
            
            console.log(`  🔍 Render Check Seite ${pageIndex + 1}:`, JSON.stringify(renderCheck, null, 2));
            
            // Screenshot zum Vergleich
            const screenshot = await newPage.screenshot({ 
              type: 'png', 
              fullPage: false,
              clip: { x: 0, y: 0, width: 794, height: 1123 }
            });
            console.log(`  📸 Screenshot Seite ${pageIndex + 1}: ${screenshot.length} bytes`);
            
            // Generiere PDF
            const pagePDF = await newPage.pdf({
              format: 'A4',
              printBackground: true,
              margin: {
                top: '0mm',
                right: '0mm',
                bottom: '0mm',
                left: '0mm'
              },
              preferCSSPageSize: false,
              displayHeaderFooter: false
            });
            
            pagePDFs.push(Buffer.from(pagePDF));
            console.log(`  ✅ Seite ${pageIndex + 1} PDF generiert: ${pagePDF.length} bytes`);
            
            await newPage.close();
          } catch (error: any) {
            console.error(`  ❌ Fehler bei Seite ${pageIndex + 1}:`, error.message);
            await newPage.close();
            throw error;
          }
        }
        
        // Füge alle Seiten zum kombinierten PDF hinzu
        console.log(`📄 ${pagePDFs.length} einzelne PDF-Seiten generiert`);
        
        // Füge alle Seiten zum kombinierten PDF hinzu
        for (const pagePDF of pagePDFs) {
          const externalPDF = await PDFDocument.load(pagePDF);
          const [copiedPage] = await pdfDoc.copyPages(externalPDF, [0]);
          pdfDoc.addPage(copiedPage);
        }
        
        // Generiere finales PDF
        const pdfBytes = await pdfDoc.save();
        const pdf = Buffer.from(pdfBytes);
        
        console.log(`PDF generiert: ${pdf.length} bytes`);
        
        // Prüfe PDF-Größe
        if (pdf.length < 5000) {
          console.warn('WARNUNG: PDF ist sehr klein, möglicherweise leer!');
        }

        await browser.close();

        // PDF als Response senden
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="menu.pdf"');
        res.send(pdf);
      } catch (error: any) {
        await browser.close();
        throw error;
      }
    } catch (error: any) {
      console.error('Error generating PDF:', error);
      res.status(500).json({ 
        error: 'Failed to generate PDF',
        message: error.message 
      });
    }
  });
