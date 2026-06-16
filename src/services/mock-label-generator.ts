import { escapeHtml } from '../lib/escape-html.js';

export type MockLabelData = {
  shipmentId: number;
  orderNumber: string | null;
  trackingNumber: string;
  serviceLabel: string;
  weightOz: number;
  shipFrom: { name: string; street1: string; city: string; state: string; postalCode: string };
  shipTo: { name: string; street1: string; city: string; state: string; postalCode: string };
  shipDate: string;
  pdfBase64?: string;
};

function fakeBarcodeSvg(trackingNumber: string): string {
  const bars: string[] = [];
  let x = 0;
  for (let i = 0; i < trackingNumber.length * 3; i++) {
    const charCode = trackingNumber.charCodeAt(i % trackingNumber.length);
    const width = ((charCode + i) % 3) + 1;
    if ((charCode + i) % 3 !== 0) {
      bars.push(`<rect x="${x}" y="0" width="${width}" height="50" fill="black"/>`);
    }
    x += width + 1;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="50" viewBox="0 0 ${x} 50">${bars.join('')}</svg>`;
}

export function generateMockLabelHtml(data: MockLabelData): string {
  const barcode = fakeBarcodeSvg(data.trackingNumber);
  const formattedTracking = data.trackingNumber.replace(/(.{4})/g, '$1 ').trim();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>TEST LABEL — ${escapeHtml(data.orderNumber ?? data.shipmentId)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; background: #f0f0f0; display: flex; justify-content: center; padding: 20px; }
.label { width: 4in; min-height: 6in; background: white; border: 2px solid #000; position: relative; }
.void-banner { background: #ff0000; color: white; text-align: center; font-size: 22px; font-weight: 900; letter-spacing: 4px; padding: 6px 0; border-bottom: 2px solid #000; }
.section { border-bottom: 1px solid #000; padding: 8px 10px; }
.label-sm { font-size: 9px; text-transform: uppercase; color: #555; font-weight: bold; margin-bottom: 2px; }
.label-val { font-size: 13px; font-weight: bold; }
.label-val.small { font-size: 11px; font-weight: normal; }
.service-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 2px solid #000; }
.service-name { font-size: 20px; font-weight: 900; letter-spacing: 1px; }
.weight-box { border: 1px solid #999; padding: 4px 8px; font-size: 11px; text-align: center; }
.tracking-section { padding: 8px 10px; border-bottom: 2px solid #000; text-align: center; }
.tracking-num { font-size: 16px; font-weight: bold; font-family: monospace; letter-spacing: 1px; margin: 6px 0; }
.barcode-wrap { display: flex; justify-content: center; margin: 6px 0; overflow: hidden; }
.order-row { display: flex; justify-content: space-between; padding: 6px 10px; font-size: 11px; }
.test-watermark { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 80px; font-weight: 900; color: rgba(255,0,0,0.08); pointer-events: none; white-space: nowrap; letter-spacing: 10px; z-index: 0; }
</style></head><body>
<div class="label">
<div class="test-watermark">TEST</div>
<div class="void-banner">⚠ VOID — TEST LABEL — DO NOT SHIP ⚠</div>
<div class="section"><div class="label-sm">Ship From</div><div class="label-val">${escapeHtml(data.shipFrom.name)}</div><div class="label-val small">${escapeHtml(data.shipFrom.street1)}</div><div class="label-val small">${escapeHtml(data.shipFrom.city)}, ${escapeHtml(data.shipFrom.state)} ${escapeHtml(data.shipFrom.postalCode)}</div></div>
<div class="section"><div class="label-sm">Ship To</div><div class="label-val" style="font-size:16px">${escapeHtml(data.shipTo.name)}</div><div class="label-val small" style="font-size:13px">${escapeHtml(data.shipTo.street1)}</div><div class="label-val small" style="font-size:15px">${escapeHtml(data.shipTo.city)}, ${escapeHtml(data.shipTo.state)} ${escapeHtml(data.shipTo.postalCode)}</div></div>
<div class="service-row"><div class="service-name">${escapeHtml(data.serviceLabel)}</div><div class="weight-box"><div style="font-size:9px;color:#555">WEIGHT</div><div style="font-weight:bold">${data.weightOz} oz</div></div></div>
<div class="tracking-section"><div class="label-sm">Tracking Number</div><div class="tracking-num">${escapeHtml(formattedTracking)}</div><div class="barcode-wrap">${barcode}</div></div>
<div class="order-row"><span><b>Order #:</b> ${escapeHtml(data.orderNumber ?? '-')}</span><span><b>Ship Date:</b> ${escapeHtml(data.shipDate)}</span></div>
<div class="order-row"><span><b>Shipment ID:</b> ${data.shipmentId}</span><span style="color:red;font-weight:bold">TEST MODE</span></div>
</div>
</body></html>`;
}

export function generateFakeTrackingNumber(): string {
  const digits = Array.from({ length: 20 }, () => Math.floor(Math.random() * 10)).join('');
  return `TEST${digits}`;
}

export function generateFakeShipmentId(): number {
  return -(Math.floor(Math.random() * 9_000_000) + 1_000_000);
}

export function serviceCodeToLabel(serviceCode: string): string {
  const map: Record<string, string> = {
    usps_priority_mail: 'USPS PRIORITY MAIL',
    usps_first_class_mail: 'USPS FIRST CLASS',
    usps_ground_advantage: 'USPS GROUND ADVANTAGE',
    usps_priority_mail_express: 'USPS PRIORITY EXPRESS',
    ups_ground: 'UPS GROUND',
    ups_2nd_day_air: 'UPS 2ND DAY AIR',
    ups_next_day_air: 'UPS NEXT DAY AIR',
    fedex_ground: 'FEDEX GROUND',
    fedex_2day: 'FEDEX 2DAY',
  };
  return map[serviceCode] ?? serviceCode.replace(/_/g, ' ').toUpperCase();
}

export async function generateMockLabelPdf(data: MockLabelData): Promise<string> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([288, 432]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const red = rgb(0.85, 0, 0);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const white = rgb(1, 1, 1);

  page.drawRectangle({ x: 0, y: 400, width: 288, height: 32, color: red });
  page.drawText('*** VOID - TEST LABEL - DO NOT SHIP ***', { x: 8, y: 410, size: 7, font, color: white });
  page.drawText('SHIP FROM', { x: 8, y: 388, size: 7, font, color: gray });
  page.drawText(data.shipFrom.name, { x: 8, y: 376, size: 9, font, color: black });
  page.drawText(data.shipFrom.street1, { x: 8, y: 364, size: 8, font: fontReg, color: black });
  page.drawText(`${data.shipFrom.city}, ${data.shipFrom.state} ${data.shipFrom.postalCode}`, { x: 8, y: 354, size: 8, font: fontReg, color: black });
  page.drawLine({ start: { x: 8, y: 348 }, end: { x: 280, y: 348 }, thickness: 0.5, color: gray });
  page.drawText('SHIP TO', { x: 8, y: 338, size: 7, font, color: gray });
  page.drawText(data.shipTo.name || 'TESTING', { x: 8, y: 326, size: 11, font, color: black });
  page.drawText(data.shipTo.street1 || 'TESTING', { x: 8, y: 312, size: 9, font: fontReg, color: black });
  page.drawText(`${data.shipTo.city || ''}, ${data.shipTo.state || ''} ${data.shipTo.postalCode || ''}`, { x: 8, y: 300, size: 10, font, color: black });
  page.drawLine({ start: { x: 8, y: 292 }, end: { x: 280, y: 292 }, thickness: 1, color: black });
  page.drawText(data.serviceLabel, { x: 8, y: 278, size: 13, font, color: black });
  page.drawText(`${data.weightOz} oz`, { x: 220, y: 278, size: 9, font: fontReg, color: black });
  page.drawLine({ start: { x: 8, y: 270 }, end: { x: 280, y: 270 }, thickness: 1, color: black });
  page.drawText('TRACKING NUMBER', { x: 8, y: 258, size: 7, font, color: gray });
  page.drawText(data.trackingNumber, { x: 8, y: 244, size: 8, font, color: black });

  let bx = 8;
  for (let i = 0; i < data.trackingNumber.length * 2; i++) {
    const ch = data.trackingNumber.charCodeAt(i % data.trackingNumber.length);
    const w = ((ch + i) % 3) + 1;
    if ((ch + i) % 3 !== 0) {
      page.drawRectangle({ x: bx, y: 210, width: w, height: 28, color: black });
    }
    bx += w + 1;
    if (bx > 280) break;
  }

  page.drawLine({ start: { x: 8, y: 200 }, end: { x: 280, y: 200 }, thickness: 0.5, color: gray });
  page.drawText(`Order: ${data.orderNumber ?? '-'}`, { x: 8, y: 188, size: 7, font: fontReg, color: gray });
  page.drawText(`Ship Date: ${data.shipDate}`, { x: 150, y: 188, size: 7, font: fontReg, color: gray });
  page.drawText(`Shipment ID: ${data.shipmentId}`, { x: 8, y: 176, size: 7, font: fontReg, color: gray });
  page.drawText('TEST MODE — $0.00', { x: 180, y: 176, size: 7, font, color: red });

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes).toString('base64');
}
