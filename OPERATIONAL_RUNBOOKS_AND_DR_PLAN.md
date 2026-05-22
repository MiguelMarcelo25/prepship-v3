# PrepShip Operational Runbooks And Disaster Recovery Plan

## Executive Summary

This Phase 12 deliverable defines the operational runbooks, deployment/rollback controls, and disaster recovery checks PrepShip needs before enterprise signoff. The goal is simple: when something fails, the team should know who owns it, what to check first, how to restore service, and how to prove recovery.

This is a planning/control batch only. It does not change runtime code, deployment behavior, database state, shipped/cancelled logic, label side effects, or inventory mutations.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No formal outage runbooks | Operators improvise during rates, labels, sync, or billing incidents | Approved runbook list with owner and escalation path | Runbook review signoff |
| Rollback steps are not fully documented | Bad deploys can take longer to recover | Backend, worker, frontend, and migration rollback paths | Rollback drill or dry-run checklist |
| Restore process is not proven | Backups may exist but recovery may fail under pressure | Tested database/object/env restore process | Restore test record with timestamp |
| Incident ownership is unclear | Alerts can fire without a clear response owner | Owner/severity/escalation policy for critical workflows | On-call/owner matrix |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Rates/labels | Diagnostics improved, but outage handling is manual | Operators may not know whether to retry, switch account, or pause label work | Rates and label outage runbooks |
| Sync/worker | Render worker owns background work | Stuck sync can create stale orders/rates/reporting | Sync stuck and worker restart runbooks |
| Billing/inventory | Reconciliation is mapped but not implemented | Bad totals or stock mismatch may be handled ad hoc | Billing zero-total and inventory mismatch runbooks |
| Deployment | Manual deploys happen across Vercel and Render | Version skew or failed migration can create production errors | Deploy/rollback checklist |
| Security | Credential and suspicious-access tasks are scoped | Credential leak or suspicious access needs immediate steps | Credential rotation and security incident runbooks |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Staging parity | Production-only failures are harder to reproduce | Add staging parity checklist for env, migrations, and representative data |
| Feature flags | Risky changes need a quick kill switch | Add rollout/disable policy for reporting, strict JWT, and alerting |
| Runbook storage | Docs can drift from code | Guard required runbook names and owner/escalation fields |
| Communication | Incident updates can be inconsistent | Add status-update template and owner handoff checklist |
| Post-incident review | Repeated incidents can recur | Add lightweight incident review template |

## Runbook Matrix

| Runbook | Trigger | First Checks | Recovery Action | Owner | Verification |
|---|---|---|---|---|---|
| Rates not loading | Rate Browser no rates, provider errors, rate timeout spike | provider/account diagnostics, `/rates/browse`, Render logs, ShipStation status | retry live rates, switch valid account, pause noisy account, escalate provider outage | Rates owner | rate returns for test order |
| Label creation failing | label API error, provider failure, label purchase timeout | label route logs, provider status, order editability, carrier credentials | retry safe label action, switch carrier/account, document failed label state | Fulfillment owner | label created or failure state recorded |
| ShipStation outage | sync/rate/label failures across accounts | ShipStation status, provider error rate, circuit breaker state | pause provider-heavy jobs, notify ops, retry after recovery | Fulfillment owner | sync/rate smoke passes |
| Direct carrier outage | direct carrier rates/labels fail | carrier status, account credentials, provider error tags | disable affected direct carrier path, use alternate account | Rates owner | alternate rate/label path works |
| Sync stuck | `/sync/status` stale, worker job stuck, orders stale | worker heartbeat, queue depth, last success/failure, Render logs | restart worker, clear stuck job with owner approval, run manual recovery sync | Sync owner | fresh sync success timestamp |
| Inventory mismatch | stock/effective stock disagreement | inventory ledger, order_items sold counts, recent receives/adjustments | run reconciliation report, dry-run repair, approve cache rebuild | Inventory owner | mismatch count resolved |
| Billing totals missing or zero | generated line items exist but summary is zero/stale | billing generation log, line item count, summary API, client/date filters | regenerate summary/read model, rerun billing report | Billing owner | totals match line items |
| Print queue stuck | print job pending/failing or download unavailable | print queue status, job id, queue entries, Render logs | restart job if safe, regenerate bundle, clear stale job with owner approval | Warehouse owner | PDF/download available |
| Frontend white screen | blank app after deploy | browser console, Vite chunk error, deployment version, cache state | hard refresh, rollback frontend, verify chunk recovery | Frontend owner | app loads in incognito |
| User locked out | login/admin access failure | Supabase user state, role/permission claims, JWT strict flag | restore role/permission, disable strict JWT rollout if needed | Admin owner | user can log in |
| Credential rotation | credential leak, expiry, provider auth failure | affected credential class, last update, dependent clients/accounts | rotate credential, update storage, invalidate old secret, audit event | Security owner | provider smoke passes |
| Database restore | data loss/corruption or migration failure | backup/PITR availability, migration version, affected tables | restore to staging first, verify, then production recovery plan | DB owner | restore drill record |
| Rollback deploy | production regression after deploy | commit/version, Vercel/Render status, migration compatibility | rollback frontend/API/worker, pause risky worker jobs | Release owner | smoke checklist passes |
| Suspicious access/security event | unexpected admin/client access or credential activity | audit logs, auth logs, affected users, exposed artifacts | revoke sessions/keys, rotate secrets, preserve evidence | Security owner | access blocked and report filed |

