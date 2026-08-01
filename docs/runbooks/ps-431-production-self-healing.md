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

The `Production Watchdog` workflow runs **hourly** (it was `*/5` until 2026-07-29 — see
"Why this workflow is hourly and must stay that way" below) and supports
`workflow_dispatch`. It restores/saves `outputs/production-watchdog-state.json` so
alert and restart cooldowns survive stateless runners.

### External uptime provider

Already stood up on 2026-07-29 (see the operator section below) — this is the spec it
must satisfy, not an instruction to create a second one. Monitor is a GET on:

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

## Operator setup steps (DJ / Lawrence — not automatable from the repo)

These are the two PS-431 deliverables that live in third-party dashboards. Everything
else in this runbook is already wired in code. Tick these off and note the date and
owner in the table at the end.

### 1. External uptime monitor (deliverable 3) — ALREADY STOOD UP 2026-07-29

Per the comment in `.github/workflows/production-watchdog.yml` and the PS-431 guard, DJ
stood up an external uptime monitor on `/health/ready` on 2026-07-29. It is the reason
this workflow could drop from `*/5` to hourly. **Do not create a second one** — use the
list below to VERIFY the existing monitor's settings rather than to build a new one.

The point is a check that still fires when Render itself is down, so it must not run on
Render.

1. Confirm the existing monitor (UptimeRobot / Better Stack) is still enabled.
2. Confirm it is an **HTTP(s)** monitor with:
   - URL: `https://prepshipv4-api-l5xc.onrender.com/health/ready`
   - Interval: 5 minutes (1 minute if the paid tier allows)
   - Timeout: 30 seconds
   - **Expected status: 200.** `/health/ready` returns 503 when the DB is unreachable or
     not writable, which is exactly the condition worth paging on.
3. Alert contacts: add DJ's mobile number for SMS **and** an email address. SMS matters —
   a push notification on a silenced phone is not an alert at 3 AM.
4. Set "notify when down after" to 2 consecutive failures. One failed poll during a
   deploy is normal; two in a row is not.
5. Verify it works before trusting it: use the provider's **Test notification** action,
   confirm the SMS arrives, and record the date.

Do NOT point the monitor at `/health/deep`. That endpoint reports degraded subsystems and
is intentionally noisier; `/health/ready` is the "is the service actually usable" signal.

### 2. Render dashboard configuration (deliverable 4)

The read-only-session restart lever only works if Render actually polls the endpoint.

1. Render dashboard, service `prepshipv4-api`, **Settings**.
2. Set **Health Check Path** to `/health/ready`. If it is blank, Render never restarts an
   unhealthy-but-running process, and the poisoned-session recovery from Audit 1.9/2.9
   cannot fire.
3. **Notifications**: enable email on deploy failure and on service failure, to an address
   that reaches a phone.
4. Confirm the sync worker service auto-restarts on crash (default, but verify it was not
   disabled). A platform restart is free and uncapped; the watchdog's Render-API deploy
   path is capped at 2/hour, so the platform restart is the cheaper recovery.

### Verification record

| Item | Done | Date | Owner | Verified how |
|---|---|---|---|---|
| Uptime monitor created | ☑ | 2026-07-29 | DJ | recorded in the workflow comment + PS-431 guard |
| SMS contact confirmed | ☐ | | | test SMS received on phone |
| Render health check path | ☐ | | | value reads `/health/ready` |
| Render failure emails | ☐ | | | test or real deploy failure |

### Why this workflow is hourly and must stay that way

PS-431's card text asks for a 5-minute external watchdog. That was tried and reverted on
2026-07-29 because it was actively harmful: at `*/5` this workflow plus `sync-cron`
consumed essentially the whole GitHub Actions spending limit, which blocked the CI-gated
deploy — a health CHECK preventing health FIXES from shipping. Hourly is ~720 runs/month
instead of ~8,640.

Fast detection is not lost: the external uptime monitor polls `/health/ready` every 1–5
minutes from outside Render, which is strictly better for "is production down" than a
GitHub cron. This workflow is the deeper hourly check and keeps the two things the uptime
monitor cannot see — the Vercel shell, and the authenticated sync-freshness probe.

The guard asserts only that a schedule EXISTS, not its exact cadence, so the cadence can
be tuned without a guard edit. Do not "restore" `*/5` on the strength of the card text.

## 2026-07-13 worker crash loop — root-cause finding (deliverable 5)

Investigated 2026-08-01. **Verdict: the root cause of that specific incident cannot be
established, and no amount of further digging will change that.** Recording why, because
"we did not find it" and "the evidence does not exist" are different claims and only the
second one is true here.

### Why it is unrecoverable

| evidence source | state on 2026-08-01 |
|---|---|
| Render worker logs, 2026-07-13 03:00–11:00 CA | outside the retention window (19 days) |
| `worker_status_events` (durable worker liveness) | **0 rows — table empty** |
| pg-boss job history for that window | not retained |

The `worker_status_events` table is the one that would have answered this. It was built
for exactly this purpose under PS-256 — its own env comment says the point is that "a
restart no longer erases the operator-visible history of worker liveness (e.g. 'worker
was stuck 14:32-15:17')".

It is empty because **`WORKER_STATUS_EVENTS_DURABLE` defaults to OFF** and was never
flipped on Render. The OFF path is a true no-op, so nothing was ever written. The
telemetry that would diagnose a crash loop was built, shipped, and left switched off —
which is why the incident it was designed to explain is the one it could not explain.

The three suspects the card named (OOM, postgres.js sessions poisoned by the read-only
window, pg-boss wedge) can be neither confirmed nor excluded. Do not let a plausible
story get written into the card as fact.

### Mitigation status: already deployed

The card's own suggested mitigation — "worker self-exit on repeated lane failure so
Render restarts it clean, since platform restart is free and uncapped, unlike the
watchdog's deploy path" — is in the code and has been since 2026-07-15:

- `src/worker.ts` — `createWorkerFailureBreaker(env.WORKER_UNCAUGHT_FAILURE_LIMIT)`
  exits(1) on escaped-failure limit, carrying the dated PS-431 override comment.
- `src/services/sync-job-queue.ts` — `requestRestart(reason)` exits(1) when the queue
  reports unhealthy.

So the *recovery* path for a future crash loop exists. Only the *diagnosis* path is off.

### To make the next one diagnosable — DJ action, with a prerequisite

Flipping `WORKER_STATUS_EVENTS_DURABLE=1` on Render is what turns the next crash loop
into something explainable. **Do not flip it before adding retention.**

`worker_status_events` has no pruning of any kind. Emission is a heartbeat every 30 s
plus job_start / job_complete / job_failed, so roughly 3,000–5,000 rows/day, indefinitely.
That is the same unbounded-growth shape that took `automation_runs` to 925 MB in a week
and forced a retention decision under PS-469. Add a retention window (30 days is ample
for crash-loop forensics) at the same time as the flip, not after.

Order of operations:

1. Add pruning to `worker_status_events` with a bounded window.
2. Flip `WORKER_STATUS_EVENTS_DURABLE=1` on Render as a canary.
3. Confirm rows appear and the table's growth rate matches the estimate above.
4. Leave it on. The next crash loop then has a liveness history to read.
