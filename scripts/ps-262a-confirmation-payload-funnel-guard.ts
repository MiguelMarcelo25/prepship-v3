/**
 * PS-262a guard — one canonical marketplace-confirmation identity, used by every path.
 *
 * The per-marketplace identity (eBay lineItems/ebayOrderId, Walmart purchaseOrderId/
 * rawOrder, storeAccountId) was built only in labels.ts; the direct mark-shipped-
 * externally path and the outbox worker passed near-empty payloads, so direct
 * eBay/Walmart confirmations failed with no identity. Now buildMarketplaceConfirmationIdentity
 * owns it and hydrate fills missing fields (live values win) at every entry point.
 * This unit-tests the factory and statically pins that all three paths delegate.
 *
 *   npx tsx scripts/ps-262a-confirmation-payload-funnel-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildMarketplaceConfirmationIdentity,
  hydrateMarketplaceConfirmationPayload,
  normalizeConfirmationProvider,
} from '../src/services/fulfillment/confirmation-payload';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── Identity builder ─────────────────────────────────────────────────────────
const walmartOrder = {
  externalOrderId: 'walmart-200014694741274',
  raw: { accountId: 'WMT-ACCT', purchaseOrderId: 'PO-123', orderId: 'o1' },
};
const wmId = buildMarketplaceConfirmationIdentity('walmart', walmartOrder);
check('walmart identity carries purchaseOrderId', wmId.purchaseOrderId === 'PO-123');
check('walmart identity carries storeAccountId + rawOrder', wmId.storeAccountId === 'WMT-ACCT' && !!wmId.rawOrder);

const ebayOrder = {
  externalOrderId: 'ebay-77',
  raw: { accountId: 'EB-ACCT', orderId: 'EB-ORDER-9', lineItems: [{ lineItemId: 'L1', quantity: 2 }, { quantity: 1 }] },
};
const ebId = buildMarketplaceConfirmationIdentity('ebay', ebayOrder);
check('ebay identity carries ebayOrderId', ebId.ebayOrderId === 'EB-ORDER-9');
check('ebay identity carries only valid lineItems',
  Array.isArray(ebId.lineItems) && (ebId.lineItems as any[]).length === 1
  && (ebId.lineItems as any[])[0].lineItemId === 'L1' && (ebId.lineItems as any[])[0].quantity === 2);

// purchaseOrderId falls back to the externalOrderId prefix-strip when raw lacks it.
const wmFromExternal = buildMarketplaceConfirmationIdentity('walmart', { externalOrderId: 'walmart-PO-XYZ', raw: {} });
check('walmart purchaseOrderId falls back to externalOrderId strip', wmFromExternal.purchaseOrderId === 'PO-XYZ');

// ── Hydrate ──────────────────────────────────────────────────────────────────
const filled = hydrateMarketplaceConfirmationPayload({ provider: 'walmart', order: walmartOrder, payload: {} });
check('hydrate fills a blank payload with identity', filled.purchaseOrderId === 'PO-123' && !!filled.rawOrder);

const liveWins = hydrateMarketplaceConfirmationPayload({
  provider: 'walmart', order: walmartOrder, payload: { purchaseOrderId: 'LIVE-PO' },
});
check('hydrate never overwrites a live value', liveWins.purchaseOrderId === 'LIVE-PO');
check('hydrate still fills the OTHER blanks alongside a live value', !!liveWins.rawOrder && liveWins.storeAccountId === 'WMT-ACCT');

const ssNoop = hydrateMarketplaceConfirmationPayload({ provider: 'shipstation', order: walmartOrder, payload: { a: 1 } });
check('hydrate is a no-op for shipstation (no identity injected)',
  ssNoop.purchaseOrderId === undefined && ssNoop.a === 1);

check('normalizeConfirmationProvider maps correctly',
  normalizeConfirmationProvider('Walmart') === 'walmart'
  && normalizeConfirmationProvider('ebay') === 'ebay'
  && normalizeConfirmationProvider('shipstation') === null
  && normalizeConfirmationProvider('manual') === null);

// ── Static: every entry point delegates to the single owner ──────────────────
const outbox = read('src/services/fulfillment/outbox.ts');
check('confirmShipmentDirectNow hydrates (direct path, F1)',
  outbox.includes('hydrateMarketplaceConfirmationPayload') && /provider: args\.provider/.test(outbox));
check('processOutboxRow re-hydrates from the loaded order (recovery path, F2)',
  /SELECT external_order_id, raw FROM orders/i.test(outbox) && /provider: row\.provider/.test(outbox));

const labels = read('src/services/labels.ts');
check('labels.ts delegates identity to the factory', labels.includes('buildMarketplaceConfirmationIdentity(provider, order)'));
check('labels.ts no longer builds the identity inline',
  !labels.includes('payload.ebayOrderId =') && !labels.includes('payload.purchaseOrderId ='));

const markShipped = read('src/services/fulfillment/mark-shipped-externally.ts');
check('mark-shipped-externally passes order.raw to the direct path', /raw: order\.raw/.test(markShipped));

const pkg = read('package.json');
check('package.json wires test:ps-262a-confirmation-payload-funnel', /test:ps-262a-confirmation-payload-funnel/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-262a confirmation-payload funnel guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-262a confirmation-payload funnel guard');
