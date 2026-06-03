/**
 * PS-073 — certify the batch-header recipient-name reference + Batch Manifest
 * render for TEST orders too (isTest/mock batches), using fake names only.
 * READ-ONLY, in-memory: no DB, no network, no postage, no labels.
 *
 *   npx tsx scripts/ps-073-test-order-names-cert.ts
 */
import zlib from 'node:zlib';
import { renderBatchHeaderPdfForTest } from '../src/services/print-queue';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function extractPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let out = buf.toString('latin1');
  const sm = Buffer.from('stream');
  const em = Buffer.from('endstream');
  let idx = 0;
  for (;;) {
    const s = buf.indexOf(sm, idx);
    if (s === -1) break;
    let ds = s + sm.length;
    if (buf[ds] === 0x0d) ds += 1;
    if (buf[ds] === 0x0a) ds += 1;
    const e = buf.indexOf(em, ds);
    if (e === -1) break;
    let inflated = '';
    try {
      inflated = zlib.inflateSync(buf.subarray(ds, e)).toString('latin1');
    } catch {
      inflated = '';
    }
    out += inflated;
    for (const m of inflated.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
      const hex = m[1]!;
      if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
    }
    idx = e + em.length;
  }
  return out;
}

const testEntry = {
  queueEntryId: 'qe-test',
  orderId: '9001',
  orderNumber: 'TEST-9001',
  clientId: 4,
  skuGroupId: 'SKU:booster-gel-001:1',
  primarySku: 'Booster-gel-001',
  itemDescription: 'Booster Gel',
  orderQty: 1,
  multiSkuData: [{ sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 }],
};

async function render(recipients: Array<{ name: string; orderNumber: string }>): Promise<string> {
  const bytes = await renderBatchHeaderPdfForTest({
    entry: testEntry as never,
    totalOrders: recipients.length,
    recipients: recipients as never,
    isTest: true, // <-- TEST order batch
  });
  check('test-mode renderer returns PDF bytes', bytes.length > 0);
  return extractPdfText(bytes);
}

async function main(): Promise<void> {
  // ── Small TEST batch (3 orders): names on the header + TEST stamp ─────────
  const small = await render([
    { name: 'Alex Kim', orderNumber: 'TEST-9001' },
    { name: 'Bailey Park', orderNumber: 'TEST-9002' },
    { name: 'Order TEST-9003', orderNumber: 'TEST-9003' }, // missing-name fallback
  ]);
  check('TEST batch stamps the header as TEST', small.includes('TEST'));
  // PS-073 mock-match: rounded BATCH HEADER pill + secondary-reference footer.
  check('TEST batch renders the BATCH HEADER title', small.includes('BATCH HEADER'));
  check('TEST batch renders the reference footer', /Reference only/.test(small));
  check('TEST batch shows "Names in this batch (3)"', /Names in this batch \(3\)/.test(small));
  // Names are rendered upper-cased for the warehouse rescue list.
  check('TEST batch lists a recipient name', small.includes('ALEX KIM') && small.includes('BAILEY PARK'));
  check('TEST batch shows the missing-name fallback', small.includes('ORDER TEST-9003'));
  check('TEST batch still shows item pick card', small.includes('Booster Gel') && small.includes('Booster-gel-001'));

  // ── Large TEST batch (40 orders): header points to a Batch Manifest ───────
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `Picker ${String(i + 1).padStart(2, '0')}`,
    orderNumber: `TEST-${9100 + i}`,
  }));
  const large = await render(many);
  check('large TEST batch does not cram all names on header', !/Names in this batch \(40\)/.test(large));
  check('large TEST batch points to a Batch Manifest', /Batch Manifest|see (next )?(Batch )?[Mm]anifest|manifest/i.test(large));
  check('large TEST batch manifest lists fake names', large.includes('PICKER 01') && large.includes('PICKER 40'));
  check('large TEST batch manifest is stamped TEST', large.includes('TEST'));

  if (failures > 0) {
    console.error(`\nFAIL PS-073 test-order names certification (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-073 test-order names certification');
}

main().catch((e) => {
  console.error('PS-073 test-order cert failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
