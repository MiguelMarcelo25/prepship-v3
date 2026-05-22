# PrepShip DJ/OpenClaw Dev Task Packet

## Current State

- Branch: `prepshipv4-stable`
- Latest pushed commit before this inventory classification batch: `fe86fb5f`
- Worktree at last update: clean
- Latest implementation batch tracked here: Phase 9 table-first/lazy-load pass for Orders, Analysis, Inventory, Billing, and Packages
- Latest production read from user: Rate Browser and live app behavior look healthy after the recent deploys
- GitHub Actions:
  - `Keep Render API warm`: manual only now
  - `Sync ShipStation orders + shipments`: manual only now
  - `CI`: still runs on push/PR
- Render worker remains the primary background scheduler.
- New Phase 13 tracks the Supabase Auth 7-day maximum login session policy.

## Four DJ/OpenClaw Docs

| Document | Status | Percent | Why Not 100% |
|---|---|---:|---|
| `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md` | Created / active | 98% | Reporting metrics, Walmart selling-fee index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, low-risk orders/inventory indexes, durable job strategy, ShipStation Awaiting parity status, rate backfill status, billing reference-rate status, print queue batch/merge latest-run status, inventory source-of-truth policy, inventory dry-run reconciliation, dry-run artifact persistence, mismatch classification, and inventory repair/apply policy moved to documented ownership; actual owner-approved inventory repair implementation, label side effects, full job progress/events, artifact storage, and shipment-adjacent DDL cleanup still open |
| `ENTERPRISE_READINESS_AUDIT.md` | Created / active | 96% | Dashboard, Analysis, Inventory, Billing, Print Queue, Orders, Manifests, and label/shipment-sensitive route policy are now mapped; secrets governance, audit logging, reconciliation reporting, observability/alerting, runbook/DR planning, privacy/compliance, and production signoff are mapped; marketplace awaiting-count reconciliation and key operational latest-run statuses have guarded paths; still needs label/shipment runtime enforcement, broader runtime audit/reconciliation/alert implementation, DR drills, artifact durability, and authenticated production verification |
| `SECURITY_PATCH_PLAN.md` | Created / mostly implemented | 95% | Needs live auth smoke tests, strict JWT production rollout, label/shipment runtime enforcement after review, and broader field-level role/client-scope rollout |
| `RATE_SYSTEM_HARDENING_PLAN.md` | Created / mostly implemented | 78% | Needs browser production verification, duplicate-name UX polish, provider/account metrics, and full backfill progress/events beyond latest-run durability |

## Additional Phase 13 Doc

| Document | Status | Percent | Why Not 100% |
|---|---|---:|---|
| `JWT_SESSION_EXPIRATION_PLAN.md` | Created / production setting applied | 75% | Repo policy and guard exist, production Supabase dashboard evidence shows `168` hours, and production logout/login smoke passed; staging short-timebox proof and expired-session verification remain open |

## Official PS-010 Through PS-013 Task Track

These tasks are fixable, but they should be handled with different levels of scope and access.

| Task | Title | Fixability | Implementation Notes |
|---|---|---|---|
| PS-010 | Home/App Shell Chunk Split + Route Performance Pass | Directly fixable in code | Split the large `web/src/Home.tsx` shell into focused route, topbar, shell, status, and view-renderer modules. Preserve route behavior, lazy loading, RBAC, scope, and existing UI semantics. |
| PS-011 | Production Performance & Smoke Benchmarking | Directly fixable in tooling/docs | Add repeatable local performance and smoke benchmark commands plus production-safe documentation. This proves page-load improvements with evidence instead of relying only on bundle-size estimates. |
| PS-012 | Enterprise Readiness Closeout: Smoke, Audit, Alerts, Durable Jobs | Fixable in phases | Code/docs/guards can be added locally, but production evidence, CI billing/spend-limit resolution, Render/Supabase checks, alert destinations, restore drills, and secrets rotation may require DJ or account-owner access. |
| PS-013 | Source of Truth Matrix + Domain Ownership Hardening | Architecture hardening task | Define who owns truth for orders, order items, inventory, rates, carriers, labels/shipments, manifests, billing, reporting, clients/stores, sync, and settings. Add guardrails so future code does not create more source-of-truth drift. |

Recommended handling:

- PS-010 and PS-011 can be implemented directly by Lawrence/Codex with normal repo verification.
- PS-012 should be split into local hardening work plus access-dependent production evidence.
- PS-013 should start with a source-of-truth matrix and lightweight guards before any broad migration/refactor.

## Official PS-016 Through PS-018 Shipping + Site Functionality Test Track

DJ approved these as standalone tasks after confirming that code changes are not enough unless the real user workflow is tested. These tasks focus on shipping certification, marketplace confirmation, and full-site button/user-outcome coverage.

> Functionality rule: every critical-path task must build, then test the actual user workflow. A task is not complete until build/typecheck, unit/static guards, targeted functionality tests, and workflow/browser smoke tests pass. If the workflow still fails, iterate and retest before marking complete.

## Testing Gate Policy For All New Tasks

DJ's standing requirement for all projects and all future developer tasks:

- Build/typecheck must pass.
- Unit/static guards must pass.
- Targeted functionality tests must pass.
- Workflow/e2e/smoke tests must pass for the actual user outcome.
- If any check fails, the developer must iterate on the fix and rerun the failed check plus relevant surrounding coverage.
- A task is complete only with evidence: exact commands run, pass/fail results, and any manual/production validation still required.
- Code changes alone are not completion. The user-facing workflow must be proven.

This policy exists because previous changes could pass static guards while real PrepShip workflows still failed, especially shipping labels, print queue, marketplace confirmation, and Orders recovery.

## Shipped Data Unlock Safety Plan

DJ provided the explicit override phrase `unlock shipped data` on 2026-05-23 for the current shipping reliability work only. This unlock is narrow: it exists so PS-016 through PS-021 can fix or test label, queue, shipment, marketplace confirmation, and Orders recovery behavior where shipped/shipment paths are genuinely involved.

Rules:

- Touch shipped/cancelled or `shipments` paths only when the fix cannot be completed safely elsewhere.
- Keep `assertOrderEditable`, `LOCKED_STATUSES`, queue ownership, client/store scope, RBAC, secret redaction, and financial redaction intact.
- Do not re-enable destructive shipped/cancelled edit or batch mutation controls.
- Do not run SQL updates/deletes against real shipped/cancelled production orders.
- Do not delete/rewrite shipment history or destructively alter `orders` / `shipments` schema.
- Add a nearby code comment for any locked logic change: `Per user override unlock shipped data on 2026-05-23: ...`.
- Commit messages for locked logic changes must include: `Per user override unlock shipped data on 2026-05-23`.

Allowed if needed:

- `OrdersView.tsx`: shipped label reprint/queue validation, bad label URL handling, failure recovery, and Retry/error UI.
- `print-queue` routes/services: validate existing shipped label URLs, reject `[object Object]`, return clean per-label failures, and safely handle shipped-label queue/print flows.
- `shipments` schema/types: read/type additions only for diagnostics/tests, never destructive changes.

Required reporting for any task using the unlock:

- exact locked files touched
- why the unlock was necessary
- proof protections were not weakened
- tests run and pass/fail results
- confirmation no real labels/postage/live marketplace notifications occurred unless DJ approved
- confirmation no production shipped/cancelled data mutation occurred unless DJ separately approved

