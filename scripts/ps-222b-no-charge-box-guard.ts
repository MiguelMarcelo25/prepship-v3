/**
 * PS-222b guard — no-charge/factory box shows an explicit $0.00 line.
 *
 * decidePackageCostLine used to SUPPRESS any package_cost line whose effective
 * price was <= 0, so a $0 box showed nothing. PS-222b makes a box flagged
 * packages.source = NO_CHARGE_BOX_SOURCE ('factory') emit an EXPLICIT $0.00 line
 * — but ONLY that flagged box, so ordinary $0/unpriced boxes are unchanged (no
 * surprise on the ~839 currently-suppressed price rows). A real positive price or
 * override still bills normally. This guard exercises the whole matrix offline.
 *
 *   npx tsx scripts/ps-222b-no-charge-box-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  decidePackageCostLine,
  NO_CHARGE_BOX_SOURCE,
  type BoxPackage,
  type ShippedBoxResolution,
} from '../src/services/billing-box-policy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

function pkg(source: string): BoxPackage {
  return { id: 1, name: 'Box', packageCode: null, length: 1, width: 1, height: 1, source };
}
function resolved(p: BoxPackage, overridePrice: number | null = null): ShippedBoxResolution {
  return { status: 'resolved', source: 'dims', packageId: p.id, pkg: p, overridePrice, note: null };
}

// 1. Factory box, no positive price → explicit $0.00 line (the feature).
const factoryFree = decidePackageCostLine({
  resolution: resolved(pkg(NO_CHARGE_BOX_SOURCE)), clientHasBoxPricing: true, configuredPrice: null, markupPct: 0,
});
check('factory box with no price → explicit $0.00 line',
  factoryFree.kind === 'line' && factoryFree.amount === 0);

// 2. Factory box explicitly priced 0 → still an explicit $0.00 line.
const factoryZero = decidePackageCostLine({
  resolution: resolved(pkg(NO_CHARGE_BOX_SOURCE)), clientHasBoxPricing: true, configuredPrice: 0, markupPct: 0,
});
check('factory box priced $0 → explicit $0.00 line', factoryZero.kind === 'line' && factoryZero.amount === 0);

// 3. NON-factory box priced $0 → STILL suppressed (no 839-row surprise).
const normalZero = decidePackageCostLine({
  resolution: resolved(pkg('custom')), clientHasBoxPricing: true, configuredPrice: 0, markupPct: 0,
});
check('non-factory $0 box → still suppressed (kind:none)', normalZero.kind === 'none');

// 4. NON-factory box with no price → suppressed (unchanged).
const normalNull = decidePackageCostLine({
  resolution: resolved(pkg('custom')), clientHasBoxPricing: true, configuredPrice: null, markupPct: 0,
});
check('non-factory unpriced box → still suppressed', normalNull.kind === 'none');

// 5. Factory box with a real positive price → bills the price (no-charge only at <=0).
const factoryPriced = decidePackageCostLine({
  resolution: resolved(pkg(NO_CHARGE_BOX_SOURCE)), clientHasBoxPricing: true, configuredPrice: 5, markupPct: 0,
});
check('factory box with positive price → bills the price (never lowers a charge)',
  factoryPriced.kind === 'line' && factoryPriced.amount === 5);

// 6. Normal box positive price + markup → bills price × (1+markup).
const normalPriced = decidePackageCostLine({
  resolution: resolved(pkg('custom')), clientHasBoxPricing: true, configuredPrice: 10, markupPct: 20,
});
check('normal box bills price × (1+markup)', normalPriced.kind === 'line' && normalPriced.amount === 12);

// 7. Factory box but client has NO box pricing → none (scoped to box-billing clients).
const factoryNoClientPricing = decidePackageCostLine({
  resolution: resolved(pkg(NO_CHARGE_BOX_SOURCE)), clientHasBoxPricing: false, configuredPrice: null, markupPct: 0,
});
check('factory box but client has no box pricing → none', factoryNoClientPricing.kind === 'none');

// 8. Operator override wins (even on a factory box).
const factoryOverride = decidePackageCostLine({
  resolution: resolved(pkg(NO_CHARGE_BOX_SOURCE), 2), clientHasBoxPricing: true, configuredPrice: null, markupPct: 0,
});
check('operator override on a factory box bills the override', factoryOverride.kind === 'line' && factoryOverride.amount === 2);

// ── Static contract ─────────────────────────────────────────────────────────
const policy = read('src/services/billing-box-policy.ts');
check('BoxPackage carries source', /source\?:\s*string \| null/.test(policy));
check('NO_CHARGE_BOX_SOURCE marker exported', /export const NO_CHARGE_BOX_SOURCE = 'factory'/.test(policy));
const billing = read('src/services/billing.ts');
check('billing.ts selects packages.source into BoxPackage', /source:\s*packages\.source/.test(billing));

if (failures > 0) {
  console.error(`\nFAIL PS-222b no-charge box guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-222b no-charge box guard');
