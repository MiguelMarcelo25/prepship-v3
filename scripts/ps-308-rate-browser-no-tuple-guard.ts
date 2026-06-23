/**
 * PS-308 (FE / Rate Browser) guard — the stacked SHIPP house TUPLE is gone from the Rate Browser row.
 *
 * The PS-308 audit (2026-06-23) found the headline DoD line still violated: RateRowItem.tsx still
 * stacked customer_rate / "Rate Cost" / "Margin" inside a single price cell — the very tuple the card
 * was created to remove ("There is no stacked tuple display in Rate Browser, Awaiting Shipment, or
 * Shipped rows"). The three pre-existing PS-308 guards only cover the Awaiting/Shipped TABLE columns,
 * so the Rate Browser row had zero coverage and the violation stayed green.
 *
 * This guard closes that gap and proves the tuple does not come back:
 *   - the customer comparison rate is still the row's PRIMARY price (houseTuple.customerRate headline);
 *   - the internal DJR Rate Cost is rendered in a delineated, admin-only block (stable data marker);
 *   - the row performs NO money math — the old FE margin recompute (customerRate - drpCost) and the
 *     stacked "Margin $…" line are gone (margin is backend-owned and lives in the table columns).
 *
 * Offline/static only — no network, no DB, no postage.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const src = readFileSync('web/src/components/RateRowItem.tsx', 'utf8');

// POSITIVE — the customer comparison rate is still the primary headline + HOUSE badge retained.
check('RateRowItem renders the customer comparison rate as the primary price',
  /houseTuple\.customerRate\.toFixed\(2\)/.test(src));
check('RateRowItem retains the HOUSE badge', /renderHouseBadge\(\)/.test(src));

// POSITIVE — the internal Rate Cost is a SEPARATED, delineated admin block (not stacked in the price).
check('Internal Rate Cost is rendered in a delineated admin block (data marker + label + drpCost)',
  /data-ps308-internal-cost/.test(src) &&
  /Rate Cost/.test(src) &&
  /houseTuple\.drpCost\.toFixed\(2\)/.test(src));

// NEGATIVE — the old stacked tuple is gone: no FE margin recompute, no stacked "Margin $…" line.
check('No FE margin recompute in the row (customerRate - drpCost removed)',
  !/houseTuple\.customerRate\s*-\s*houseTuple\.drpCost/.test(src));
check('No stacked "Margin $…" tuple line in the price cell',
  !/Margin \$\{/.test(src) && !/>\s*Margin \$/.test(src));

if (failures > 0) {
  console.error(`\nPS-308 Rate Browser no-tuple guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-308 Rate Browser no-tuple guard passed.');