| Task | Title | Priority | Root Problem | Implementation Notes | Completion Gate |
|---|---|---|---|---|---|
| PS-016 | Shipping Label + Marketplace Confirmation Certification Harness | Critical | Static guards pass while core shipping can still hang or fail in real use. | Add read-only shipping inspector, preflight smoke, offline/test-label smoke, gated real-label certification, marketplace confirmation smoke, certification guard, and docs. | Must prove label creation, shipment persistence, status transition, label retrieval/reprint, outbox/marketplace confirmation state, and safe failure diagnostics without leaking secrets/PII or buying postage unless explicitly approved. |
| PS-017 | eBay Marketplace Shipment Confirmation Connector + Recovery Tests | Critical | eBay label purchase and eBay marketplace shipment notification are separate outcomes; eBay confirmation may be unsupported/incomplete in the outbox path. | Implement eBay `confirmShipment` support through the connector/outbox architecture, safe credential resolution, redacted errors, retry/idempotency handling where practical, tests/guards, and marketplace confirmation docs. | Must pass mocked/safe eBay confirmation tests proving success, missing credentials, missing tracking, redacted failure, outbox status transitions, shipment confirmation status, and no token/PII leaks. |
| PS-018 | Full-Site Button + User-Outcome Functionality Test Harness | High | Buttons can exist and click, but still fail the recipient/user's intended workflow. | Add site action matrix, stable selectors, Playwright full-site action suite, mocked API fixtures, site-action guard, and docs requiring every new user-facing action to define outcome/loading/success/error/role/scope coverage. | Must pass site-action guard, browser tests for critical actions, failure-state coverage, typecheck, and build. No real postage, marketplace notification, destructive production action, or shipped/cancelled mutation in tests. |

Recommended order:

1. PS-016 first - proves exactly where shipping breaks.
2. PS-017 second - fixes/guards the eBay marketplace notification gap.
3. PS-018 third - broadens coverage so broken buttons/workflows do not pass silently.

### PS-016 Copy/Paste Handoff

```md
PS-016 - Shipping Label + Marketplace Confirmation Certification Harness

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Priority: Critical

Context:
PrepShip V4 needs a safe certification harness for the full shipping critical path. Static/unit guards are not enough because label creation, shipment persistence, order status updates, label retrieval, marketplace confirmation, and UI loading states can still fail in real workflows.

Implementation:
- Add `scripts/inspect-shipping-order.ts` and `npm run inspect:shipping-order`.
- Add `scripts/smoke-shipping-preflight.ts` and `npm run smoke:shipping:preflight`.
- Add `scripts/smoke-shipping-test-label.ts` and `npm run smoke:shipping:test-label`.
- Add `scripts/smoke-shipping-real-label.ts` and `npm run smoke:shipping:real-label` with hard `--live-approved` safety.
- Add `scripts/smoke-marketplace-confirm.ts` and `npm run smoke:marketplace-confirm`.
- Add `scripts/shipping-certification-guard.mjs` and `npm run guard:shipping-certification`.
- Add `docs/shipping-certification-harness.md`.

Safety:
- Inspector/preflight must be read-only.
- No secrets, API keys, OAuth tokens, credentials, customer PII, raw labels, raw provider payloads, or cross-client data in logs/output.
- No real postage or live marketplace notification unless explicitly approved and gated.
- Do not weaken auth, RBAC, scope, shipped/cancelled lockdown, label safety, or credential protections.

Verification:
- `npm run guard:shipping-certification`
- `npm run inspect:shipping-order -- --help`
- `npm run smoke:shipping:preflight -- --help`
- `npm run smoke:shipping:test-label -- --help`
- `npm run smoke:shipping:real-label -- --help`
- `npm run smoke:marketplace-confirm -- --help`
- `npm run typecheck`
- `npm run build:web`
- `npm run test:test-order-queue-label`
- `npm run test:direct-carrier-labels`
- `npm run test:connector-architecture`
- `npm run test:runtime-ddl`
- `npm run test:raw-error-response-audit`

Return:
Files changed, new commands, what each command verifies, safety protections, redacted example output, commands run with pass/fail, and any live-label checks requiring DJ approval.
```

### PS-017 Copy/Paste Handoff

```md
PS-017 - eBay Marketplace Shipment Confirmation Connector + Recovery Tests

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Priority: Critical

Context:
eBay label creation and eBay marketplace shipment confirmation are separate outcomes. The fulfillment outbox can recognize marketplace providers, but eBay confirmation must be implemented and tested so eBay orders are marked shipped/fulfilled with tracking when supported.

Implementation:
- Confirm the current eBay support gap before changing code.
- Add/extend the eBay store connector with `confirmShipment`.
- Use existing credential/account resolution patterns; do not hardcode secrets.
- Wire `provider === 'ebay'` into fulfillment outbox state transitions.
- Persist success/failure to fulfillment outbox and shipment confirmation fields.
- Add mocked eBay tests/guards for success, missing credentials, missing tracking, redacted failure, retry/idempotency behavior, and unsupported provider behavior.
- Update marketplace confirmation docs and PS-016 smoke support if PS-016 is merged.

Safety:
- Do not expose OAuth tokens, refresh tokens, credentials, raw marketplace payloads, customer PII, or cross-client data.
- Do not weaken auth, RBAC, scope, shipped/cancelled lockdown, label safety, or credential protections.

Verification:
- `npm run guard:shipping-certification` if PS-016 exists
- `npm run smoke:marketplace-confirm -- --help`
- eBay mocked connector tests/guard
- `npm run test:connector-architecture`
- `npm run test:direct-carrier-labels`
- `npm run test:test-order-queue-label`
- `npm run test:raw-error-response-audit`
- `npm run typecheck`
- `npm run build:web`

Return:
Files changed, eBay connector behavior, outbox state transitions, tests/guards added, pass/fail commands, live eBay checks requiring DJ approval, and known limitations.
```

### PS-018 Copy/Paste Handoff

```md
PS-018 - Full-Site Button + User-Outcome Functionality Test Harness

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Priority: High

Context:
DJ wants a full functionality test of each button/action on the site. The goal is not only to prove that buttons exist or click, but that each button is coded according to what the recipient/user needs and that success, failure, loading, role, and scope behavior are correct.

Implementation:
- Create `docs/site-action-functionality-matrix.md`.
- Add stable `data-testid` selectors for critical actions where safe.
- Create `web/e2e/site-actions.spec.js`.
- Add `npm run test:site-actions:browser`.
- Create `scripts/site-action-functionality-guard.mjs`.
- Add `npm run guard:site-actions`.
- Add safe mocked Playwright fixtures for awaiting, shipped, cancelled, eBay, Walmart, existing-label, external-label, inventory, package, and client rows.
- Add `docs/site-action-testing.md`.
- Update dev policy: any new user-facing button/action must update the matrix and have coverage or an explicit manual/blocked reason.

Minimum coverage:
- Navigation/shell/auth/logout.
- Orders search/filter/sort/detail drawer.
- Print Label, Reprint Label, Send to Queue, Print Queue, batch actions.
- Inventory receive/restock/edit.
- Packages add/edit.
- Clients filters/actions/scope.
- Billing/invoice actions if present.
- Settings/carrier verify/test connection where present.
- Failure states for label creation and recoverable UI errors.

Safety:
- No real postage.
- No real marketplace notification.
- No destructive production actions.
- No shipped/cancelled mutation.
- Preserve auth, RBAC, scope, secret redaction, and label safety.

Verification:
- `npm run guard:site-actions`
- `npm run test:site-actions:browser`
- `npm run test:orders-ux:browser`
- `npm run test:inventory-ux:browser`
- `npm run test:maintenance-gate:browser`
- `npm run test:frontend-failure-states`
- `npm run typecheck`
- `npm run build:web`

Return:
Files changed, action matrix coverage, Playwright coverage, mock fixtures, guardrails, pass/fail commands, remaining uncovered actions with reason, and manual/live checks requiring DJ approval.
```

## Official PS-019 Through PS-021 Operations Reliability Task Track

DJ approved these tasks after the Walmart rates/label/print-queue incident and the temporary stuck Orders workflow. These are critical reliability tasks, and the completion rule is stricter than code-only completion:

> A task is not complete when code changes are written. It is complete only after build/typecheck, unit/static guards, targeted functionality tests, and workflow/smoke tests pass. If any check fails, iterate on the fix and rerun the failed check plus the relevant surrounding suite until passing.

