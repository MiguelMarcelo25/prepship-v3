/**
 * PS-207 guard — bill the box the shipment actually used.
 *
 * DJ-decided policy (HKP audit, 2026-06-12): package_cost is priced from the
 * SHIPMENT'S RECORDED BOX ONLY. No SKU defaults, no inventory.package_id, no
 * combo defaults, no rounded-dims matching, no rate-dims resolution, no
 * precedence pick when the selected box and shipment dims disagree. Unsure →
 * explicit $0.00 package_cost_missing review line. Operator decisions persist
 * in billing_box_resolutions across regeneration.
 *
 * Layer 1: behavioral matrix on the PURE policy module (zero db — offline).
 * Layer 2: source pins so the banned fallbacks cannot quietly return.
 */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  boxDimsKey,
  decidePackageCostLine,
  describeBoxReview,
  resolveShippedPackageId,
  type BoxLookups,
  type BoxPackage,
  type ShippedBoxResolution,
} from '../src/services/billing-box-policy';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ── Fixtures (HKP-shaped) ───────────────────────────────────────────────────
const BOX_12_10_3: BoxPackage = { id: 31, name: '12x10x3', packageCode: 'box-12x10x3', length: 12, width: 10, height: 3 };
const BOX_11_9_6: BoxPackage = { id: 32, name: '11x9x6', packageCode: null, length: 11, width: 9, height: 6 };
const BOX_8_8_2: BoxPackage = { id: 3, name: '8.5x8x2.5', packageCode: null, length: 8.5, width: 8, height: 2.5 };
const BOX_NO_DIMS: BoxPackage = { id: 40, name: 'Envelope', packageCode: 'envelope', length: 0, width: 0, height: 0 };

const lookups: BoxLookups = {
  byId: new Map([[31, BOX_12_10_3], [32, BOX_11_9_6], [3, BOX_8_8_2], [40, BOX_NO_DIMS]]),
  byCode: new Map([['box-12x10x3', BOX_12_10_3], ['envelope', BOX_NO_DIMS]]),
  byDims: new Map([
    [boxDimsKey(12, 10, 3)!, BOX_12_10_3],
    [boxDimsKey(11, 9, 6)!, BOX_11_9_6],
    [boxDimsKey(8.5, 8, 2.5)!, BOX_8_8_2],
  ]),
};

const base = { operator: null, selectedPid: null, selectedPackageId: null, dimsL: null, dimsW: null, dimsH: null, lookups } as const;

// ── boxDimsKey identity (NOT rounding) ──────────────────────────────────────
assert.equal(boxDimsKey(12, 10, 3), '12x10x3');
assert.equal(boxDimsKey(12.0, 10, 3), '12x10x3', 'float noise must not split identical dims');
assert.notEqual(boxDimsKey(12.5, 9, 3), boxDimsKey(13, 9, 3), 'rounded-dims matching is BANNED — 12.5 is not 13');
assert.equal(boxDimsKey(12, 10, null), null, 'partial dims are no dims');
assert.equal(boxDimsKey(12, 10, 0), null, 'non-positive dims are no dims');

// ── Resolver matrix ─────────────────────────────────────────────────────────

// selected_package_id (numeric string) + coherent dims → resolved.
const r1 = resolveShippedPackageId({ ...base, selectedPackageId: '31', dimsL: 12, dimsW: 10, dimsH: 3 });
assert.equal(r1.status, 'resolved');
assert.equal((r1 as { packageId: number | null }).packageId, 31);
assert.equal((r1 as { source: string }).source, 'selected_package_code');

// selected_package_id (package_code) resolves.
const r2 = resolveShippedPackageId({ ...base, selectedPackageId: 'box-12x10x3' });
assert.equal(r2.status, 'resolved');
assert.equal((r2 as { packageId: number | null }).packageId, 31);

