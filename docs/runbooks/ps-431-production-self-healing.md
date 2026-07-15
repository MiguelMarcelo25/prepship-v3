# PS-431 Production Self-Healing Runbook

## Ownership and alert layers

| Layer | Signal | Owner | Expected action |
|---|---|---|---|
| In app | shipment watchdog verdict, restart cap, `alert_only` | Sync owner | inspect canonical `/sync/status`; use recovery only after identifying the stale lane |
| GitHub Actions | Vercel shell, Render `/health`, required `/health/ready`, canonical sync freshness | Platform owner | inspect failed check and workflow state before enabling restart |
| External uptime | public Render `/health/ready` | DJ + Lawrence | acknowledge phone/SMS/email page and open Render |
| Render native | service deploy, crash, health-check failure | Platform owner | preserve logs/metrics, then restart or roll back |

The in-app and GitHub webhook payloads contain lifecycle state, safe reasons,
timestamps, and a manual action only. They must never contain customer data, order or
shipment payloads, label URLs, provider responses, bearer tokens, API keys, deploy hook
URLs, or marketplace credentials.

## Required configuration

### Render API and sync worker

- `SHIPMENT_SYNC_WATCHDOG_ALERT_WEBHOOK_URL`: phone-reachable webhook. If omitted, the app falls back to `WATCHDOG_ALERT_WEBHOOK_URL`.
- `SHIPMENT_SYNC_WATCHDOG_ALERT_COOLDOWN_MS=1800000`: minimum supported state cooldown.
- `WORKER_UNCAUGHT_FAILURE_LIMIT=3`: repeated escaped failures before unhealthy exit.
- `SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS=false` initially. Enable only after notify-only acceptance.
- Confirm each Render service health-check path is exactly `/health/ready` in its dashboard.
- Enable Render native deploy-failed, service-crashed, and health-check notifications for DJ and Lawrence.

### GitHub repository

Secrets:

- `CRON_SECRET`: same value accepted by the Render `/cron/*` endpoints.
- `WATCHDOG_ALERT_WEBHOOK_URL`: same phone-reachable endpoint as the in-app alert.
- Optional recovery: `RENDER_DEPLOY_HOOK_URL` or `RENDER_API_KEY`.

Variables:

- `SYNC_API_URL` (defaults to the production Render API URL).
- `PRODUCTION_VERCEL_SHELL_URL` (defaults to the production Vercel URL).
- Optional `WATCHDOG_SYNC_STATUS_URL`; otherwise the watcher derives the cron status URL.
- `WATCHDOG_ALLOW_RESTARTS=false` until alert-only soak is approved.
- `RENDER_SERVICE_ID` only when Render API recovery is approved.

The `Production Watchdog` workflow runs every five minutes and supports
`workflow_dispatch`. It restores/saves `outputs/production-watchdog-state.json` so
alert and restart cooldowns survive stateless runners.

### External uptime provider

Create a GET monitor for:

`https://prepshipv4-api-l5xc.onrender.com/health/ready`

Use a five-minute interval or faster, require HTTP 200, and deliver SMS/email to both DJ
and Lawrence. Run the provider's test-notification flow and attach its dated delivery
proof to PS-431. Do not place a cron secret in this public monitor; sync freshness stays
on the cron-authenticated GitHub layer.

## Alert response

1. Record alert time, state, failed checks, workflow run URL, Render service/deploy id, and acknowledgement owner.
2. Open Render logs at least five minutes before the first failure. Preserve the **first** fatal event, exit/restart reason, and memory graph before restarting.
3. Check `/health/ready`. A failed `dbWrite` probe indicates a read-only-poisoned database session; a failed `eventLoop` probe indicates process pressure.
4. Check the authenticated application `/sync/status` and compare worker heartbeat, queue state, order watermark, shipment watermark, and watchdog verdict.
5. If the page says `restart_cap_exhausted`, stop automated recovery and use the Render dashboard only after reviewing the causal evidence.
6. Verify recovery with HTTP 200 from `/health/ready`, a fresh worker heartbeat, a successful sync timestamp, and a healthy watchdog verdict.

## Manual recovery levers

### Render dashboard restart

Use when readiness is failing, the worker heartbeat is stale, or a repeatedly unhealthy
process has exhausted automated recovery. Preserve logs first. Restart the specific API
or sync worker service; do not restart unrelated services. Recheck readiness and sync
freshness before closing the incident.

### GitHub sync-cron dispatch/backfill

Open `Sync ShipStation orders + shipments`, choose `workflow_dispatch`, then select
`shipments`, `orders`, or `all`. Keep `since_days=0` for normal watermark recovery. A
bounded backfill window may be used only after reviewing the gap and provider load. This
queues existing canonical jobs; it does not bypass their admission/lock rules.

### Application full sync

Use the authenticated application sync action only when a full historical recovery is
needed. The backend request is `fullResync: true` (or the guarded cron equivalent), and
it can be expensive. Confirm the gap, provider availability, and operator owner before
starting. Never use it as the first response to a transient alert.

## Controlled acceptance drill

Production disruption requires DJ's explicit approval. With approval:

1. Start in notify-only mode and record the current healthy state.
2. Stop only the sync worker or use an approved stale-heartbeat fixture.
3. Confirm in-app or GitHub detection and phone delivery within about 10 minutes.
4. Keep the same failure state for 30 minutes; confirm no second phone alert.
5. Use a fixture state with the hourly restart cap exhausted; confirm one distinct cap alert.
6. Restore the worker and prove readiness, heartbeat, and both sync watermarks recover.
7. Run the external uptime provider's test-notification action separately.

Do not buy labels/postage, notify marketplaces, invoke live provider confirmation, or
update/delete production shipped/cancelled orders or shipment history during this drill.
