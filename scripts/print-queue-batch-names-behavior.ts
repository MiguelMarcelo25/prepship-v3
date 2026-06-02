/*
 * PS-073 — Batch names + manifest BEHAVIOURAL guard.
 *
 * Exercises the recipient-name + Batch Manifest logic with FAKE FIXTURE
 * NAMES ONLY and renders real fixture PDFs (no network, no DB, no labels,
 * no postage). Hermetic: dummy env is set before importing the service so
 * this can never touch a real database. Run with:
 *
 *   npx tsx scripts/print-queue-batch-names-behavior.ts
 */

// ── Hermetic env: set BEFORE the service module graph loads ../lib/env.
// dotenv does not override already-set process.env keys, so these dummies
// win and no real DATABASE_URL / Supabase secret is ever required or used.
const dummyEnv: Record<string, string> = {
  DATABASE_URL: 'postgres://guard:guard@127.0.0.1:5432/guard',
  SUPABASE_URL: 'https://guard.example.com',
  SUPABASE_ANON_KEY: 'guard-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'guard-service',
  SUPABASE_JWT_SECRET: 'guard-jwt-secret',
  NODE_ENV: 'test',
};
for (const [key, value] of Object.entries(dummyEnv)) {
  if (!process.env[key]) process.env[key] = value;
}

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { PrintQueueEntry } from '../src/db/schema/print-queue';

const failures: string[] = [];
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

// Fake fixture recipient names — never real customers.
const FAKE_NAMES = [
  'ALEX KIM', 'BAILEY PARK', 'CASEY LEE', 'DANA CHOI', 'ELLIOT CHEN',
  'FINLEY SONG', 'GRAYSON YOO', 'HARPER LIM', 'IVY JUNG', 'JORDAN KWON',
  'KAI SHIN', 'LOGAN HAN', 'MORGAN OH', 'NICOLE BAE', 'OWEN RYU',
  'PARKER NAM', 'QUINN SEO', 'RILEY KO', 'SAM KANG', 'TAYLOR MOON',
  'UMA HWANG', 'VICTOR JEON', 'WENDY MIN', 'XAVIER ROH', 'YUNA CHO',
  'ZARA AHN', 'ARI BAEK', 'BORA CHA', 'CHAE DO', 'DAEL EOM',
  'EUN FANG', 'GANG HUH', 'HANA IM', 'IAN JANG', 'JAE KOO',
  'KARA LYU', 'LIA MOK', 'MINA NOH', 'NORA PAEK', 'OSCAR QUAH',
  'PIA RA', 'RUE SA', 'SOO TAK', 'TARA UH', 'VINA WI',
];

