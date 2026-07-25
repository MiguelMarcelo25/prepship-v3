import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  generateMockLabelHtml,
  generateMockLabelPdf,
  type MockLabelData,
} from '../src/services/mock-label-generator.js';

const base: MockLabelData = {
  shipmentId: -1234567,
  orderNumber: 'TEST-HU10-001',
  trackingNumber: 'TEST01234567890123456789',
  serviceLabel: 'USPS GROUND ADVANTAGE',
  weightOz: 12,
  shipFrom: {
    name: 'TEST Fulfillment Center',
    street1: '41 Test St',
    city: 'Gardena',
    state: 'CA',
    postalCode: '90248',
  },
  shipTo: {
    name: 'TEST - DO NOT SHIP',
    street1: '100 Testing St',
    city: 'Test Springs',
    state: 'FL',
    postalCode: '99904',
  },
  shipDate: '2026-07-25',
};

const standardHtml = generateMockLabelHtml(base);
assert.doesNotMatch(standardHtml, /Surface Transportation Only/);
assert.doesNotMatch(standardHtml, /TEST TRACKING # HAZMAT/);

const labelsService = readFileSync('src/services/labels.ts', 'utf8');
assert.match(
  labelsService,
  /isHazmat: hazmatPurchaseFacts != null/,
  'the label workflow must pass canonical hazmat purchase facts into the mock renderer',
);

const hazmatData = { ...base, isHazmat: true };
const hazmatHtml = generateMockLabelHtml(hazmatData);
assert.match(hazmatHtml, />H<\/div>/);
assert.match(hazmatHtml, /HAZMAT - Surface Transportation Only/);
assert.match(hazmatHtml, /TEST TRACKING # HAZMAT/);
assert.match(hazmatHtml, /VOID/);
assert.match(hazmatHtml, /DO NOT SHIP/);

const pdfBase64 = await generateMockLabelPdf(hazmatData);
const pdfBytes = Buffer.from(pdfBase64, 'base64');
const pdf = await PDFDocument.load(pdfBytes);
assert.equal(pdf.getPageCount(), 1);
assert.deepEqual(pdf.getPage(0).getSize(), { width: 288, height: 432 });

const outputArg = process.argv.find((value) => value.startsWith('--output='));
if (outputArg) {
  const outputPath = path.resolve(outputArg.slice('--output='.length));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, pdfBytes);
  console.log(`Rendered fixture: ${outputPath}`);
}

console.log('Mock hazmat label guard passed.');
