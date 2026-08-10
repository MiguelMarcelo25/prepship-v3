// PS-497 — the invariant that silently broke.
//
// Automatic inventory deduction stopped on 2026-07-16 and ran for 22 days unnoticed. The
// mechanism was not a crash: claims were written to `fulfillment_line_claims` with
// `status='review'`, and NOTHING reads that status as work. `fulfillment-deductions.ts`
// selects `status='pending'` only. A row written to a state no consumer reads is a leak, and
// a leak nobody reports is invisible by construction.
//
// `scripts/ps-318-shipping-workflow-certification-guard.ts` asserted `deductInventoryForOrder`
// was still PRESENT in labels.ts, and it passed throughout the outage. The symbol survived
// while the behaviour died — which is exactly why this guard asserts REPORTING and STATE
// TRANSITIONS rather than the existence of a function name.
//
// What this guard does NOT do, deliberately: it does not assert the backlog is zero, and it
// does not make a non-empty backlog fail anything. Draining those 2,731 claims means either
// deducting 22+ days of stock at once — against a table where an operator already applied a
// manual `+1000` reconciliation on 2026-07-22 — or closing them and losing the record. Both
// are DJ's call, and both need the `unlock shipped data` override because
// `src/services/fulfillment-deductions.ts` is a locked surface. This guard makes the
// condition VISIBLE so the decision can be made deliberately, and makes it impossible to
// remove that visibility silently.

import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const health = read('src/routes/health.ts');
const healthCode = stripComments(health);
const deductions = read('src/services/fulfillment-deductions.ts');
const deductionsCode = stripComments(deductions);

// ── the backlog is reported ───────────────────────────────────────────────────
//
// What the QUERY RETURNS is proven behaviourally, not here. The first version of this guard
// asserted the SQL's source shape — `status = 'review'`, the table name, the three field
// names — and Hermes defeated all of it by appending `and false` to the predicate: permanent
// zero backlog, ten green assertions. Reading SQL cannot tell you what SQL returns.
//
// scripts/ps-497-inventory-claim-review-integration.ts now executes the real query against a
// seeded PGlite database and asserts the numbers. These assertions cover only what execution
// cannot: that the probe is wired in, and that it can never gate readiness.
check('the deep probe reports the inventory claim review backlog',
  /checkComponent\('inventoryClaimReview'/.test(healthCode));
check('the probe delegates to the extracted, executable reader',
  /readInventoryClaimReviewHealth\(/.test(healthCode));
check('the component is wired into the deep readiness component list',
  /inventoryClaimReview,/.test(healthCode));

// The behavioural test is load-bearing now, so it must not be quietly dropped or unregistered.
{
  const integration = read('scripts/ps-497-inventory-claim-review-integration.ts');
  check('a behavioural integration test exists and executes the real reader',
    /readInventoryClaimReviewHealth/.test(integration) && /PGlite/.test(integration));
  check('it asserts returned COUNTS, which is what `and false` would break',
    /reviewCount, 7/.test(integration));
  const pkg = read('package.json');
  check('the behavioural test is registered as an npm script',
    /test:ps-497-inventory-claim-review-integration/.test(pkg));
  const pack = read('scripts/sot-guard-pack.mjs');
  check('and runs inside the guard pack, so it gates every deploy',
    /test:ps-497-inventory-claim-review-integration/.test(pack));
}

// ── and it must never gate readiness ─────────────────────────────────────────
// /deep answers 503 when any component fails, and Render restarts the service on that
// signal. Failing this component on a non-zero backlog would restart production in a loop
// over a data condition. This assertion exists so a later "improvement" cannot quietly turn
// a diagnostic into an outage.
{
  const probe = healthCode.slice(
    healthCode.indexOf("checkComponent('inventoryClaimReview'"),
    healthCode.indexOf('checkSyncFreshness()') > 0
      ? healthCode.indexOf('const syncFreshness')
      : healthCode.length,
  );
  check('the review probe never throws on a non-empty backlog — it reports, it does not gate',
    probe.length > 0 && !/throw\s/.test(probe), probe.length);
}

// ── the leak itself is still pinned ──────────────────────────────────────────
check('the deduction worker still consumes the pending state',
  /eq\(fulfillmentLineClaims\.status, 'pending'\)/.test(deductionsCode));
check('review is still a state this file can WRITE',
  /status: 'review'/.test(deductionsCode));
// The point of the card. If someone later adds a consumer that applies review claims, this
// assertion fires and forces the change to be justified — because doing so silently is a
// 22-day inventory replay, not a bug fix.
check('nothing in the deduction worker SELECTS review as work (a drain is a DJ decision, not a refactor)',
  !/eq\(fulfillmentLineClaims\.status, 'review'\)/.test(deductionsCode)
  && !/status,\s*'review'\s*\)\s*\)?\s*$/m.test(deductionsCode.split('\n').filter((l) => /select|where/i.test(l)).join('\n')));

if (failures > 0) {
  console.error(`\nPS-497 inventory claim review visibility guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPASS PS-497 inventory claim review visibility guard');
console.log('Read-only: source assertions only. No database access, no inventory mutation.');
