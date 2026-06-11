/**
 * PS-177 (Phase 5, part 1) guard — queue SKU identity is backend-derivable.
 *
 * THE GAP: addToQueue trusted whatever identity the frontend sent. An
 * identifier-only caller (the PS-176 resume recovery, future thin clients) fell
 * back to a degraded ORDER:<id> group with no pick identity. The backend
 * already owned the collapse/identity rule (print-queue-identity, PS-052/070);
 * it just never DERIVED the full queue identity from it.
 *
 * THE FIX: pure buildQueueSkuIdentityFromItems (FE buildQueueAddPayload parity:
 * collapse → `${groupToken}:${qty}` sorted combo key → COMBO:/SKU:/ORDER:
 * prefixes; no-SKU eBay lines KEPT), and addToQueue rebuilds the identity from
 * order_items whenever the caller's identity is absent or degraded — while a
 * caller-sent REAL identity is kept verbatim (zero churn for existing flows).
 *
 *   npx tsx scripts/ps-177-queue-sku-identity-guard.ts
 */
import { readFileSync } from 'node:fs';
import { buildQueueSkuIdentityFromItems } from '../src/services/print-queue-identity';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral parity matrix (mirrors the FE buildQueueAddPayload semantics) ──
{
  const single = buildQueueSkuIdentityFromItems(1463, [
    { sku: 'Booster-gel-001', name: 'Booster Gel', qty: 2 },
  ]);
  check('single-SKU order → SKU: group with qty-bearing combo key',
    single.skuGroupId.startsWith('SKU:') && /:2$/.test(single.skuGroupId) &&
    single.primarySku === 'Booster-gel-001' && single.orderQty === 2 && single.multiSkuData === null);
}
{
  const combo = buildQueueSkuIdentityFromItems(1463, [
    { sku: 'HU-10', name: 'Leeds Line V2', qty: 1 },
    { sku: 'Booster-gel-001', name: 'Booster Gel', qty: 2 },
  ]);
  check('multi-SKU order → COMBO: group, lines sorted deterministically',
    combo.skuGroupId.startsWith('COMBO:') && combo.orderQty === 3 &&
    Array.isArray(combo.multiSkuData) && combo.multiSkuData.length === 2);
  const comboReversed = buildQueueSkuIdentityFromItems(1463, [
    { sku: 'Booster-gel-001', name: 'Booster Gel', qty: 2 },
    { sku: 'HU-10', name: 'Leeds Line V2', qty: 1 },
  ]);
  check('identical combos in any input order produce the IDENTICAL group id',
    combo.skuGroupId === comboReversed.skuGroupId);
}
{
  const noSku = buildQueueSkuIdentityFromItems(99, [
    { sku: '', name: 'eBay mystery item', qty: 1 },
  ]);
  // FE parity: a single line is wrapped `SKU:<token>:<qty>` even when the token
  // is a NOSKU title token — the point is it is NOT the degraded ORDER: fallback.
  check('no-SKU eBay line is KEPT (title identity, not the ORDER: fallback)',
    noSku.skuGroupId.includes('NOSKU:') && noSku.skuGroupId !== 'ORDER:99' &&
    noSku.itemDescription === 'eBay mystery item');
}
check('no items at all → ORDER:<id> fallback with qty 1',
  (() => {
    const empty = buildQueueSkuIdentityFromItems(77, []);
    return empty.skuGroupId === 'ORDER:77' && empty.orderQty === 1 && empty.primarySku === null;
  })());
check('adjustment lines are filtered out (FE parity)',
  (() => {
    const withAdjustment = buildQueueSkuIdentityFromItems(5, [
      { sku: 'REAL-1', name: 'Real', qty: 1 },
      { sku: 'DISCOUNT', name: 'Discount', qty: 1, adjustment: true },
    ]);
    return withAdjustment.orderQty === 1 && withAdjustment.primarySku === 'REAL-1';
  })());
check('quantities merge across duplicate lines (collapse rule)',
  buildQueueSkuIdentityFromItems(6, [
    { sku: 'A', qty: 1 },
    { sku: 'a ', qty: 2 },
  ]).orderQty === 3);

// ── wiring pins ───────────────────────────────────────────────────────────────
const printQueueService = readFileSync('src/services/print-queue.ts', 'utf8');
check('addToQueue derives identity ONLY when the caller identity is absent/degraded',
  /identityDegraded = !identity\.skuGroupId \|\| \/\^\(ORDER:\|order-\)\/\.test\(identity\.skuGroupId\)/.test(printQueueService));
check('derivation reads order_items and is best-effort (caller values on failure)',
  /from\(orderItems\)[\s\S]{0,120}eq\(orderItems\.orderId, numericOrderId\)/.test(printQueueService) &&
  /sku identity derivation failed/.test(printQueueService));
check('insert + conflict-update both write the resolved identity',
  (printQueueService.match(/skuGroupId: identity\.skuGroupId,/g)?.length ?? 0) === 2);

if (failures > 0) {
  console.error(`\nFAIL PS-177 queue sku identity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-177 queue sku identity guard');