## Deployment / Rollback Matrix

| Deploy Step | Failure Mode | Rollback Step | Owner | Verification |
|---|---|---|---|---|
| Vercel frontend deploy | white screen, bad bundle, API mismatch | rollback to previous Vercel deployment | Frontend owner | incognito app load |
| Render API deploy | API 5xx, auth failure, route timeout | rollback Render API to previous commit | API owner | `/health/ready`, Orders, Rates smoke |
| Render worker deploy | sync/reporting/rate backfill stuck | rollback worker or pause worker scheduler | Worker owner | worker heartbeat and sync status |
| Drizzle migration | migration failure or slow lock | stop deploy, restore migration backup/rollback script | DB owner | schema version and app smoke |
| Strict JWT rollout | users cannot authenticate | set `STRICT_JWT_CLAIMS=false` | Security owner | login/API smoke |
| Alert rollout | noisy/incorrect alerts | set alert to notify-only or disable emitter | Observability owner | alert quiet and logs intact |

## Production Watchdog

The production watchdog is a one-shot, read-first safety script for external uptime checks and controlled Render recovery. Run it from an approved scheduler or Render Shell with `npm run watchdog:production`. It checks the Vercel shell URL, Render `/health`, and Render `/health/ready` plus `/health/deep`; readiness is considered acceptable when either deep readiness endpoint passes after `/health` passes.

Required read-only env vars:

| Env var | Purpose |
|---|---|
| `VERCEL_SHELL_URL` | Public Vercel app shell URL to fetch. 5xx/network failures count as unhealthy; 3xx/4xx auth gates are acceptable for the shell. |
| `RENDER_BASE_URL` | Render API base URL. The watchdog appends `/health`, `/health/ready`, and `/health/deep`. |
| `WATCHDOG_ALERT_WEBHOOK_URL` | Optional alert destination. If missing, the sanitized alert is written to process logs only. |
| `WATCHDOG_STATE_FILE` | Optional persistent JSON state path for consecutive failure and restart counters. Defaults under `outputs/`. |

Restart/redeploy is disabled unless explicitly enabled. With no restart credentials, or without `WATCHDOG_ALLOW_RESTARTS=true`, the script stays in alert-only mode and never calls Render recovery APIs.

Controlled recovery env vars:

