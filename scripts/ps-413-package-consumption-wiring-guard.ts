/** PS-413 source-of-truth placement and no-blind-backfill guard. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const owner = readFileSync('src/services/package-consumption.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');
const sync = readFileSync('src/services/shipment-sync.ts', 'utf8');
const packageRoute = readFileSync('src/routes/packages.ts', 'utf8');
const schemaReadiness = readFileSync('src/services/package-consumption-schema.ts', 'utf8');
const resolver = readFileSync('src/services/package-resolution.ts', 'utf8');
const dryRun = readFileSync('scripts/ps-413-package-consumption-backfill-dry-run.ts', 'utf8');

assert(owner.includes('package_ledger_idempotency_key_unq') === false, 'owner must use schema, not inline DDL');
assert(owner.includes('.onConflictDoNothing()'), 'canonical owner must claim idempotency before decrement');
assert(owner.includes('stockQty: sql`${packages.stockQty} - 1`'), 'canonical owner must decrement atomically');
assert(owner.includes("reason: 'ambiguous_dimensions'"), 'ambiguous dimensions must require review');
assert(resolver.includes('const DIMS_TOLERANCE = 0.001') && resolver.includes('.limit(2)'),
  'auto-provision lookup must never use fuzzy first-match selection');
assert(owner.includes('packageConsumptionReviews'), 'unresolved shipments must create durable review work');
assert(owner.includes('reverseOutboundPackageConsumptionInTransaction'), 'voids must reverse package consumption');
assert(labels.includes('consumeOutboundPackageInTransaction({'), 'label paths must call canonical owner');
assert(labels.includes('reverseOutboundPackageConsumptionInTransaction(row.id, now, tx)'), 'label void must reverse in local void transaction');
assert(labels.includes('created.labelId ?? (created.shipmentId || null)'), 'direct labels must retain provider-native identity');
assert(labels.includes("source: directProviderKey ?? 'prepship_v2'"), 'shared Shipp/Walmart/ShipStation label tail must preserve source');
assert(sync.includes('consumeOutboundPackageInTransaction({'), 'ShipStation sync must call canonical owner');
assert(sync.includes('acct.sourceAccountId'), 'ShipStation sync must use stable account identity');
assert(sync.includes('isTest: sourceAccountIsTest'), 'unmatched test-account shipments must not consume stock');
assert(sync.includes('only for NEW ShipStation shipment rows'), 'sync must remain forward-only');
assert(!/stockQty:\s*z\.number/.test(packageRoute), 'generic package payload must not overwrite stock');
assert(packageRoute.includes('stockQty: sql`${packages.stockQty} + ${qty}`'), 'receive must update stock atomically');
assert(packageRoute.includes('stockQty: sql`${packages.stockQty} + ${qtyDelta}`'), 'adjust must update stock atomically');
assert(packageRoute.includes('Package has ledger history and cannot be deleted'), 'ledger history must block package deletion');
assert(schemaReadiness.includes('ensurePackageConsumptionSchema'), 'runtime schema readiness must exist before provider paths');
const readinessIndex = labels.indexOf('await ensurePackageConsumptionSchema();', labels.indexOf('Real ShipStation flow'));
assert(readinessIndex > 0 && readinessIndex < labels.indexOf('createDirectCarrierLabelForOrder({', readinessIndex),
  'schema readiness must run before direct-provider purchase');
assert(readinessIndex < labels.indexOf("createCarrierLabel('shipstation'", readinessIndex),
  'schema readiness must run before ShipStation purchase');
assert(!/db\.(insert|update|delete)|\.insert\(|\.update\(|\.delete\(/.test(dryRun), 'backfill must remain read-only');
assert(!dryRun.includes('--apply'), 'backfill must expose no apply mode');
assert(dryRun.includes('${since.toISOString()}::timestamptz'), 'backfill must bind its date boundary as a PostgreSQL timestamptz');

console.log('PASS PS-413 package consumption wiring guard');