| Task | Title | Priority | Root Problem | Implementation Notes | Completion Gate |
|---|---|---|---|---|---|
| PS-019 | Harden Walmart Direct Label + Print Queue + Orders Recovery Flow | Critical shipping reliability | Walmart/direct-carrier rates and labels can hang or return unsupported label payload shapes; print-to-queue can surface raw object/string/Buffer errors; Orders can appear stuck after the failed flow. | Add timeout support to `web/src/lib/vercelFunction.ts`; harden Walmart/direct label payload normalization; validate label URLs before queueing; harden print-queue merge input handling; improve request/job observability; make Orders recover with clear Retry/error states instead of endless skeletons. | Must pass `npm run typecheck`, `npm run build:web`, relevant label/queue/order guards, new targeted Walmart label/queue tests, and safe mocked workflow tests. |
| PS-020 | Production Self-Healing Watchdog + Deep Health + Ops Restart Runbook | Critical 24/7 operations reliability | Public `/health` and the Vercel app shell can be OK while the real operator workflow is wedged, leaving ops without dev coverage after hours. | Add `/health/ready` or `/health/deep`; add app-level Orders/queue readiness checks; add `scripts/production-watchdog.mjs`; support alert-only and restart-capable modes with thresholds/cooldowns; document Render restart/deploy-hook runbook; improve Orders UI failure recovery. | Must pass build/typecheck, existing observability/health/static guards, new deep-health/watchdog tests, safe mocked restart workflow tests, and no-secrets verification. |
| PS-021 | Verify and Fix Walmart Shipping Label Payload/Response Handling | Critical Walmart label reliability | Evidence suggests the outgoing Walmart payload may be valid, but incoming Walmart label/download response shapes can be object-shaped and unsafe extraction can turn them into `[object Object]`. | Inspect and document Walmart estimate/label request shapes; add sanitized diagnostics; replace unsafe `String(object)` label extraction in `api/carriers/labels.ts`; support nested URL/base64 label response shapes; prevent invalid label values from persistence or print queue; add direct Vercel timeout handling where needed. | Must pass `npm run typecheck`, `npm run test:direct-carrier-labels`, `npm run guard:shipping-certification`, `npm run guard:site-actions`, updated/new Walmart extraction guards, and safe mocked workflow verification. |

### PS-019 Copy/Paste Handoff

```md
PS-019 - Harden Walmart Direct Label + Print Queue + Orders Recovery Flow

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable

Context:
DJ reported Walmart rates eventually loaded, then Print to Queue failed with:

The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Object.

Observed Request ID:
`0cae0a34-9bcc-4014-b263-3f161a49dc43`

After that, Awaiting Shipment appeared stuck on LOADING ORDERS. Render `/health` was still OK, so this appears to be a workflow/API hang and recovery issue rather than a full backend death.

Primary code paths:
- `web/src/lib/vercelFunction.ts`
- `web/src/lib/v2-apiClient.ts`
- `web/src/components/Views/OrdersView.tsx`
- `api/carriers/labels.ts`
- `src/routes/print-queue.ts`
- `src/services/print-queue.ts`
- `web/src/hooks/v2Hooks.ts`
- `src/routes/orders.ts`

Suspected details:
- `callVercelFunction()` currently has no explicit timeout, while direct carrier rates/labels use that path.
- Walmart/direct label responses may include nested objects such as `{ pdf: { href: "..." } }` or `{ labelUrl: { href: "..." } }`.
- `api/carriers/labels.ts` uses Walmart label helpers including `buyLabelWalmartShipping()`, `walmartLabelDataUrlFromPayload()`, `findWalmartLabelString()`, and `firstString()`.
- Unsafe stringification can turn object-shaped payloads into `[object Object]`.
- Print queue paths such as `resolveLabelFetchUrl()`, `PDFDocument.load()`, and `Buffer.from()` need stricter input validation and clean per-label errors.

Implementation:
- Add bounded timeout handling to direct Vercel function calls.
- Harden Walmart/direct label payload extraction so objects cannot become `[object Object]`.
- Validate `response.labelUrl` before queueing.
- Harden print queue label URL/PDF handling with clear per-label failures.
- Add safe request/job logging with request IDs and no secrets/PII/raw labels.
- Ensure Orders recovers from label/queue failures with a clear error or Retry state.

Completion rule:
Not complete until build, unit/static guards, targeted functionality tests, and mocked workflow tests all pass. Iterate until passing.

Verification:
- `npm run typecheck`
- `npm run build:web`
- `npm run test:shipstation-label-url`
- `npm run test:direct-carrier-labels`
- `npm run test:test-order-queue-label`
- `npm run test:print-queue-durable`
- `npm run test:frontend-failure-states`
- `npm run test:orders-startup-requests`
- `npm run guard:shipping-certification`
- New Walmart/direct-label and queue failure tests

Targeted functionality tests must prove:
- nested Walmart/direct label payloads normalize to a queueable URL/PDF
- `[object Object]` is rejected
- invalid/short base64 is rejected
- Vercel function timeout path returns a clear error
- print queue rejects invalid label URLs without raw Buffer/string/Object errors
- Orders/label failure path does not enqueue bad labels and does not remain indefinitely loading

Return:
Root cause, files changed, implementation notes, exact commands and pass/fail results, workflow evidence, remaining risks, and confirmation no real labels/postage/live orders were used.
```

### PS-020 Copy/Paste Handoff

```md
PS-020 - Production Self-Healing Watchdog + Deep Health + Ops Restart Runbook

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable

Context:
PrepShip can be operationally stuck while public checks still pass:
- Render `/health` returns 200
- Vercel app shell loads

DJ needs 24/7 safeguards for ops hours when devs are unavailable.

Approval note:
PS-020 was first discussed as a proposed task only. It became official after DJ explicitly approved: "create 020 as a task." Future task creation still requires explicit DJ approval before assigning a new official PS number.

Implementation:
- Add `/health/ready` or `/health/deep` for app-level readiness.
- Include safe DB, Orders-query, print-queue, worker heartbeat, and timeout-budget checks.
- Add `scripts/production-watchdog.mjs`.
- Support alert-only mode and restart/redeploy mode only when Render credentials/deploy hook env vars are configured.
- Add thresholds, cooldowns, and max restarts to prevent loops.
- Document Render dashboard/API/deploy-hook restart steps.
- Improve Orders UI so failed API loads do not show endless skeletons.

Completion rule:
Not complete until build, unit/static guards, targeted functionality tests, and workflow/smoke tests all pass. Iterate until passing.

Verification:
- `npm run typecheck`
- `npm run build:web`
- `npm run test:observability-alerting`
- `npm run test:api-observability-metrics`
- `npm run test:operational-runbooks`
- `npm run guard:backend-connectivity`
- `npm run test:frontend-failure-states`
- `npm run test:orders-startup-requests`
- New deep-health/watchdog/restart-mode tests

Return:
Safeguards added, files changed, Render/Vercel config required, exact verification results, workflow evidence, manual ops steps, and confirmation no secrets/customer data/live labels were used.
```

### PS-021 Copy/Paste Handoff

```md
PS-021 - Verify and Fix Walmart Shipping Label Payload/Response Handling

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable

Context:
The Walmart Shipping label flow may not be sending a bad request. Evidence points to PrepShip mishandling Walmart's incoming label response shape. `api/carriers/labels.ts` has unsafe extraction behavior where object-shaped fields can become `[object Object]`.

Example problematic shape:

{
  "data": {
    "labelUrl": {
      "href": "https://example.com/label.pdf"
    }
  }
}

Implementation:
- Inspect and document Walmart estimate and label purchase request payload fields.
- Confirm sanitized outgoing Walmart fields including `purchaseOrderId`, `boxDimensions`, `boxItems`, `fromAddress`, `toAddress` where applicable, `returnAddress`, `packageType`, `carrierName`, `carrierServiceType`, `addOns`, `hasBattery`, `hazmat`, and `accountType`.
- Add sanitized diagnostics for request/response boundaries, logging only structural keys and timings.
- Replace unsafe `String(object)` label extraction.
- Support nested URL/base64/download shapes.
- Reject empty strings, `[object Object]`, non-string values, and unsupported shapes with sanitized operator-facing errors.
- Prevent invalid label values from persistence or print queue.
- Add/extend regression guards for nested Walmart label responses.

Important distinction:
This task must prove whether the problem is the outgoing Walmart request payload, the incoming Walmart response shape, or both. Do not blindly change Walmart request fields unless the field mismatch is proven by docs, existing repo comments, or sanitized diagnostics.

Completion rule:
Not complete until build, unit/static guards, targeted functionality tests, and workflow/smoke tests all pass. Iterate until passing.

Verification:
- `npm run typecheck`
- `npm run test:direct-carrier-labels`
- `npm run guard:shipping-certification`
- `npm run guard:site-actions`
- Updated/new Walmart extraction guard
- Safe mocked workflow test proving no live labels/postage/live order mutation occurred

Return:
Root cause proven, whether issue was outgoing payload or incoming response shape, files changed, sanitized payload fields confirmed/corrected, tests added, verification results, and remaining DJ-present production validation.
```

