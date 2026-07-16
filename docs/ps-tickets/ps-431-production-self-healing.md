# PS-431 — Production 24/7 self-healing

## Placement gate

- **Business rule/workflow:** a stale shipment-sync worker must be detected outside the worker, bounded recovery must never loop forever, and cap exhaustion or alert-only escalation must reach an operator without repeated phone spam.
- **Canonical owner:** `src/services/shipment-sync-watchdog.ts` owns shipment-sync health and recovery. `src/services/shipment-sync-watchdog-alert.ts` owns the in-app escalation/cooldown contract. `scripts/production-watchdog.mjs` owns the independent external readiness/freshness decision. `src/services/worker-failure-breaker.ts` owns the escaped-failure exit threshold.
- **Imperfect-data entry points:** stale worker heartbeats, stale provider-sync watermarks, wedged pg-boss jobs, a read-only-poisoned database session, missing monitoring secrets, stateless GitHub runners, and exceptions that escape worker job boundaries.
- **Callers that delegate:** the API timer and cron recovery route delegate to the shipment watchdog; the read-only cron status route delegates to the same status owner; GitHub Actions delegates to the external one-shot watchdog; `worker.ts` delegates thresholding to the worker failure breaker.
- **Duplicated/unsafe owner removed or forbidden:** `/health/deep` cannot substitute for `/health/ready`; the external runner does not reimplement order/shipment age thresholds; the frontend does not infer sync health; the read-only status endpoint cannot enqueue or restart work.
- **Frontend role:** none. This is backend/process/operations control-plane work.
- **Backend boundary proof:** `npm run test:ps-431-production-self-healing`, the existing shipment watchdog guards, production-watchdog guard, source-of-truth pack, typecheck, and build.
- **Workflow proof:** the workflow is scheduled every five minutes, uses the cron-authenticated canonical status endpoint, restores/saves cooldown state, and defaults to alert-only.

## Implementation

The in-app watchdog sends a concise JSON webhook only when recovery resolves to
`alert_only` or a worker restart is skipped because the hourly cap is exhausted.
Cooldown state is stored in the backend `settings` source of truth by
`state + escalation kind`; a successful webhook can fire at most once per 30 minutes
for that state. Failed deliveries are not recorded as sent.

The external watchdog now requires `/health/ready` independently of `/health/deep`
and reads `/cron/shipment-sync-watchdog/status` using the existing cron secret.
It consumes the backend verdict instead of recreating sync thresholds. Its state file
includes failure/restart counters and successful alert timestamps. The GitHub workflow
restores the newest cached state and saves a new immutable cache entry even when the
health step fails.

Repeated escaped worker failures previously logged indefinitely because registering
`uncaughtException` prevents Node's default exit. The bounded failure breaker now exits
unhealthy after `WORKER_UNCAUGHT_FAILURE_LIMIT` escapes (default 3), allowing Render's
supervisor to replace the process once rather than leaving a poisoned worker alive.

## 2026-07-13 incident conclusion

The 2026-07-16 retrospective used retained Render worker logs and deploy history for
2026-07-13 06:00-20:00 UTC. It resolves the ambiguity in the original incident report:

- Render recorded 34 worker replacements: 30 were API-triggered deploys and four were
  manual. None in the inspected window was a platform crash/OOM replacement.
- The worker emitted 69 read-only transaction failures from 07:09:33 through 08:22:13
  UTC across four successive instances. Three were process-level
  `[worker:unhandledRejection]` failures from read-only `SELECT` operations; the rest
  were primarily pg-boss update failures.
- Jobs continued to wedge after replacement: 128 job attempts across 25 instances hit
  the 600-second lane deadline during the inspected window. The query for the worker
  status persistence deadline reached its 500-row evidence cap, spanning 24 instances.
- The same retained log window contains no heap/OOM match. Absence of an OOM log is not
  a substitute for a memory graph, but the deploy trigger history proves that the
  observed replacement loop itself was control-plane API recovery rather than Render's
  process supervisor reacting to OOM.

The root cause of the reported "crash loop" was therefore a **watchdog/API redeploy
loop over unhealthy data-plane lanes**: the read-only database window poisoned pg-boss
and worker operations, 600-second jobs and status writes stayed stuck, the watchdog saw
the replacement worker as stale, and its Render API recovery started another deploy.

The deployed mitigation is intentionally layered. `/health/ready` rejects a non-writable
database; the in-app watchdog caps API restarts and now sends a cooldown-deduplicated
cap/alert-only escalation; repeated escaped worker failures force a bounded supervisor
exit; job deadlines and abort signals bound stuck work; and the PS-426 consumer
leadership controller releases/reacquires the stately ShipStation lanes when its
PostgreSQL leadership session is lost. The runbook still requires preserving the first
fatal event, exit reason, deploy id, and memory graph for any *future platform crash* so
a different trigger is not conflated with this resolved API-redeploy incident.

## Shipped-data override boundary

The user supplied `unlock shipped data` in this conversation. PS-431 changes watchdog
lifecycle metadata and a read-only shipped-data health observer only. No code in
`src/routes/orders.ts`, `src/services/fulfillment-deductions.ts`,
`web/src/components/Views/OrdersView.tsx`, `src/db/schema/orders.ts`, or
`src/db/schema/shipments.ts` was changed. No production order/shipment row was updated or
deleted, and no label, postage, provider notification, or marketplace confirmation was
created.

## Live acceptance still required

Code, offline fixtures, and the retrospective root-cause evidence are not enough to
close PS-431. Keep the Trello card In Progress until the following live evidence is
attached:

1. The GitHub workflow is green for at least 24 hours with repository secrets/variables configured.
2. A controlled stale-heartbeat or worker-stop test produces one phone-reachable alert within about 10 minutes and no duplicate inside 30 minutes.
3. A restart-cap fixture produces the distinct cap-exhaustion alert without spam.
4. UptimeRobot or Better Stack monitors `/health/ready`, with SMS/email delivery tested for DJ and Lawrence.
5. Render's health-check path is verified as `/health/ready`, and Render native service notifications are enabled and tested.

The 2026-07-13 crash-loop/root-cause acceptance item is complete. For any future
platform-triggered crash, preserve the first fatal Render log line, exit/restart reason,
deploy id, and memory graph under the runbook rather than reopening this historical
control-plane conclusion without new evidence.
