/**
 * PS-304 guard — backend package-facts read-model on the OrdersView ROW.
 *
 * Proves (a) the pure row owner buildOrderRowPackageFacts derives the named package
 * fields (state / requiresRerate / staleRateImpact / rerateCopy / immutableReason) across
 * resolved / needs-dims / stale / shipped / cancelled / has-label rows and converges
 * on the PS-301 packageState; (b) the pure precedence policy now carries
 * canSaveComboDefault / canPropagateDefault; (c) the order-list route emits
 * packageFacts ON THE ROW (not only the detail panel).
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no marketplace
 * calls, no Trello mutation, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';
import { buildOrderRowPackageFacts } from '../src/services/shipping-workflow/order-row-package-facts';
import { resolvePackageFactsFromInputs } from '../src/services/package-facts-policy';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

const DIMS = { length: 8, width: 6, height: 6 };

// 1. AWAITING resolved (dims+weight, fresh rate) → state resolved; no rerate; no immutable reason.
const resolved = buildOrderRowPackageFacts({
  orderStatus: 'awaiting_shipment', externallyShipped: false, canonicalStatus: null,
  hasActiveLabel: false, packageState: 'resolved', rateState: 'final', requiresRerate: false,
  weightOz: 16, dims: DIMS, selectedPackageId: '42',
});
check('resolved: state=resolved', resolved.state === 'resolved', resolved.state);
check('resolved: not requiresRerate', resolved.requiresRerate === false, resolved);
check('resolved: no staleRateImpact', resolved.staleRateImpact === false, resolved);
check('resolved: no rerate warning reason/copy', resolved.rerateReason === null && resolved.rerateCopy === null, resolved);
check('resolved: no immutableReason', resolved.immutableReason === null, resolved);
check('resolved: passes through weight/dims/packageId',
  resolved.weightOz === 16 && resolved.dims?.length === 8 && resolved.selectedPackageId === '42', resolved);

// 2. NEEDS DIMS (no dims) → state needs_dims (fallback when no PS-301 packageState).
const noDims = buildOrderRowPackageFacts({
  orderStatus: 'awaiting_shipment', externallyShipped: false, canonicalStatus: null,
  hasActiveLabel: false, weightOz: null, dims: null, selectedPackageId: null,
});
check('needs-dims: state=needs_dims (dims fallback)', noDims.state === 'needs_dims', noDims.state);

// 2b. Convergence: an explicit PS-301 packageState wins over the dims fallback.
const converged = buildOrderRowPackageFacts({
  orderStatus: 'awaiting_shipment', externallyShipped: false, canonicalStatus: null,
  hasActiveLabel: false, packageState: 'needs_dims', weightOz: 16, dims: DIMS, selectedPackageId: null,
});
check('convergence: PS-301 packageState overrides dims fallback', converged.state === 'needs_dims', converged.state);

// 3. STALE rate → staleRateImpact + requiresRerate.
const stale = buildOrderRowPackageFacts({
  orderStatus: 'awaiting_shipment', externallyShipped: false, canonicalStatus: null,
  hasActiveLabel: false, packageState: 'resolved', rateState: 'expired', requiresRerate: true,
  weightOz: 16, dims: DIMS, selectedPackageId: null,
});
check('stale: staleRateImpact=true', stale.staleRateImpact === true, stale);
check('stale: requiresRerate=true', stale.requiresRerate === true, stale);
check('stale: backend-owned expired warning copy',
  stale.rerateReason === 'rate_expired' &&
  stale.rerateCopy === 'Re-rate needed - saved rate expired', stale);

// 4. SHIPPED → immutableReason=shipped; locked (no rerate / no stale impact).
const shipped = buildOrderRowPackageFacts({
  orderStatus: 'shipped', externallyShipped: false, canonicalStatus: null,
  hasActiveLabel: true, packageState: 'resolved', rateState: 'final', requiresRerate: false,
  weightOz: 16, dims: DIMS, selectedPackageId: '7',
});
check('shipped: immutableReason=shipped', shipped.immutableReason === 'shipped', shipped);
check('shipped: not requiresRerate (locked)', shipped.requiresRerate === false, shipped);

// 5. CANCELLED → immutableReason=cancelled; locked.
const cancelled = buildOrderRowPackageFacts({
  orderStatus: 'cancelled', externallyShipped: false, canonicalStatus: 'cancelled',
  hasActiveLabel: false, rateState: 'expired', requiresRerate: true,
  weightOz: 16, dims: DIMS, selectedPackageId: null,
});
check('cancelled: immutableReason=cancelled', cancelled.immutableReason === 'cancelled', cancelled);
check('cancelled: locked (no rerate/stale despite stale rate)',
  cancelled.requiresRerate === false &&
  cancelled.staleRateImpact === false &&
  cancelled.rerateReason === null &&
  cancelled.rerateCopy === null, cancelled);

// 6. HAS LABEL (awaiting with an active label) → immutableReason=has_label.
const hasLabel = buildOrderRowPackageFacts({
  orderStatus: 'awaiting_shipment', externallyShipped: false, canonicalStatus: null,
  hasActiveLabel: true, packageState: 'resolved', rateState: 'final', requiresRerate: false,
  weightOz: 16, dims: DIMS, selectedPackageId: null,
});
check('has-label: immutableReason=has_label', hasLabel.immutableReason === 'has_label', hasLabel);

// 7. POLICY — canSaveComboDefault / canPropagateDefault.
const overrideComplete = resolvePackageFactsFromInputs({
  override: { weightOz: 16, length: 8, width: 6, height: 6, selectedPackageId: '42' },
  comboDefault: null, singleSkuDefault: null, imported: null, comboKey: 'SKU-A:2',
});
check('policy: override+comboKey+complete → source override', overrideComplete.source === 'override', overrideComplete);
check('policy: override → canSaveComboDefault=true', overrideComplete.canSaveComboDefault === true, overrideComplete);
check('policy: override → canPropagateDefault=true', overrideComplete.canPropagateDefault === true, overrideComplete);

const importedOnly = resolvePackageFactsFromInputs({
  override: null, comboDefault: null, singleSkuDefault: null,
  imported: { weightOz: 16, length: 8, width: 6, height: 6 }, comboKey: null,
});
check('policy: imported (no comboKey) → canSaveComboDefault=false',
  importedOnly.canSaveComboDefault === false && importedOnly.canPropagateDefault === false, importedOnly);

const comboDefault = resolvePackageFactsFromInputs({
  override: null, comboDefault: { weightOz: 16, length: 8, width: 6, height: 6 },
  singleSkuDefault: null, imported: null, comboKey: 'SKU-A:2',
});
check('policy: combo_default → canSaveComboDefault=true, canPropagateDefault=false',
  comboDefault.source === 'combo_default' &&
  comboDefault.canSaveComboDefault === true &&
  comboDefault.canPropagateDefault === false, comboDefault);

// 8. WIRING — the order-list route emits packageFacts on the row via the backend owner.
const ordersRoute = read('src/routes/orders.ts');
check('orders route imports buildOrderRowPackageFacts',
  /import \{ buildOrderRowPackageFacts \} from '\.\.\/services\/shipping-workflow\/order-row-package-facts'/.test(ordersRoute));
check('orders route emits packageFacts on the row via the backend owner',
  /packageFacts: buildOrderRowPackageFacts\(\{/.test(ordersRoute));

if (failures > 0) {
  console.error(`\nPS-304 package-facts row owner guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-304 package-facts row owner guard passed.');
