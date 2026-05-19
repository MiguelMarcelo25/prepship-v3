# PrepShip Audit Logging Matrix

## Executive Summary

This Phase 12 deliverable scopes the append-only audit logging work needed for enterprise readiness. It does not add runtime logging yet. It defines which business-critical actions must be audited, what actor/context must be captured, which data needs before/after snapshots, and which implementation tests should exist before calling the audit trail production-ready.

PrepShip already has stronger route protection and scoped reads. The next enterprise step is proof: when credentials, labels, orders, inventory, packages, billing, settings, and sync jobs change, the system should preserve who did it, what changed, when it happened, and whether the action succeeded.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No formal append-only audit table/service | Critical actions can happen without a durable trail | Central audit service and migration-owned append-only table | Migration test and service unit/API tests |
| Credential changes are not fully audited | Carrier/store/client secrets can change without owner traceability | Audit credential create/update/delete/verify/OAuth callback events | Credential action tests |
| Label/order side effects lack complete audit status | Label, inventory, package, print queue, fulfillment, and billing can drift without proof | Audit label/order side-effect outcomes and warnings | Label workflow tests in separate reviewed batch |
| Shipped/cancelled overrides need explicit human trace | Human override can affect locked operational truth | Audit override actor, reason, route, target, and before/after | Locked-surface reviewed tests only |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Credentials | Redaction/permission guardrails exist | No durable proof of who changed a key/token | Add audit events for client/carrier/store/OAuth credential mutations |
| Labels and shipments | Label creation touches external APIs and downstream side effects | Partial success can be hard to reconstruct | Add side-effect status events and recovery markers |
| Inventory/packages | Receive/adjust/delete actions affect stock trust | Stock disputes cannot be traced cleanly | Audit before/after quantities, reason, actor, and source |
| Billing | Generated line items and summaries affect client charges | Billing disputes lack traceable generation/update events | Audit generation, export, config changes, and invoice actions |
| Admin/settings/users | Permission and config changes affect security | Role/settings changes can be invisible | Audit before/after permission and settings changes |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Sync/backfill jobs | Manual starts/stops and failures may not have a durable user-facing history | Emit audit/job events for job lifecycle |
| Print queue | In-memory job status is scoped now, but not durable | Persist queue job lifecycle before relying on audit-only logs |
| Frontend actions | UI can hide actions, but backend must be source of truth | Audit only on backend mutation success/failure |
| Sensitive values | Audit logs must not store raw secrets | Store changed-field names and masked metadata, never raw tokens |

## Audit Event Matrix

| Action | Currently Audited? | Actor Captured? | Before/After Captured? | Required Event Fields | Required Fix | Test |
|---|---|---|---|---|---|---|
| user login/logout | [ ] Unknown | [ ] | [ ] | user id, email, IP, user agent, success/failure | auth event bridge or Supabase audit export | login/logout event test |
| admin role/user permission change | [ ] | [ ] | [ ] | actor, target user, before roles, after roles, reason | audit service around user-management endpoints | non-admin denied; admin change audited |
| client create/update/delete | [ ] | [ ] | [ ] | actor, client id, changed fields, redacted credential flags | wrap client mutations in audit event | client update audit test |
| client ShipStation credential update | [ ] | [ ] | [ ] | actor, client id, credential type changed, masked fingerprint | audit without raw secret values | credential redaction + audit test |
| carrier account create/update/delete | [ ] | [ ] | [ ] | actor, account id, source/provider, changed fields, assigned clients | audit shared credential-account service | carrier account audit test |
| store account create/update/delete | [ ] | [ ] | [ ] | actor, account id, provider/source, changed fields | audit shared credential-account service | store account audit test |
| marketplace OAuth callback/token refresh | [ ] | [ ] | [ ] | provider, store account id, token class, status, error code | audit OAuth callback and refresh jobs | OAuth callback audit test |
| label create/void/return | [ ] | [ ] | [ ] | actor, order id, label id, provider, cost, tracking, status | add label workflow audit events | label audit workflow test |
| order manual edit | [ ] | [ ] | [ ] | actor, order id, changed fields, old/new safe values | audit order mutation endpoints in reviewed batch | order edit audit test |
| shipped/cancelled force override | [ ] | [ ] | [ ] | actor, route, target id, reason, before/after status | locked-surface reviewed audit patch only | override audit test |
| inventory receive/adjust | [ ] | [ ] | [ ] | actor, inventory id, sku, client id, delta, reason, before/after qty | audit inventory mutations | inventory adjustment audit test |
| package receive/adjust/delete | [ ] | [ ] | [ ] | actor, package id, delta, reason, before/after qty | audit package mutations | package audit test |
| settings changes | [ ] | [ ] | [ ] | actor, setting group, changed fields, before/after safe values | audit settings write routes | settings audit test |
| billing config/generation/export | [ ] | [ ] | [ ] | actor, date range, client ids, line count, totals, export id | audit billing generation/export routes | billing audit test |
| sync/backfill/reporting job lifecycle | [ ] Partial job status | [ ] | [ ] | actor/system, job type, job id, start/finish/fail, counts | connect scheduler/pg-boss/job events to audit or job history | job lifecycle test |
| print queue add/clear/delete/print job | [ ] | [ ] | [ ] | actor, queue entry/job id, client ids, action, status | audit print queue action handlers after durable job design | print queue audit test |

## Recommended Patches

- [ ] Add `audit_events` migration with append-only semantics.
- [ ] Add `src/services/audit-log.ts` with safe event writer and redaction helpers.
- [ ] Add backend-only event schemas for actor, target, action, before/after, request id, IP, user agent, and correlation id.
- [ ] Add credential mutation audit events first.
- [ ] Add settings/user/admin audit events second.
- [ ] Add inventory/package/billing audit events third.
- [ ] Handle label/order/shipped override audit in a separate reviewed batch because those paths are operationally sensitive.

## Test Plan

- `npm run test:audit-logging`
- Existing guards:
  - `npm run test:auth-coverage`
  - `npm run test:rbac-permissions`
  - `npm run test:client-redaction`
  - `npm run test:credential-accounts`
- Future implementation tests:
  - credential update emits audit event without raw secret values
  - settings write emits before/after safe values
  - billing generation emits line count and total summary
  - inventory adjustment emits before/after quantity
  - shipped/cancelled override audit test only after explicit reviewed override scope

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Runtime audit logging should be rolled out behind a migration and feature flag if needed.
- Audit events must be append-only; rollback should disable new writes, not delete historical audit events.
- Never store raw credentials, full authorization headers, full provider token payloads, or unredacted label PDFs in audit rows.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and approve event names.
2. Add migration-owned `audit_events` table and audit service.
3. Implement credential and settings audit events first.
4. Implement billing/inventory/package audit events.
5. Implement durable job lifecycle events.
6. Scope label/order/shipped override audit separately with explicit review.