function fixtureEntry(overrides: Partial<PrintQueueEntry> = {}): PrintQueueEntry {
  return {
    id: 'fixture-1',
    clientId: 1,
    orderId: '1001',
    orderNumber: 'FAKE-1001',
    labelUrl: 'mock://label',
    skuGroupId: 'g1',
    primarySku: 'Booster-gel-001',
    itemDescription: 'Booster Gel',
    orderQty: 2,
    // Runtime multiSkuData may carry a per-line description (product name)
    // even though the persisted column type is sku+qty only; the header
    // shows description || sku as the card title.
    multiSkuData: [
      { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 },
      { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
    ] as unknown as PrintQueueEntry['multiSkuData'],
    status: 'queued',
    printCount: 0,
    lastPrintedAt: null,
    queuedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  } as PrintQueueEntry;
}

async function main() {
  const svc = await import('../src/services/print-queue');
  const {
    resolveRecipientDisplayName,
    resolveScopedRecipient,
    sortBatchRecipients,
    annotateDuplicateNames,
    planBatchNamesDisplay,
    BATCH_NAMES_HEADER_THRESHOLD,
    renderBatchHeaderPdfForTest,
  } = svc;

  // ── Pure logic ────────────────────────────────────────────────────
  const named = resolveRecipientDisplayName({ shipToName: 'Alex Kim', orderNumber: 'A-1' });
  check('name present -> uses recipient name', named.name === 'Alex Kim' && named.orderNumber === 'A-1');

  const missing = resolveRecipientDisplayName({ shipToName: '  ', orderNumber: 'A-2' });
  check('blank name -> Order <orderNumber> fallback', missing.name === 'Order A-2');

  const noNum = resolveRecipientDisplayName({ shipToName: null, orderNumber: null, orderId: null });
  check('no name + no order number -> Unnamed recipient', noNum.name === 'Unnamed recipient');

  check(
    'privacy: recipient object exposes only name + orderNumber',
    JSON.stringify(Object.keys(named).sort()) === JSON.stringify(['name', 'orderNumber'])
  );

  const sorted = sortBatchRecipients([
    { name: 'Zed', orderNumber: '9' },
    { name: 'alice', orderNumber: '1' },
    { name: 'Bob', orderNumber: '2' },
  ]);
  check(
    'sort is deterministic + case-insensitive',
    sorted.map((r) => r.name).join(',') === 'alice,Bob,Zed'
  );

  const dups = annotateDuplicateNames([
    { name: 'Sam Kang', orderNumber: '1' },
    { name: 'Sam Kang', orderNumber: '2' },
    { name: 'Unique One', orderNumber: '3' },
  ]);
  check(
    'duplicate names are flagged, uniques are not',
    dups[0]!.duplicate && dups[1]!.duplicate && !dups[2]!.duplicate
  );

  // ── Cross-client scope (exercises the actual scope gate, not a substring) ─
  const sameClient = resolveScopedRecipient(
    { clientId: 1, orderId: '500', orderNumber: null },
    { shipToName: 'Sam Kang', orderNumber: 'OWN-9', clientId: 1 }
  );
  check('scope: same-client row name is trusted', sameClient.name === 'Sam Kang');

  const crossClient = resolveScopedRecipient(
    { clientId: 1, orderId: '500', orderNumber: null },
    { shipToName: 'Other Client Person', orderNumber: 'OTHER-9', clientId: 2 }
  );
  check('scope: cross-client row NAME is dropped', crossClient.name !== 'Other Client Person');
  check(
    'scope: cross-client row ORDER NUMBER never surfaces (name or field)',
    !crossClient.orderNumber.includes('OTHER-9') && !crossClient.name.includes('OTHER-9')
  );
  check('scope: cross-client falls back to the entry\'s own order id', crossClient.name === 'Order 500');

  check('threshold is ~30', BATCH_NAMES_HEADER_THRESHOLD === 30);
  check('<= threshold plans header display', planBatchNamesDisplay(25).onHeader === true && planBatchNamesDisplay(25).needsManifest === false);
  check('> threshold plans manifest', planBatchNamesDisplay(45).onHeader === false && planBatchNamesDisplay(45).needsManifest === true);

  // ── PDF render ────────────────────────────────────────────────────
  const outDir = path.join(process.cwd(), 'test-results', 'ps073');
  fs.mkdirSync(outDir, { recursive: true });

  // 25-order batch -> names on header, NO manifest page (single page).
  const recipients25 = FAKE_NAMES.slice(0, 25).map((name, i) =>
    resolveRecipientDisplayName({ shipToName: name, orderNumber: `FAKE-${1000 + i}` })
  );
  const pdf25 = await renderBatchHeaderPdfForTest({
    entry: fixtureEntry(),
    totalOrders: 25,
    recipients: recipients25,
    isTest: true,
  });
  const doc25 = await PDFDocument.load(pdf25);
  check('25-order batch renders a single header page (names fit, no manifest)', doc25.getPageCount() === 1, `pages=${doc25.getPageCount()}`);
  fs.writeFileSync(path.join(outDir, 'header-25.pdf'), pdf25);

  // 45-order batch -> header pointer + dedicated manifest page(s).
  const recipients45 = FAKE_NAMES.slice(0, 45).map((name, i) =>
    resolveRecipientDisplayName({ shipToName: name, orderNumber: `FAKE-${2000 + i}` })
  );
  const pdf45 = await renderBatchHeaderPdfForTest({
    entry: fixtureEntry(),
    totalOrders: 45,
    recipients: recipients45,
    isTest: true,
  });
  const doc45 = await PDFDocument.load(pdf45);
  check('45-order batch adds a Batch Manifest page after the header', doc45.getPageCount() >= 2, `pages=${doc45.getPageCount()}`);
  fs.writeFileSync(path.join(outDir, 'header-45-manifest.pdf'), pdf45);

  // Missing-name batch still renders safely (fallbacks only).
  const recipientsMissing = Array.from({ length: 6 }, (_unused, i) =>
    resolveRecipientDisplayName({ shipToName: null, orderNumber: `FAKE-${3000 + i}` })
  );
  const pdfMissing = await renderBatchHeaderPdfForTest({
    entry: fixtureEntry(),
    totalOrders: 6,
    recipients: recipientsMissing,
    isTest: true,
  });
  const docMissing = await PDFDocument.load(pdfMissing);
  check('all-missing-name batch renders without error', docMissing.getPageCount() === 1);
  check('missing names use Order fallback', recipientsMissing.every((r) => r.name.startsWith('Order ')));

  // Real-world small batch shape (single SKU, x3, 3 names) — mirrors the
  // live TEST batches to certify the scaled-up card look on a tiny roster.
  const pdfSmall = await renderBatchHeaderPdfForTest({
    entry: fixtureEntry({
      primarySku: 'TEST-PACK',
      itemDescription: 'TEST Accessory Pack - Mockup Kit',
      orderQty: 3,
      multiSkuData: null,
    }),
    totalOrders: 3,
    recipients: ['TEST USER 01', 'TESTING CUSTOMER A', 'TESTING BUYER'].map((name, i) =>
      resolveRecipientDisplayName({ shipToName: name, orderNumber: `FAKE-${5000 + i}` })
    ),
    isTest: true,
  });
  const docSmall = await PDFDocument.load(pdfSmall);
  check('single-SKU small batch renders one header page', docSmall.getPageCount() === 1);
  fs.writeFileSync(path.join(outDir, 'header-small.pdf'), pdfSmall);

  // High-SKU combo (8 SKUs) -> cards are capped with a "+N more" line and
  // the ORDERS count must NOT be pushed off-page / overlap (M2 regression).
  const eightSkus = Array.from({ length: 8 }, (_u, i) => ({
    sku: `SKU-${i + 1}`,
    description: `Fixture Item ${i + 1}`,
    qty: 1,
  }));
  const pdf8 = await renderBatchHeaderPdfForTest({
    entry: fixtureEntry({
      multiSkuData: eightSkus as unknown as PrintQueueEntry['multiSkuData'],
    }),
    totalOrders: 12,
    recipients: FAKE_NAMES.slice(0, 12).map((name, i) =>
      resolveRecipientDisplayName({ shipToName: name, orderNumber: `FAKE-${4000 + i}` })
    ),
    isTest: true,
  });
  const doc8 = await PDFDocument.load(pdf8);
  check('8-SKU combo renders without error (cards capped)', doc8.getPageCount() >= 1);
  fs.writeFileSync(path.join(outDir, 'header-8sku.pdf'), pdf8);

  console.log('');
  if (failures.length > 0) {
    console.error(`PS-073 behaviour guard: ${failures.length} FAILED -> ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log(`PS-073 behaviour guard: all checks passed. Fixture PDFs in ${outDir}`);
}

main().catch((err) => {
  console.error('PS-073 behaviour guard crashed:', err);
  process.exit(1);
});