## Official PS-022 Full-Site Workflow Certification Task

DJ approved PS-022 after PS-018 revealed that the first site-action harness was useful but not strict enough. PS-022 supersedes and strengthens PS-018: a passing suite should mean the website works against controlled fixtures, critical actions are covered, expected API requests and payloads are verified, and live/provider actions remain separately gated.

| Task | Title | Priority | Root Problem | Implementation Notes | Completion Gate |
|---|---|---|---|---|---|
| PS-022 | Full-Site Workflow Certification Harness | Critical workflow certification | Current browser/action coverage can still pass while critical buttons are missing, expected API calls do not fire, payloads are not deeply asserted, or state transitions are only loosely mocked. | Convert PS-018 into a strict workflow certification gate: required action contracts, request ledger assertions, forbidden external-provider blocking, full shipping workflow fixture test, failure-state variants, role/scope checks, backend API contract guards, aggregate certification scripts, and docs clarifying mocked versus live-gated proof. | Must pass `npm run guard:site-actions`, `npm run test:site-actions:browser`, `npm run test:workflow-certification:browser`, `npm run test:api-contracts`, `npm run test:full-site-certification`, browser UX suites, frontend failure guards, shipping/label guards, typecheck, and build. No real labels, postage, live marketplace notifications, production mutations, secrets, raw labels, or PII exposure. |

### PS-022 Copy/Paste Handoff

```md
PS-022 - Full-Site Workflow Certification Harness

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable

Status:
This supersedes and strengthens PS-018. PS-018 started the site-action harness, but PS-022 turns it into a workflow certification gate.

Context:
DJ wants a full website functionality test where a pass means the app works against controlled fixtures. The goal is not just "buttons exist" or "buttons click." Every critical user-facing action must have a defined outcome, expected API request(s), expected request payload, success/loading/failure UI behavior, role/scope behavior, and forbidden side-effect rules.

Current gaps:
- Critical actions can be optional with patterns like "if button exists, click it."
- Missing critical buttons can still pass.
- Expected API requests and payloads are not strict enough.
- State transitions such as shipment/outbox/queue status are loosely mocked.
- The suite is not yet a "full pass = working website against controlled fixtures" certification gate.

Safety distinction:
Automated tests may prove the website works against mocked/sandbox fixtures. They must not create real labels, buy postage, send real marketplace notifications, mutate live production orders, update shipped/cancelled records, generate real invoices, expose secrets, or call live external providers. Any live provider or production certification must be a separate gated/manual command with explicit DJ approval.

Inspect first:
- `docs/site-action-functionality-matrix.md`
- `docs/site-action-testing.md`
- `web/e2e/site-actions.spec.js`
- `web/e2e/orders-ux.spec.js`
- `web/e2e/inventory-ux.spec.js`
- `web/e2e/maintenance-gate.spec.js`
- `scripts/site-action-functionality-guard.mjs`
- `scripts/frontend-failure-states-guard.mjs`
- `scripts/shipping-certification-guard.mjs`
- `scripts/direct-carrier-label-guard.mjs`
- `scripts/print-queue-invalid-label-guard.mjs`
- `scripts/smoke-shipping-preflight.ts`
- `scripts/smoke-shipping-test-label.ts`
- `scripts/smoke-marketplace-confirm.ts`
- `package.json`
- Main UI/action surfaces: Orders, Inventory, Packages, Billing, Settings/carrier/store account, Clients, Auth/session, Dashboard/navigation.
- Backend/API surfaces used by workflows: orders, carrier labels/rates, print queue, fulfillment outbox, inventory, packages, billing, account verify, health/deep readiness.

Implementation requirements:

1. Replace optional click coverage with required workflow contracts.
- Critical selectors must exist.
- If absent, the test must fail clearly.
- If intentionally unavailable for a role/status, assert that absence as expected behavior.

2. Upgrade `docs/site-action-functionality-matrix.md` into a strict action contract matrix.
- Required columns: page/view, action label, selector/test id, allowed roles, denied roles, fixture state before action, intended outcome, backend/API dependency, expected method/path, required payload fields, expected success response, loading state, success UI state, failure UI state, state transition, side-effect classification, test mode, covered spec/test name, uncovered/manual reason.
- Guard must fail if critical actions are missing required fields.

3. Add stable selectors/test IDs for critical actions where needed.
- Cover app shell navigation, auth/session, dashboard retry, orders search/filter/sort, order detail, rate browser, create/print label, reprint label, send to queue, batch actions, print queue merge/download/status, inventory receive/restock/edit, packages add/edit, clients filters/scope/actions, billing actions, carrier/store verify/sync, and maintenance/error retry controls.
- Do not weaken shipped/cancelled lockdown or re-enable forbidden controls.

4. Build a request ledger for Playwright tests.
- Record all API requests made during each workflow.
- Assert expected requests occurred.
- Assert method/path and important payload fields.
- Assert unexpected live external/provider requests did not occur.
- Assert payloads do not contain `[object Object]`.
- Assert no secrets/tokens/raw labels/base64 PDFs/customer PII are leaked into visible UI errors.
- Block live provider hosts including Walmart, eBay, ShipStation, and live carrier APIs unless intentionally mocked through route interception.

5. Add full shipping workflow certification test.
- Awaiting Shipment order -> detail -> rate/service if applicable -> create label -> shipment/label response -> send to print queue -> print queue merge/download/status -> fulfillment outbox/marketplace confirmation state -> row refresh/recovery state.
- Assert order appears, create-label button exists, create-label request fires with expected payload, response contains tracking and valid label URL, label URL is not `[object Object]`, queue request fires with expected payload, print/merge request fires, final job state succeeds, outbox state reaches queued/succeeded or expected mocked state, and UI loading/success states appear.

6. Add failure-state workflow variants.
- Label creation failure.
- Missing/invalid label URL.
- Object-shaped URL that would become `[object Object]` if unguarded.
- Print queue add failure.
- Print queue merge/PDF failure.
- Carrier/rate timeout.
- Orders API failure.
- Orders stuck/loading recovery with retry.
- Permission denied / scoped user cannot see or mutate another client/store.
- Shipped/cancelled rows do not expose forbidden mutation controls.

7. Add full-page smoke/navigation certification.
- Visit every critical route under mocked authenticated state.
- Assert page renders, no uncaught exceptions, no console errors except explicit allowlist, expected initial API requests fire, loading resolves, empty/error states are readable, and navigation works.
- Minimum pages: dashboard/home, orders/awaiting shipment, orders/shipped, orders/cancelled, inventory, packages, print queue, billing, clients, settings/integrations, maintenance/error page if present.

8. Add backend/API contract checks.
- Cover `/health`, `/health/ready` or `/health/deep`, `/init/stores`, `/init/counts`, `/orders`, `/orders/:id/full`, label create endpoints, rate endpoints, print queue add/print/merge/status/download, fulfillment outbox/marketplace status, inventory, packages, billing, and carrier/store account verify/test connection paths.
- Run against mocked/test fixtures or safe local test mode. Do not require production credentials.

9. Strengthen `scripts/site-action-functionality-guard.mjs`.
- Fail if the matrix misses required columns, critical actions lack selectors/test names, browser specs have optional skip logic for critical actions, request ledger assertions are missing, forbidden external host blocking is missing, loading/success/failure checks are missing, role/scope checks are missing, or package scripts are missing.

10. Add package scripts.
- Add or update: `guard:site-actions`, `test:site-actions:browser`, `test:workflow-certification:browser`, `test:api-contracts`, `test:full-site-certification`.
- `npm run test:full-site-certification` should run the site-action guard, API contract guard, browser workflow certification, orders UX browser test, inventory UX browser test, maintenance gate browser test, and frontend failure-state guard.
- Keep safe/mocked by default.

11. Keep live/sandbox provider checks separate and gated.
- Any live/sandbox command must require an explicit flag such as `--live-approved`, require explicit order/client/provider inputs, never default to production mutation, and document that DJ must approve/coordinate live order/label checks in the moment.

12. Update docs.
- Update `docs/site-action-testing.md`.
- Explain what full-site certification proves and what it does not prove.
- Include mocked versus sandbox versus live-gated modes, request ledger guidance, forbidden side effects, and pass/fail interpretation.

Full automated pass means:
- app shell loads
- auth/session works under fixture
- critical pages render
- critical actions exist or are correctly hidden by role/status
- expected API requests fire
- request payload contracts match
- loading/success/failure UI states work
- role/scope restrictions work
- forbidden external calls do not happen
- no secrets/PII/raw labels leak
- shipping workflow works against controlled fixtures

Full automated pass does NOT mean:
- every live carrier works right now
- every live marketplace credential is valid
- production DB has no bad data
- live postage/marketplace notification was tested

Guardrails:
- Do not create real labels.
- Do not buy postage.
- Do not send real marketplace notifications.
- Do not mutate live production orders.
- Do not update shipped/cancelled production records.
- Do not generate real invoices/charges.
- Do not expose secrets, tokens, credentials, raw provider payloads, raw label PDFs/base64, customer PII, or cross-client data.
- Do not weaken auth/RBAC/client/store scope.
- Do not weaken shipped/cancelled lockdown.
- Do not make critical actions optional in tests unless absence is the expected behavior being asserted.
- Do not use production credentials or live provider endpoints in automated certification.

Verification:
- `npm run guard:site-actions`
- `npm run test:site-actions:browser`
- `npm run test:workflow-certification:browser`
- `npm run test:api-contracts`
- `npm run test:full-site-certification`
- `npm run test:orders-ux:browser`
- `npm run test:inventory-ux:browser`
- `npm run test:maintenance-gate:browser`
- `npm run test:frontend-failure-states`
- `npm run guard:shipping-certification`
- `npm run test:direct-carrier-labels`
- `npm run test:print-queue-invalid-label`
- `npm run typecheck`
- `npm run build:web`

If a listed script does not exist before this task, add it or document the exact replacement command. If any command fails, fix the issue, rerun the failed command, and rerun the relevant surrounding suite. Do not mark complete until all required checks pass or a non-code environmental blocker is clearly documented.

Definition of done:
- PS-018's loose coverage is replaced/strengthened by strict workflow certification.
- Critical actions cannot silently skip because a button is missing.
- Every critical action has a matrix contract.
- Browser tests assert required API requests and payloads.
- Browser tests block unexpected live external provider calls.
- Full shipping workflow is covered from order to label to queue to print to confirmation/outbox using safe fixtures.
- Failure/retry states are covered.
- Role/scope and shipped/cancelled controls are covered.
- Backend/API contracts used by the UI are covered.
- Aggregate full-site certification command exists and passes.
- Docs clearly explain what a full pass proves and what still needs live-gated validation.
- No real labels, postage, marketplace notifications, production mutations, secrets, raw labels, or PII exposure occurred.

Return:
Summary of what the certification harness proves, what it does not prove without live-gated checks, files changed, critical workflows covered, API requests/payload contracts covered, failure states covered, role/scope cases covered, scripts added, verification pass/fail results, remaining uncovered actions with reason, and confirmation that no real labels/postage/live marketplace notifications/production mutations occurred.
```

