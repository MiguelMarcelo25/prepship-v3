/*
 * PS-109 — Multi-SKU batch-header product names guard.
 *
 * Proves: (1) batch-send preserves per-line descriptions; (2) the batch header
 * shows the product NAME first and "sku: X" second; (3) a legacy row whose
 * description was stripped renders an explicit "Unnamed item" fallback instead of
 * the "spanish-100 / sku: spanish-100" SKU/SKU duplicate; (4) multi-SKU grouping
 * is unchanged. Hermetic — fake fixture data only, no DB, no network, no labels,
 * no postage.
 *
 *   npx tsx scripts/ps-109-multi-sku-header-names-guard.ts
 */

// Hermetic env BEFORE the service graph loads ../lib/env (dotenv won't override).
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

import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  headerCardTitle,
  collapseIdentityLines,
  UNNAMED_QUEUE_ITEM_LABEL,
} from '../src/services/print-queue-identity';
import type { PrintQueueEntry } from '../src/db/schema/print-queue';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}

// Inflate pdf-lib content streams + decode <hex> Tj tokens so drawn text is searchable.
function extractPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let out = buf.toString('latin1');
  let idx = 0;
  for (;;) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let dataStart = s + 'stream'.length;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;
    const e = buf.indexOf('endstream', dataStart);
    if (e === -1) break;
    let inflated = '';
    try {
      inflated = zlib.inflateSync(buf.subarray(dataStart, e)).toString('latin1');
    } catch {
      inflated = '';
    }
    out += inflated;
    for (const m of inflated.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
      const hex = m[1]!;
      if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
    }
    idx = e + 'endstream'.length;
  }
  return out;
}

// ── 1) headerCardTitle — the canonical name/fallback resolver ────────────────
check('real name wins', headerCardTitle({ sku: 'spanish-100', description: 'My First 100 Spanish Words', cardTitle: 'My First 100 Spanish Words' }), 'My First 100 Spanish Words');
check('stripped (sku only) -> Unnamed item, NOT the sku', headerCardTitle({ sku: 'spanish-100', description: '', cardTitle: 'spanish-100' }), UNNAMED_QUEUE_ITEM_LABEL);
check('description echoes the sku -> Unnamed item', headerCardTitle({ sku: 'spanish-100', description: 'spanish-100', cardTitle: 'spanish-100' }), UNNAMED_QUEUE_ITEM_LABEL);
check('case-insensitive sku echo -> Unnamed item', headerCardTitle({ sku: 'HU-10', description: 'hu-10' }), UNNAMED_QUEUE_ITEM_LABEL);
check('no-SKU eBay title is kept as the name', headerCardTitle({ sku: '', description: 'Samyang Variety Pack', cardTitle: 'Samyang Variety Pack' }), 'Samyang Variety Pack');
check('unresolved label is kept', headerCardTitle({ sku: '', description: '', cardTitle: 'UNRESOLVED EBAY ITEM' }), 'UNRESOLVED EBAY ITEM');

// ── 2) Frontend batch-send mapping preserves description (static source) ─────
const ordersViewSrc = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
checkTrue(
  'buildQueueSendOrderPayload maps description through',
  /description:\s*toStringValue\(item\?\.description\)/.test(ordersViewSrc),
);
checkTrue(
  'batch-send filter keeps no-SKU lines (sku OR description)',
  /\.filter\(\(item\)\s*=>\s*item\.sku\s*\|\|\s*item\.description\)/.test(ordersViewSrc),
);

// ── 2b) Backend resolves legacy-row names from canonical order_items (static) ─
const printQueueSrc = readFileSync('src/services/print-queue.ts', 'utf8');
checkTrue(
  'batch render enriches entries from canonical order_items before drawing headers',
  /enrichEntriesWithCanonicalItemNames\(entries\)/.test(printQueueSrc)
    && /from\(orderItems\)/.test(printQueueSrc),
);
checkTrue(
  'canonical resolver only fills a name when the line has just a SKU (no real name)',
  /function lineNeedsName/.test(printQueueSrc),
);

