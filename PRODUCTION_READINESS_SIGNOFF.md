# PrepShip Production Readiness Signoff Checklist

## Executive Summary

This Phase 12 deliverable defines the final signoff gates PrepShip should satisfy before a release is considered production-ready or enterprise-ready. It pulls together code checks, browser checks, API auth/security checks, Render/Vercel/Supabase checks, migration checks, data parity checks, observability checks, and owner approvals.

This is a planning/control batch only. It does not change runtime behavior, database state, shipped/cancelled logic, label side effects, inventory mutations, or deployment automation.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No single release signoff checklist | Releases can pass tests but miss production smoke or owner approval | One release gate checklist with evidence links | Completed checklist for each release |
| Manual deploys can skip verification | API, worker, and frontend may not be on the same known-good commit | Commit/version parity checks for Vercel, Render API, and Render worker | Deployment commit evidence |
| Production checks are not formalized | Browser/API/Supabase issues can be missed after deploy | Required post-deploy smoke tests | Recorded smoke-test results |
| Enterprise controls need owner approval | Planning docs can exist without business/security acceptance | Owner signoff for security, ops, billing, inventory, and platform controls | Signoff table completed |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Release evidence | Local tests are strong, production smoke is manual | Passed code can still fail after deploy | Record test outputs and production smoke results |
| Version parity | Frontend/API/worker deploys are manual | Version skew can cause browser/API errors | Verify deployed commit for all services |
| Auth/security | Guards exist locally | Misconfigured production env can bypass intended behavior | Production auth/security smoke tests |
| Data correctness | Reconciliation plans exist | Metrics/billing/inventory can drift silently | Parity checks and reconciliation owner approval |
| Operational readiness | Runbooks and alerts are planned | Incidents can still lack response ownership | Confirm alert/runbook owners before signoff |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| GitHub Actions billing | CI may be blocked by billing/spend limits | Treat GitHub CI status separately from local verification until billing is resolved |
| Browser extensions | External extension console errors can distract reviews | Signoff should separate PrepShip-owned errors from extension errors |
| Manual records | Evidence can live only in chat screenshots | Store signoff notes in a release checklist or issue |
| Rollback readiness | Rollback may be possible but not rehearsed | Attach rollback plan to every risky release |
| Migration status | App code can rely on unapplied migrations | Add migration applied checklist before deploy signoff |

## Signoff Matrix

| Gate | Required Evidence | Owner | Status Before Release | Verification |
|---|---|---|---|---|
| Local typecheck | `npm run typecheck` exit 0 | Dev owner | required | command output |
| Web build | `npm run build:web` exit 0 | Dev owner | required | command output |
| Security guards | auth, RBAC, redaction, credential tests pass | Security owner | required | guard output |
| Frontend failure guards | frontend failure-state and orders UX tests pass | Frontend owner | required | guard output |
| Rate system guard | rate hardening test passes and Rate Browser smoke passes | Rate owner | required | guard output + browser smoke |
| API auth smoke | unauth `/users` and `/clients` return 401; non-admin `/admin/*` returns 403 | Security owner | required | API smoke output |
| Secret response smoke | `/clients` and `/init/init-data` do not expose raw ShipStation secrets | Security owner | required | API response sample |
| Browser tools smoke | Orders, Dashboard, Inventory, Clients, Packages, Rate Shop, Analysis, Settings, Billing, Manifests load | Product/Ops owner | required | browser checklist |
| Version parity | Vercel frontend, Render API, Render worker on expected commit | Release owner | required | deploy evidence |
| Render logs | no repeated 30s timeouts, 499 storm, or API 5xx spike | Platform owner | required | log review |
| Supabase health | CPU, memory, connections stable | DB owner | required | dashboard review |
| Supabase session policy | Auth time-box user sessions set to `168` hours / 7 days; access JWT remains short-lived | Security owner | required | Supabase Auth settings screenshot + login smoke |
| Migration status | required Drizzle migrations applied | DB owner | required when schema changes | migration log |
| Reconciliation checks | required parity reports reviewed or deferred with owner approval | Data owner | required before enterprise signoff | report evidence |
| Alert/runbook readiness | owners assigned for alerts/runbooks | Ops owner | required before enterprise signoff | owner table |
| Rollback readiness | rollback path identified for frontend/API/worker/migrations | Release owner | required | rollback note |

## Release Evidence Template

| Field | Value |
|---|---|
| Release date/time | |
| Git commit | |
| Vercel frontend deploy | |
| Render API deploy | |
| Render worker deploy | |
| Migrations applied | |
| Local checks passed | |
| Browser smoke passed | |
| API auth/security smoke passed | |
| Render/Supabase health reviewed | |
| Supabase session policy reviewed | 2026-05-20 screenshot shows time-box user sessions = `168` hours; user-confirmed production logout/login smoke passed after setting change |
| Known issues/deferred risks | |
| Rollback plan | |
| Final owner approval | |

## Recommended Patches

- [ ] Add this checklist to the release workflow and require it for major deploys.
- [ ] Create a lightweight release issue/template with the Release Evidence Template.
- [ ] Add a production smoke script or documented command set for auth/security checks.
- [ ] Add a browser smoke checklist for every tool page.
- [ ] Add migration-applied evidence to every schema-changing deploy.
- [ ] Add owner approval fields for security, platform, data, ops, and product.
- [x] Record Phase 13 Supabase session policy evidence: production dashboard shows `168` hours.
- [x] Record Phase 13 production logout/login smoke evidence after the session policy change.

## Test Plan

- `npm run test:production-signoff`
- Future implementation tests:
  - release template contains commit, deploy, migration, smoke, health, rollback, and owner fields
  - production smoke script verifies unauthenticated protected routes reject access
  - browser smoke checklist covers every tool page
  - migration checklist is required for schema changes

## Deployment / Rollback Notes

- This checklist is planning-only and safe to deploy with documentation and guard changes.
- Signoff should not block emergency hotfixes, but emergency deploys should document skipped checks and complete post-deploy verification.
- Rollback should be chosen before deployment, not during the incident.
- GitHub Actions failures caused by billing/spending limits should not be confused with code failures, but should be tracked as a platform readiness issue.

## Recommended Implementation Order

1. Review this checklist with DJ/OpenClaw and approve required gates.
2. Convert the Release Evidence Template into a reusable GitHub issue or markdown release note.
3. Add production smoke commands for auth/security and route health.
4. Add browser smoke checklist ownership for all tool pages.
5. Require migration evidence for schema-changing deploys.
6. Use the checklist for the next manual Render/Vercel deploy and refine it from the results.
