# PrepShip Security Patch Plan

## Executive Summary

This plan tracks the immediate security patch work discussed by DJ/OpenClaw. It focuses on route auth coverage, admin enforcement, secret redaction, safer public errors, JWT hardening, unsafe route review, JWT/session expiration policy, and production smoke tests.

Several patches are already implemented and guarded locally. The first runtime RBAC permission layer is also implemented for `/users`, settings, carrier accounts, and carrier verification, with explicit client/store scope filtering started for `/clients`, `/init`, `/dashboard`, `/analysis`, `/inventory`, `/billing`, and `/print-queue` list/action ownership. The first secrets governance, audit logging, and reconciliation plan matrices are also created. Remaining work is mostly production verification, remaining operational route scoping, runtime audit/reconciliation implementation, credential rotation/last-used tracking, and deeper raw-error review.

Phase 13 adds `JWT_SESSION_EXPIRATION_PLAN.md`: PrepShip should enforce a 7-day maximum login session through Supabase Auth time-boxed sessions while keeping access JWTs short-lived.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| `/users` route exposure | Supabase Auth users can be listed if route is public | `/users` and `/users/*` require auth, with admin policy decided | `npm run test:auth-coverage` plus live unauth smoke test |
| root-only route auth gaps | `/clients` or `/orders` root can bypass wildcard-only middleware | protected route roots and wildcards require auth | auth coverage guard plus live unauth smoke tests |
| admin endpoint access | valid non-admin users can reach admin operations | `/admin` and `/admin/*` require admin | static guard plus live non-admin token test |
| client secret exposure | ShipStation credentials can leak to browser | public client DTO redacts secrets and returns booleans | `npm run test:client-redaction` plus live `/clients` smoke test |
| raw internal error leakage | DB/upstream details can leak to browser | generic 500s, detailed server logs only | route audit and forced-failure tests |

## High-Risk Issues

| Area | Current Status | Risk | Recommended Patch |
|---|---|---|---|
| `/users` auth | [x] root and wildcard auth guarded; root list now requires `users:manage` | production non-admin smoke test still needed | verify non-admin cannot list users and `/users/me` still works |
| protected route roots/wildcards | [x] static auth coverage guard | production tokens still need smoke tests | test unauth root and wildcard requests after deploy |
| `/admin` enforcement | [x] `requireAdmin` root and wildcard guarded | production non-admin smoke test still needed | test non-admin token returns `403` |
| client redaction | [x] `/clients` and `/init/init-data` guarded by mapper tests | future endpoints can return raw clients if not audited | route audit for all client-returning endpoints |
| JWT strict claims | [x] optional strict issuer/audience support exists | strict mode needs staged token compatibility check | enable `STRICT_JWT_CLAIMS=true` only after login/token test |
| JWT session expiration | [x] 7-day session policy documented and Supabase time-box set to `168` hours | Expired-session UX still needs staging/prod proof | keep access JWTs short-lived and prove expired sessions return to login cleanly |
| safe errors | [~] credential handlers use safer generic 500s | wider route handlers may still return `err.message` | audit and patch raw error responses |
| unsafe proxy | [x] `/aws-api` rewrite removed | confirm no external workflow depends on it | production route/rewrite smoke test |
| mock labels | [x] signed/expiring mock label URLs | confirm no real PII enters mock labels | route review and sample response check |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| RBAC | first permission layer exists and client/init/dashboard/analysis/inventory/billing/print-queue list/action scoping has started, but operational route row scoping is not complete | continue route-by-route client/store scope implementation |
| client scoping | authenticated users may need row-level/client-level limits | add client/store scope policies and tests |
| credential governance | matrix exists, but rotation, last-used, and audit events are not complete | central credential audit events and rotation process |
| audit logging | event matrix exists, but append-only audit table/service is not implemented | add audit events for credential/admin/business-critical changes |
| reconciliation | report plan exists, but read-only report queries and repair dry-runs are not implemented | add reconciliation reports for orders, billing, inventory, packages, rates, and fulfillment |
| logs | secrets/tokens need log scan | add redaction policy and log scan checklist |
| runtime DDL | credential tables still have compatibility bootstrap paths | move DDL to migrations |

## Recommended Patches