## Phase Summary

| Phase | Status | Percent | Why Not 100% Yet |
|---|---|---:|---|
| Phase 1 - Runtime Architecture | Complete | 100% | Done |
| Phase 2 - Observability | Good start | 87% | Observability/alerting signal plan exists, Awaiting Shipment lag investigation is scoped, browser/API request IDs now flow through request headers, response headers, timing/error logs, detailed Orders list logs, opt-in browser API timing diagnostics, admin-only `/observability/api-timing` p95/p99 snapshots, an admin `/observability/status` status payload with lightweight DB ping, and a Settings System Status panel; needs external alerts, slow-query dashboard, and broader worker/rate/label health widgets |
| Phase 3 - Dashboard + Analysis Cleanup | Mostly complete | 86% | Dashboard Orders / Units KPI guard exists; needs production parity checks, remaining Analysis JSONB audit, and broader regression tests |
| Phase 4 - `order_items` Normalization | Mostly complete | 83% | Runtime schema bootstrap now checks migrations; needs production trigger/backfill verification and parity tests |
| Phase 5 - Reporting Read Models | Started | 30% | `analytics_cache` exists, but full dashboard/daily/SKU/inventory/billing read models are not complete |
| Phase 6 - Inventory Metrics | Partial | 65% | Inventory source-of-truth policy, read-only dry-run reconciliation, JSON/CSV artifact persistence, mismatch classification, and repair/apply control plan are documented and guarded; needs owner-approved repair implementation and precomputed sold/velocity/restock metrics |
| Phase 7 - Billing + Packages | Partial/good progress | 64% | Billing read surfaces now have client/store scope and billing reference-rate fetch latest-run durability; needs reconciliation, billing summary read model completion, package usage metrics, and package ledger hardening |
| Phase 8 - Shared Frontend Data Layer | Partial/good progress | 68% | Fresh-browser Inventory now defaults to active stock rows, and Receive Inventory loads the full selected-client SKU set with a guarded wide picker; needs standardized React Query hooks and remaining broad `safe()` fallback cleanup |
| Phase 9 - Lazy Loading + UI Performance | Partial | 74% | Awaiting Shipment startup-load risks are scoped, Orders support data is gated by user intent, global SKU lookup and daily stats are noncritical/lazy, first-page exact order counts are delayed until after the table paints, legacy sidebar counts no longer block first paint, Orders sync/worker polling is delayed and hidden-tab gated, global markups/settings hydration is delayed on Orders routes, New Order/order detail/tracking modal code loads only after user intent, Analysis table code is split into an on-demand chunk, Analysis rows paint before chart hydration, and Orders/Inventory/Analysis/Billing/Packages order-detail drawers lazy-load after user intent; needs fuller table-first loading, more lazy-loaded charts/export tools, remaining request timing evidence, and all-tool browser audit |
| Phase 10 - DJ/OpenClaw Security + Failure-State Hardening | Mostly complete | 98% | Unauthenticated production auth smoke checks passed and first runtime permission layer exists; dashboard/analysis/inventory/billing/print-queue/client/init/orders/manifests scoping started; raw-error response audit is mapped and guarded; non-shipment Vercel plus imported carrier compatibility raw-error route batches are patched; needs authenticated secret checks, label/shipment raw-error review, and label/shipment runtime enforcement after review |
| Phase 11 - Source-of-Truth + Duplication Audit | In progress | 98% | Reporting metrics, Walmart selling-fee index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, low-risk orders/inventory indexes, durable job strategy, ShipStation Awaiting parity status, rate backfill status, billing reference-rate status, print queue latest-run status, inventory source-of-truth policy, inventory dry-run reconciliation, dry-run artifact persistence, mismatch classification, and inventory repair/apply policy moved to documented ownership; actual inventory repair implementation, labels, full job events/artifacts, and shipment-adjacent DDL still remain |
| Phase 12 - Enterprise Readiness | Scoped/started | 98% | Dashboard, Analysis, Inventory, Billing, Print Queue, Orders, Manifests, and label/shipment-sensitive route policy are mapped; read/action ownership is implemented for explicit client/store JWT claims on key surfaces; `financials:read` now protects Analysis/Dashboard SKU financials, Inventory SKU-order shipping costs, Billing routes, Orders export/list label costs, Manifests label costs, Packages unit costs, and Rate Browser rate-result DTOs; Rate Browser account source metadata requires `credentials:read`; secrets governance, audit logging, reconciliation reporting, observability/alerting, runbook/DR planning, privacy/compliance, and production signoff are mapped; needs label/shipment runtime enforcement, broader runtime audit/reconciliation/alert implementation, DR drills, and owner signoff evidence |
| Phase 13 - JWT Session Expiration | Production setting applied | 75% | 7-day session policy is documented and guarded, Supabase Auth time-box is set to `168` hours, and production logout/login smoke passed; staging expiry proof and forced re-login evidence remain open | 
## Phase Checklist

