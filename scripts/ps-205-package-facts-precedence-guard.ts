/**
 * PS-205 guard — saved SKU/combo package defaults beat ShipStation-imported
 * weights/dims everywhere that rates, displays, or buys.
 *
 * HUGRAB fixture: combo booster-gel-001:2|hu-10:1 has a saved client default
 * (package 121, 12x10x3, 31 oz) but ShipStation re-imports 35 oz. Canonical
 * precedence (pure owner: package-facts-policy.ts):
 *   override → combo_default → single_sku_default → imported (fallback ONLY).
 *
 * Materialization (combo-package-defaults.ts) writes the winning combo default
 * into order_overrides for mutable awaiting rows at IMPORT time, so every
 * existing reader (list, panel, Rate Browser, passive rating, Recalculate
 * Selected/All, print-queue payloads, create-label) resolves the right facts
 * through its existing `overrides.rate_* ?? orders.*` read — one write point,
 * all callers delegate.
 *
 * Offline + pure. No network, no DB, no postage.
 *
 *   npx tsx scripts/ps-205-package-facts-precedence-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  resolvePackageFactsFromInputs,
  rungHasFacts,
  rungsCarrySameFacts,
} from '../src/services/package-facts-policy';
import { computeComboKey } from '../src/lib/package-combo';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const COMBO = { weightOz: 31, length: 12, width: 10, height: 3, selectedPackageId: '121' };
const IMPORTED_35OZ = { weightOz: 35, length: 14, width: 11, height: 9, selectedPackageId: null };

// ── (1+2) exact combo default beats imported weight AND raw SS dimensions ────
{
  const facts = resolvePackageFactsFromInputs({
    override: null,
    comboDefault: COMBO,
    singleSkuDefault: null,
    imported: IMPORTED_35OZ,
    comboKey: 'booster-gel-001:2|hu-10:1',
  });
  check('HUGRAB fixture: combo default (31 oz) beats imported orders.weight_oz (35 oz)',
    facts.source === 'combo_default' && facts.weightOz === 31);
  check('HUGRAB fixture: combo default dims (12x10x3) beat raw ShipStation dimensions (14x11x9)',
    facts.dims?.length === 12 && facts.dims?.width === 10 && facts.dims?.height === 3 &&
    facts.selectedPackageId === '121' && facts.comboKey === 'booster-gel-001:2|hu-10:1');
}

// ── (3) explicit combo default beats product-derived multi-SKU stacked dims ──
{
  const facts = resolvePackageFactsFromInputs({
    override: null,
    comboDefault: COMBO,
    singleSkuDefault: { weightOz: 40, length: 12, width: 10, height: 15, selectedPackageId: null },
    imported: IMPORTED_35OZ,
  });
  check('explicit combo default (12x10x3) beats product-derived stacked dims (12x10x15)',
    facts.source === 'combo_default' && facts.dims?.height === 3 && facts.weightOz === 31);
}

// ── operator override outranks everything; materialized facts stay honest ────
{
  const operator = resolvePackageFactsFromInputs({
    override: { weightOz: 33, length: 12, width: 10, height: 4, selectedPackageId: '99' },
    comboDefault: COMBO,
    singleSkuDefault: null,
    imported: IMPORTED_35OZ,
  });
  check('an explicit operator edit outranks the combo default', operator.source === 'override' && operator.weightOz === 33);
  const materialized = resolvePackageFactsFromInputs({
    override: { ...COMBO },
    comboDefault: COMBO,
    singleSkuDefault: null,
    imported: IMPORTED_35OZ,
  });
  check('a materialized override (facts == combo default) reports source combo_default, not a fake operator edit',
    materialized.source === 'combo_default' && materialized.weightOz === 31);
  check('rung equality helper distinguishes operator edits from materialized defaults',
    rungsCarrySameFacts(COMBO, { ...COMBO }) === true &&
    rungsCarrySameFacts(COMBO, { ...COMBO, weightOz: 33 }) === false);
}

// ── imported is FALLBACK ONLY; single-SKU rung sits between ──────────────────
{
  const single = resolvePackageFactsFromInputs({
    override: null,
    comboDefault: null,
    singleSkuDefault: { weightOz: 12, length: 8, width: 6, height: 2, selectedPackageId: '7' },
    imported: IMPORTED_35OZ,
  });
  check('true single-SKU product default beats imported facts when no combo default exists',
    single.source === 'single_sku_default' && single.weightOz === 12);
  const imported = resolvePackageFactsFromInputs({
    override: null, comboDefault: null, singleSkuDefault: null, imported: IMPORTED_35OZ,
  });
  check('imported facts apply ONLY when no PrepShip-saved rung exists',
    imported.source === 'imported' && imported.weightOz === 35);
  check('an empty rung never wins (rungHasFacts gate)',
    rungHasFacts({ weightOz: null, length: null, width: null, height: null, selectedPackageId: null }) === false);
}

// ── (6+7) qty- and client-scoping of the combo identity ──────────────────────
check('different quantities are different combo identities (booster x2 ≠ booster x1)',
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 2 }, { sku: 'HU-10', quantity: 1 }]) === 'booster-gel-001:2|hu-10:1' &&
  computeComboKey([{ sku: 'booster-gel-001', quantity: 1 }, { sku: 'hu-10', quantity: 1 }]) !== 'booster-gel-001:2|hu-10:1');
check('SKU order/case/duplicate-lines do not change combo identity',
  computeComboKey([{ sku: 'HU-10', quantity: 1 }, { sku: 'BOOSTER-GEL-001', quantity: 1 }, { sku: 'booster-gel-001', qty: 1 }]) ===
  'booster-gel-001:2|hu-10:1');
const service = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
check('combo default lookups are CLIENT-scoped (clientId is part of every key/lookup)',
  /eq\(clientComboPackageDefaults\.clientId, candidate\.clientId\)/.test(service) &&
  /eq\(clientComboPackageDefaults\.clientId, clientId\)/.test(service) &&
  /eq\(clientComboPackageDefaults\.clientId, row\.clientId\)/.test(service));

// ── (5) future imports get combo facts BEFORE rating can use imported data ───
const importer = readFileSync('src/services/store-order-import.ts', 'utf8');
check('the single import-persistence helper materializes saved combo defaults after every batch',
  /await replaceOrderItemsForOrders\(persistedRows\);/.test(importer) &&
  /await materializePackageFactsForImportedOrderIds\(persistedOrderIds\);/.test(importer));
check('materialization failures never fail the sync itself (best-effort)',
  /catch \(err\) \{\s*\n\s*console\.warn\(\s*\n\s*'\[store-order-import\] package-facts materialization skipped:'/.test(importer));

// ── (8) shipped/cancelled/labelled rows are read-only no-ops ──────────────────
// The gate lives in a named predicate, not an inline eq(). The original
// assertion grepped for a literal eq(orders.orderStatus, 'awaiting_shipment')
// inside a 1500-character window of the materializer; the gate was refactored
// into orderLifecycleEffectiveStatusSql() and the window was brittle to the
// function growing, so this went red on a clean base while the lockdown itself
// was intact. Pin the predicate and its application instead of the old spelling.
check('the awaiting-only predicate resolves through the lifecycle status owner',
  /function mutableAwaitingOrderLifecyclePredicate\(\): SQL \{\s*\n\s*return sql`\$\{orderLifecycleEffectiveStatusSql\(\)\} = 'awaiting_shipment'`;/
    .test(service));
check('materializer touches ONLY mutable awaiting rows (lockdown gate)',
  (service.match(/mutableAwaitingOrderLifecyclePredicate\(\),/g) ?? []).length >= 2 &&
  /materializePackageFactsForImportedOrders[\s\S]*?mutableAwaitingOrderLifecyclePredicate\(\),/
    .test(service));
check('rows with a live (non-voided) label are skipped — via a READ-ONLY shipments probe',
  /hasActiveLabel: sql<boolean>`exists \(/.test(service) &&
  /if \(candidate\.hasActiveLabel\) continue;/.test(service));
check('operator edits / prior materializations are never overwritten (existing facts skip)',
  /if \(hasExistingFacts\) continue;/.test(service));
check('the new code never writes orders/shipments rows (override columns only)',
  !/db\s*\.update\(orders\)/.test(service) && !/insert\(shipments\)/.test(service) && !/update\(shipments\)/.test(service));

// ── (4+9) stale saved rates are cleared before re-rate, never persisted over ──
check('materialization invalidates a best rate saved off imported facts (bestRateAt cleared + pending stamped)',
  /materializePackageFactsForImportedOrders[\s\S]*?curBestRateAt != null \? \{ bestRateJson: null, bestRateAt: null, bestRateDims: null \}/.test(service) &&
  (service.match(/setOrderRatePending\(/g)?.length ?? 0) >= 2);
check('the explicit save-defaults flow keeps its sibling materialization + invalidation (PS-060/PS-121 intact)',
  /applyComboPackageDefaultToMatchingMutableOrders/.test(service) &&
  /invalidate \? \{ bestRateJson: null, bestRateAt: null, bestRateDims: null \}/.test(service));

// ── (10) rating/label/queue read the canonical facts through overrides ───────
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
check('create-label weight resolves overrides BEFORE imported orders.weightOz',
  /body\.weightOz \?\? overrides\?\.rateWeightOz \?\? order\.weightOz/.test(labelsService));
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('list rows + rate paths resolve overrides BEFORE imported weight',
  /finiteNumberOrNull\(safeOverrides\?\.rateWeightOz\) \?\? finiteNumberOrNull\(r\.order\.weightOz\)/.test(ordersRoute) &&
  /overrides\?\.rateWeightOz \?\? order\.weightOz/.test(ordersRoute));
check('the detail payload exposes the canonical packageFacts DTO (source-honest panel display)',
  (ordersRoute.match(/packageFacts: await resolveOrderPackageFacts\(id\)/g)?.length ?? 0) >= 2);

if (failures > 0) {
  console.error(`\nFAIL PS-205 package-facts precedence guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-205 package-facts precedence guard');