// ── 3) Grouping is unchanged: a 2-SKU combo with names keeps both, qty merges ─
const combo = collapseIdentityLines([
  { sku: 'spanish-100', description: 'My First 100 Spanish Words', qty: 1 },
  { sku: 'spanish-songbook-2', description: 'I Love to Sing in Spanish: Animal Songs (Songbook)', qty: 1 },
]);
check('combo keeps both lines', combo.length, 2);
checkTrue('combo headerCardTitle shows real names', combo.every((c) => headerCardTitle(c) !== UNNAMED_QUEUE_ITEM_LABEL));
const dup = collapseIdentityLines([
  { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
  { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
]);
check('duplicate same-SKU lines collapse', dup.length, 1);
check('duplicate qty merged', dup[0]!.qty, 2);

// ── 4) Rendered PDF: stripped row -> Unnamed item; named row -> names ────────
async function main() {
  const { renderBatchHeaderPdfForTest, resolveRecipientDisplayName } = await import('../src/services/print-queue');
  const baseEntry = (multiSkuData: unknown): PrintQueueEntry => ({
    id: 'fixture-109',
    clientId: 1,
    orderId: '9109',
    orderNumber: 'FAKE-9109',
    labelUrl: 'mock://label',
    skuGroupId: 'COMBO:x',
    primarySku: 'spanish-100',
    itemDescription: 'spanish-100', // mimics a nameless order whose desc IS the sku
    orderQty: 2,
    multiSkuData: multiSkuData as PrintQueueEntry['multiSkuData'],
    status: 'queued',
    printCount: 0,
    lastPrintedAt: null,
    queuedAt: new Date(),
    createdAt: new Date(),
  } as PrintQueueEntry);
  const recipients = ['TEST USER 01', 'TEST USER 02'].map((name, i) =>
    resolveRecipientDisplayName({ shipToName: name, orderNumber: `FAKE-${7000 + i}` }),
  );

  // Stripped multi_sku_data (the reported bug) -> Unnamed item, not SKU/SKU.
  const strippedPdf = await renderBatchHeaderPdfForTest({
    entry: baseEntry([
      { sku: 'spanish-100', qty: 1 },
      { sku: 'spanish-songbook-2', qty: 1 },
    ]),
    totalOrders: 2,
    recipients,
    isTest: true,
  });
  const strippedText = extractPdfText(strippedPdf);
  checkTrue('stripped header shows "Unnamed item" fallback', strippedText.includes(UNNAMED_QUEUE_ITEM_LABEL));
  checkTrue('stripped header still shows the sku line', /sku:\s*spanish-100/.test(strippedText));

  // Descriptions preserved (post-fix) -> product names render, no Unnamed fallback.
  const namedPdf = await renderBatchHeaderPdfForTest({
    entry: baseEntry([
      { sku: 'spanish-100', description: 'My First 100 Spanish Words', qty: 1 },
      { sku: 'spanish-songbook-2', description: 'I Love to Sing in Spanish: Animal Songs (Songbook)', qty: 1 },
    ]),
    totalOrders: 2,
    recipients,
    isTest: true,
  });
  const namedText = extractPdfText(namedPdf);
  // Long names wrap across lines (each wrapped line is a separate PDF text token),
  // so assert distinctive WHOLE words from the real names — wrapText breaks on
  // spaces, keeping words intact. These words appear in no SKU.
  checkTrue('named header shows product-name words ("Words"/"Animal")', namedText.includes('Words') && namedText.includes('Animal'));
  checkTrue('named header shows the sku line', /sku:\s*spanish-100/.test(namedText));
  checkTrue('named header does NOT fall back to Unnamed item', !namedText.includes(UNNAMED_QUEUE_ITEM_LABEL));

  if (failures > 0) {
    console.error(`\nFAIL PS-109 multi-SKU header names guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-109 multi-SKU header names guard');
}

main().catch((err) => {
  console.error('PS-109 guard crashed:', err);
  process.exit(1);
});
