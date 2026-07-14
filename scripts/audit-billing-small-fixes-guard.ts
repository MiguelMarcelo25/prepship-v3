/**
 * Audit 2026-07-13 item 4.5 / B-9 billing small-fixes guard.
 *
 * Offline only. PGlite exercises the additive billing_ref_rates migration;
 * no configured database, provider, label/postage, or production data access.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { normalizeBillingReferenceRates } from '../src/services/billing-ref-rate-store';
import { resolveBillingInvoiceRowTotal } from '../src/services/billing-invoice-row-total';

const read = (file: string): string => readFileSync(file, 'utf8');

assert.equal(
  resolveBillingInvoiceRowTotal({
    rowTotal: 14.5,
    pickPackFee: 3,
    packageCost: 2,
    shipping: 2,
    storage: 1,
  }),
  14.5,
  'positive backend row_total remains authoritative',
);
assert.equal(
  resolveBillingInvoiceRowTotal({
    rowTotal: 0,
    pickPackFee: 3,
    packageCost: 2,
    shipping: 2,
    storage: 1,
  }),
  8,
  'legacy zero row_total fallback includes billed package cost',
);

const normalized = normalizeBillingReferenceRates([
  {
    weightOz: 16,
    zipTo: ' 90210 ',
    carrier: ' UPS ',
    service: '',
    cost: 8.25,
    source: 'manual-old',
    fetchedAt: new Date('2026-07-13T00:00:00Z'),
  },
  {
    weightOz: 16,
    zipTo: '90210',
    carrier: 'UPS',
    service: null,
    cost: 7.75,
    source: 'manual-new',
    fetchedAt: new Date('2026-07-14T00:00:00Z'),
  },
]);
assert.equal(normalized.length, 1, 'duplicate reference-rate identities collapse before upsert');
assert.deepEqual(
  normalized[0],
  {
    weightOz: 16,
    zipTo: '90210',
    carrier: 'UPS',
    service: null,
    cost: '7.75',
    source: 'manual-new',
    fetchedAt: new Date('2026-07-14T00:00:00Z'),
  },
  'reference-rate normalization is stable and last-write wins',
);

const migration = read('drizzle/0066_billing_ref_rate_identity.sql');
const pg = new PGlite();
await pg.exec(`
  create table billing_ref_rates (
    id serial primary key,
    weight_oz integer,
    zip_to text,
    carrier text,
    service text,
    cost numeric(10, 2),
    source text,
    fetched_at timestamptz not null default now()
  );
  insert into billing_ref_rates
    (weight_oz, zip_to, carrier, service, cost, source, fetched_at)
  values
    (16, '90210', 'UPS', null, 8.25, 'old', '2026-07-13T00:00:00Z'),
    (16, '90210', 'UPS', null, 7.75, 'new', '2026-07-14T00:00:00Z');
`);
for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
  await pg.exec(statement);
}
let rows = await pg.query<{ count: number; cost: string; source: string }>(`
  select count(*)::int as count, max(cost)::text as cost, max(source) as source
  from billing_ref_rates
`);
assert.deepEqual(rows.rows[0], { count: 1, cost: '7.75', source: 'new' },
  'migration keeps the newest duplicate and removes older copies');
await pg.exec(`
  insert into billing_ref_rates
    (weight_oz, zip_to, carrier, service, cost, source, fetched_at)
  values (16, '90210', 'UPS', null, 7.25, 'upsert', '2026-07-14T01:00:00Z')
  on conflict (weight_oz, zip_to, carrier, service) do update set
    cost = excluded.cost,
    source = excluded.source,
    fetched_at = excluded.fetched_at;
`);
rows = await pg.query<{ count: number; cost: string; source: string }>(`
  select count(*)::int as count, max(cost)::text as cost, max(source) as source
  from billing_ref_rates
`);
assert.deepEqual(rows.rows[0], { count: 1, cost: '7.25', source: 'upsert' },
  'NULL-service identity supports conflict update without appending');
await pg.close();

const billingService = read('src/services/billing.ts');
const rateStore = read('src/services/billing-ref-rate-store.ts');
const refFetch = read('src/services/ref-rates-fetch.ts');
const billingRoute = read('src/routes/billing.ts');
const csv = read('src/routes/billing-invoice-csv.ts');
const schema = read('src/db/schema/billing.ts');
const readiness = read('src/services/runtime-schema-readiness.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const guardPack = read('scripts/sot-guard-pack.mjs');
const doc = read('docs/ps-tickets/audit-4.5-billing-small-fixes.md');

assert.match(billingService, /returning\(\{ totalCost: billingLineItems\.totalCost \}\)/,
  'generation counts order and storage rows from RETURNING');
assert.match(billingService, /generated \+= insertedStorageLines\.length/,
  'storage generation count uses returned row count');
assert.doesNotMatch(billingService, /generated \+= 1;\s*total \+= storage\.amount/,
  'storage generation must not count a planned/conflict-skipped row');

assert.match(schema, /unique\('billing_ref_rates_identity_unq'\)[\s\S]*\.nullsNotDistinct\(\)/,
  'schema declares the NULL-safe reference-rate identity');
assert.match(migration, /unique nulls not distinct\s*\(weight_oz, zip_to, carrier, service\)/i,
  'migration creates the matching NULL-safe unique key');
assert.doesNotMatch(migration, /(?:update|delete)\s+(?:orders|shipments)\b/i,
  'migration never mutates protected order or shipment data');
assert.match(rateStore, /onConflictDoUpdate/,
  'reference-rate store performs an upsert');
assert.match(rateStore, /returning\(\{ id: billingRefRates\.id \}\)/,
  'reference-rate store reports rows actually persisted');
assert.match(billingRoute, /upsertBillingReferenceRates\(/,
  'manual reference-rate route delegates to the store');
assert.doesNotMatch(billingRoute, /db\.insert\(billingRefRates\)/,
  'manual route no longer appends reference-rate rows directly');
assert.match(refFetch, /upsertBillingReferenceRates\(/,
  'live reference-rate fetch delegates to the same store');
assert.doesNotMatch(refFetch, /db\.insert\(billingRefRates\)/,
  'live fetch no longer appends reference-rate rows directly');
assert.ok(readiness.includes("'billing_ref_rates_identity_unq'"),
  'runtime readiness requires migration 0066 before workers start');

assert.match(billingRoute, /resolveBillingInvoiceRowTotal\(/,
  'HTML and XLSX invoice paths delegate fallback totals');
assert.match(csv, /resolveBillingInvoiceRowTotal\(/,
  'CSV invoice path delegates fallback totals');
assert.doesNotMatch(`${billingRoute}\n${csv}`, /pickPackFeeAmt \+ shippingAmt \+ storageAmt/,
  'serializers no longer own the package-omitting fallback');

assert.equal(
  packageJson.scripts?.['test:audit-billing-small-fixes'],
  'tsx scripts/audit-billing-small-fixes-guard.ts',
  'package exposes Audit 4.5 guard',
);
assert.ok(guardPack.includes("'test:audit-billing-small-fixes'"),
  'SOT guard pack requires Audit 4.5 guard');
for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}

console.log('PASS Audit 4.5 billing small fixes guard');
