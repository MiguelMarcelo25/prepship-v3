/**
 * PS-497 ShipStation shipment-items guard.
 *
 * Offline: the REAL normalizer against ShipStation's REAL response shape. No provider
 * call, no postage, no production.
 *
 * WHAT BROKE. `shipment_sync` accounts for 1,003 of the 2,651 inventory claims stranded in
 * status='review' since 2026-07-16. The `kind: 'exact'` branch in shipment-sync.ts was
 * written correctly and had simply never received data: ShipStation V1 `GET /shipments`
 * defaults `includeShipmentItems` to FALSE, which OMITS the array rather than returning it
 * empty, so `Array.isArray(undefined)` was false on every row, every shipment took the
 * `unavailable` fallback, normalizeFulfillmentFacts stamped
 * `reviewReason: 'fulfillment_lines_unavailable'`, and the enqueue predicate
 * `fulfilledLines.some((line) => line.sku && !line.reviewReason)` could never be true.
 *
 * The repo already knew the field existed: parity/SHIPSTATION_API_DEEP_DIVE.md lists
 * shipmentItems[] under "fields returned but NOT consumed by v4".
 *
 * WHY SHIPMENT-scoped lines and not the order's. Unlike the label path, this path sets
 * NEITHER requireAwaitingOrderStatus NOR requireNoActiveOutboundShipment, and its
 * commandKey is per-shipment — so it legitimately fires for partial shipments and for
 * orders that already have others. The order's lines would over-deduct. ShipStation's
 * shipmentItems are scoped to the individual shipment, which is exactly right.
 */
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const { normalizeFulfilledLines } = await import('../src/services/order-lifecycle-command');

// ── the request must ASK for the items ─────────────────────────────────────
const sync = readFileSync('src/services/shipment-sync.ts', 'utf8').replace(/\r\n/g, '\n');
const syncCode = sync
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

check('the shipments request asks for shipment items',
  /includeShipmentItems: 'true'/.test(syncCode),
  'V1 defaults it to false and OMITS the array — the exact branch never sees data');
check('it is set on the list query, not somewhere inert',
  /new URLSearchParams\(\{[\s\S]{0,400}?includeShipmentItems: 'true',[\s\S]{0,80}?\}\)/.test(syncCode));
// An in-flight request made WITHOUT items must never satisfy one made WITH them.
check('the dedupe key distinguishes item-bearing requests',
  /dedupeKey: `shipments:list:[^`]*:items`/.test(syncCode));

// The exact/unavailable ternary must survive — the fallback is the fail-safe for stores
// that still return nothing.
check('the exact branch is still gated on items actually being present',
  /Array\.isArray\(candidate\?\.source\.shipmentItems\) && candidate\.source\.shipmentItems\.length > 0/.test(syncCode));
check('the unavailable fallback is preserved for stores that return no items',
  /kind: 'unavailable' as const,\s*\n\s*description: 'ShipStation shipment did not include fulfillment-line quantities'/.test(sync));

// ── THE proof: ShipStation's real item shape must deduct ───────────────────
// Shape per ShipStation V1 GET /shipments with includeShipmentItems=true.
const ssItems = [
  { orderItemId: 987654321, lineItemKey: 'abc-1', sku: 'SKU-A', name: 'Widget', quantity: 2,
    unitPrice: 9.99, weight: { value: 8, units: 'ounces' } },
  { orderItemId: 987654322, lineItemKey: 'abc-2', sku: 'SKU-B', name: 'Gadget', quantity: 1,
    unitPrice: 4.5, weight: { value: 3, units: 'ounces' } },
];
const normalized = normalizeFulfilledLines(ssItems as never);

check('both ShipStation items normalize', normalized.length === 2, normalized);
check('SKUs survive — a line without one is forced to review',
  normalized.every((l) => !!l.sku), normalized);
check('quantities survive exactly',
  normalized[0]?.quantity === 2 && normalized[1]?.quantity === 1, normalized);
// The line key falls back to `${sku}:${index+1}`, NOT orderItemId, because
// normalizeFulfilledLines resolves its key candidates through text(), which accepts only
// strings (order-lifecycle-command.ts:78-79) and ShipStation sends orderItemId as a NUMBER.
// That is acceptable: the claim's idempotency key is
// `inventory:deduct:lifecycle:${event.id}:line:${lineKey}` — scoped to the event — and
// sku:index is unique within one shipment, including two rows of the same SKU. Pinned so
// the fallback is a known property rather than a surprise.
check('the line key is stable and unique within the shipment',
  normalized[0]?.lineKey === 'SKU-A:1' && normalized[1]?.lineKey === 'SKU-B:2', normalized);
check('two rows of the SAME sku still get distinct keys',
  (() => {
    const dup = normalizeFulfilledLines([
      { orderItemId: 1, sku: 'SKU-A', quantity: 1 },
      { orderItemId: 2, sku: 'SKU-A', quantity: 3 },
    ] as never);
    return dup[0]!.lineKey !== dup[1]!.lineKey;
  })());
check('no reviewReason is stamped on a clean provider line',
  normalized.every((l) => !('reviewReason' in l) || !l.reviewReason), normalized);

// This is the exact predicate in applyOrderLifecycleCommandInTransaction that gates
// enqueueInventoryClaimDeduction. False for 22 days on this path.
check('THE enqueue predicate is TRUE for a synced ShipStation shipment',
  normalized.some((l) => l.sku && !l.reviewReason), normalized);

// ── the fail-safe still fails safe ─────────────────────────────────────────
check('an item with no sku still yields a review line, not a silent deduction',
  normalizeFulfilledLines([{ orderItemId: 1, quantity: 1 }] as never)
    .every((l) => !l.sku));
check('a zero quantity is flagged rather than deducted as 1',
  normalizeFulfilledLines([{ orderItemId: 1, sku: 'S', quantity: 0 }] as never)[0]?.reviewReason
    === 'invalid_quantity');
check('an empty item array normalizes to nothing (caller falls back to unavailable)',
  normalizeFulfilledLines([] as never).length === 0);

// ── scope: these are SHIPMENT lines, so the order-scoped loader must NOT be used here ──
check('shipment-sync does NOT reuse the whole-order line loader',
  !/loadWholeOrderShipmentLines/.test(syncCode),
  'this path fires for partial and repeat shipments — order lines would over-deduct');
check('the per-shipment commandKey is unchanged',
  /commandKey: `lifecycle:shipment:\$\{row\.id\}:shipped`/.test(syncCode));
check('provenance records which line source was used',
  /lineFacts: candidate\?\.source\.shipmentItems\?\.length \? 'shipment_items' : 'review_missing'/.test(syncCode));

if (failures > 0) {
  console.error(`\nFAIL PS-497 ShipStation shipment items guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-497 ShipStation shipment items guard');
