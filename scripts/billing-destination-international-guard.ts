/**
 * Billing INTERNATIONAL destination badge — source-of-truth boundary guard.
 *
 * The rule ("which destinations are international?") is backend-owned. The frontend
 * renders the badge the backend emits and must never derive it from a country value,
 * because the rule is not `country !== 'US'`: Puerto Rico ships at USPS domestic rates
 * but carries country code 'PR'.
 *
 * Offline/static: no DB, no network, no provider calls.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INTERNATIONAL_BILLING_BADGE,
  classifyDestinationCountry,
} from '../src/services/billing-destination-international';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

// ── the pure rule ────────────────────────────────────────────────────────────
check('a foreign destination is international', () => {
  assert.deepEqual(classifyDestinationCountry('CA'), { countryCode: 'CA', isInternational: true });
  assert.equal(classifyDestinationCountry('GB').isInternational, true);
});

check('US and its USPS-domestic territories are NOT international', () => {
  // PR is the case a naive `country !== 'US'` gets wrong.
  for (const code of ['US', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM', 'FM', 'MH', 'PW']) {
    assert.equal(
      classifyDestinationCountry(code).isInternational,
      false,
      `${code} ships at USPS domestic rates and must not be badged international`,
    );
  }
});

check('a missing or blank country is NOT international (we do not invent the fact)', () => {
  for (const value of [null, undefined, '', '   ', 42, {}]) {
    const result = classifyDestinationCountry(value);
    assert.equal(result.isInternational, false);
    assert.equal(result.countryCode, null);
  }
});

check('provider spellings normalize instead of falsely reading as foreign', () => {
  for (const alias of ['usa', 'USA', 'United States', 'united states of america', ' us ']) {
    assert.equal(classifyDestinationCountry(alias).isInternational, false, alias);
  }
  assert.equal(classifyDestinationCountry('ca').countryCode, 'CA');
  assert.equal(classifyDestinationCountry('ca').isInternational, true);
});

// ── the DTO boundary ─────────────────────────────────────────────────────────
const detailRow = (destinationCountry: unknown) => ({
  lineType: 'pick_pack',
  orderId: 4242,
  orderNumber: '3212',
  clientId: 1,
  qty: 1,
  totalCost: '2.50',
  destinationCountry,
});

check('the DTO badges an international row and carries the normalized code', () => {
  const [row] = toBillingDetailOrderRows([detailRow('CA')]);
  assert.equal(row.destinationIsInternational, true);
  assert.equal(row.destinationCountry, 'CA');
  assert.ok(row.billingBadges.includes(INTERNATIONAL_BILLING_BADGE));
});

check('the DTO leaves a domestic row unbadged', () => {
  const [row] = toBillingDetailOrderRows([detailRow('US')]);
  assert.equal(row.destinationIsInternational, false);
  assert.ok(!row.billingBadges.includes(INTERNATIONAL_BILLING_BADGE));
});

check('the DTO leaves a Puerto Rico row unbadged (USPS domestic)', () => {
  const [row] = toBillingDetailOrderRows([detailRow('PR')]);
  assert.equal(row.destinationIsInternational, false);
  assert.ok(!row.billingBadges.includes(INTERNATIONAL_BILLING_BADGE));
});

check('the DTO leaves an unknown-country row unbadged', () => {
  const [row] = toBillingDetailOrderRows([detailRow(null)]);
  assert.equal(row.destinationIsInternational, false);
  assert.equal(row.destinationCountry, null);
  assert.ok(!row.billingBadges.includes(INTERNATIONAL_BILLING_BADGE));
});

// ── placement: the rule stays in the backend ─────────────────────────────────
const billingService = readFileSync('src/services/billing.ts', 'utf8');
check('the billing detail query projects the raw destination country', () => {
  assert.match(
    billingService,
    /destinationCountry: sql<string \| null>`nullif\(trim\(\$\{orders\.raw\}->'shipTo'->>'country'\), ''\)`/,
    'orders has no country column; it must be read from raw.shipTo',
  );
});

const detailTable = readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8');
check('the frontend renders the backend decision and does not re-derive it', () => {
  assert.match(detailTable, /row\.destinationIsInternational === true/);
  assert.match(detailTable, /data-billing-badge="INTERNATIONAL"/);
  // No country comparison anywhere in the billing table — that rule is backend-owned.
  assert.doesNotMatch(
    detailTable,
    /destinationCountry\s*(?:!==|===|!=|==)\s*['"]/,
    'the frontend must not compare country codes; the backend owns the rule',
  );
});

if (failures > 0) {
  console.error(`\nFAIL billing destination international guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS billing destination international guard');