### Phase 1 - Runtime Architecture: 100%

- [x] Vercel frontend
- [x] Render API
- [x] Render worker
- [x] Supabase DB/auth
- [x] API/worker runtime split
- [x] Worker owns background sync
- [x] Pg-boss/job queue foundation

### Phase 2 - Observability: 87%

- [x] API timing logs
- [x] `Server-Timing`
- [x] `/sync/status`
- [x] `/worker/status`
- [x] worker heartbeat/status basics
- [x] GitHub scheduled cron noise removed
- [x] `OBSERVABILITY_ALERTING_PLAN.md`
- [x] `npm run test:observability-alerting`
- [x] Admin-only `/observability/api-timing` p95/p99 API timing snapshot
- [x] Admin-only `/observability/status` runtime/API status payload
- [x] `/observability/status` includes lightweight DB ping timing
- [x] Settings System Status panel reads `/observability/status` lazily
- [x] `npm run test:api-observability-metrics`
- [x] Awaiting Shipment lag investigation scoped
- [x] `AWAITING_SHIPMENTS_PERFORMANCE_PLAN.md`
- [x] Render restart/startup maintenance bottleneck hypothesis added to the Awaiting plan
- [x] Startup orders performance maintenance no longer inherits from `RUN_SYNC_SCHEDULER`
- [x] orders performance maintenance is now explicit opt-in with `RUN_ORDERS_PERFORMANCE_MAINTENANCE=true`
- [x] `RUN_ORDERS_PERFORMANCE_MAINTENANCE=true` is required to run orders performance maintenance
- [x] `npm run test:orders-maintenance-startup`
- [x] `X-Request-Id` response header and timing/error log correlation
- [x] Request ID correlation for detailed `[orders:list]` segment timings
- [x] Browser API calls send request IDs and failed API errors include them
- [x] Opt-in browser `[api:client-timing]` diagnostics for slow/failed requests
- [ ] Check Render logs for `[orders:maintenance] ensured index`, `backfilled`, `repaired`, and `refreshed planner stats`
- [ ] Confirm `RUN_ORDERS_PERFORMANCE_MAINTENANCE` / `RUN_SYNC_SCHEDULER` production env ownership for API vs worker
- [ ] Capture browser Network timing for Awaiting page
- [~] Correlate Render `[api:timing]` and `[orders:list]` logs
- [ ] Correlate Supabase slow-query logs for the same timestamps
- [x] Add p95/p99 visibility for `/orders`, `/init/counts`, `/orders/daily-stats`, and `/orders/distinct-skus`
- [~] external alerts
- [x] p95/p99 API timing snapshot
- [~] slow DB query dashboard
- [x] Lightweight DB ping visible in Settings System Status
- [x] Settings System Status panel
- [ ] Broader internal status panel for worker, DB, sync, queue, rates, labels, billing, and reporting health

### Phase 3 - Dashboard + Analysis Cleanup: 86%

- [x] `/dashboard` route
- [x] dashboard summary/trends/top SKUs/inventory-risk endpoints
- [x] panel-level dashboard loading/errors
- [x] dashboard avoids giant raw order pulls
- [x] dashboard KPI cards show Orders / Units and have regression guard
- [ ] production parity checks
- [ ] remaining Analysis JSONB cleanup
- [ ] dashboard/analysis regression tests

### Phase 4 - `order_items` Normalization: 83%

- [x] `order_items` table
- [x] indexes
- [x] trigger/backfill/repair logic
- [x] dashboard/analysis/inventory hot paths partially moved
- [x] runtime schema bootstrap replaced with migration-readiness checks
- [ ] production trigger verification
- [ ] production backfill verification
- [ ] parity tests
- [ ] remaining JSONB analytics audit

### Phase 5 - Reporting Read Models: 30%

- [x] `analytics_cache`
- [x] reporting/read-model direction started
- [ ] dashboard summary metrics
- [ ] daily sales metrics
- [ ] SKU velocity metrics
- [ ] inventory risk metrics
- [ ] billing summary metrics

### Phase 6 - Inventory Metrics: 65%

- [x] `order_items` used in important inventory paths
- [x] lower-SKU index support started
- [x] inventory page pressure reduced
- [x] `INVENTORY_SOURCE_OF_TRUTH_PLAN.md`
- [x] `inventory_ledger` source-of-truth ownership documented
- [x] `inventory.stockQty` documented as materialized/cache balance
- [x] `npm run test:inventory-source-of-truth`
- [x] `inventory:reconcile:dry-run`
- [x] `npm run test:inventory-reconciliation-dry-run`
- [x] read-only ledger/cache/effective-stock reconciliation report
- [x] `INVENTORY_REPAIR_APPLY_PLAN.md`
- [x] `npm run test:inventory-repair-plan`
- [x] owner-approved repair/apply policy documented
- [x] dry-run mismatch classifications
- [x] `classificationCounts`, `recommendedAction`, and `safeToAutoRepair=false`
- [x] dry-run JSON/CSV artifact persistence
- [~] `inventory_ledger` source-of-truth enforcement
- [~] inventory reconciliation service
- [ ] owner-approved inventory repair/apply implementation
- [ ] precomputed sold/velocity/days-supply/restock metrics

### Phase 7 - Billing + Packages: 64%

- [x] generated billing line items exist
- [x] billing summary first-load failure no longer fakes `$0.00`
- [x] billing read endpoints apply explicit client/store scope claims
- [x] billing reference-rate fetch latest-run status persists to `settings`
- [x] `/packages` lightweight/paginated support
- [ ] billing reconciliation report
- [ ] billing summary read model
- [ ] package usage metrics
- [ ] package ledger/reporting hardening

### Phase 8 - Shared Frontend Data Layer: 68%

- [x] request storm reduced
- [x] hidden-tab/status pressure reduced
- [x] critical fetch guard added
- [x] counts/rates/billing failure-state behavior improved
- [x] fresh-browser Inventory Stock Levels defaults to active rows
- [x] Receive Inventory SKU picker loads all selected-client SKUs
- [x] Receive Inventory SKU picker widened for operator scanning
- [x] `npm run test:receive-sku-picker`
- [ ] standardize React Query hooks
- [ ] remove remaining broad `safe()` fallbacks
- [ ] visible retry/error states for every tool page

### Phase 9 - Lazy Loading + UI Performance: 74%

- [x] major route/view lazy loading
- [x] Orders side data delayed/lazy-loaded
- [x] Rate Browser cached/progressive direction started
- [x] Awaiting Shipment startup request audit scoped
- [x] Orders startup request guard added
- [x] Confirm `/orders/distinct-skus` is not required for initial Awaiting table paint
- [x] Confirm `/orders/daily-stats` is not blocking initial Awaiting table paint
- [x] Orders locations/carrier-account support data deferred until user intent
- [x] Legacy SidebarOrders initial counts delayed until after first paint
- [x] Legacy SidebarOrders count polling slowed and hidden-tab gated
- [x] Orders sync and worker status polling startup delays guarded
- [x] Orders route delays global markups/settings hydration
- [x] First-page exact order count delayed until after table paint
- [x] New Order modal lazy-loaded behind user intent
- [x] Order detail drawer lazy-loaded behind order-number intent
- [x] Tracking modal lazy-loaded behind tracking-number intent
- [x] Analysis data table lazy-loaded into its own chunk
- [x] Analysis table rows load before chart hydration
- [x] Billing and Packages order-detail drawers lazy-loaded behind user intent
- [x] Inventory and Analysis order-detail drawers lazy-loaded behind user intent
- [ ] Make Awaiting page table load first
- [~] Defer sidebar counts, daily stats, sync status, settings, locations, and packages until after first paint or user intent
- [x] Make exact order count delayed or optional when slow
- [x] Add startup request guard for Orders page
- [ ] lazy-load more drawers/modals/charts/export tools
- [ ] split very large frontend views
- [ ] browser audit all tool pages