// selected_pid + coherent dims → resolved via pid.
const r3 = resolveShippedPackageId({ ...base, selectedPid: 32, dimsL: 11, dimsW: 9, dimsH: 6 });
assert.equal(r3.status, 'resolved');
assert.equal((r3 as { packageId: number | null }).packageId, 32);
assert.equal((r3 as { source: string }).source, 'selected_pid');

// Exact dims identity alone resolves.
const r4 = resolveShippedPackageId({ ...base, dimsL: 11, dimsW: 9, dimsH: 6 });
assert.equal(r4.status, 'resolved');
assert.equal((r4 as { source: string }).source, 'dims');
assert.equal((r4 as { packageId: number | null }).packageId, 32);

// SP6753/SP6763: custom dims, no package row → UNRESOLVED + exact wording.
const r5 = resolveShippedPackageId({ ...base, dimsL: 11.5, dimsW: 9, dimsH: 3 });
assert.equal(r5.status, 'unresolved');
assert.equal(
  describeBoxReview(r5 as Extract<ShippedBoxResolution, { status: 'unresolved' }>),
  'Unmatched box (Custom 11.5x9x3) — no package matches the shipment box',
);

// SP6754: selected 12x10x3 but shipment dims 12x10x1 (custom) → MISMATCH.
const r6 = resolveShippedPackageId({ ...base, selectedPackageId: '31', dimsL: 12, dimsW: 10, dimsH: 1 });
assert.equal(r6.status, 'mismatch', 'selected box vs custom shipment dims must NEVER precedence-pick');
assert.equal(
  describeBoxReview(r6 as Extract<ShippedBoxResolution, { status: 'mismatch' }>),
  'Box mismatch — selected box (12x10x3) disagrees with shipment dims (12x10x1)',
);

// Selected box vs dims that identify a DIFFERENT package → MISMATCH.
const r7 = resolveShippedPackageId({ ...base, selectedPid: 31, dimsL: 11, dimsW: 9, dimsH: 6 });
assert.equal(r7.status, 'mismatch');
assert.equal((r7 as { dimsPkg: BoxPackage | null }).dimsPkg?.id, 32);

// Provider-account contamination of selected_pid: a legacy provider id that
// collides with a package id + custom dims → MISMATCH review, never a silent
// wrong-box bill.
const r8 = resolveShippedPackageId({ ...base, selectedPid: 3, dimsL: 12, dimsW: 10, dimsH: 1 });
assert.equal(r8.status, 'mismatch');

// selected_package_id outranks selected_pid (v4 label flows write the box
// into selected_package_id; selected_pid is provider-flavored on legacy rows).
const r9 = resolveShippedPackageId({ ...base, selectedPackageId: '31', selectedPid: 3, dimsL: 12, dimsW: 10, dimsH: 3 });
assert.equal(r9.status, 'resolved');
assert.equal((r9 as { packageId: number | null }).packageId, 31);

// Package row without dims cannot be coherence-checked — selection stands.
const r10 = resolveShippedPackageId({ ...base, selectedPackageId: 'envelope', dimsL: 12, dimsW: 10, dimsH: 1 });
assert.equal(r10.status, 'resolved');
assert.equal((r10 as { packageId: number | null }).packageId, 40);

// Unknown selected identifier is noise — it does not veto a dims identity.
const r11 = resolveShippedPackageId({ ...base, selectedPackageId: 'package', dimsL: 12, dimsW: 10, dimsH: 3 });
assert.equal(r11.status, 'resolved');
assert.equal((r11 as { packageId: number | null }).packageId, 31);

// Unknown selected identifier + no dims → UNRESOLVED (never dropped).
const r12 = resolveShippedPackageId({ ...base, selectedPackageId: 'package' });
assert.equal(r12.status, 'unresolved');
assert.equal((r12 as { reason: string }).reason, 'unknown_selected_package');

// No evidence at all → UNRESOLVED.
const r13 = resolveShippedPackageId({ ...base });
assert.equal(r13.status, 'unresolved');
assert.equal((r13 as { reason: string }).reason, 'no_box_evidence');

