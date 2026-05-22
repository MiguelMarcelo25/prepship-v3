# Enterprise Readiness Closeout

PS-012 - Enterprise Readiness Closeout: Smoke, Audit, Alerts, Durable Jobs

Last updated: 2026-05-22

## Purpose

This document is the single source of truth for PrepShip V4 enterprise-readiness closeout. It records which operational, security, audit, and reliability areas are complete, partial, blocked, or must be fixed before production signoff.

No production-destructive action is authorized by this document. Do not paste secrets, tokens, carrier credentials, customer data, labels, addresses, rates, or private operational records into this file.

## Status Legend

- [OK] Complete: implemented or covered with sufficient local evidence.
- [PARTIAL] Partial: foundation exists, but more evidence, coverage, or operational work is required.
- [BLOCKED] Blocked: cannot be completed without external access, account-owner action, credentials, or production approval.
- [MUST-FIX] Must fix before production: high-risk item that should block enterprise production signoff until resolved.

## Executive Summary

PrepShip V4 has strong foundations for internal operation: auth/RBAC guardrails, client/store scope conventions, shipped/cancelled lockdown rules, timing diagnostics, sync status diagnostics, durable job planning, and bundle/performance guards. The remaining enterprise-readiness gap is not one isolated code bug. It is proof and governance: production smoke evidence, operational alert destinations, restore/rollback drill evidence, secret rotation/last-used audit, append-only audit enforcement, durable job artifact visibility, and documented CI/account blockers.

Current overall status: [PARTIAL] Partial.

Primary production signoff blockers:

- [MUST-FIX] Production smoke evidence is incomplete until approved production/staging checks are run and attached.
- [MUST-FIX] CI status may be externally blocked by GitHub billing/spend-limit/account status and must be resolved by the account owner.
- [PARTIAL] Alert thresholds and destinations need final operator approval.
- [PARTIAL] Restore/rollback drill evidence needs an approved, non-destructive drill.
- [PARTIAL] Secrets rotation/last-used/audit is partially documented but not fully proven across every credential type.

## Readiness Category Matrix