- [x] Gate `/users`.
- [x] Protect root and wildcard paths for protected modules.
- [x] Require admin for `/admin` and `/admin/*`.
- [x] Add `npm run test:auth-coverage`.
- [x] Redact `ssApiKey`, `ssApiSecret`, and `ssApiKeyV2`.
- [x] Add `hasShipStationV1Credentials` and `hasShipStationV2Credentials`.
- [x] Add `npm run test:client-redaction`.
- [x] Remove unsafe `/aws-api` raw-IP rewrite.
- [x] Make mock label URLs signed/expiring.
- [~] Return generic production-safe 500s for credential handlers.
- [ ] Audit remaining route handlers that return raw `err.message`.
- [ ] Run production auth smoke tests.
- [x] Decide and enforce admin/user-management policy for `/users` root list.
- [x] Build first formal RBAC permission middleware.
- [x] Add `npm run test:rbac-permissions`.
- [x] Add first client/store scope helper and low-risk `/clients` + `/init` filters.
- [x] Add `npm run test:client-store-scope`.
- [x] Add dashboard aggregate row-scope query filters.
- [x] Add `npm run test:dashboard-client-scope`.
- [x] Add Analysis direct endpoint row-scope query filters.
- [x] Add `npm run test:analysis-client-scope`.
- [x] Add Inventory read endpoint row-scope query filters.
- [x] Add `npm run test:inventory-client-scope`.
- [x] Add Billing read endpoint row-scope query filters.
- [x] Add `npm run test:billing-client-scope`.
- [x] Add Print Queue list endpoint row-scope query filters.
- [x] Add `npm run test:print-queue-client-scope`.
- [x] Add Print Queue action/job ownership checks.
- [x] Add `npm run test:print-queue-ownership`.
- [x] Add `SECRETS_GOVERNANCE_MATRIX.md`.
- [x] Add `npm run test:secrets-governance`.
- [x] Add `AUDIT_LOGGING_MATRIX.md`.
- [x] Add `npm run test:audit-logging`.
- [x] Add `RECONCILIATION_REPORTS_PLAN.md`.
- [x] Add `npm run test:reconciliation-plan`.
- [x] Add `JWT_SESSION_EXPIRATION_PLAN.md`.
- [x] Add `npm run test:jwt-session-policy`.
- [ ] Build remaining operational route row-scope query filters.
- [ ] Add audit logs for credential and admin actions.

## Checklist

### Auth Coverage

- [x] `/users`
- [x] `/users/*`
- [x] `/orders` and `/orders/*`
- [x] `/clients` and `/clients/*`
- [x] `/packages` and `/packages/*`
- [x] `/inventory` and `/inventory/*`
- [x] `/billing` and `/billing/*`
- [x] `/rates` and `/rates/*`
- [x] `/settings` and `/settings/*`
- [x] `/analysis` and `/analysis/*`
- [x] `/dashboard` and `/dashboard/*`
- [x] `/manifests` and `/manifests/*`
- [x] `/worker` and `/worker/*`
- [x] `/sync` and `/sync/*`
- [x] `/admin` and `/admin/*`

### Secret Redaction

- [x] shared public client mapper
- [x] `/clients`
- [x] `/clients/:id`
- [x] client create/update responses
- [x] `/init/init-data`
- [x] frontend credential-presence booleans
- [ ] live `/clients` response check after deploy
- [ ] live `/init/init-data` response check after deploy

### Production Smoke Tests

- [ ] unauthenticated `/users` returns `401`
- [ ] unauthenticated `/clients` returns `401`
- [ ] unauthenticated protected wildcard route returns `401`
- [ ] non-admin `/admin/*` returns `403`
- [ ] `/clients` with token has no ShipStation secrets
- [ ] `/init/init-data` with token has no ShipStation secrets
- [ ] normal login still works with current JWT settings
- [ ] strict JWT claims tested before production enablement
- [x] Supabase Auth time-box user sessions is set to `168` hours / 7 days
- [ ] access JWT expiry remains short-lived, preferably current/default 1 hour
- [ ] expired-session behavior returns users to login cleanly

## Test Plan

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
- `npm run test:rbac-permissions`
- `npm run test:client-store-scope`
- `npm run test:dashboard-client-scope`
- `npm run test:analysis-client-scope`
- `npm run test:inventory-client-scope`
- `npm run test:billing-client-scope`
- `npm run test:print-queue-client-scope`
- `npm run test:print-queue-ownership`
- `npm run test:secrets-governance`
- `npm run test:audit-logging`
- `npm run test:reconciliation-plan`
- `npm run test:jwt-session-policy`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`
- Live curl/browser tests for unauth, non-admin, and secret-redaction cases.

## Deployment/Rollback Notes

- Keep `STRICT_JWT_CLAIMS=false` until production token compatibility is verified.
- Keep access JWT expiry short; do not set access JWT lifetime to 7 days.
- Enforce the 7-day login limit through Supabase Auth time-boxed sessions.
- In the Supabase dashboard, enter `168` in the time-box field because the field is measured in hours.
- Deploy auth/secret changes separately from broader client/store row-scope changes.
- If production login breaks after strict claims are enabled, disable `STRICT_JWT_CLAIMS` and redeploy/restart.
- If a route starts returning unexpected 401/403, check root/wildcard route registration and token audience/issuer first.