// Operator directive wins over coherent shipment evidence.
const r14 = resolveShippedPackageId({
  ...base,
  operator: { packageId: 32, overridePrice: null, note: null },
  selectedPackageId: '31',
  dimsL: 12, dimsW: 10, dimsH: 3,
});
assert.equal(r14.status, 'resolved');
assert.equal((r14 as { source: string }).source, 'operator');
assert.equal((r14 as { packageId: number | null }).packageId, 32);

// Operator override-price-only resolves a custom box.
const r15 = resolveShippedPackageId({
  ...base,
  operator: { packageId: null, overridePrice: 0.74, note: 'custom 11.5x9x3' },
  dimsL: 11.5, dimsW: 9, dimsH: 3,
});
assert.equal(r15.status, 'resolved');
assert.equal((r15 as { overridePrice: number | null }).overridePrice, 0.74);

// A note-only resolution row is NOT a directive — review still fires.
const r16 = resolveShippedPackageId({
  ...base,
  operator: { packageId: null, overridePrice: null, note: 'looked at it' },
  dimsL: 11.5, dimsW: 9, dimsH: 3,
});
assert.equal(r16.status, 'unresolved');

// ── Generator decision matrix (decidePackageCostLine) ───────────────────────
const resolved31 = r1 as Extract<ShippedBoxResolution, { status: 'resolved' }>;

// Box-billing client + resolved priced package → normal line (markup applies).
const d1 = decidePackageCostLine({ resolution: resolved31, clientHasBoxPricing: true, configuredPrice: 0.55, markupPct: 0 });
assert.deepEqual(d1, { kind: 'line', amount: 0.55, packageId: 31, pkgName: '12x10x3' });
const d2 = decidePackageCostLine({ resolution: resolved31, clientHasBoxPricing: true, configuredPrice: 0.5, markupPct: 10 });
assert.equal(d2.kind, 'line');
assert.ok(Math.abs((d2 as { amount: number }).amount - 0.55) < 1e-9, 'markup applies to configured price');

// Resolved + zero/no configured price → none ("visible zero config = free").
assert.equal(decidePackageCostLine({ resolution: resolved31, clientHasBoxPricing: true, configuredPrice: 0, markupPct: 0 }).kind, 'none');
assert.equal(decidePackageCostLine({ resolution: resolved31, clientHasBoxPricing: true, configuredPrice: undefined, markupPct: 0 }).kind, 'none');

// Operator override price is the FINAL amount — markup must NOT re-apply.
const dOverride = decidePackageCostLine({
  resolution: r15 as Extract<ShippedBoxResolution, { status: 'resolved' }>,
  clientHasBoxPricing: true,
  configuredPrice: undefined,
  markupPct: 25,
});
assert.deepEqual(dOverride, { kind: 'line', amount: 0.74, packageId: null, pkgName: 'operator-resolved' });

// Unresolved/mismatch → $0.00 review line with the generator's description.
const dReview = decidePackageCostLine({ resolution: r6, clientHasBoxPricing: true, configuredPrice: 0.55, markupPct: 0 });
assert.equal(dReview.kind, 'review');
assert.ok((dReview as { description: string }).description.startsWith('Box mismatch'));

// Zero-box-price client → NOTHING, not even review lines.
assert.equal(decidePackageCostLine({ resolution: r6, clientHasBoxPricing: false, configuredPrice: undefined, markupPct: 0 }).kind, 'none');
assert.equal(decidePackageCostLine({ resolution: resolved31, clientHasBoxPricing: false, configuredPrice: 0.55, markupPct: 0 }).kind, 'none');

// Expected current-data behavior table (card): SP6755/6759 12x10x3 → $0.55;
// SP6754/SP6753 → review. Encoded above via d1 / r6 / r5.