| Env var | Purpose |
|---|---|
| `WATCHDOG_ALLOW_RESTARTS=true` | Explicit gate for any automated Render redeploy/restart request. |
| `WATCHDOG_FAILURE_THRESHOLD` | Consecutive failure threshold before recovery is considered. Default: `3`. |
| `WATCHDOG_RESTART_COOLDOWN_MS` | Cooldown after a recovery request. Default: `900000` ms. |
| `WATCHDOG_MAX_RESTARTS_PER_HOUR` | Max restarts per hour. Default: `2`. |
| `RENDER_DEPLOY_HOOK_URL` | Preferred low-friction deploy hook. Render documents deploy hooks as service-specific secret URLs from the Settings tab. |
| `RENDER_API_KEY` + `RENDER_SERVICE_ID` | Alternative Render API recovery path. The watchdog calls `POST https://api.render.com/v1/services/{serviceId}/deploys`. |

Render dashboard restart:

1. Open the affected Render service.
2. Confirm current deploy, logs, and health status.
3. Use the dashboard Manual Deploy or Restart action for the API/worker service.
4. Re-run `/health`, `/health/ready` or `/health/deep`, and the relevant user smoke.
5. Preserve timestamps, deploy id, request IDs, and sanitized logs in the incident record.

Manual fallback:

1. If the watchdog is alert-only or blocked by consecutive failure, cooldown, or max restarts per hour limits, page the API/Platform owner.
2. Verify the Vercel shell and Render health endpoints manually from a clean shell.
3. Use Render dashboard restart first when credentials or deploy hook/API env vars are unavailable.
4. If dashboard recovery fails, rollback the Render deploy or pause noisy workers according to the Deployment / Rollback Matrix.
5. No secrets, deploy hook URLs, API keys, customer data, labels, or raw provider credentials should be pasted into incident notes or alerts.

## Disaster Recovery Matrix

| DR Area | Required Control | Current Gap | Owner | Verification |
|---|---|---|---|---|
| Supabase database backups | automated backups and PITR policy | restore test still needed | DB owner | dated restore drill |
| Object/file artifacts | label PDFs/exports/report artifacts recoverable or regenerable | retention/rebuild policy needed | Fulfillment owner | artifact recovery test |
| Environment variables | secure backup and rotation inventory | owner and restore path needed | Security owner | env restore checklist |
| Render services | API/worker config recoverable | config export/runbook needed | Platform owner | recreate service checklist |
| Vercel frontend | deployment rollback and env parity | rollback drill needed | Frontend owner | rollback smoke test |
| External providers | outage fallback plan | provider-specific playbooks needed | Ops owner | provider outage tabletop |
| RTO/RPO | recovery objectives defined | business targets not approved | Leadership | approved RTO/RPO values |

## Recommended Patches

- [ ] Create runbook files or sections for every item in the Runbook Matrix.
- [ ] Add owner, severity, escalation path, first checks, recovery steps, and verification to each runbook.
- [ ] Add deployment and rollback smoke checklist for Vercel frontend, Render API, Render worker, and migrations.
- [ ] Add disaster recovery checklist for Supabase, env vars, artifacts, Render, Vercel, and external providers.
- [ ] Add restore drill cadence and record of last successful restore test.
- [ ] Link alerts from `OBSERVABILITY_ALERTING_PLAN.md` to the matching runbook.

## Test Plan

- `npm run test:operational-runbooks`
- `npm run test:production-watchdog`
- Future operational tests:
  - deployment rollback dry-run checklist is completed
  - database restore drill is recorded
  - strict JWT rollback is tested in staging
  - worker restart/runbook smoke test is completed
  - frontend rollback/incognito smoke test is completed
  - provider outage tabletop is completed

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Runtime implementation should start with runbook files and alert links before adding new automation.
- Rollback runbooks should be validated in staging before production use.
- Restore drills should never overwrite production without explicit human approval.
- Security incident runbooks should preserve evidence and avoid leaking secrets in status updates.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and assign owners.
2. Create dedicated runbook pages for rates, labels, sync, billing, inventory, print queue, rollback, and suspicious access.
3. Add deployment/rollback smoke checklist for Vercel, Render API, Render worker, and migrations.
4. Add Supabase restore drill checklist and record template.
5. Link alerts from `OBSERVABILITY_ALERTING_PLAN.md` to runbooks.
6. Run one staging tabletop for provider outage and one rollback dry run.
