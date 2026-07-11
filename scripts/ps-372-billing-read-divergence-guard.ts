/**
 * PS-372 — Billing read-time divergence cleanup guard.
 *
 * Pins the four "same concept, computed differently" fixes:
 *  (a) ONE "no configured price" sentinel (null) shared by the billing
 *      generator's box price lookup and clientUsedPackagePricingRows.
 *  (c) store attribution: orders.store_id is populated at INGESTION (the
 *      ShipStation connector extracts advancedOptions.storeId and order-sync
 *      persists it); billing's readers prefer the column and use raw only as
 *      the legacy-row fallback. (Backfilling legacy shipped rows requires
 *      DJ's `unlock shipped data` — deliberately NOT done here.)
 *  (d) the label-vs-billing package-identity boundary (PS-207/PS-221):
 *      label-time resolution tolerates ±0.1" dims and may auto-create;
 *      billing-time resolution matches EXACT dims and never guesses — a
 *      label-resolved box surfaces as an explicit review line at billing
 *      regen instead of silently re-pricing.
 *  (b) lives in scripts/ps-363-billing-no-box-cost-alert-guard.ts (the alert
 *      owner consumes the emitter's clientHasBoxPricing gate).
 *
 *   npx tsx scripts/ps-372-billing-read-divergence-guard.ts
 */
import { readFileSync } from 'node:fs';
import { buildClientUsedPackagePricingRows } from '../src/services/billing-client-used-package-pricing-rows';
import {
  boxDimsKey,
  decidePackageCostLine,
  resolveShippedPackageId,
  type BoxLookups,
  type BoxPackage,
} from '../src/services/billing-box-policy';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const read = (path: string) => readFileSync(path, 'utf8');

// ── (a) one "no configured price" sentinel: null ─────────────────────────────
{
  const rows = buildClientUsedPackagePricingRows({
    packages: [
      { id: 7, packageId: 7, name: 'Unpriced Box', length: 12, width: 10, height: 3, unitCost: 0.9 },
      { id: 8, packageId: 8, name: 'Free Box', length: 6, width: 4, height: 2, unitCost: 0.5 },
    ],
    savedPrices: [{ packageId: 8, price: 0 }],
    billingPackageIds: [7, 8],
  });
  const unpriced = rows.find((row) => row.packageId === 7);
  const zeroPriced = rows.find((row) => row.packageId === 8);
  check('(a) unconfigured price is NULL, not 0 (pricing rows)',
    unpriced != null && unpriced.charge === null && unpriced.price === null && unpriced.marginPct === null);
  check('(a) a genuinely configured $0 price stays 0 (distinct from unconfigured)',
    zeroPriced != null && zeroPriced.charge === 0 && zeroPriced.price === 0);

  const billingSrc = read('src/services/billing.ts');
  check('(a) billing generator normalizes its box-price map miss to the SAME null sentinel',
    /configuredPrice:\s*\n?\s*boxResolution\.status === 'resolved' && boxResolution\.packageId != null\s*\n?\s*\? clientPrices\?\.get\(boxResolution\.packageId\) \?\? null\s*\n?\s*: null/.test(billingSrc));
  check('(a) decidePackageCostLine treats the null sentinel as "no line" (not a $0 bill)',
    decidePackageCostLine({
      resolution: { status: 'resolved', source: 'dims', packageId: 7, pkg: { id: 7, name: 'Unpriced Box', packageCode: null, length: 12, width: 10, height: 3 }, overridePrice: null, note: null },
      clientHasBoxPricing: true,
      configuredPrice: null,
      markupPct: 15,
    }).kind === 'none');
}

// ── (c) store attribution: populated at ingestion, column-first reads ────────
{
  const connector = read('src/connectors/store/shipstation.ts');
  check('(c) ShipStation connector extracts advancedOptions.storeId at INGESTION',
    /const storeId = o\.advancedOptions\?\.storeId \?\? null/.test(connector));
  const orderSync = read('src/services/order-sync.ts');
  check('(c) order-sync persists the normalized storeId onto orders',
    /storeId: args\.storeId/.test(orderSync) && /function normalizedStoreId/.test(orderSync));
  const storeImport = read('src/services/store-order-import.ts');
  const orderItems = read('src/services/order-items.ts');
  check('(c) order upserts refresh orders.store_id on conflict (import + item paths)',
    /storeId: sql`excluded\.store_id`/.test(storeImport) &&
    (/storeId: sql`excluded\.store_id`/.test(orderItems) || /store_id = excluded\.store_id/.test(orderItems)));
  const billingSrc = read('src/services/billing.ts');
  check('(c) billing TS reader prefers the orders.store_id column (raw is legacy fallback only)',
    /if \(orderStoreId !== null\) return orderStoreId;/.test(billingSrc));
  check('(c) billing SQL scope predicate prefers o.store_id before the raw fallback',
    /o\.store_id is not null and o\.store_id = any\(sc\.store_ids\)/.test(billingSrc));
}

// ── (d) label-vs-billing package-identity boundary (documented + pinned) ─────
{
  // Label/package-consumption time: PS-413 exact-safe match. Pin the constant
  // so fuzzy matching cannot silently consume the wrong catalog package.
  const labelResolver = read('src/services/package-resolution.ts');
  check('(d) label-time resolver keeps its documented exact-safe dims tolerance',
    /const DIMS_TOLERANCE = 0\.001;/.test(labelResolver));

  // Billing-time: exact match, never guess (PS-207). The same near-miss must
  // remain explicit review at both label consumption and billing boundaries.
  const catalogBox: BoxPackage = { id: 7, name: '12x10x3', packageCode: null, length: 12, width: 10, height: 3 };
  const lookups: BoxLookups = {
    byId: new Map([[7, catalogBox]]),
    byCode: new Map(),
    byDims: new Map([[boxDimsKey(12, 10, 3)!, catalogBox]]),
  };
  const nearMiss = resolveShippedPackageId({
    operator: null,
    selectedPid: null,
    selectedPackageId: null,
    dimsL: 12,
    dimsW: 10,
    dimsH: 3.05, // within the LABEL tolerance, outside billing's exact match
    lookups,
  });
  check('(d) billing-time resolution never dims-guesses: 0.05" off => NOT resolved',
    nearMiss.status !== 'resolved');
  check('(d) the near-miss surfaces as an explicit review/unresolved (visible, not a silent $0 re-price)',
    nearMiss.status === 'unresolved' || nearMiss.status === 'mismatch');
  const exact = resolveShippedPackageId({
    operator: null,
    selectedPid: null,
    selectedPackageId: null,
    dimsL: 12,
    dimsW: 10,
    dimsH: 3,
    lookups,
  });
  check('(d) exact dims still resolve at billing time',
    exact.status === 'resolved' && exact.packageId === 7);
  // The review path materializes as a $0 review LINE (never a guessed charge).
  const reviewDecision = decidePackageCostLine({
    resolution: nearMiss,
    clientHasBoxPricing: true,
    configuredPrice: null,
    markupPct: 0,
  });
  check('(d) billing regen turns the near-miss into an explicit review line, not a price',
    reviewDecision.kind === 'review');
}

if (failures > 0) {
  console.error(`\nPS-372 billing read-divergence guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-372 billing read-divergence guard passed.');