// ── Layer 2: source pins ────────────────────────────────────────────────────
const service = read('src/services/billing.ts');
const routes = read('src/routes/billing.ts');
const ordersRoute = read('src/routes/orders.ts');
const schema = read('src/db/schema/billing.ts');
const policy = read('src/services/billing-box-policy.ts');
const feTable = read('web/src/components/Views/BillingDetailTable.tsx');
const feParity = read('web/src/components/Views/billing-parity.ts');
const feView = read('web/src/components/Views/BillingView.tsx');
// PS-368/369: order-row aggregation is backend-owned (billing-detail-row-sot,
// the only aggregator since the dead FE twin was deleted). d9942d62: the Edit
// Billing Detail modal markup moved into BillingEditDetailModal.
const backendRowSot = read('src/services/billing-detail-row-sot.ts');
const feEditModal = read('web/src/components/Views/BillingEditDetailModal.tsx');
const feOrders = read('web/src/components/Views/OrdersView.tsx');
// PS-166 W4f: the side-panel Size row (the lockstepPanelDims dim inputs) moved
// VERBATIM to the presentational OrdersPanelShippingFields component; OrdersView
// still owns the lockstepPanelDims handler and threads it down as a prop.
const feShippingFields = read('web/src/components/Views/OrdersPanelShippingFields.tsx');
const pkgJson = read('package.json');

// Banned fallbacks are GONE from the generator.
assert.ok(!service.includes('packageIdFromItems'), 'SKU-default package billing must stay deleted');
assert.ok(!service.includes('packagesByRoundedDims') && !service.includes('roundedDimsKey'),
  'rounded-dims package matching must stay deleted');
assert.ok(!/from '\.\.\/db\/schema\/inventory'/.test(service),
  'billing generator must not import inventory (SKU/package defaults are fulfillment aids, not billing evidence)');
assert.ok(!service.includes('rateDims'),
  'rate-dims must not participate in billing box resolution');
assert.ok(!service.includes('packageByClientSku') && !service.includes('packageBySku'),
  'SKU→package maps must stay deleted from billing');

// Generator delegates to the canonical policy module.
assert.ok(service.includes("from './billing-box-policy'"),
  'generator must resolve boxes via billing-box-policy');
assert.ok(service.includes('resolveShippedPackageId({') && service.includes('decidePackageCostLine({'),
  'generator must delegate resolution AND emission decision to the policy module');
assert.ok(service.includes("lineType: 'package_cost_missing'") && service.includes("unitCost: '0.00'"),
  'review lines must be explicit $0.00 package_cost_missing rows');

// Persistence: regeneration must never touch billing_box_resolutions.
assert.ok(service.includes('ensureBillingBoxResolutionsSchema'),
  'runtime ensure must exist so API/worker work pre-migration');
assert.ok(!/delete\(billingBoxResolutions\)/.test(service) && !/delete\(billingBoxResolutions\)/.test(routes),
  'NOTHING may delete billing_box_resolutions — operator decisions persist');
assert.ok(/db\.delete\(billingLineItems\)/.test(service),
  'regeneration deletes line items only');

// Schema + migration.
assert.ok(/pgTable\(\s*'billing_box_resolutions'/.test(schema),
  'billing_box_resolutions schema must exist');
assert.ok(schema.includes("unique('billing_box_resolutions_order_unq').on(t.orderId)"),
  'one resolution per order');
assert.ok(existsSync('drizzle/0043_billing_box_resolutions.sql'),
  'migration 0043 must exist');
const migration = read('drizzle/0043_billing_box_resolutions.sql');
assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS billing_box_resolutions') &&
  migration.includes('ENABLE ROW LEVEL SECURITY'),
  'migration must be idempotent + RLS-enabled-no-policy');

// PATCH /details/:orderId writes resolutions + converts review immediately.
assert.ok(routes.includes('billingBoxResolutions') && routes.includes('onConflictDoUpdate'),
  'detail PATCH must upsert the box resolution');
assert.ok(routes.includes("eq(billingLineItems.lineType, 'package_cost_missing')"),
  'resolving must convert the review line');
assert.ok(routes.includes('isAutofillOfConfigured'),
  'modal autofill of the configured price must NOT pin an override');

// billingDetails exposes backend flags (FE renders, never computes policy).
assert.ok(service.includes('packageCostNeedsReview') && service.includes('packageCostReviewReason'),
  'detail DTO must carry the review flag + reason');

