/**
 * PS-199 guard — Walmart purchaseOrderId resolution is v4-owned.
 *
 * THE BUG (production, 2026-06-11): every Walmart Shipping quote in v4 failed
 * with "requires a Walmart purchaseOrderId" — the resolution chain lived only
 * in the legacy Vercel functions and was never ported when the Rate Browser
 * moved to v4 /rates/browse. Nothing resolved the PO, and the connector's
 * rawOrder (boxItems + ship-to) was never hydrated either.
 *
 * THE FIX: src/services/walmart-po-resolution.ts is the canonical owner
 * (ownership recorded in ARCHITECTURE.md: live Marketplace lookup owns the
 * translation; store_orders is its cache). The rates path resolves per
 * walmart_shipping account and passes purchaseOrderId + rawOrder into the
 * connector, stamping purchaseOrderSource on the per-carrier meta. The labels
 * mode (consumed by PS-202) always live-verifies and throws rather than buy
 * against an unverified PO.
 *
 * Source-pin guard (the resolver is io-coupled — DB + live Marketplace — so
 * behavior is pinned structurally, the established pattern for io modules).
 * Read-only; no network, no postage.
 *
 *   npx tsx scripts/ps-199-walmart-po-resolution-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const resolver = readFileSync('src/services/walmart-po-resolution.ts', 'utf8');

// ── resolution priority order (① body → ② prefix → ③ cache → ④ live) ─────────
{
  const body = resolver.indexOf("purchaseOrderId ? 'body.purchaseOrderId' : 'none'");
  const prefix = resolver.indexOf("purchaseOrderSource = 'orders.external_order_id'");
  const cache = resolver.indexOf("purchaseOrderSource = 'store_orders lookup'");
  const live = resolver.indexOf("purchaseOrderSource = 'walmart_marketplace_api'");
  check('resolver implements all four sources in priority order',
    body >= 0 && prefix > body && cache > prefix && live > cache,
    `offsets body=${body} prefix=${prefix} cache=${cache} live=${live}`);
}
check('walmart- prefix strip is the ② rule',
  /externalOrderId\?\.startsWith\('walmart-'\)/.test(resolver) &&
  /externalOrderId\.slice\('walmart-'\.length\)/.test(resolver));
check('③ cache lookup matches external_order_id OR customer_order_id (newest first)',
  /external_order_id IN \(\$\{a\}, \$\{b\}, \$\{c\}\)/.test(resolver) &&
  /OR customer_order_id IN \(\$\{a\}, \$\{b\}, \$\{c\}\)/.test(resolver) &&
  /ORDER BY last_fetched_at DESC NULLS LAST/.test(resolver));
check('④ live lookup uses the canonical store connector (one Marketplace client)',
  /lookupWalmartOrderByCustomerOrderId\(input\.credentials, candidateCustomerOrderId\)/.test(resolver) &&
  /from '\.\.\/connectors\/store\/walmart\.js'/.test(resolver));
check('live hits are cached back into store_orders (upsert, conflict-safe)',
  /INSERT INTO store_orders/.test(resolver) &&
  /ON CONFLICT \(provider, external_order_id\) DO UPDATE/.test(resolver));

// ── the no-borrow rule (legacy Fix 1) ─────────────────────────────────────────
check('a REAL order never borrows another order\'s PO (demo fallback gated on no orderId, rates only)',
  /if \(!purchaseOrderId && !orderId && mode === 'rates'\)/.test(resolver) &&
  /store_orders fallback \(settings demo\)/.test(resolver));

// ── labels mode: money-path strictness ────────────────────────────────────────
check('labels mode ALWAYS live-verifies when a customerOrderId candidate exists',
  /mode === 'labels' \? candidateCustomerOrderId != null : !purchaseOrderId/.test(resolver));
check('labels mode throws on live-verification failure (never buys unverified)',
  /Label not purchased\./.test(resolver));
check('labels mode throws when no PO resolves (no silent fallback)',
  /mode === 'labels' && !purchaseOrderId/.test(resolver) &&
  /Walmart Shipping labels require a Walmart purchaseOrderId/.test(resolver));

// ── rawOrder hydration (the connector needs boxItems + ship-to) ───────────────
check('rawOrder usability check ported (orderLines or postalAddress)',
  /orderLines\?\.orderLine/.test(resolver) && /shippingInfo\?\.postalAddress/.test(resolver));
check('PO-known-but-raw-missing re-hydrates from the cache',
  /purchaseOrderId && !walmartRawOrderUsable\(rawOrder\)/.test(resolver));

// ── rates-path wiring ─────────────────────────────────────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('direct-rates path resolves the PO for walmart_shipping accounts',
  /normalizeProviderKey\(account\.provider\) === 'walmart_shipping'/.test(ratesService) &&
  /resolveWalmartPurchaseOrder\(/.test(ratesService) &&
  /'rates',\s*\)/.test(ratesService));
check('connector receives the resolved PO and the raw marketplace order',
  /purchaseOrderId: walmartPo\?\.purchaseOrderId \?\? input\.purchaseOrderId/.test(ratesService) &&
  /walmartPo\?\.rawOrder != null \? \{ rawOrder: walmartPo\.rawOrder \}/.test(ratesService));
check('purchaseOrderSource is stamped on the per-carrier meta (FE badge renders it)',
  /purchaseOrderSource: walmartPo\.purchaseOrderSource/.test(ratesService));
check('store-account attribution flows into the cache upsert',
  /storeAccountId: account\.sourceTable === 'store_accounts' \? account\.id : null/.test(ratesService));

// ── ownership recorded ────────────────────────────────────────────────────────
const architecture = readFileSync('ARCHITECTURE.md', 'utf8');
check('ARCHITECTURE.md records the ownership decision (live lookup owner, store_orders cache)',
  /walmart-po-resolution/.test(architecture) && /store_orders.+cache/i.test(architecture));

// ── safety: resolver writes only the cache table ──────────────────────────────
check('resolver never writes orders/shipments (reads orders only; store_orders is the only write)',
  !/INSERT INTO orders\b/.test(resolver) && !/UPDATE orders\b/.test(resolver) &&
  !/INSERT INTO shipments\b/.test(resolver) && !/UPDATE shipments\b/.test(resolver));

if (failures > 0) {
  console.error(`\nFAIL PS-199 walmart PO resolution guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-199 walmart PO resolution guard');
