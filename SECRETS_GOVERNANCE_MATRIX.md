# PrepShip Secrets Governance Matrix

## Executive Summary

This Phase 12 deliverable turns the secrets/credential governance item into a concrete control matrix. PrepShip already has several important protections: protected route roots, admin/permission gates on credential surfaces, client ShipStation secret redaction, shared credential-account handlers, migration-owned credential tables, production-safe credential-handler 500s, and redaction guards.

The remaining work is enterprise governance rather than one bug fix: define ownership for each credential class, add rotation and last-used tracking, add audit events for credential changes, scan logs for accidental secret output, and verify production responses with real tokens.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No formal credential rotation workflow | Compromised carrier/store/client credentials may stay active too long | Document and implement rotation process per credential class | Rotation runbook and credential update audit test |
| Credential change audit logs are incomplete | Cannot prove who changed production credentials | Append-only audit events for create/update/delete/verify actions | Audit-log tests for carrier/store/client credential edits |
| Last-used tracking is incomplete | Hard to know whether a credential is stale or actively used | Track last successful use and last failure by account/source | DB fields or metrics plus route/service tests |
| Production secret exposure must be smoke-tested | Local guards do not prove deployed responses are safe | Verify `/clients`, `/init/init-data`, carrier/store endpoints, and logs in production | Manual/API smoke tests after deploy |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Client ShipStation keys | Redacted from `/clients` and `/init/init-data`; guarded by `npm run test:client-redaction` | A future endpoint could return raw client rows | Keep shared `publicClient` mapper and expand API response tests |
| Carrier/store account credentials | Shared service and safer handlers exist; raw secrets should stay server-side | Drift between Vercel/Render adapters or logs could expose provider credentials | Add response-shape tests and credential audit events |
| Marketplace OAuth tokens | Stored in store credential JSON and used by marketplace sync/OAuth flows | Token refresh/update actions may lack audit and rotation controls | Add audit events, last-used timestamps, and redacted error handling |
| Supabase service role/JWT secret | Backend-only by env convention | Misconfigured frontend/env logs could leak privileged keys | Env validation, log redaction, and deployment secret inventory |
| Label/mock URLs | Mock labels use signed expiring URLs | Real label PDFs/URLs need access and retention policy | Define label PDF retention/access runbook |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Logs | Provider errors may include raw upstream text | Add central secret redaction helper for logs |
| Direct carrier credentials | Provider-specific storage/rotation varies | Normalize credential metadata through shared credential-account policy |
| Token refresh failures | OAuth refresh can fail without a business-facing runbook | Add runbook and alert for repeated provider auth failures |
| Field-level UI policy | Operators may need credential presence without values | Keep boolean presence fields and mask placeholders |
| Migration/readiness | Credential tables are migration-owned, but production migration status must be verified | Add production migration checklist to deploy runbook |

## Credential Matrix

| Credential Type | Storage Location | Current Protection | Exposure Risk | Required Owner | Rotation / Last-Used Gap | Audit / Logging Gap | Status |
|---|---|---|---|---|---|---|---|
| Supabase service role key | Render/Vercel env only | Backend convention; not returned by APIs | Critical if copied into frontend env or logs | Platform/admin owner | Rotation runbook needed | Log/env exposure scan needed | [~] |
| Supabase JWT secret/JWKS config | Render API env / Supabase JWKS | Optional strict claims and shared verifier exist | Inconsistent verification if legacy paths drift | Backend owner | Staged strict rollout needed | Auth failures should log safely | [~] |
| Default ShipStation v1 key/secret | Render worker/API env | Server-only; used by sync/shipments | Critical if logged or returned | Fulfillment ops owner | Rotation and last-used tracking needed | Sync/rate/label auth failures need redaction | [ ] |
| Default ShipStation v2 key | Render worker/API env | Server-only; used by rates/labels | Critical if logged or returned | Fulfillment ops owner | Rotation and last-used tracking needed | Rate/label failure metrics needed | [ ] |
| Client ShipStation keys | `clients` table fields | API redaction and client-redaction guard exist | Future raw client response could leak keys | Backend/API owner | Rotation history not formalized | Client credential update audit missing | [x]/[~] |
| Carrier account credentials | `carrier_accounts.credentials` | Shared service, auth gates, migration readiness, generic 500s | Adapter drift or raw response/log leak | Credential service owner | Last-used and rotation fields missing | Create/update/delete audit missing | [~] |
| Store account credentials | `store_accounts.credentials` | Shared service, auth gates, migration readiness, generic 500s | Marketplace token/secret leak | Credential service owner | Last-used and rotation fields missing | Create/update/delete/OAuth audit missing | [~] |
| eBay OAuth refresh token | `store_accounts.credentials` | Server-side OAuth callback updates row | Token refresh/update lacks enterprise audit | Marketplace owner | Rotation/re-auth runbook needed | OAuth callback audit missing | [ ] |
| Walmart/Amazon marketplace secrets | `store_accounts.credentials` / env where applicable | Server-side sync handlers | Raw upstream error text could expose provider details | Marketplace owner | Rotation/last-used tracking needed | Provider failure metric/audit needed | [ ] |
| Direct carrier credentials/OAuth | Carrier-specific credential records/env | Provider-specific handling | Inconsistent redaction and diagnostics | Carrier integrations owner | Normalize last-used and rotation fields | Provider/account-level metrics needed | [ ] |
| Label PDFs and signed URLs | Provider URLs / mock signed URLs | Mock URLs signed/expiring | Real labels are PII-bearing artifacts | Fulfillment ops owner | Retention/access policy needed | Access/download audit needed | [~] |

## Recommended Patches

- [x] Keep `/clients` and `/init/init-data` on the shared public client serializer.
- [x] Keep carrier/store account handlers on shared credential-account parsing and DB services.
- [x] Keep credential handlers returning production-safe generic 500s.
- [ ] Add append-only audit events for credential create/update/delete/verify/OAuth callback actions.
- [ ] Add `last_used_at`, `last_success_at`, and `last_failure_at` style metadata where credential use is business-critical.
- [ ] Add a shared log redaction helper for tokens, API keys, secrets, authorization headers, and OAuth payloads.
- [ ] Add production smoke tests that verify credential endpoints and init/client payloads never return secret fields.
- [ ] Add credential rotation and provider re-auth runbooks.

## Test Plan

- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:rbac-permissions`
- `npm run test:secrets-governance`
- Production smoke checks with a valid token:
  - `/clients` does not return `ssApiKey`, `ssApiSecret`, or `ssApiKeyV2`.
  - `/init/init-data` does not return ShipStation secrets.
  - Carrier/store account responses do not return raw secret values unless a specific admin-only write payload is being submitted.
  - Render/Vercel logs do not print authorization headers, provider tokens, or raw credential JSON.

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Do not add encryption, rotation, or schema fields without a migration and rollback plan.
- Roll out any strict JWT or credential policy change behind an env flag where practical.
- If a credential response regression is detected, roll back the API immediately and rotate exposed provider credentials.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and assign owners.
2. Add audit events for credential writes and OAuth callbacks.
3. Add credential last-used metadata for carrier/store/client credential usage.
4. Add log redaction helper and scan provider error logging.
5. Write rotation/re-auth runbooks.
6. Run production smoke checks after every credential-surface deploy.