// Dims ⇄ box coherence upstream (mutable orders only; package channel only).
assert.ok(ordersRoute.includes('applyBoxDimsCoherence'),
  'order save paths must run box/dims coherence');
const coherenceCalls = ordersRoute.split('await applyBoxDimsCoherence(').length - 1;
assert.equal(coherenceCalls, 3,
  `coherence wired at PATCH /:id + /selected-package-id + /save-dims (found ${coherenceCalls})`);
assert.ok(ordersRoute.includes('BOX_DIMS_MISMATCH'),
  'explicit package+dims conflicts must reject with a structured code');
assert.ok(ordersRoute.includes("from '../services/billing-box-policy'"),
  'order-side coherence must share boxDimsKey with the billing resolver');
// The /selected-pid route is the SHIP ACCOUNT channel — no box coherence.
const selectedPidRoute = ordersRoute.slice(
  ordersRoute.indexOf("'/:id{[0-9]+}/selected-pid'"),
  ordersRoute.indexOf("'/:id{[0-9]+}/selected-package-id'"),
);
assert.ok(selectedPidRoute.length > 0 && !selectedPidRoute.includes('applyBoxDimsCoherence'),
  '/selected-pid (provider-account channel) must not run box coherence');

// FE: chip + modal + aggregation carry + panel lockstep.
assert.ok(feTable.includes('packageCostNeedsReview') && feTable.includes('NEEDS REVIEW'),
  'Box Cost cell must render the amber NEEDS REVIEW chip');
assert.ok(/packageCostNeedsReview[\s\S]{0,800}onOpenBillingEdit\(row\)/.test(feTable),
  'the chip must open the Edit Billing Detail modal (resolve flow)');
assert.ok(backendRowSot.includes('packageCostNeedsReview'),
  'backend order-row aggregation (billing-detail-row-sot) must carry the review flag');
assert.ok(feEditModal.includes('packageCostNeedsReview'),
  'Edit modal (BillingEditDetailModal) must surface the review reason');
assert.ok(feOrders.includes('lockstepPanelDims'),
  'OrdersView must still own + thread the lockstepPanelDims handler');
// PS-166 W4f re-anchor: the three Size inputs (L/W/H) that route through the
// lockstep now live in OrdersPanelShippingFields (presentational, byte-identical
// markup); the handler stays in OrdersView and is passed as a prop, so the
// exactly-matching-package auto-select behavior is unchanged.
const lockstepUses = feShippingFields.split('lockstepPanelDims({ ...current').length - 1;
assert.equal(lockstepUses, 3, `all three Size inputs route through the lockstep (found ${lockstepUses})`);

// npm wiring.
assert.ok(pkgJson.includes('"test:ps-207-shipped-box-billing-policy"'),
  'guard must be wired into package.json');

// The policy module stays OFFLINE-IMPORTABLE (no db/schema/service/env deps), so
// this guard can exercise the full resolution matrix without a database. PS-371
// let it delegate to the single markup-formula owner (markup-resolver), which is
// itself runtime-import-free (only an `import type`), so offline import still holds
// — proven: this guard imports decidePackageCostLine from the policy module above.
// The ONLY permitted import is that pure markup owner; db/schema/service imports
// stay banned.
{
  const importLines = policy.match(/^import\b.*$/gm) ?? [];
  const badImports = importLines.filter(
    (line) => !/from '\.\/shipping-workflow\/markup-resolver'/.test(line),
  );
  assert.ok(badImports.length === 0,
    `billing-box-policy.ts may import ONLY the pure markup owner; found: ${badImports.join(' | ')}`);
  assert.ok(!/from '\.\.\/(db|services|routes)\//.test(policy) && !/schema\//.test(policy),
    'billing-box-policy.ts must not import db/schema/service modules (offline-importable)');
}

console.log('PASS ps-207 shipped-box billing policy guard (resolver matrix + decision matrix + source pins)');
