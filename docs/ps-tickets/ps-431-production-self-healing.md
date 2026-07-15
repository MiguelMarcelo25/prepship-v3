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

The retained ticket evidence proves a crash/restart loop coincided with read-only
database poisoning and stale sync health. It does **not** prove whether the process-level
trigger was OOM, a poisoned PostgreSQL session, or a pg-boss failure because the required
historical Render log event and memory graph were not available in this development run.
The change therefore does not claim a false root cause: readiness already detects
write failure, connection lifetime limits recycle poisoned sessions, the sync watchdog
owns stale-job recovery, and repeated escaped worker failures now force a bounded
supervisor restart. The runbook requires saving the first fatal event and memory graph
the next time the condition occurs.

## Shipped-data override boundary

The user supplied `unlock shipped data` in this conversation. PS-431 changes watchdog
lifecycle metadata and a read-only shipped-data health observer only. No code in
`src/routes/orders.ts`, `src/services/fulfillment-deductions.ts`,
`web/src/components/Views/OrdersView.tsx`, `src/db/schema/orders.ts`, or
`src/db/schema/shipments.ts` was changed. No production order/shipment row was updated or
deleted, and no label, postage, provider notification, or marketplace confirmation was
created.

## Live acceptance still required

Code and offline fixtures are not enough to close PS-431. Keep the Trello card In
Progress until the following evidence is attached:

1. The GitHub workflow is green for at least 24 hours with repository secrets/variables configured.
2. A controlled stale-heartbeat or worker-stop test produces one phone-reachable alert within about 10 minutes and no duplicate inside 30 minutes.
3. A restart-cap fixture produces the distinct cap-exhaustion alert without spam.
4. UptimeRobot or Better Stack monitors `/health/ready`, with SMS/email delivery tested for DJ and Lawrence.
5. Render's health-check path is verified as `/health/ready`, and Render native service notifications are enabled and tested.
6. The next crash-loop incident preserves the first fatal Render log line, exit/restart reason, deploy id, and memory graph so the exact causal trigger can be confirmed.
