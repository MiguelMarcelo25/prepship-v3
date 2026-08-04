#!/usr/bin/env node
/**
 * Mandatory SOT/backend-truth/no-wrapper guard pack.
 *
 * PS-335: this is CI/Hermes review wiring only. The commands below are
 * offline/static guards and must stay free of provider calls, DB writes, label
 * creation, marketplace notifications, and shipped/cancelled mutations.
 */
import { spawnSync } from 'node:child_process';

const REQUIRED_GUARDS = [
  'test:ps-464-architecture-boundaries',
  'test:ps-305-authority-drift',
  'test:rate-source-of-truth',
  'test:ps-466-automation-controls',
  // PS-465 hazmat. These existed and passed but nothing ran them -- not this
  // pack, not test:master:shipping -- so the whole dangerous-goods compliance
  // surface could rot undetected during an unrelated refactor, which is exactly
  // how non-cert guards have been lost before. They are hermetic: the migration
  // integration guard uses PGlite in-process, the rest read files and modules,
  // and all three were verified under this runner's OFFLINE_GUARD_ENV (which
  // forces an unreachable DATABASE_URL) before being added here.
  'test:ps-465-hazmat',
  'test:mock-hazmat-label',
  'test:ps-465-466-migration-rollout',
  // PS-462 canonical inventory ledger. Same story as the hazmat block above, and
  // the third time this pattern has cost a review: eleven proofs existed and
  // passed -- including three migrated-database integrations -- and nothing ran
  // any of them, so the ledger cutover that removed every competing quantity
  // column could rot undetected. Inventory balances feed Billing and the Client
  // Portal, so a silent regression here is a money-path regression.
  // Hermetic: verified green under this runner's OFFLINE_GUARD_ENV before being
  // added, the integrations use PGlite in-process, and the rest read files and
  // modules. Aggregate entry on purpose -- it also carries PS-439's inventory
  // source-of-truth guard and concurrency integration, which had the same gap.
  'test:ps-462-inventory-sot',
  // PS-442 sync lane fairness, watermarks and durable state. Fourth instance of
  // the same pattern in one day: the guard existed, passed, and ran nowhere --
  // and both PS-442 commits shipped with [skip ci], so it had never run in CI
  // either. It pins the busy-defer job set, the inventory product cursor keys,
  // the per-account watermark triples and the Walmart token abort, i.e. exactly
  // the starvation and freeze behaviour that is invisible until a lane stalls in
  // production. Hermetic: verified green under OFFLINE_GUARD_ENV before adding.
  'test:ps-442-sync-fairness',
  // PS-467/468 shipment attribution. Both tickets require this in the pack, for
  // the reason the tickets exist: a shipment that could not be attributed used
  // to be persisted with a bare NULL order_id and no signal, which is how a
  // dangerous-goods label became invisible to every order-scoped query. Six of
  // its twenty checks are CONSUMPTION pins -- an owner nothing calls is not a
  // fix, and shipment-sync losing those call sites must fail here.
  'test:ps-467-468-shipment-scope',
  // PS-467 audit: WHY each unattributed shipment is unattributed, derived not stored.
  // The card called 796 of them "recoverable" -- a dry-run proved the order_id is
  // recoverable in every case and correct in none, because those orders already have
  // the shipment. Pinned here because the precedence rule is what stops that mistake
  // recurring: sibling evidence must outrank the order number, or a duplicate reads as
  // a lost link and someone backfills 790 duplicate rows onto shipped orders.
  'test:ps-467-unattributed-audit',
  // PS-469: same facts => one run. The idempotency key used to include the
  // trigger's sourceEventId, which carries txid_current(), so every write minted
  // a new key and identical facts were re-evaluated forever -- 322,962 runs over
  // 294 orders in four days. Pinned here because the regression is silent: it
  // breaks nothing, it just burns the database.
  'test:ps-469-automation-idempotency',
  // PS-469 retention: the same table, bounded. The loop put 926 MB here in a week and
  // the fix stopped the growth, but nothing stopped the SIZE. Pinned for the half that
  // is easy to get wrong: automation_runs is the evidence ruleExecutionHistoryExists
  // reads, so pruning a row with matched_rule_version_ids would make a rule that really
  // ran silently deletable, audit trail and all. Those rows survive at any age.
  'test:ps-469-run-retention',
  // The three below were each found RED on a clean base on 2026-08-01, having
  // rotted unnoticed precisely because they were not in this pack. In every case
  // the protection was intact and only the source-text assertion had gone stale
  // (a literal moved into a helper, a condition wrapped onto a second line, a
  // helper renamed with -> try). A guard nobody runs is not a guard, so they are
  // pinned here now. Each was mutation-tested when repaired: break the thing it
  // protects and it goes red.
  // PS-431: worker_status_events is the telemetry that would have explained the
  // 2026-07-13 crash loop and could not, because its flag defaults off. Before that
  // flag can safely be flipped the log has to be bounded -- its emission rate is a
  // fixed 30s heartbeat, so it grows at a constant rate whether or not anything is
  // happening. Pinned here so the retention window cannot quietly become unbounded
  // and repeat what PS-469 hit at 925 MB.
  'test:ps-431-worker-status-event-retention',
  // PS-485: leadership acquisition is the gate on ALL THREE stately consumers
  // (orders, shipments, fulfillment-outbox). Failing to acquire used to retry
  // silently forever -- 29 minutes with no consumer, 40 minutes of dead order sync,
  // and a watchdog that queued recovery into the unconsumed queue and called it done.
  // Pinned for BOTH directions: a sustained failure must escalate to a restart, and
  // a brief one must NOT -- restarting during a normal deploy handoff would be worse
  // than the bug, since losing to the outgoing leader is exactly how handoff works.
  'test:ps-485-consumer-leadership-acquire',
  'test:ps-205-package-facts-precedence',
  'test:ps-361-shipment-sync-watchdog',
  'test:ps-409-status-catchup-backlog',
  // PS-470: an unsaved edit must never publish. publish() posts only the
  // simulation hash, so the backend ships the SAVED draft -- an operator
  // changed an action, published three times, and got three byte-identical
  // no-op versions, each reported as success.
  'test:ps-470-publish-gate-dirty',
  // PS-471: a periodic tick must never BLOCK on its advisory lock. One stranded
  // transaction held shipment_sync.watchdog.tick for 88 minutes; because the
  // watchdog blocked, every later tick queued behind it and pinned a Supavisor
  // connection, until no request could reach the database -- a ~90-minute
  // outage while Postgres itself sat idle. Pinned here because the guard cuts
  // BOTH ways: the periodic caller must skip, and the read-modify-write callers
  // (combo defaults, account-state, billing storage) must keep blocking, since
  // converting those the same way would silently drop writes.
  'test:ps-471-advisory-lock-safety',
  // PS-472: a blocked order must say WHY. A hazmat rule matched HU-10 HUGRAB
  // orders, the declaration write was refused by a capability flag, one failed
  // action failed the whole run, and a failed run blocks rating -- surfacing to
  // the operator as nothing but "Rate unavailable". 11 orders sat frozen for two
  // days while the cause sat in automation_action_results.reason the whole time.
  // Pinned here because half these checks are FAIL-CLOSED pins: DJ chose "hold
  // with a visible reason" over "skip and ship", so a later refactor must not
  // quietly turn an unrecordable hazmat declaration into a shippable order.
  'test:ps-472-automation-failure-visibility',
  // PS-473: the same lesson as PS-472, one layer down at the provider boundary.
  // A hazmat order was filtered to its one certified carrier and Stamps.com
  // returned a hard, non-retryable refusal -- which surfaced only as our own
  // fallthrough string "Carrier rate request failed", so "USPS declines
  // dangerous goods" and "our payload has a bad field" looked identical.
  // providerDetail carries the provider's real words. Pinned here for BOTH
  // halves: the detail must survive the field-by-field cache read-back, and
  // credentials must never ride along with it.
  'test:ps-473-provider-error-detail',
  // PS-474: an active hazmat declaration must not lose the ship-from phone.
  // Hazmat switches the request from /v2/rates/estimate (postal codes, no
  // addresses) to a full /v2/rates shipment -- so ship_from.phone is suddenly
  // required, and a Rate-Browser-supplied origin bypassed getDefaultShipFrom's
  // phone default. ShipStation answered 'phone should not be empty' and three
  // auto-declared HU-10 orders could not rate. Pinned because the guard covers
  // BOTH origin resolutions: the bug was one of them being un-normalised.
  'test:ps-474-hazmat-shipfrom-phone',
  // PS-475: the dangerous-goods mark follows the rules BOTH ways. Unticking
  // never worked -- no rule means no intent means no handler -- so orders kept
  // a HAZMAT badge with every rule paused. Pinned here because half the guard
  // is REFUSALS: a retraction must never touch a shipped order, never erase a
  // human's manual tick, never fire on unknown state, and hazmat.retract must
  // stay available:false so no rule can be authored to un-declare hazmat.
  'test:ps-475-hazmat-retraction',
  // PS-476: a rule status change must WAKE the orders it affects. PS-475 knew
  // how to retract but never ran -- pausing a rule enqueued nothing, and since
  // PS-469 killed the ambient re-evaluation loop, nothing else wakes an order.
  // Pinned for the two choices that silently break it: convergence must use
  // plain fact events (a paused rule can never be reprocessed) and must NOT use
  // the manual_reprocess trigger (which lets the add handler overwrite a human's
  // manual declaration), plus the cap that keeps PS-469 from recurring.
  'test:ps-476-rule-status-convergence',
  // PS-477: a shipment PrepShip did not purchase still discloses its hazmat.
  // Absence of a snapshot must never read as "not dangerous goods" -- the queue
  // omitted the fields entirely and the detail panel rendered clearDeclaration(),
  // so five shipped HUGRAB orders displayed as clear. Both entries are hermetic:
  // the first calls the pure reducer and reads source text, the second runs the
  // real loaders AND the real listQueue against in-process PGlite, overwriting
  // DATABASE_URL before the modules load so this runner's OFFLINE_GUARD_ENV
  // singleton is unreachable. Pinned as a pair because they fail in different
  // directions -- the reducer guard cannot see a caller that stops asking it,
  // and the integration guard is the only thing that runs the DTO builder the
  // bug actually lived in.
  'test:ps-477-hazmat-disclosure',
  'test:ps-477-hazmat-disclosure-integration',
  'test:ps-421-method-capability-matrix',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:ps-336-task-sot-gates',
  'test:ps-426-awaiting-cursor-manual-sync',
  'test:ps-427-inventory-reconciliation',
  'test:ps-428-durable-worker-execution',
  'test:ps-429-final-review-closure',
  'test:ps-430-print-queue-worker-health',
  'test:ps-431-production-self-healing',
  'test:ps-432-sync-fulfillment-resilience',
  'test:ps-433-frontend-source-of-truth',
  'test:ps-441-sot-migration',
  'test:ps-436-sync-starvation',
  'test:ps-439-session-advisory-locks',
  'test:ps-450-inventory-outbox',
  'test:sync-continuous-self-healing',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-329-orders-wrapper-sot-cleanup',
  'test:ps-412-finalized-billing',
  'test:ps-449-billing-finalization',
  'test:audit-money-rounding',
  'test:audit-orders-service-boundary',
  'test:audit-pg-boss-inventory-outbox',
  'test:sync-job-admission',
  'test:audit-runtime-schema-readiness',
  'test:ps-455-runtime-schema-migration',
  'test:audit-imported-handler-boundary',
  'test:audit-print-queue-merge-durability',
  'test:audit-structured-money-logging',
  'test:audit-orders-bulk-snapshot',
  'test:audit-order-editable-write',
  'test:ps-451-order-editable-write',
  'test:audit-print-queue-lifecycle',
  'test:ps-452-print-queue-lifecycle',
  'test:audit-sync-watchdog-lifecycle',
  'test:audit-billing-cross-period-reconciliation',
  'test:audit-dead-code-cleanup',
  'test:audit-limiter-fingerprint-hygiene',
  'test:audit-sync-cursor-webhook-hygiene',
  'test:audit-frontend-cache-bundle-hygiene',
  'test:ps-458-query-cache-unification',
  'test:audit-billing-small-fixes',
  'test:audit-api-process-lifecycle',
  'test:audit-print-queue-small-fixes',
  'test:audit-backfill-diagnostics',
  'test:audit-rate-on-ingest',
  'test:audit-local-tariff-calibration',
  'test:audit-multi-instance-readiness',
  'test:audit-orders-raw-payload-policy',
  'test:audit-billing-close-workflow-ux',
  'test:audit-po-box-eligibility',
  'test:audit-table-virtualization',
];

const npmCli = process.env.npm_execpath;
const results = [];
// Enforce the pack's offline contract even when a developer shell has live DB credentials.
const OFFLINE_GUARD_ENV = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://sot_guard:offline@127.0.0.1:1/sot_guard',
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'offline',
  SUPABASE_SERVICE_ROLE_KEY: 'offline',
  SUPABASE_JWT_SECRET: 'offline',
};

for (const command of REQUIRED_GUARDS) {
  const startedAt = Date.now();
  console.log(`\n[sot-guard-pack] npm run ${command}`);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, 'run', command], {
        stdio: 'inherit',
        shell: false,
        env: OFFLINE_GUARD_ENV,
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: OFFLINE_GUARD_ENV,
      });
  const durationMs = Date.now() - startedAt;
  results.push({
    command,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    durationMs,
  });
  if (result.status !== 0) {
    console.table(results);
    console.error(`[sot-guard-pack] failed at ${command}`);
    process.exit(1);
  }
}

console.table(results);
console.log('[sot-guard-pack] passed');
