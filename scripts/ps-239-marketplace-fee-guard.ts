/**
 * PS-239 guard (backend slice) — marketplace fee + profit source of truth.
 *
 * Pins the pure fee math, the profit computation, the most-specific-wins rule
 * resolution (incl. the KF-Goods two-store case), the items subtotal, the
 * canViewFinancials redaction, and the settings-key allow + orders wiring.
 *
 *   npx tsx scripts/ps-239-marketplace-fee-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  computeMarketplaceFee,
  buildOrderRowMarketplace,
  type MarketplaceFeeRule,
} from '../src/services/shipping-workflow/rate-money';
import {
  resolveStoredMarketplaceFeeRule,
  resolveMarketplaceFeeRule,
  computeProductSubtotal,
  toComputeRule,
  parseMarketplaceFeeRules,
  type StoredMarketplaceFeeRule,
} from '../src/services/marketplace-fee';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
const approx = (a: number | null, b: number) => a != null && Math.abs(a - b) < 1e-6;

// 1. computeMarketplaceFee — flat + tiered boundary.
check('flat fee = subtotal * percent', approx(computeMarketplaceFee(100, { kind: 'flat', percent: 12 }), 12));
const tiered: MarketplaceFeeRule = { kind: 'tiered', threshold: 15, belowPercent: 8, atOrAbovePercent: 15 };
check('tiered below threshold uses belowPercent', approx(computeMarketplaceFee(10, tiered), 0.8)); // 10 * 8%
check('tiered exactly at $15 uses atOrAbovePercent', approx(computeMarketplaceFee(15, tiered), 2.25)); // 15 * 15%
check('tiered above threshold uses atOrAbovePercent', approx(computeMarketplaceFee(100, tiered), 15));
check('no rule -> null (renders —)', computeMarketplaceFee(100, null) === null);
check('rule + zero subtotal -> 0', approx(computeMarketplaceFee(0, tiered), 0));

// 2. buildOrderRowMarketplace — profit math incl. negative + null-until-rate.
const withRate = buildOrderRowMarketplace({ productSubtotal: 100, marketplaceFeeRule: { kind: 'flat', percent: 12 }, markedAmount: 10 });
check('profit = subtotal - fee - markedRate', approx(withRate?.profit ?? null, 78)); // 100 - 12 - 10
check('fee shown with a subtotal', approx(withRate?.marketplaceFee ?? null, 12));
const noRate = buildOrderRowMarketplace({ productSubtotal: 100, marketplaceFeeRule: { kind: 'flat', percent: 12 }, markedAmount: null });
check('fee shows pre-rating (no marked rate)', approx(noRate?.marketplaceFee ?? null, 12));
check('profit null until a rate exists', noRate?.profit === null);
const negative = buildOrderRowMarketplace({ productSubtotal: 10, marketplaceFeeRule: { kind: 'flat', percent: 12 }, markedAmount: 20 });
check('negative profit is rendered, not clamped', approx(negative?.profit ?? null, -11.2)); // 10 - 1.2 - 20
const noneToShow = buildOrderRowMarketplace({ productSubtotal: null, marketplaceFeeRule: null, markedAmount: null });
check('nothing to show -> null tuple', noneToShow === null);

// 3. Resolution — most-specific-wins, incl. KF-Goods two-store (by storeId).
const kfRules: StoredMarketplaceFeeRule[] = [
  { clientId: 11, kind: 'tiered' },                                   // KF Goods client default
  { storeId: 277422, kind: 'flat', percent: 15 },                    // amazon store
  { storeId: 376827, kind: 'flat', percent: 0 },                     // non-amazon store
];
const amazonStore = resolveStoredMarketplaceFeeRule(kfRules, { clientId: 11, storeId: 277422 });
check('KF amazon store resolves the store rule (not client)', amazonStore?.storeId === 277422 && amazonStore?.percent === 15);
const otherStore = resolveStoredMarketplaceFeeRule(kfRules, { clientId: 11, storeId: 376827 });
check('KF non-amazon store resolves its own store rule', otherStore?.storeId === 376827);
const noStore = resolveStoredMarketplaceFeeRule(kfRules, { clientId: 11, storeId: 999999 });
check('unknown store falls back to the client rule', noStore?.clientId === 11 && noStore?.storeId == null);
check('no matching rule -> null', resolveStoredMarketplaceFeeRule(kfRules, { clientId: 77 }) === null);
check('disabled rule is skipped', resolveStoredMarketplaceFeeRule([{ clientId: 5, kind: 'flat', percent: 9, disabled: true }], { clientId: 5 }) === null);
check('resolveMarketplaceFeeRule returns a compute-ready rule', resolveMarketplaceFeeRule(kfRules, { clientId: 11, storeId: 277422 })?.kind === 'flat');
check('toComputeRule fills tiered defaults', (() => { const r = toComputeRule({ kind: 'tiered' }); return r.kind === 'tiered' && r.threshold === 15 && r.belowPercent === 8 && r.atOrAbovePercent === 15; })());

// 4. computeProductSubtotal — excludes adjustments, == Σ line_total.
check('subtotal sums non-adjustment unitPrice*qty', approx(computeProductSubtotal([
  { sku: 'A', quantity: 2, unitPrice: 5 },
  { sku: 'B', quantity: 1, price: 10 },
]), 20));
check('subtotal excludes adjustment lines', approx(computeProductSubtotal([
  { sku: 'A', quantity: 1, unitPrice: 10 },
  { sku: 'DISCOUNT', quantity: 1, unitPrice: -5, adjustment: true },
]), 10));
check('subtotal prefers explicit line_total', approx(computeProductSubtotal([{ sku: 'A', quantity: 3, unitPrice: 4, line_total: 11 }]), 11));
check('subtotal of non-array -> 0', computeProductSubtotal(undefined) === 0);
check('parseMarketplaceFeeRules reads {rules:[]}', parseMarketplaceFeeRules(JSON.stringify({ version: 1, rules: [{ kind: 'flat', percent: 12 }] })).length === 1);

// 5. Source pins — redaction + wiring.
const dto = readFileSync('src/services/shipping-workflow/best-rate-workflow-dto.ts', 'utf8');
check('marketplace gated by canViewFinancials (redaction)',
  /canViewFinancials\s*\?\s*buildOrderRowMarketplace\(/.test(dto));
check('DTO carries a marketplace field', /marketplace\?: OrderRowMarketplaceDisplay \| null/.test(dto));
const orders = readFileSync('src/routes/orders.ts', 'utf8');
check('orders loads marketplace-fee rules once', orders.includes('loadMarketplaceFeeRules()'));
check('orders computes productSubtotal + resolves the rule per row',
  orders.includes('computeProductSubtotal(r.order.items)') && orders.includes('resolveMarketplaceFeeRule(marketplaceFeeRules'));
const settings = readFileSync('src/routes/settings.ts', 'utf8');
check('settings allows marketplace_fee_rules', settings.includes("'marketplace_fee_rules'"));
const pkg = readFileSync('package.json', 'utf8');
check('package.json exposes test:ps-239-marketplace-fee', /test:ps-239-marketplace-fee/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-239 marketplace-fee guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-239 marketplace-fee guard');