| Category | Status | Current evidence | Remaining work / blocker |
|---|---:|---|---|
| Runtime label/shipment scope enforcement | [PARTIAL] Partial | Label, rate, carrier, and order paths include auth and scope patterns. Shipped/cancelled lockdown is documented in `AGENTS.md`. | Complete a route-by-route scope evidence pass for label purchase, direct carrier labels, voids, manifests, and shipment confirmation. |
| Client/store isolation | [PARTIAL] Partial | Scope helpers and guard scripts exist in the repo for client/store isolation. Walmart dual-source dedupe work reduced duplicate display/action paths. | Produce final evidence that every high-risk read/write path uses scoped selectors or equivalent checks. |
| RBAC enforcement | [PARTIAL] Partial | Auth middleware and permission checks exist; frontend and backend routes use role-aware behavior. | Create a route matrix listing required permission per admin/manager/worker/customer-facing operation. |
| Secret redaction | [PARTIAL] Partial | Redaction guard scripts and credential account patterns exist. | Confirm all error responses, carrier-account APIs, logs, and diagnostics redact secrets and never return raw credentials. |
| Shipped/cancelled lockdown | [OK] Complete | `AGENTS.md` explicitly locks shipped/cancelled mutation paths and shipped/cancelled UI batch actions. | Keep guardrails active; any future change requires explicit human override phrase and review. |
| Production smoke evidence | [MUST-FIX] Must fix before production | Local build/typecheck/guards can prove static readiness. | Run approved staging/production smoke checks and attach sanitized evidence for login, orders, rates, carriers, labels, inventory, settings, billing, and manifests. |
| Secrets rotation / last-used / audit | [PARTIAL] Partial | Credential-account architecture exists and redaction requirements are known. | Confirm last-used tracking, rotation audit events, actor capture, and secret update history for ShipStation, carrier accounts, marketplace accounts, Supabase, Render, and GitHub secrets. |
| Append-only audit logging | [PARTIAL] Partial | Audit logging matrix/guard exists in the repo. | Prove append-only enforcement at DB/service level, or document missing DB-level constraints as a follow-up blocker. |
| Durable jobs | [PARTIAL] Partial | Durable jobs planning guard exists. Sync scheduler, fulfillment outbox, and print queue paths are known. | Add operator-visible job progress/events/artifacts for critical sync, label, billing, reporting, and outbox jobs where missing. |
| Reconciliation artifacts | [PARTIAL] Partial | Reporting/reconciliation concepts exist. | Define retained artifacts for order sync reconciliation, shipment confirmation reconciliation, inventory deduction reconciliation, billing reconciliation, and rate/label purchase reconciliation. |
| Alerting | [MUST-FIX] Must fix before production | Timing diagnostics and health/status endpoints exist. | Define alert thresholds, destinations, owner, escalation path, and muted maintenance windows for API health, worker freshness, sync failures, label failures, DB errors, outbox retries, and billing failures. |
| Restore/rollback | [BLOCKED] Blocked | No destructive actions should be run by agents. | Requires DJ/account-owner approval for a non-destructive restore/rollback drill and artifact capture. |
| CI billing/spend-limit blocker | [BLOCKED] Blocked | Prior task context reported CI not running due account billing/spend-limit state. | Account owner must resolve GitHub billing/spend limit or provide current CI run evidence. |
| Migration status | [PARTIAL] Partial | Runtime schema readiness has been added for recent label/connector columns; migrations exist. | Confirm production migration drift using a safe migration/status check. Do not paste production schema details containing sensitive data. |
| Sync worker status | [PARTIAL] Partial | Sync status diagnostics and worker endpoints exist. | Run authenticated worker/sync freshness checks with approved token and record sanitized timestamps only. |
| API health | [OK] Complete | Public health endpoint can prove API and DB are generally alive. | Continue including `/health` evidence in production signoff; protected status checks need auth. |
| Supabase health assumptions | [BLOCKED] Blocked | Local code can assume configured Supabase dependencies, but production project state needs external access. | Requires Supabase dashboard/API access to confirm auth health, DB health, connection limits, backups, and RLS assumptions. |

## Required Evidence For Signoff

The production signoff package should include sanitized evidence for:

- API health response status only, not secrets or customer data.
- Authenticated sync/worker status with only timestamps, status labels, and request IDs.
- Latest successful sync timestamp.
- Latest imported order timestamp, redacted to date/time and safe store/client labels only.
- Label creation smoke result using an approved test order/account only.
- Fulfillment outbox pending/succeeded/failed counts.
- Inventory deduction or ledger smoke result using test-safe data only.
- Billing smoke or dry-run evidence without customer PII.
- CI run URL or external blocker note.
- Restore/rollback drill note, command class, approver, timestamp, and outcome.

## Safe Verification Commands

These commands are safe to run locally because they should not mutate production data:

```powershell
git status --short --branch
npm run typecheck
npm run build:web
node scripts/enterprise-readiness-closeout-guard.mjs
```

Desired package script name after coordinator wiring:

```json
{
  "scripts": {
    "guard:enterprise-readiness-closeout": "node scripts/enterprise-readiness-closeout-guard.mjs"
  }
}
```

Production/staging checks require DJ approval, authenticated tokens, and sanitized output. Do not run production mutation or recovery commands as part of this closeout document.

## Runtime Label / Shipment Scope Enforcement

Status: [PARTIAL] Partial.

Expected enterprise behavior:

- Every label/rate/shipment/manifest action requires an authenticated user.
- Every action is scoped to allowed client/store/account context.
- Manager/admin permissions are enforced server-side, not only in the UI.
- Error responses are redacted and request-ID traceable.
- Shipped/cancelled mutation lockdown remains intact.
- Shipment rows are never edited by ad hoc SQL from agent work.

