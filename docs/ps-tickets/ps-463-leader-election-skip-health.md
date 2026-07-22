# PS-463 — Consumer leadership and skip-health follow-up

## Placement

- **Canonical leadership owner:** `ShipStationConsumerLeadershipController` in
  `src/services/sync-job-queue.ts` owns consumer acquisition, handoff, health,
  connection loss, and release.
- **Canonical readiness owner:** `src/services/worker-job-skip-health.ts` owns
  the fulfillment-outbox liveness verdict. `src/lib/sync-cadence.ts` owns the
  one-minute cadence used to derive its three-cadence health budget.
- **Imperfect-data boundary:** a transaction-pooler URL can break session-lock
  ownership, rapid legitimate lane skips can look persistent by count alone,
  and an old successful snapshot can hide a consumer that is no longer fetched.
- **Callers:** the queue controller uses the validated leadership connection;
  `/health/deep` passes the worker start time and renders the backend verdict.
  No frontend or connector owns this policy.

## Behavior

The optional `SHIPSTATION_CONSUMER_LEADER_DATABASE_URL` selects an explicit
direct/session-mode leadership connection. A supplied Supabase transaction-mode
URL on port 6543 fails closed. For compatibility, an ordinary Supabase
`DATABASE_URL` on port 6543 is converted to the matching sticky session-mode
port 5432 before the single reserved connection is created.

Fulfillment-outbox health is based on elapsed time, not a raw skip count. Three
rapid skips during a healthy shared-lane walk remain healthy. The same skip
state fails only after three full outbox cadences. A succeeded, failed, running,
or never-observed job also fails once its latest run (or worker startup grace)
is older than that budget, making leader-loss silence visible through
`/health/deep`.

## Safety and proof

The change affects queue control-plane telemetry only. Provider execution,
fulfillment-confirmation policy, order/shipment data, labels, postage, billing,
and marketplace payloads are unchanged. All tests use injected timestamps,
connection strings, and fake leadership sessions; no live provider call or
production mutation is permitted.

Focused proof:

- `npm run test:ps-463-leader-skip-health`
- `npm run test:ps-439-session-advisory-locks`
- `npm run test:sync-advisory-lock`
- `npm run test:ps-426-awaiting-cursor-manual-sync`
- `npm run test:ps-431-production-self-healing`
- `npm run test:audit-sync-watchdog-lifecycle`
- `npm run typecheck`
