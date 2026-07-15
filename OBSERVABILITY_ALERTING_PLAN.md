# PrepShip Observability And Alerting Plan

## Executive Summary

This Phase 12 deliverable defines the production signals, metrics, alerts, dashboards, and ownership needed for PrepShip to be enterprise-ready. The goal is to make failures visible before operators or clients discover them in the browser.

This started as a planning/control batch. Runtime implementation has now begun with additive browser/API request ID propagation: the frontend sends `X-Request-Id`, the API exposes `X-Request-Id` / `Server-Timing`, API timing/error plus detailed Orders list logs include the same request ID, opt-in browser timing logs can be enabled with `localStorage.setItem('prepship:apiTiming', '1')`, admins can inspect bounded in-process route latency snapshots at `/observability/api-timing`, `/observability/status` summarizes process memory, runtime scheduler flags, hot routes, and lightweight DB ping timing, and Settings now includes a lazy Settings System Status panel backed by that payload. It does not change external API behavior or shipped/cancelled order logic. Remaining implementation should follow this matrix in small batches after owners and alert thresholds are approved.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No central alerting policy | API, sync, rate, label, billing, or DB failures can stay silent | Alert policy with owner, threshold, and action for each critical signal | Alert dry-run or dashboard screenshot |
| External API failures lack account-level visibility | ShipStation/carrier failures can appear as generic no-rate/no-label states | Provider/account tagged metrics for rates, labels, sync, and marketplace APIs | Simulated provider failure emits tagged signal |
| Slow DB/query visibility is incomplete | Supabase pressure can become page timeouts and 499s | Slow route and slow query dashboard | Route timing and slow query smoke test |
| Job failures are not consistently surfaced | Sync, rate backfill, print queue, and reporting jobs can fail or restart unclearly | Job health dashboard with failed/stuck/dead-letter states | Failed-job fixture appears in status signal |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| API requests | Timing logs, `Server-Timing`, request IDs, `/observability/api-timing`, and `/observability/status` exist | No external alert thresholds or centralized dashboard | Add request metrics by route, status, and duration bucket to the external monitoring layer |
| External APIs | Rate/label/sync clients have partial diagnostics | Carrier/store outages can hide in generic UI failures | Add provider/account metrics and alert thresholds |
| Database | Pool and timeout protections exist | Slow queries can still create page timeouts | Add slow query signal and route-to-query correlation |
| Worker/jobs | Worker status and heartbeat exist | Failed/stuck jobs can require manual log hunting | Add job success/failure/stuck counters and alerting |
| Frontend | Failure states improved for key fetches and opt-in browser timing logs exist | Browser errors are not yet captured centrally | Add frontend error reporting and release/version tags |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Request IDs | Request IDs now exist on browser requests, API responses, API timing/error logs, and detailed Orders list timing logs; worker/job propagation is not complete | Extend request ID propagation into worker/job logs and frontend support tooling |
| Response size | Large responses can hurt browser speed and bandwidth | Log response-size buckets for heavy routes |
| Cache health | Cache hits/misses are not fully visible | Track analytics/rate/reporting cache hit ratio |
| Status panel | Settings System Status now shows API timing, memory, uptime, and runtime flags | Expand the panel with worker, DB, sync, queue, rate, label, billing, and reporting health |
| Runbooks | Alerts need clear actions | Link every alert to a runbook and escalation owner |

## Signal Matrix

| Signal | Current Visibility | Missing Metric / Log | Alert Needed | Owner | Test |
|---|---|---|---|---|---|
| API 5xx rate | server logs and `/observability/api-timing` error counts | external route/status alert counters | API 5xx spike | API owner | force test route error in staging |
| API latency | timing middleware, `Server-Timing`, and `/observability/api-timing` | external p95/p99 dashboard by route | p95 over threshold for hot routes | API owner | slow route fixture emits metric |
| API 499/timeouts | Render logs | route/client/request-id aggregation | 499 spike or 30s timeout spike | API owner | production log review checklist |
| Slow DB queries | partial route timing plus lightweight `/observability/status` DB ping | query duration, table, route correlation | slow query over threshold | DB owner | slow query smoke test |
| Supabase pool pressure | Supabase dashboard/manual | connection count and saturation alert | high connections/pool timeout | DB owner | Supabase metric review |
| Worker heartbeat | `/worker/status` | stale heartbeat alert | heartbeat stale | Worker owner | stop worker in staging |
| Sync jobs | `/sync/status` and worker logs | success/failure duration counters | sync failure/stuck job | Sync owner | failed sync fixture |
| Rate calls | rate diagnostics | provider/account success, empty, failed, timeout counters | rate failure spike by account/provider | Rate owner | mocked carrier failure |
| Label creation | label route/provider logs | provider/account label failure counters | label failure spike | Fulfillment owner | label failure fixture |
| Billing generation | generated rows and UI status | generation duration, zero-total anomaly, failed run counters | failed billing generation or zero-total anomaly | Billing owner | billing fixture with mismatch |
| Inventory/reporting refresh | worker/reporting logs | refresh duration and failed refresh counters | reporting refresh failed/stale | Reporting owner | failed refresh fixture |
| Frontend runtime errors | browser console/manual | release-tagged frontend error capture | frontend error spike | Frontend owner | client error fixture |