Current gap:

- A final route-level matrix is still needed for direct carrier labels, direct carrier rates, ShipStation labels, print queue jobs, voids, manifests, and fulfillment confirmation.

Recommended next step:

- Add a route/scope matrix documenting exact middleware/helper for each endpoint, then add targeted guards for any missing path.

## Client / Store Isolation

Status: [PARTIAL] Partial.

Expected enterprise behavior:

- Client-scoped users can only see and mutate allowed client/store records.
- Store aliases, direct marketplace stores, and ShipStation stores resolve to a canonical source context.
- Dual-source Walmart records do not create duplicate visible/actionable orders.

Current gap:

- Store ownership is still transitional in places, especially where legacy client store arrays coexist with newer account/connector patterns.

Recommended next step:

- Document the source-of-truth relationship between `clients`, store accounts, connector accounts, and order source fields in PS-013.

## RBAC Enforcement

Status: [PARTIAL] Partial.

Expected enterprise behavior:

- Admin, manager, worker, and limited roles have a documented permission matrix.
- Backend routes enforce permissions independently of frontend visibility.
- Batch actions, billing, settings, carrier credentials, labels, and sync controls are explicitly permissioned.

Current gap:

- Route-level permission evidence is not yet consolidated in one signoff artifact.

Recommended next step:

- Add a backend route/RBAC matrix to the production readiness package.

## Secret Redaction

Status: [PARTIAL] Partial.

Expected enterprise behavior:

- API responses never expose raw credentials.
- Logs never include raw tokens, keys, passwords, authorization headers, labels, addresses, or carrier credential payloads.
- Error responses include safe request IDs instead of sensitive payloads.

Current gap:

- Need a final redaction proof for carrier account endpoints, marketplace credential flows, external API failure logging, and sync diagnostics.

Recommended next step:

- Run existing redaction guards and add fixture tests for any credential route not covered.

## Shipped / Cancelled Lockdown

Status: [OK] Complete.

The repository policy in `AGENTS.md` defines shipped/cancelled order data, shipment table behavior, frontend read-only behavior, and fulfillment deduction kill-switch behavior. This is considered complete as a policy guardrail. Future changes still require explicit human override and review.

## Production Smoke Evidence

Status: [MUST-FIX] Must fix before production.

Required smoke areas:

- Login/auth page.
- Awaiting Shipment.
- Shipped and Cancelled read-only views.
- Rate Shop.
- Carrier settings/test connection/rates.
- Label creation with approved test order only.
- Print queue with approved test order only.
- Inventory stock levels and history.
- Dashboard.
- Settings.
- Billing.
- Manifests.
- API health and protected worker/sync status.

Current blocker:

- Production smoke requires approved credentials/session and sanitized capture rules.

## Secrets Rotation / Last-Used / Audit

Status: [PARTIAL] Partial.

Required coverage:

- Carrier account credentials.
- ShipStation credentials.
- Marketplace credentials/OAuth tokens.
- Supabase keys and JWT settings.
- Render environment secrets.
- GitHub Actions secrets.

Expected evidence:

- Secret create/update/delete emits audit event.
- Secret use records safe last-used metadata without storing the secret.
- Rotation status or rotation timestamp is available where practical.
- No secret value appears in logs, docs, screenshots, or return output.

## Append-Only Audit Logging

Status: [PARTIAL] Partial.

Expected enterprise behavior:

- Sensitive actions emit audit events.
- Audit records are append-only by design.
- Audit updates/deletes are restricted or impossible outside explicit retention tooling.
- Audit events include actor, action, target, request ID, timestamp, and safe metadata.

Current gap:

- Need final proof of append-only enforcement at DB/service level.

## Durable Jobs

Status: [PARTIAL] Partial.

Critical jobs to track:

- Order sync.
- Shipment sync.
- Fulfillment outbox.
- Print queue label creation.
- Billing generation/export.
- Reporting metrics refresh.
- Inventory reconciliation.
- Carrier/rate backfills.

