/**
 * PS-073 — adaptive batch-header product-name font certification.
 *
 * Proves the Print Queue batch header shrinks the product-NAME font only when
 * the name is genuinely long, while a short/normal name keeps the bold default
 * size. Renders two single-SKU fixtures with the test-only renderer and reads
 * the `<size> Tf` operators out of the (inflated) PDF content stream:
 *
 *   - short name  ("Leeds Line V2")  -> title drawn at the 18pt default
 *   - long  name  (long laundry SKU) -> title font stepped DOWN below 18pt,
 *                                       but never below the legible floor
 *
 * Fake recipient names only — no DB, no network, no postage, no PII.
 *
 *   npx tsx scripts/ps-073-adaptive-title-font-cert.ts
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

// Inflate every content stream and return the decoded operator text. The font
// size lives in `/Fn <size> Tf` operators, which survive in the inflated stream
// (they are NOT inside the hex-encoded text tokens). Read-only, in-memory.
function inflatedStreams(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let out = '';
  const streamMarker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let idx = 0;
  for (;;) {
    const s = buf.indexOf(streamMarker, idx);
    if (s === -1) break;
    let dataStart = s + streamMarker.length;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;
    const e = buf.indexOf(endMarker, dataStart);
    if (e === -1) break;
    const chunk = buf.subarray(dataStart, e);
    try {
      out += zlib.inflateSync(chunk).toString('latin1');
    } catch {
      try {
        out += zlib.inflateRawSync(chunk).toString('latin1');
      } catch {
        /* not a flate stream */
      }
    }
    idx = e + endMarker.length;
  }
  return out;
}

// All distinct font sizes used via `Tf` operators in the rendered page.
function fontSizes(bytes: Uint8Array): number[] {
  const text = inflatedStreams(bytes);
  const sizes = new Set<number>();
  for (const m of text.matchAll(/\/[A-Za-z0-9_+.-]+\s+(\d+(?:\.\d+)?)\s+Tf/g)) {
    sizes.add(Number(m[1]));
  }
  return [...sizes].sort((a, b) => a - b);
}

async function renderSizes(entry: unknown): Promise<number[]> {
  const bytes = await renderBatchHeaderPdfForTest({
    entry: entry as never,
    totalOrders: 1,
    recipients: [{ name: 'Test Picker', orderNumber: 'TST-1' }] as never,
    isTest: true,
  });
  check('renderer returns non-empty PDF bytes', bytes.length > 0);
  return fontSizes(bytes);
}

async function main(): Promise<void> {
  const base = {
    queueEntryId: 'qe-1',
    orderId: '1001',
    orderNumber: 'TST-1',
    clientId: 4,
    orderQty: 1,
    multiSkuData: null,
  };

  // ── Short name: keeps the 18pt default (the design default look) ──────────
  const shortSizes = await renderSizes({
    ...base,
    skuGroupId: 'SKU:HU-10:1',
    primarySku: 'HU-10',
    itemDescription: 'Leeds Line V2',
  });
  console.log('short-name font sizes:', shortSizes.join(', '));
  check('short name: title drawn at 18pt default', shortSizes.includes(18));

  // ── Long name: title font stepped DOWN below the 18pt default ─────────────
  const longSizes = await renderSizes({
    ...base,
    skuGroupId: 'SKU:AWE-LAUNDRY-PRE-1P:1',
    primarySku: 'AWE LAUNDRY PRE - 1P',
    itemDescription:
      "Laundry Pre Wash Stain Remover 32 Oz La's Totally Awesome by La's Totally Awesome",
  });
  console.log('long-name  font sizes:', longSizes.join(', '));
  // The QTY badge is 19pt and is present in both; the title is the only thing
  // that should have dropped. Assert NO 18pt title remains and that a smaller,
  // still-legible title size (>= floor 11) appears.
  check('long name: no 18pt title (it shrank)', !longSizes.includes(18));
  const shrunkTitle = longSizes.some((s) => s >= 11 && s < 18 && s !== 10.5);
  check('long name: a shrunk-but-legible title size appears (11..<18)', shrunkTitle);

  if (failures > 0) {
    console.error(`\nFAIL PS-073 adaptive title font certification (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-073 adaptive title font certification');
}

main().catch((e) => {
  console.error('PS-073 adaptive title font cert failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