## Production Watchdog Alerting

`npm run watchdog:production` emits a sanitized alert payload when the Vercel shell, Render `/health`, required Render `/health/ready`, or canonical shipment-sync freshness check is unhealthy. Render `/health/deep` remains diagnostic and cannot substitute for readiness. The GitHub workflow runs every five minutes and persists per-state alert timestamps; the same state pages at most once per 30 minutes. The default behavior is alert-only. Automated Render recovery requires `WATCHDOG_ALLOW_RESTARTS=true` plus either `RENDER_DEPLOY_HOOK_URL` or `RENDER_API_KEY` and `RENDER_SERVICE_ID`.

Alert fields:

| Field | Meaning |
|---|---|
| `service` | Fixed service label: `prepship-v4`. |
| `status` | `healthy` or `unhealthy`. |
| `mode` | `alert-only`, `render-deploy-hook`, or `render-api`. |
| `action` | `alert`, `restart-requested`, or `restart-request-failed`. |
| `reason` | Why recovery did or did not run, such as consecutive failure threshold, cooldown, max restarts per hour, or Render HTTP status. |
| `consecutiveFailures` | Current failure count from `WATCHDOG_STATE_FILE`. |
| `threshold` | `WATCHDOG_FAILURE_THRESHOLD` value. |
| `cooldownMs` | `WATCHDOG_RESTART_COOLDOWN_MS` value. |
| `maxRestartsPerHour` | `WATCHDOG_MAX_RESTARTS_PER_HOUR` value. |
| `failingChecks` | Failed required checks. `/health/ready` and shipment-sync freshness are independently required; `/health/deep` is diagnostic. |
| `checks` | Sanitized check results with target host/path only, status, duration, and safe error string. |
| `runbook` | Pointer to `docs/runbooks/ps-431-production-self-healing.md`. |

No alert should include secrets, deploy hook query strings, bearer tokens, raw Render API keys, customer data, label URLs, addresses, or provider credentials. Render deploy hook setup follows Render's service Settings deploy hook flow; Render API recovery uses the documented Create Deploy endpoint.

## Recommended Patches

- [x] Add a shared request-id middleware and propagate request IDs to logs and response headers.
- [x] Add request IDs to detailed `/orders` list segment timing logs.
- [x] Add browser-side request IDs to API calls and failed request errors.
- [x] Add opt-in browser API timing diagnostics for slow or failed requests.
- [x] Add admin-only `/observability/api-timing` for bounded in-process p95/p99 API timing snapshots by method/path.
- [x] Add admin-only `/observability/status` for process memory, runtime scheduler flags, hot-route status, and lightweight DB ping timing.
- [x] Add Settings System Status panel backed by `/observability/status`.
- [ ] Standardize structured logs for API errors, external API failures, and worker jobs.
- [ ] Add route-level metrics for status, duration, and response-size buckets.
- [ ] Add provider/account-level metrics for ShipStation, direct carriers, and marketplace APIs.
- [ ] Add job health metrics for worker heartbeat, sync, rate backfill, print queue, reporting refresh, and fulfillment outbox.
- [ ] Add slow DB query visibility linked to route/request ID where practical.
- [ ] Add frontend error capture with release/build version.
- [ ] Expand the internal status panel to summarize worker, sync, queue, DB, rates, labels, billing, and reporting health.

## Test Plan

- `npm run test:observability-alerting`
- `npm run test:api-observability-metrics`
- `npm run test:production-watchdog`
- Future implementation tests:
  - API request emits request ID, route, status, and duration
  - simulated 500 emits safe structured error without secrets
  - simulated ShipStation rate failure increments provider/account failure signal
  - simulated label failure increments provider/account failure signal
  - stale worker heartbeat triggers status warning
  - failed reporting refresh appears in status signal
  - frontend error fixture includes release/build version

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Runtime observability changes should be feature-flagged or low-risk additive logging first.
- Alert thresholds should start in notify-only mode before paging/escalation.
- Rollback should disable new emitters or alerts without removing existing logs.
- No alert should include secrets, tokens, full customer addresses, or raw provider credentials.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and assign owners.
2. Add request IDs and structured API/worker logs.
3. Add route status/duration/response-size metrics for hot routes.
4. Add external provider/account metrics for rates and labels.
5. Add worker/job heartbeat, failure, and stale-job metrics.
6. Add slow DB query dashboard and Supabase pressure checklist.
7. Add frontend error capture with release/build tags.
8. Create alert thresholds and runbook links after baseline data is collected.