Expected enterprise behavior:

- Jobs have durable status.
- Jobs expose progress/events.
- Jobs record safe artifacts or summaries.
- Jobs are idempotent or protected by idempotency keys/advisory locks.
- Operators can see stuck/failing jobs.

Current gap:

- Some durable-job planning exists, but final operator-visible artifacts and dashboard evidence are partial.

## Reconciliation Artifacts

Status: [PARTIAL] Partial.

Required reconciliation artifacts:

- Orders imported vs source platform orders.
- Shipment labels created vs shipment rows.
- Marketplace confirmations sent vs fulfillment outbox rows.
- Inventory deductions vs shipped/test shipment events.
- Billing line items vs shipments/orders/packages.
- Rate selected vs label purchased.

Current gap:

- Artifact retention and operator signoff format need to be standardized.

## Alerting

Status: [MUST-FIX] Must fix before production.

Required alert areas:

- API health degradation.
- DB health degradation.
- Sync stale beyond threshold.
- Worker heartbeat stale.
- Fulfillment outbox retry/failure spike.
- Label creation failures.
- Carrier API failure spike.
- Billing generation failure.
- Inventory deduction failure.
- Error-rate and latency thresholds.

Required operational fields:

- Threshold.
- Destination.
- Owner.
- Escalation path.
- Maintenance window behavior.
- Evidence link.

Current blocker:

- Alert destinations and owners require DJ/account-owner approval.

## Restore / Rollback

Status: [BLOCKED] Blocked.

Agents must not run destructive production actions. Restore/rollback readiness requires DJ/account-owner approval and an intentionally non-destructive drill plan.

Minimum drill evidence:

- Backup source confirmed.
- Restore target confirmed as non-production or approved safe target.
- Rollback command class documented.
- Approver captured.
- Timestamp captured.
- Outcome summarized without exposing data.

## CI Billing / Spend-Limit Blocker

Status: [BLOCKED] Blocked.

If GitHub Actions cannot start because of billing, payment, or spend-limit restrictions, that is an account-owner blocker rather than a code-test failure. The readiness package should include the exact CI run URL and the sanitized GitHub annotation text.

## Migration Status

Status: [PARTIAL] Partial.

Recent label/connector schema readiness has reduced runtime drift risk, but enterprise signoff still needs a safe migration drift check.

Expected evidence:

- Applied migration list or schema drift check.
- No destructive migration pending.
- Runtime compatibility checks passing.
- Production DB check performed by approved operator.

## Sync Worker Status

Status: [PARTIAL] Partial.

Expected evidence:

- Worker process is live.
- Scheduler ownership is clear.
- Latest heartbeat is fresh.
- Latest successful order sync timestamp is fresh.
- Latest successful shipment sync timestamp is fresh.
- Stuck queue/backoff status is visible.

Current blocker:

- Protected status endpoints require authenticated token/session and sanitized output.

## API Health

Status: [OK] Complete.

The public health endpoint is acceptable as a basic liveness check. It is not sufficient by itself for enterprise production signoff because protected worker/sync/order freshness checks require authentication.

## Supabase Health Assumptions

Status: [BLOCKED] Blocked.

Required evidence from approved operator:

- Supabase project status.
- Auth health.
- DB connection limits.
- Backup/PITR status if available.
- RLS/security posture where applicable.
- Recent incident/error view.

Do not paste Supabase keys, JWT secrets, connection strings, or private project identifiers into this document.

## Final Go / No-Go Summary

Current recommendation: no-go for enterprise production signoff until the [MUST-FIX] and [BLOCKED] items are either completed or formally accepted by DJ/account owner.

Code readiness may be materially ahead of evidence readiness. The immediate closeout work should focus on sanitized proof, alert ownership, restore/rollback drill approval, CI account blocker resolution, and final source-of-truth documentation.