### Phase 10 - DJ/OpenClaw Security + Failure-State Hardening: 98%

- [x] `/users` gated
- [x] protected root + wildcard route gates
- [x] `/admin` requires admin
- [x] optional strict JWT claims
- [x] client ShipStation secret redaction
- [x] `/aws-api` removed
- [x] mock label URLs signed/expiring
- [x] safer credential-handler 500s
- [x] auth/client/credential/frontend/orders guard tests
- [x] GitHub scheduled production crons disabled
- [x] first runtime RBAC permission guard for `/users`, settings, and credential surfaces
- [x] first dashboard aggregate client/store scope guard
- [x] first Analysis read client/store scope guard
- [x] first Inventory read client/store scope guard
- [x] first Billing read client/store scope guard
- [x] first Print Queue list client/store scope guard
- [x] first Print Queue action/job ownership guard
- [x] first Orders read/list/export client/store scope guard
- [x] first Manifests generate client/store scope guard
- [x] `RAW_ERROR_RESPONSE_AUDIT.md`
- [x] `npm run test:raw-error-response-audit`
- [x] first non-shipment raw-error route patch batch
- [x] imported carrier compatibility raw-error patch batch
- [~] live production auth smoke tests
- [x] deeper raw-error route audit
- [~] route-by-route raw-error response patches
- [ ] formal RBAC/client-scope enforcement

### Phase 11 - Source-of-Truth + Duplication Audit: 98%

- [x] `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`
- [x] shared JWT verifier
- [x] shared CORS helper
- [x] shared credential-account helper/service
- [x] auth coverage guard
- [x] frontend failure-state guard
- [x] carrier/store PATCH rename/approval consolidation
- [x] centralized rate cache key
- [x] persisted rate cache diagnostics
- [x] exact-or-approximate `/rates/cached/bulk`
- [x] normalized Rate Browser diagnostics
- [x] `RUNTIME_DDL_MIGRATION_AUDIT.md`
- [x] static runtime DDL guard
- [x] reporting metrics Drizzle migration
- [x] Walmart selling-fee source index moved to migration ownership
- [x] `store_orders` Drizzle migration
- [x] eBay/Walmart marketplace order handlers verify `store_orders` migration readiness instead of creating schema at request time
- [x] credential-account runtime DDL removed
- [x] credential-account RLS/readiness migration added
- [x] `order_items` / `analytics_cache` runtime DDL removed
- [x] order item trigger/function readiness moved to migration checks
- [x] low-risk orders/inventory performance index runtime DDL removed
- [x] remaining maintenance DDL narrowed to shipment-adjacent index fallback
- [x] `DURABLE_JOBS_PLAN.md`
- [x] `npm run test:durable-jobs-plan`
- [x] ShipStation Awaiting parity durable last-run status in `settings`
- [x] Rate backfill durable latest-run status in `settings`
- [x] `/rates/backfill-best/latest`
- [x] `npm run test:rate-backfill-durable`
- [x] Billing reference-rate durable latest-run status in `settings`
- [x] `/billing/fetch-ref-rates/status` includes `durableJob`
- [x] `npm run test:ref-rates-durable`
- [x] Print queue batch-send durable latest-run status in `settings`
- [x] Print queue PDF-merge durable latest-run status in `settings`
- [x] `/print-queue/batch-send/status/:jobId` includes scoped matching `durableJob`
- [x] `/print-queue/print/status/:jobId` includes scoped matching `durableJob`
- [x] `npm run test:print-queue-durable`
- [x] `INVENTORY_SOURCE_OF_TRUTH_PLAN.md`
- [x] inventory source-of-truth policy and guard
- [x] `npm run test:inventory-source-of-truth`
- [x] `inventory:reconcile:dry-run`
- [x] `npm run test:inventory-reconciliation-dry-run`
- [x] `INVENTORY_REPAIR_APPLY_PLAN.md`
- [x] `npm run test:inventory-repair-plan`
- [x] classified inventory reconciliation mismatches
- [x] dry-run classification counts and row-level recommended actions
- [x] Walmart/eBay marketplace order pullers use shared JWT/CORS helpers
- [x] `npm run test:marketplace-order-auth-cors`
- [x] Direct eBay/Walmart marketplace status drift is separated from ShipStation PS-001
- [x] Stale synthetic marketplace awaiting rows can reconcile to shipped/cancelled when `store_orders` has a terminal status and no real ShipStation row owns the order number
- [x] `npm run test:marketplace-reconciliation`
- [~] runtime DDL migration cleanup
- [~] inventory source-of-truth cleanup
- [~] full durable job progress/events and artifact storage
- [ ] label side-effect status reporting
- [ ] remaining legacy JWT/CORS copies cleanup
- [ ] carrier/store endpoint policy final verification

### Phase 12 - Enterprise Readiness: 98%

- [x] `ENTERPRISE_READINESS_AUDIT.md`
- [x] critical/high/medium issue buckets scoped
- [x] `RBAC_CLIENT_SCOPE_MATRIX.md`
- [x] canonical enterprise role names defined
- [x] RBAC/client-scope route matrix completed for planning
- [x] first runtime RBAC permission middleware for `/users`, settings, carrier accounts, and carrier verification
- [x] `npm run test:rbac-permissions`
- [x] first client/store scope helper for explicit JWT `clientIds` / `storeIds`
- [x] `/clients` list/detail scope filtering for scoped users
- [x] `/init/init-data` and `/init/stores` client/store payload scope filtering
- [x] `npm run test:client-store-scope`
- [x] `/dashboard` summary/daily-counts/SKU panels/inventory-risk scope filtering for scoped users
- [x] dashboard cache keys include client/store scope
- [x] `npm run test:dashboard-client-scope`
- [x] `/analysis` overview/daily-shipments/top-skus/SKU breakdown/SKU daily scope filtering for scoped users
- [x] `npm run test:analysis-client-scope`
- [x] `/inventory` list/ledger/stats/alerts/detail/detail-ledger/parents/SKU-orders scope filtering for scoped users
- [x] `npm run test:inventory-client-scope`
- [x] `/billing` config/summary/details/invoice/package-prices scope filtering for scoped users
- [x] `npm run test:billing-client-scope`
- [x] `/print-queue` list scope filtering for scoped users
- [x] `npm run test:print-queue-client-scope`
- [x] `/print-queue` add/clear/delete/print/status/download ownership checks for scoped users
- [x] `npm run test:print-queue-ownership`
- [x] `/orders` list/daily-counts/dashboard-sales/ids/store-counts/daily-stats/picklist/distinct-skus/by-number/detail/full/export scope filtering for scoped users
- [x] `/manifests/generate` GET/POST scope filtering for scoped users
- [x] `npm run test:orders-manifests-scope`
- [x] `financials:read` permission added for financial field visibility
- [x] Analysis/Dashboard top-SKU financial fields redact without `financials:read`
- [x] Inventory SKU-order shipping-cost fields redact without `financials:read`
- [x] Billing routes require `financials:read`
- [x] `npm run test:field-level-rbac`
- [x] Orders export/list label costs redact without `financials:read`
- [x] Manifests label costs redact without `financials:read`
- [x] Packages unit costs redact without `financials:read`
- [x] Rate Browser rate money fields redact without `financials:read`
- [x] Rate Browser account source metadata requires `credentials:read`
- [x] `npm run test:field-level-rbac-extended`
- [x] `LABEL_SHIPMENT_SCOPE_REVIEW.md`
- [x] `npm run test:label-shipment-scope-review`
- [x] `SECRETS_GOVERNANCE_MATRIX.md`
- [x] `npm run test:secrets-governance`
- [x] `AUDIT_LOGGING_MATRIX.md`
- [x] `npm run test:audit-logging`
- [x] `RECONCILIATION_REPORTS_PLAN.md`
- [x] `npm run test:reconciliation-plan`
- [x] marketplace status reconciliation dry-run/apply script
- [x] direct eBay marketplace awaiting drift is tracked as marketplace reconciliation, not ShipStation sync
- [x] `npm run test:marketplace-reconciliation`
- [x] `OBSERVABILITY_ALERTING_PLAN.md`
- [x] `npm run test:observability-alerting`
- [x] `/observability/api-timing` API timing snapshot
- [x] `/observability/status` runtime/API status payload
- [x] `npm run test:api-observability-metrics`
- [x] `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`
- [x] `npm run test:operational-runbooks`
- [x] `PRIVACY_COMPLIANCE_PLAN.md`
- [x] `npm run test:privacy-compliance`
- [x] `PRODUCTION_READINESS_SIGNOFF.md`
- [x] `npm run test:production-signoff`
- [x] `DURABLE_JOBS_PLAN.md`
- [x] `npm run test:durable-jobs-plan`
- [x] `npm run test:ref-rates-durable`
- [x] Print queue latest-run durable status in `settings`
- [x] `npm run test:print-queue-durable`
- [ ] label/shipment runtime scope enforcement after review
- [~] secrets governance
- [~] audit logging
- [~] reconciliation reports
- [~] runtime DDL backlog/inventory
- [~] durable jobs
- [~] observability/alerts
- [~] deployment/rollback/DR runbooks
- [~] privacy/compliance checklist
- [~] production readiness signoff checklist

