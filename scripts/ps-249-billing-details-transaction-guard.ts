/**
 * PS-249 (Card 4, slice 3) — the /billing/details PATCH is cross-tenant scoped AND atomic.
 *
 * A single /details save mutates many rows for one order (per-line update/insert loop, packageId
 * stamp, box-resolution upsert, missing-line cleanup). Two invariants:
 *   1. the base lookup is gated by billingClientScopePredicate(scope) -> 404 out-of-scope (no
 *      cross-tenant billing edit);
 *   2. all the mutations run inside ONE db.transaction (on `tx`), so a mid-save failure can't leave
 *      the order's billing torn. The idempotent schema ensure is hoisted ABOVE the txn (DDL stays
 *      out of the money transaction). Edits billing_line_items only (never shipments) — not lockdown.
 *
 *   npx tsx scripts/ps-249-billing-details-transaction-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const billing = readFileSync('src/routes/billing.ts', 'utf8');
const start = billing.indexOf("app.patch('/details/:orderId");
const endRel = billing.indexOf('\napp.', start + 1);
const handlerRaw = start >= 0 ? billing.slice(start, endRel > start ? endRel : start + 8000) : '';
// Drizzle's fluent style splits `await tx\n  .update(...)` across lines, so flatten ALL whitespace
// before matching — this makes `tx.update(billingLineItems)` (and the db.* negatives) contiguous.
const flat = handlerRaw.replace(/\s+/g, '');

check('/details PATCH handler found', start >= 0);
check('base lookup is cross-tenant scope-gated (404 out-of-scope)',
  /billingClientScopePredicate\(scope\)/.test(flat));
check('the multi-row edit runs inside ONE db.transaction', /db\.transaction\(async\(tx\)=>/.test(flat));
check('the idempotent schema ensure is hoisted ABOVE the transaction (DDL out of the money txn)',
  flat.indexOf('ensureBillingBoxResolutionsSchema()') >= 0 &&
    flat.indexOf('ensureBillingBoxResolutionsSchema()') < flat.indexOf('db.transaction'));
check('the billing-line writes run on tx (atomic)',
  /tx\.update\(billingLineItems\)/.test(flat) &&
    /tx\.insert\(billingLineItems\)/.test(flat) &&
    /tx\.delete\(billingLineItems\)/.test(flat) &&
    /tx\.insert\(billingBoxResolutions\)/.test(flat));
check('NO billing-line write escapes the transaction (no bare db.update/insert/delete on billing tables)',
  !/db\.update\(billingLineItems\)/.test(flat) &&
    !/db\.insert\(billingLineItems\)/.test(flat) &&
    !/db\.delete\(billingLineItems\)/.test(flat) &&
    !/db\.insert\(billingBoxResolutions\)/.test(flat));
check('the edit still touches billing_line_items only, never shipments (source of truth preserved)',
  !/\.update\(shipments\)/.test(flat) && !/\.insert\(shipments\)/.test(flat));

check('package.json wires test:ps-249-billing-details-transaction',
  /test:ps-249-billing-details-transaction/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-249 billing-details transaction guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-249 billing-details transaction guard');