### Phase 13 - JWT Session Expiration: 75%

- [x] Policy chosen: 7-day maximum Supabase session lifetime
- [x] Access JWTs remain short-lived, preferably current/default 1 hour
- [x] `JWT_SESSION_EXPIRATION_PLAN.md`
- [x] `npm run test:jwt-session-policy`
- [x] Backend keeps current JWT `exp` validation through `jose`
- [x] `STRICT_JWT_CLAIMS` stays staged behind env flag
- [x] Supabase dashboard value documented as `168` hours for 7 days
- [x] Configure Supabase Auth time-box user sessions to `168` hours / 7 days
- [x] Production logout/login smoke passed after setting change
- [ ] Verify expired-session behavior in staging with a short temporary time-box
- [ ] Verify production login and forced re-login behavior after rollout
- [ ] Add production evidence to `PRODUCTION_READINESS_SIGNOFF.md`

## Recommended Next Order

1. Finish production verification after this batch deploys.
   - Confirm GitHub no longer creates new scheduled cron failures.
   - Confirm Render API and worker are deployed on the latest pushed commit.
   - Confirm Rate Browser stays healthy across several awaiting-shipment orders.
2. Finish auth/security smoke tests.
   - [x] `/users` unauthenticated returns `401`.
   - [x] `/clients` unauthenticated returns `401`.
   - [ ] non-admin `/admin/*` returns `403`.
   - [ ] `/clients` and `/init/init-data` with a valid token do not expose ShipStation secrets.
3. Browser-audit all tools.
   - Orders, Dashboard, Inventory, Clients, Packages, Rate Shop, Analysis, Settings, Billing, Manifests.
4. Run the Awaiting Shipment performance investigation before any AWS or archive decision.
   - Capture Browser Network timing for first load.
   - Correlate Render `[api:timing]` and `[orders:list]` logs.
   - Search Render logs for `[orders:maintenance]` during the slowdown window and confirm whether startup index/backfill/analyze work overlapped user traffic.
   - Confirm API `RUN_ORDERS_PERFORMANCE_MAINTENANCE` is not enabled unless a maintenance window is intended.
   - Correlate Supabase slow-query logs for the same timestamp.
   - Confirm whether the blocker is `/orders`, `/init/counts`, `/orders/daily-stats`, `/orders/distinct-skus`, settings/locations/packages, worker pressure, or frontend render.
   - Only implement table-first loading, delayed exact counts, or archive/hot-window changes after the confirmed bottleneck is known.
5. Continue Phase 11 with the next safest batch.
   - Apply and smoke-test `drizzle/0030_store_orders.sql` before marketplace order imports rely on it.
   - Apply and smoke-test `drizzle/0031_credential_accounts_rls.sql` before carrier/store credential routes rely on it.
   - Apply and smoke-test `drizzle/0024_order_items_phase2.sql` and `drizzle/0025_order_items_sync_trigger.sql` before order item analytics/backfill rely on them.
   - Confirm existing performance migrations `0021`, `0022`, `0023`, and `0026` are applied before relying on runtime maintenance cleanup.
   - Keep label/outbox/shipment-adjacent DDL deferred to a separate reviewed plan.
   - Review `INVENTORY_REPAIR_APPLY_PLAN.md` and the classified inventory dry-run output with DJ/OpenClaw before implementing any repair/apply mode.
   - Add JSON/CSV dry-run artifact persistence before any owner-approved inventory repair/apply command.
   - Review `DURABLE_JOBS_PLAN.md` with DJ/OpenClaw and approve durable job storage target.
   - Durable job state implementation for print queue/rate backfill/ref-rate jobs.
   - Label side-effect status reporting.
6. Continue Phase 12.
   - Review `RBAC_CLIENT_SCOPE_MATRIX.md` with DJ/OpenClaw.
   - Review `SECRETS_GOVERNANCE_MATRIX.md` with DJ/OpenClaw and assign credential owners.
   - Review `AUDIT_LOGGING_MATRIX.md` with DJ/OpenClaw and approve audit event names.
   - Review `RECONCILIATION_REPORTS_PLAN.md` with DJ/OpenClaw and approve report ownership.
   - Review `OBSERVABILITY_ALERTING_PLAN.md` with DJ/OpenClaw and approve alert owners/thresholds.
   - Review `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md` with DJ/OpenClaw and approve runbook owners.
   - Review `PRIVACY_COMPLIANCE_PLAN.md` with DJ/OpenClaw and approve data-class owners.
   - Review `PRODUCTION_READINESS_SIGNOFF.md` with DJ/OpenClaw and approve release gates.
   - Deploy and smoke-test the runtime RBAC, client/init scope, dashboard scope, analysis scope, inventory scope, billing scope, and print-queue list/action scope layer.
   - Implement remaining label/shipment runtime scope enforcement in a separate reviewed batch.
   - Audit logging.
   - Reconciliation reports.
   - Observability alerts.
   - Runbooks and disaster recovery.
7. Continue Phase 13.
   - Production Supabase Auth time-box is set to `168` hours / 7 days.
   - Keep access JWT expiry short; do not set access JWT lifetime to 7 days.
   - Run staging short-timebox proof before production rollout.
   - Capture production login and expired-session evidence in the signoff checklist.

## Verification Commands

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
- `npm run test:raw-error-response-audit`
- `npm run test:rbac-permissions`
- `npm run test:client-store-scope`
- `npm run test:dashboard-client-scope`
- `npm run test:analysis-client-scope`
- `npm run test:inventory-client-scope`
- `npm run test:billing-client-scope`
- `npm run test:print-queue-client-scope`
- `npm run test:print-queue-ownership`
- `npm run test:orders-manifests-scope`
- `npm run test:field-level-rbac`
- `npm run test:field-level-rbac-extended`
- `npm run test:label-shipment-scope-review`
- `npm run test:secrets-governance`
- `npm run test:audit-logging`
- `npm run test:reconciliation-plan`
- `npm run test:marketplace-reconciliation`
- `npm run test:observability-alerting`
- `npm run test:api-observability-metrics`
- `npm run test:operational-runbooks`
- `npm run test:privacy-compliance`
- `npm run test:production-signoff`
- `npm run test:durable-jobs-plan`
- `npm run test:inventory-source-of-truth`
- `npm run test:inventory-reconciliation-dry-run`
- `npm run test:inventory-repair-plan`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:rate-system-hardening`
- `npm run test:runtime-ddl`
- `npm run test:jwt-session-policy`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`
- `npm run test:orders-startup-requests`

## Assumptions

- Render worker is the primary scheduler.
- GitHub Actions should stay CI-only.
- Manual GitHub workflow buttons can remain for emergency recovery.
- Browser extension console errors are external and not counted as PrepShip bugs.
- Shipped/cancelled mutation protections remain locked unless the exact override phrase is given again.
- `DUPLICATION_OPTIMIZATION_AUDIT.md` is retained as a legacy pointer only.
- Phase 13 enforces a 7-day login session through Supabase Auth session settings, not through 7-day access JWTs.
