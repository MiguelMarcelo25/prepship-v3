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

## Official PS-035 Through PS-040 Certification, Orders, Shipping, Package, and Billing Track

DJ added this task packet on 2026-05-29. The detailed implementation handoffs are tracked in `docs/ps-035-through-ps-040-task-packet.md`.

| Task | Title | Priority | Root Problem | Completion Gate |
|---|---|---|---|---|
| PS-035 | Build Complete PrepShip Full-Workflow Certification Coverage Matrix | High | Passing full-site certification is not yet a complete operator workflow certification. | Coverage matrix plus stronger `test:full-workflow-certification` command with mocked/offline browser/API workflow coverage and documented remaining gaps. |
| PS-036 | Fix ShipStation Sync + Make Orders Column Integrity Mandatory E2E | Critical | ShipStation v1 timezone/date formatting can skip shipment rows, causing false `Ext. Label` displays and revealing an Orders column-integrity certification gap. | Fixed ShipStation date formatting, dry-run missed-shipment recovery, honest missing-sync UI state, and permanent Awaiting/Shipped column-integrity E2E assertions. |
| PS-037 | Save/Auto-Apply Package Defaults by Client SKU+Qty Combination | High | Mixed-SKU package defaults need exact client + SKU/qty combination matching instead of polluting SKU-level defaults. | New combo-default model/endpoints/UI behavior, Hugrab-style E2E coverage, and regression proof that multi-SKU saves do not overwrite individual SKU defaults. |
| PS-038 | Flag Expedited Shipping Orders in Awaiting Shipment + Shipped Tables | High | Operators need visible SLA warning for requested expedited shipping before and after label creation. | Centralized expedited detection, Orders payload flag/label, Order Date badge, red row highlight, and API/UI/E2E certification coverage. |
| PS-039 | Investigate + Backfill Order #1010 Shipment Metadata From ShipStation Shipment #289653129 | Critical | Order `1010` incorrectly shows `Ext. Label` even though DJ confirmed a real ShipStation shipment exists. | Sanitized read-only investigation, dry-run-first repair output for shipment `289653129`, targeted regression coverage, and no write-mode backfill without DJ approval. |
| PS-040 | Fix Billing Detail Item Qty Display + Repair Missing Shipment/Box Linkage | Critical | Billing Detail drops per-line qty and stale billing rows can miss shipment/box/shipping data after shipment sync gaps. | Qty suffix display, dry-run-first billing shipment-linkage repair, recurrence tests, and proof Billing Detail shows carrier/box/shipping after approved repair/regeneration. |

Safety for this track:

- Do not run production write-mode backfills or billing repairs without DJ approval of dry-run output.
- Do not buy postage, create/void labels, or send marketplace/customer notifications in tests.
- Do not expose secrets, raw provider payloads, raw labels, customer PII, or cross-client data.
- Keep shipped/cancelled lockdown protections intact; use the narrow shipped-data override rules only where explicitly allowed by `AGENTS.md`.

### PS-035 Certification Commands (delivered 2026-05-29)

The full coverage matrix for all workflow checkpoints (A–P) lives in
[`docs/full-workflow-certification-matrix.md`](docs/full-workflow-certification-matrix.md).
Two certification commands now exist:

- `npm run test:full-site-certification` — unchanged pre-existing site smoke
  (typecheck + web build + site-action/API guards + 5 Playwright browser specs
  + frontend failure states). **Requires a running dev server** for Playwright.
- `npm run test:full-workflow-certification` — **stronger superset**: runs
  `test:full-site-certification`, then `test:workflow-suites`.
- `npm run test:workflow-suites` — the **offline behavioral core**: 69 guards
  across checkpoints A–P via [`scripts/run-workflow-certification.mjs`](scripts/run-workflow-certification.mjs),
  with **no running server, no live providers, no real DB**. Runnable in plain
  CI. 69/69 pass as of 2026-05-29.

New PS-035 guards: `test:order-editable-lockdown` (backend shipped/cancelled
mutation-rejection — checkpoint L) and `test:order-readiness-preflight`
(label weight/ship-to/terminal/duplicate preflight — checkpoint D).

To add a future checkpoint: add an offline `test:*` guard, register it in
`scripts/run-workflow-certification.mjs`, and update the matrix. Browser-only or
live/DJ-supervised suites stay OUT of the offline core (see the matrix's
EXCLUDED section). Remaining behavioral gaps are tracked as PS-035-F1…F10
follow-ups in the matrix; one item (Walmart sidebar count parity) needs DJ
confirmation, not a code change.

## Official PS-041 Through PS-042 ShipStation Sync + Billing UI Coverage Track

DJ added this task packet on 2026-05-29. The detailed implementation handoffs are tracked in `docs/ps-041-through-ps-042-task-packet.md`.

| Task | Title | Priority | Root Problem | Completion Gate |
|---|---|---|---|---|
| PS-041 | Fix ShipStation Timezone Sync Gap + Add Mandatory E2E/Live-Path Coverage Standard | Critical | ShipStation v1 timezone-less date windows can skip recent account-local/PT orders, as seen with HUGRAB/store `378060` orders `1042` through `1045`; future fixes also need appropriate workflow/live-path coverage. | Root-cause-confirmed ShipStation date-window fix, safe dry-run recovery path, focused timezone/query-window tests, live-path/dry-run reconciliation, and updated certification standard for applicable fixes. |
| PS-042 | Fix Billing Summary Total Row Column Alignment + Add E2E Coverage | High | Billing summary Total row values are visually misaligned under their intended columns. | Root-cause-confirmed table/footer alignment fix with browser E2E proving Total cells align under the matching headers/body cells across supported table states. |

Safety for this track:

- Do not buy postage, create labels, void labels, or notify marketplaces in tests.
- Do not mutate shipped/cancelled/terminal orders without DJ approval of the exact operation.
- Do not expose secrets, raw provider payloads, raw labels, customer PII, or cross-client data.
- Keep auth/RBAC, client/store scope, source-of-truth, financial redaction, secret redaction, and shipped/cancelled lockdown intact.

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

## Official PS-023 Post-Certification Codebase Cleanup Task

DJ approved PS-023 as the cleanup/refactor task to run only after PS-022 full-site workflow certification is implemented and passing. The goal is to reduce spaghetti hotspots without rewriting the app or changing product behavior.

| Task | Title | Priority | Sequence | Root Problem | Implementation Notes | Completion Gate |
|---|---|---|---|---|---|---|
| PS-023 | Post-Certification Codebase Architecture Cleanup: Reduce Spaghetti Hotspots Without Rewriting the App | High maintainability | Start only after PS-022 passes | PrepShip V4 has good overall structure, but operator-critical behavior is concentrated in very large files such as `OrdersView.tsx`, `InventoryView.tsx`, `v2-apiClient.ts`, carrier label/rate handlers, and order routes. | Make small, reviewable extractions after PS-022 provides a safety net. Prioritize `OrdersView.tsx`; extract pure helpers, presentational components, typed mappers, isolated hooks, and response normalizers; reduce high-risk `any`; centralize provider/API shape normalization; preserve behavior exactly. | Must prove PS-022 was passing before refactor begins, then pass typecheck, web build, site-action guard, browser workflow tests, PS-022 certification scripts, and any touched shipping/rate/label/print-queue targeted guards. |

### PS-023 Copy/Paste Handoff

```md
PS-023 - Post-Certification Codebase Architecture Cleanup: Reduce Spaghetti Hotspots Without Rewriting the App

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Sequence: Start only after PS-022 full-site workflow certification is implemented and passing.

Context:
PrepShip V4 is not globally spaghetti code, but several operator-critical workflows have become too large and fragile. The repo has good structure overall: `src/routes`, `src/services`, `src/lib`, `src/connectors`, `web/src/components`, `web/e2e`, and many safety guards. The risk is that major business behavior is concentrated in oversized files.

Known hotspots:
- `web/src/components/Views/OrdersView.tsx` - roughly 9k+ lines
- `web/src/components/Views/InventoryView.tsx` - roughly 4k+ lines
- `web/src/lib/v2-apiClient.ts`
- `web/src/components/Views/DashboardView.tsx`
- `web/src/components/Settings/CarrierIntegrationsCard.tsx`
- `web/src/components/RateBrowserModal.tsx`
- `src/routes/orders.ts`
- `src/services/labels.ts`
- `api/carriers/labels.ts`
- `api/carriers/rates.ts`

Goal:
Do not rewrite the app. Reduce regression risk after PS-022 gives us a workflow safety net.

Inspect first:
- `web/src/components/Views/OrdersView.tsx`
- `web/src/components/Views/InventoryView.tsx`
- `web/src/lib/v2-apiClient.ts`
- `web/src/components/RateBrowserModal.tsx`
- `web/src/components/Settings/CarrierIntegrationsCard.tsx`
- `src/routes/orders.ts`
- `src/services/labels.ts`
- `api/carriers/labels.ts`
- `api/carriers/rates.ts`
- `web/e2e/site-actions.spec.js`
- PS-022 workflow certification files/tests once available
- Existing hooks/utilities in `web/src/hooks`, `web/src/lib`, `web/src/utils`, `src/services`, `src/lib`, and `src/connectors`

Implementation requirements:

1. Do not rewrite the app.
- Allowed: extract pure helper functions, presentational subcomponents, typed mappers/normalizers, hooks for isolated UI state, API response types, shared domain helpers, and duplicated logic.
- Forbidden: full page rewrites, routing architecture replacement, wholesale React Query/API client replacement, database schema changes unless explicitly necessary and approved, provider behavior changes unless covered by failing workflow evidence.

2. Prioritize `OrdersView.tsx`.
- Start with low-risk extractions such as order status/tab helpers, column definitions, date/filter helpers, row formatting helpers, selection/bulk-action helpers, print queue UI helpers, toast/message formatters, pure mapping functions, and small presentational components.
- Avoid touching label purchase behavior unless protected by PS-022 and existing shipping tests.

3. Preserve behavior exactly.
- This is cleanup/refactor, not a feature task.
- UI, API calls, order actions, label behavior, queue behavior, auth behavior, and error states must remain functionally identical.
- If behavior changes are discovered as necessary, stop and document them instead of silently changing them.

4. Improve type safety.
- Reduce high-risk `any` usage where practical, especially around orders, shipments, rates, labels, provider payloads, print queue entries, and marketplace confirmation payloads.
- Do not chase every `any` in the repo. Focus on types that reduce real workflow risk.

5. Centralize provider/API shape normalization.
- Where safe, introduce or improve typed normalization helpers so frontend and backend are not guessing provider payload shapes separately.
- Priority areas: rate response shape, label creation response shape, print queue entry shape, shipment/label URL shape, and marketplace confirmation status shape.

6. Keep business rules out of giant React components.
- Move low-risk business logic out of view files into hooks, pure utilities, service helpers, and typed mappers.
- React components should become more focused on rendering and interaction wiring.

7. Do not weaken safety boundaries.
- Do not weaken or bypass auth, RBAC, client/store scope, source-of-truth constraints, secret redaction, financial redaction, shipped/cancelled lockdown, label safety, credential protections, or production safeguards.
- Do not expose secrets, API keys, provider credentials, raw labels, raw customer data, or cross-client data in logs, tests, screenshots, or summaries.

Required verification:
- Confirm PS-022 certification is already passing before starting.
- `npm run typecheck`
- `npm run build:web`
- `npm run guard:site-actions`
- `npm run test:site-actions:browser`
- PS-022 commands once available, likely:
  - `npm run test:workflow-certification:browser`
  - `npm run test:api-contracts`
  - `npm run test:full-site-certification`
- Relevant targeted guards depending on touched files:
  - `npm run guard:shipping-certification`
  - `npm run test:direct-carrier-labels`
  - `npm run test:print-queue-invalid-label`
  - `npm run test:ebay-confirmation:mocked`
  - `npm run test:production-watchdog`
  - `npm run test:health-deep-readiness`

If any test fails, fix the issue and rerun the failed command plus the relevant surrounding suite.

Definition of done:
- PS-022 is already passing before this task begins.
- The largest hotspot files are measurably improved or have a documented staged refactor plan.
- At minimum, `OrdersView.tsx` has meaningful low-risk extraction/refactor work completed.
- Behavior is preserved.
- No auth/RBAC/client-scope/shipping/label/marketplace safety boundary is weakened.
- Typecheck passes.
- Web build passes.
- Existing site-action guard passes.
- Browser workflow test passes.
- PS-022 full-site certification still passes after refactor.
- Any touched shipping/rate/label/print queue code is covered by relevant targeted guards.

Return:
Summary of what was refactored, files changed, behavior preserved or changed, risk areas reviewed, type-safety improvements, commands run with pass/fail results, follow-up refactor recommendations, and confirmation that PS-022 certification still passes.
```

## Official PS-024 Walmart Shipment Confirmation Follow-Up Task

DJ approved PS-024 after a live Walmart Shipping label/print-queue test showed that label creation and print queue can work while Walmart Seller Center still shows the order as not fully marked shipped. This task is a critical real-test follow-up and is scoped only to Walmart shipment confirmation after Walmart Shipping label creation.

| Task | Title | Priority | Live signal | Scope | Required evidence |
|---|---|---|---|---|---|
| PS-024 | Verify and Harden Walmart Shipment Confirmation After Walmart Shipping Label Creation | Critical real-test follow-up | Live Walmart test for order `200014621589900` created/printed a label and tracking, but Walmart Seller Center still appeared to expose `Mark as shipped`. | Read-only inspect the existing order first; classify whether confirmation succeeded, failed, stayed pending, or was never enqueued; harden Walmart confirmation so live payloads use verified Walmart PO/order-line data and do not silently guess. | No duplicate label/postage; no unsafe duplicate Walmart confirmation without DJ approval; sanitized inspection evidence; hardened Walmart confirmation payload/diagnostics; targeted tests/guards; typecheck/build and relevant PS-022/site/shipping checks pass. |

### PS-024 Copy/Paste Handoff

```text
PS-024 - Verify and Harden Walmart Shipment Confirmation After Walmart Shipping Label Creation

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Priority: Critical real-test follow-up
Status: New task from live Walmart label/print-queue test.

Context:
DJ performed a live controlled Walmart test:
- Walmart order/customer order reference: 200014621589900
- The order came from ShipStation.
- DJ used the Walmart carrier / Walmart Shipping path.
- Print to queue worked.
- Walmart shows a tracking number.
- However, Walmart Seller Center still appears to show the "Mark as shipped" action as active/not completed.

PrepShip currently has code intended to mark Walmart shipped after label creation:
- api/carriers/labels.ts: confirmWalmartOrderShipped(...), confirmWalmartSourceOrderAfterLabelSql(...), and the Walmart Shipping label path around provider walmart_shipping.
- src/connectors/store/walmart.ts: confirmShipment(...).
- src/services/fulfillment/outbox.ts: retryable fulfillment_outbox shipment confirmation worker.

Goal:
Do not create another label. Inspect the existing live order safely, determine exactly where confirmation state is stuck, and harden the Walmart confirmation path so "label created" does not falsely imply "Walmart marked shipped."

Safety guardrails:
- Do not create another live label for this order.
- Do not buy postage.
- Do not void labels unless DJ explicitly approves.
- Do not send duplicate Walmart marketplace shipment confirmations unless DJ explicitly approves the exact retry.
- Do not expose Walmart credentials, tokens, raw customer address, customer PII, raw provider payloads containing PII, raw labels/PDF/base64, or full tracking numbers in public logs unless already approved by DJ.
- Use sanitized summaries only.
- Read-only inspection first.

Files to inspect first:
- api/carriers/labels.ts
- src/connectors/store/walmart.ts
- src/services/fulfillment/outbox.ts
- scripts/inspect-shipping-order.ts
- scripts/smoke-marketplace-confirm.ts
- scripts/direct-carrier-label-guard.mjs
- scripts/test-order-queue-label-guard.mjs
- docs/prepship-shipping-production-audit.md
- docs/marketplace-confirmation.md
- web/src/components/Views/OrdersView.tsx

Relevant functions/areas:
- resolveWalmartLabelContext(...)
- walmartBoxItems(...)
- walmartShipmentOrderLines(...) / Walmart confirmation body builder
- confirmWalmartOrderShipped(...)
- confirmWalmartSourceOrderAfterLabelSql(...)
- buyLabelWalmartShipping(...)
- Walmart Shipping path around providerKey === 'walmart_shipping'
- createWalmartStoreConnector().confirmShipment(...)
- enqueueShipmentConfirmation(...)
- processFulfillmentOutboxOnce(...)

Phase 1 - Read-only production inspection:
For order 200014621589900, inspect live state without mutation:
npm run inspect:shipping-order -- --order-number 200014621589900

If the script requires env vars, run it only in the production-capable environment. Do not print secrets.

Inspect and report sanitized values for orders, store_orders, shipments, and fulfillment_outbox, including IDs, provider/status fields, whether raw Walmart order data and line numbers exist, masked tracking, confirmation status/error, payload purchaseOrderId, payload line numbers, carrier/service, and timestamps. Do not print PII, raw labels, tokens, or raw payloads.

Phase 2 - Decide current failure mode:
Classify the live order as one of:
1. confirmation_status = succeeded and marketplace_confirmed_at populated -> likely Walmart Seller Center delay/UI confusion.
2. confirmation_status = pending and outbox pending -> worker/outbox processing issue.
3. confirmation_status = failed or outbox failed -> payload/credential/API issue.
4. No Walmart confirmation row/metadata exists -> enqueue/confirmation path did not run.
5. Payload used guessed/fallback data -> harden runtime logic to avoid blind confirmation.

Phase 3 - Harden Walmart confirmation payload:
For live Walmart shipment confirmation, do not silently guess if real Walmart order data is unavailable.

Implement safer behavior:
1. Require a real Walmart purchaseOrderId.
2. Require real Walmart order lines for live confirmation: rawOrder.orderLines.orderLine[] and valid lineNumber for each shippable line.
3. If raw order lines are missing, attempt to fetch/refresh the Walmart order using purchaseOrderId, customerOrderId, orders.order_number, and store_orders.
4. If order lines still cannot be resolved, do not send guessed Walmart /shipping payload. Mark shipment confirmation as failed or blocked with a sanitized error: Cannot mark Walmart shipped: missing Walmart order line numbers.
5. Keep label/print queue intact and surface manual-action-required messaging.
6. Preserve fallback behavior only for mocked tests or explicitly marked fixture mode, not live marketplace confirmation.
7. Ensure purchaseOrderId is the Walmart purchase order ID, not ShipStation ID or customer order number unless Walmart lookup confirms it.

Phase 4 - Improve diagnostics:
Add sanitized logs/metadata for Walmart confirmation attempts: endpoint name, has purchase order ID, purchase order source, order line count, line numbers only, has method code, carrier name, masked tracking presence, Walmart HTTP status, and Walmart correlation/request ID if available. Do not log raw addresses, raw order payload, buyer data, tokens, credentials, labels, or full tracking numbers.

Phase 5 - Tests / guards:
Add or update mocked tests/guards for:
1. Walmart confirmation payload builder uses real Walmart line numbers from raw order.
2. Multi-line Walmart orders send all shippable non-cancelled lines.
3. Cancelled lines are excluded.
4. Missing raw order lines in live mode refuses to send guessed lineNumber "1".
5. Missing purchaseOrderId fails clearly.
6. Missing trackingNumber fails clearly.
7. Existing mocked fixture mode can still use simple fixture data safely.
8. Outbox row failure records clear sanitized error.
9. UI/API response distinguishes label created, Walmart shipped confirmation succeeded, failed/manual action required, and queued/pending.

Relevant commands to run:
- npm run typecheck
- npm run build:web
- npm run test:direct-carrier-labels
- npm run test:test-order-queue-label
- npm run test:print-queue-invalid-label
- npm run smoke:marketplace-confirm -- --mock-process-once
- npm run guard:shipping-certification
- npm run guard:site-actions
- npm run test:site-actions:browser
- npm run test:api-contracts
- npm run test:workflow-certification:browser
- npm run test:full-site-certification

Use the actual script names in package.json.

Definition of done:
- Live order 200014621589900 has been inspected read-only.
- We know whether Walmart confirmation succeeded, failed, stayed pending, or used bad/missing payload data.
- No duplicate label was created.
- No unsafe duplicate Walmart confirmation was sent without DJ approval.
- Walmart confirmation payload generation is hardened.
- Live confirmation no longer silently guesses line number 1 when real Walmart order lines are missing.
- Confirmation failures produce clear manual-action-required messaging.
- Outbox/shipments status accurately reflect pending, succeeded, failed, and not required.
- Tests/guards cover the Walmart payload and failure states.
- Typecheck passes.
- Web build passes.
- Relevant direct carrier, print queue, marketplace, site-action, and PS-022 certification tests pass.

Return format:
1. Read-only inspection summary for order 200014621589900
2. Current shipment confirmation state
3. Whether Walmart Seller Center should already be marked shipped based on DB/API evidence
4. Actual failure mode found
5. Sanitized Walmart payload shape before/after fix
6. Files changed
7. Tests/commands run with pass/fail results
8. Any manual action DJ still needs to take in Walmart Seller Center
```

## Official PS-025 Walmart Mark-as-Shipped Deployment + Live Failure Diagnosis Task

DJ approved PS-025 after repeated live Walmart label tests showed that label purchase and print queue can work while Walmart Seller Center still appears to leave `Mark as shipped` active. This task follows PS-024 and focuses on proving whether the relevant fix was actually deployed, then diagnosing the exact remaining Walmart shipment-confirmation failure mode from read-only production evidence.

| Task | Title | Priority | Live signal | Scope | Required evidence |
|---|---|---|---|---|---|
| PS-025 | Diagnose Walmart Mark-as-Shipped Failure After Live Label Purchase | Critical real-test follow-up | Live Walmart PO/order reference `129114381477093` had label creation and print/queue success, but Walmart Seller Center still appeared not marked shipped. | Confirm deployment/version first, inspect production state read-only, locate the exact confirmation failure source, and implement only the fix supported by evidence. | Production deployment status for commit `22ab7df` verified; no duplicate label/postage; no duplicate Walmart confirmation without DJ approval; sanitized inspection evidence; targeted fix; typecheck/build and relevant Walmart/site/shipping/PS-022 checks pass. |

### PS-025 Copy/Paste Handoff

```text
PS-025 - Diagnose Walmart Mark-as-Shipped Failure After Live Label Purchase

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Priority: Critical real-test follow-up
Status: New task from repeated live Walmart label tests.

Context:
DJ performed another live Walmart label/print-queue test:
- Walmart PO / order reference: 129114381477093
- Label creation worked.
- Print/queue path worked.
- Walmart shows tracking/label activity.
- Walmart Seller Center still appears to show "Mark as shipped" as not completed / still active.

This happened after the earlier similar test on order/customer reference 200014621589900 and after commit:
22ab7df Harden Walmart shipment confirmation

Important:
GitHub Actions CI for recent commits is failing because the job is not starting due to billing/spending-limit, not because tests failed. Verify whether 22ab7df is actually deployed to production before assuming the fix is live.

Goal:
Determine why Walmart marketplace shipment confirmation is still not marking orders shipped after successful Walmart label creation, and fix the exact failure mode.

The label/tracking path and the marketplace confirmation path are separate:
- Walmart Shipping label purchase: POST /v3/shipping/labels
- Walmart order shipment confirmation: POST /v3/orders/{purchaseOrderId}/shipping

This task is about the Walmart order shipment confirmation path.

Safety guardrails:
- Do not create another live label for PO 129114381477093.
- Do not buy postage.
- Do not void labels unless DJ explicitly approves.
- Do not send duplicate Walmart marketplace shipment confirmations unless DJ explicitly approves the exact retry.
- Read-only inspection first.
- Do not expose Walmart tokens, credentials, raw customer address, buyer PII, raw provider payloads containing PII, raw labels/PDF/base64, or full tracking numbers in logs/task output.
- Use sanitized summaries only.

Files to inspect first:
- api/carriers/labels.ts
- src/connectors/store/walmart.ts
- src/services/fulfillment/outbox.ts
- scripts/inspect-shipping-order.ts
- scripts/smoke-marketplace-confirm.ts
- scripts/walmart-confirmation-payload-guard.ts
- scripts/direct-carrier-label-guard.mjs
- scripts/shipping-certification-guard.mjs
- web/src/components/Views/OrdersView.tsx
- docs/marketplace-confirmation.md
- docs/prepship-shipping-production-audit.md

Relevant functions:
- confirmWalmartOrderShipped(...)
- confirmWalmartSourceOrderAfterLabelSql(...)
- walmartShipmentConfirmationBody(...)
- buildWalmartShipmentConfirmationBody(...)
- markWalmartConfirmationAttemptSql(...)
- createWalmartStoreConnector().confirmShipment(...)
- processFulfillmentOutboxOnce(...)
- enqueueShipmentConfirmation(...)

Phase 1 - Confirm deployment/version:
Determine whether the code containing 22ab7df Harden Walmart shipment confirmation is actually deployed to production.

Check:
- Vercel deployment state
- Render deployment state
- GitHub Actions/deploy pipeline status
- whether CI/deploy was blocked by billing/spending-limit

If production is still running older Walmart confirmation code, report that directly and do not over-debug the new code as if it is live.

Phase 2 - Read-only production inspection:
For PO / order reference 129114381477093, run the read-only inspector in a production-capable environment:
npm run inspect:shipping-order -- --order-number 129114381477093

If order-number lookup is not enough, inspect by matching Walmart/store order references around:
129114381477093

Inspect sanitized values only.

orders:
- id
- order_number
- external_order_id
- source_provider
- source_order_id
- client_id/store_id
- order_status
- canonical_status
- whether raw exists
- whether raw.purchaseOrderId exists
- whether raw.orderLines.orderLine[] exists
- count of raw order lines
- line numbers only

store_orders:
Find matching Walmart rows by:
- external_order_id
- customer_order_id
- purchaseOrderId
- order number 129114381477093

Report:
- provider
- external_order_id
- customer_order_id
- carrier_account_id
- whether raw exists
- whether raw order lines exist
- line numbers only
- whether shippingInfo.methodCode exists

shipments:
For latest active shipment on the order:
- id
- carrier_code
- service_code
- masked tracking number only
- label_url presence only
- confirmation_provider
- confirmation_status
- confirmation_attempts
- confirmation_last_error
- marketplace_confirmed_at
- created_at

fulfillment_outbox:
For this order/shipment:
- id
- shipment_id
- provider
- status
- attempts
- last_error
- next_run_at
- updated_at
- sanitized payload keys
- payload.purchaseOrderId
- whether payload.rawOrder.orderLines.orderLine[] exists
- line numbers only
- payload.carrierName
- payload.serviceCode
- masked tracking presence only

Phase 3 - Locate the error:
Find the actual failure source. Expected places:
- shipments.confirmation_last_error
- fulfillment_outbox.last_error
- Render logs containing:
  - [carriers/labels] walmart immediate confirmation failed:
  - Walmart Ship Confirm ...
- API response meta from label creation:
  - meta.walmartShipmentConfirmed
  - meta.walmartShipmentConfirmError
  - meta.confirmationQueued
  - meta.confirmationProvider
  - meta.confirmationError

Classify the result:
- Latest fix not deployed.
- Confirmation succeeded but Seller Center UI delayed/confusing.
- Confirmation failed due to Walmart API error - include sanitized HTTP status/message.
- Confirmation failed due to missing Walmart order line numbers.
- Confirmation failed due to missing/wrong purchaseOrderId.
- Confirmation failed due to missing/wrong Walmart store credentials.
- Confirmation is pending because outbox worker is not processing.
- Print-to-Queue UI is hiding confirmation failure/pending state.

Phase 4 - Fix the root cause:
Implement only the fix supported by the inspected evidence.

Likely fixes may include:

A. Deployment blocker:
If 22ab7df is not deployed, fix the deploy/CI blocker or provide manual deploy instructions. Current known blocker: GitHub Actions not starting because billing/spending-limit needs attention.

B. Missing raw Walmart order lines:
If raw lines are missing, ensure confirmation fetches/refreshes Walmart/store order data before sending /shipping. Do not use guessed lineNumber "1" for live marketplace confirmation.

C. Wrong purchaseOrderId:
Ensure the /v3/orders/{purchaseOrderId}/shipping path uses Walmart purchaseOrderId, not ShipStation ID or customer order number unless Walmart lookup confirms it.

D. Store credentials mismatch:
Ensure Walmart marketplace confirmation loads the correct Walmart store account credentials, not only the Walmart Shipping/carrier account credentials.

E. Outbox worker issue:
If outbox is pending/failed and not processing, diagnose worker/scheduler registration and production runtime. Confirm processFulfillmentOutboxOnce(...) or production worker is running.

F. UI visibility issue:
If Print-to-Queue succeeds but Walmart confirmation fails/pends, surface that clearly in the operator UI. Do not show only "queued successfully" if Walmart confirmation failed or is pending.

Suggested UI behavior:
- Label queued + Walmart confirmation succeeded -> success.
- Label queued + Walmart confirmation pending -> warning/info: queued, Walmart confirmation pending.
- Label queued + Walmart confirmation failed -> warning/error: label queued, Walmart not marked shipped; manual action may be required.

Phase 5 - Tests / verification:
Run relevant commands:
- npm run typecheck
- npm run build:web
- npm run test:walmart-confirmation:payload
- npm run test:direct-carrier-labels
- npm run test:test-order-queue-label
- npm run test:print-queue-invalid-label
- npm run smoke:marketplace-confirm -- --mock-process-once
- npm run guard:shipping-certification
- npm run guard:site-actions
- npm run test:site-actions:browser

Also run PS-022 certification commands from current package.json:
- npm run test:api-contracts
- npm run test:workflow-certification:browser
- npm run test:full-site-certification

If a browser certification test is known to be failing for unrelated fixture reasons, report it explicitly and do not claim full certification complete.

Definition of done:
- Production deployment status for 22ab7df is confirmed.
- PO 129114381477093 is inspected read-only.
- Exact Walmart confirmation failure mode is identified.
- No duplicate label is created.
- No duplicate Walmart confirmation is sent without DJ approval.
- Any code fix is targeted to the proven failure mode.
- Print-to-Queue does not hide Walmart confirmation failure/pending state.
- Shipment/outbox state accurately reports succeeded, failed, pending, or not_required.
- Tests/guards pass or failures are clearly documented with reason.

Return format:
1. Whether 22ab7df was deployed when DJ tested PO 129114381477093
2. Read-only inspection summary for PO 129114381477093
3. Actual error found, sanitized
4. Root cause classification
5. Files changed
6. Commands run with pass/fail results
7. Whether Walmart Seller Center still requires manual action
8. Any deploy/CI blocker remaining
```

## Official PS-026 Print Queue Persistence Task

DJ approved PS-026 after confirming the intended warehouse workflow: labels sent to Print Queue must persist until an operator explicitly confirms they were printed or explicitly removes/clears them. This supersedes any previous assumption that shipped/cancelled orders should automatically clear active Print Queue entries.

| Task | Title | Priority | Operations signal | Scope | Required evidence |
|---|---|---|---|---|---|
| PS-026 | Fix Print Queue Persistence: Labels Must Not Disappear Until Confirmed Printed | Critical operations workflow | Operators may create labels, hold them in Print Queue, refresh, log out, log back in, or hit browser/popup/printer issues. Active labels disappearing before physical print creates warehouse risk. | Stop automatic cleanup of active unprinted queue entries; stop marking printed on PDF generation; add explicit Confirm Printed workflow; harden Clear/Remove confirmations; preserve queue persistence across refresh/session/restart/status changes. | Typecheck/build plus print queue durable/ownership/invalid-label, direct carrier, queue-label, shipping certification, API contract, and workflow/browser tests pass. Browser workflow proves send-to-queue -> refresh -> print/PDF -> still active -> confirm printed. |

### PS-026 Copy/Paste Handoff

```text
PS-026 - Fix Print Queue Persistence: Labels Must Not Disappear Until Confirmed Printed

Assignee: Lawrence
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Priority: Critical operations workflow
Status: New approved task from DJ. This supersedes any previous assumptions that shipped/cancelled orders should auto-clear from Print Queue.

Context:
DJ stated the intended workflow clearly:

When an order is sent to print to queue, it should show up in print queue and stay ready to be printed. If it is not printed, it should not disappear. This would cause a huge issue with operations if operators are holding labels in print queue and suddenly they disappear. It should not disappear even if they log out and log back in, or refresh the page. It should persist across sessions until printed.

Current code has multiple paths that may violate this:

- src/services/labels.ts
  - markOrderShipped(...) can remove queue entries via removeQueueEntriesForOrder(...) unless cleanupQueue: false.
  - scheduleQueueCleanupAfterLabel(...) removes queue entries in the background after label creation.
  - Real and test label flows call scheduleQueueCleanupAfterLabel(order.id, timer) after marking the order shipped.
  - This can remove a queued label before the operator physically prints it.
- src/services/order-sync.ts
  - updateExistingOrderStatusesBatch(...) deletes printQueue rows when sync flips orders to shipped or cancelled.
  - This assumes shipped/cancelled orders do not need queue entries, but for ops a shipped order can still have an unprinted label waiting in Print Queue.
- src/services/print-queue.ts
  - runMergeJob(...) marks entries as status: 'printed' after the PDF merge succeeds.
  - This happens before knowing whether the operator actually printed the labels.
- src/services/print-queue.ts
  - listQueue(...) defaults to only status = 'queued', so anything prematurely marked printed disappears from the normal queue view.
- web/src/components/Views/OrdersView.tsx
  - The Print Queue has a Clear button that deletes all active queued rows for the client with no strong workflow confirmation. This is dangerous for ops.

Files to inspect first:
- src/db/schema/print-queue.ts
- src/services/print-queue.ts
- src/routes/print-queue.ts
- src/services/labels.ts
- src/services/order-sync.ts
- scripts/cleanup-stale-queue-entries.ts
- scripts/print-queue-durable-guard.mjs
- scripts/print-queue-ownership-guard.mjs
- scripts/print-queue-invalid-label-guard.mjs
- web/src/components/Views/OrdersView.tsx
- web/src/lib/v2-apiClient.ts
- any existing browser/API certification tests around print queue, labels, and Orders workflow

Required behavior:
Print Queue must be durable and session-independent:
- Sending an order to Print Queue creates/persists a DB-backed queue entry.
- Active queue entries survive page refresh.
- Active queue entries survive logout/login.
- Active queue entries survive Render restart/process memory loss.
- Active queue entries survive order status changing to shipped after label creation.
- Active queue entries survive marketplace sync seeing the order as shipped or cancelled, unless an operator explicitly removed/cleared/confirmed them.
- Active queue entries do not disappear just because a PDF merge/download job succeeded.

A label should be removed from the active queue only after one of these explicit actions:
- Operator confirms printed successfully.
- Operator manually removes that individual queue item.
- Admin/operator intentionally clears queue after a strong confirmation dialog.

Implementation requirements:

1. Stop auto-removing active queue entries on shipped status

Remove or change all automatic queue cleanup behavior that deletes active unprinted labels solely because an order became shipped/cancelled.

Specifically inspect and fix:
- src/services/labels.ts
  - markOrderShipped(...)
  - scheduleQueueCleanupAfterLabel(...)
  - calls after mock/real label creation
- src/services/order-sync.ts
  - updateExistingOrderStatusesBatch(...) queue deletion block
- scripts/cleanup-stale-queue-entries.ts
  - It must not delete active unprinted queue entries solely because the order is shipped/cancelled.
  - Either update it to only affect explicitly printed/removed/stale-safe states or clearly mark it unsafe/deprecated for active ops queue cleanup.

Correct principle:
Order status shipped/cancelled does not imply label was physically printed.

If an order is shipped but label is still queued, the queue UI can show a badge/warning like "Order status: shipped", but it must remain printable.

2. Do not mark printed on PDF merge/download readiness

In src/services/print-queue.ts, runMergeJob(...) currently updates successful entries to:
status: 'printed', lastPrintedAt: now, printCount: 1

Change this workflow.

Required behavior:
- PDF generation/merge success should not equal printed.
- Use a recoverable state such as pdf_ready, print_ready, print_job_completed, or keep queued plus metadata, whichever fits the current schema/migration strategy best.
- Active queue should still show entries after PDF generation until operator confirms printed.
- If schema changes are needed, add a proper migration and update Drizzle schema.

Recommended model:
- queued = ready to print, active queue
- pdf_ready = PDF generated/downloadable/reopenable, still active/recoverable
- printed_confirmed = operator confirmed printed, hidden from active queue/history-visible
- removed = manually removed/cancelled from queue
- failed = print/PDF failed, visible/retryable

Minimal alternative is acceptable if it preserves the workflow:
- queued
- printed
- removed
- failed

But printed must only be set after operator confirmation.

3. Add explicit Confirm Printed endpoint/action

Add a backend route and service method to explicitly confirm queue entries as printed.

Requirements:
- Accept selected queue entry IDs and client/store auth scope.
- Verify ownership/scope just like print/download/remove routes.
- Update only those entries to printed/confirmed state.
- Set lastPrintedAt and increment printCount safely.
- Return count and IDs updated.

Frontend requirements:
- After PDF opens/downloads, show clear UI actions:
  - Confirm Printed
  - Reopen PDF if PDF/job is still recoverable
  - Keep in Queue / no-op default if operator is not sure
- Do not auto-remove/hide entries when PDF opens.
- If browser popup is blocked or PDF download fails, entries remain in active queue.

4. Recoverability across refresh/login

If a PDF was generated but not confirmed printed:
- Queue item must still appear after refresh/login.
- Operator should be able to print again or re-run merge for selected entries.
- If the old generated PDF is not durable after process restart, that is acceptable only if the queue entry still remains and can generate a new PDF from the stored label URL.

5. Harden Clear/Remove behavior

Individual remove can remain, but must be explicit.

For Clear:
- Add a strong confirmation modal/dialog.
- Wording must communicate operational risk, for example:
  "This removes all unprinted labels from the active print queue for this client. Use only if you are sure these labels should not be printed from PrepShip. Continue?"
- Do not clear printed history unless explicitly in history/admin mode.
- Log/return how many active queue entries were removed.

6. Preserve idempotency and duplicate safety

- Sending the same order to queue again should not create duplicate active queue rows.
- Current unique constraint is by (orderId, clientId) in print_queue_orders; preserve or improve this.
- If an active queue entry already exists, return alreadyQueued: true and keep it active.
- Retrying after a timeout must not buy duplicate labels if an existing label/queue entry can be reused.
- If a previous entry was explicitly confirmed printed, define whether requeue is allowed and make it intentional/traceable.

7. Make batch-send status non-destructive and diagnosable

The recent Heritage failure showed:
API GET /print-queue/batch-send/status/<jobId> timed out after 30s

Do not solve this by deleting/clearing rows.

Requirements:
- /batch-send/status/:jobId should never block for 30s on optional durable snapshot DB reads.
- Bound/timeout optional snapshot reads or return in-memory status immediately with durableJob: null if unavailable.
- Surface partial success safely: queued count, already-queued count, failed orders, and retry-safe guidance.
- Queue entries created before timeout must persist.

Guardrails / forbidden changes:
- Do not create real labels or buy postage in automated tests.
- Do not remove active unprinted queue entries as cleanup just because order status is shipped/cancelled.
- Do not mark printed just because a PDF was generated, downloaded, opened, or popup attempted.
- Do not weaken auth/RBAC/client/store scope.
- Do not expose customer PII, label PDFs/base64, raw provider payloads, tracking numbers, tokens, credentials, or cross-client queue entries.
- Do not rely on frontend state/localStorage as source of truth for queue persistence. DB must be source of truth.

Verification commands:
Run at minimum:
- npm run typecheck
- npm run build:web
- npm run test:print-queue-durable
- npm run test:print-queue-ownership
- npm run test:print-queue-invalid-label
- npm run test:direct-carrier-labels
- npm run test:test-order-queue-label
- npm run guard:shipping-certification
- npm run test:api-contracts
- npm run test:workflow-certification:browser
- npm run test:site-actions:browser

Add/update tests if existing commands do not cover the required scenarios.

Required tests / certification scenarios:
- Send order to queue -> DB row exists with active status.
- Refresh/reload equivalent -> fetch queue returns same row.
- Simulated logout/login/new session equivalent -> fetch queue returns same row.
- Create label / mark order shipped -> active queue row remains.
- Order sync flips order shipped/cancelled -> active queue row remains.
- Start print/PDF merge -> PDF generation succeeds -> active queue row still visible and not printed.
- Popup blocked / download failure simulation -> active queue row remains.
- Operator confirms printed -> row changes to printed/confirmed and disappears from default active queue but appears in history if history is enabled.
- Individual remove -> row removed/marked removed only by explicit action.
- Clear queue -> requires confirmation and only removes active queue rows for authorized client/scope.
- Batch send timeout/partial success -> successful queue entries persist and retry does not duplicate rows.
- Cross-client/client-store scope: user cannot see/confirm/remove another client/store queue entry.

Browser workflow test must include:
send-to-queue -> queue visible -> refresh page -> queue still visible -> run print/PDF -> queue still visible pending confirmation -> confirm printed -> active queue no longer shows item/history shows printed

Definition of done:
- Active unprinted Print Queue entries persist in DB and remain visible across refresh/logout/login.
- No automatic cleanup deletes active queue entries based only on order status shipped/cancelled.
- PDF generation/open/download does not mark entries printed.
- Operator confirmation is required before active queue entries become printed/hidden.
- Clear/remove actions are explicit, scoped, and guarded.
- Queue retry/idempotency prevents duplicate active entries and duplicate label purchase where possible.
- Batch status timeout cannot cause silent queue disappearance.
- Tests prove the workflow end-to-end, not only static source checks.
- All verification commands pass or failures are clearly documented with root cause.

Return format:
1. Summary of queue persistence bug(s) fixed
2. Files changed
3. Schema/migration changes, if any
4. New/updated API routes
5. New/updated UI behavior
6. Commands run with pass/fail results
7. Browser workflow evidence
8. Any remaining risks or follow-up tasks
```

## Official PS-027 Production Performance / Infrastructure Diagnosis Task

DJ approved PS-027 as the Phase 0 diagnostic before deciding whether to migrate PrepShip V4 from Vercel/Render/Supabase to AWS/nginx/RDS/SQS/etc. This task is evidence-gathering only: do not migrate production infrastructure in this task.

| Task | Title | Priority | Problem | Scope | Definition of Done |
|---|---|---|---|---|---|
| PS-027 | Phase 0 Production Performance & Infrastructure Diagnosis Before AWS Migration | Critical operations diagnosis | Production slowness/hangs may be caused by platform, DB/pool contention, slow SQL, worker pressure, external provider latency, frontend behavior, or queue/status design. Moving to AWS without evidence risks moving the same bottlenecks. | Measure public production baseline, verify API/worker/env split where possible, inspect hot route timing and DB risk areas, analyze worker/scheduler cadence, separate provider latency from app/DB latency, review frontend polling/loading behavior, and produce an AWS decision matrix. | Current production baseline measured; protected metrics/dashboard gaps listed; DB/worker/provider/frontend risks ranked; immediate stabilizing fixes listed; clear migrate-now/partial/no recommendation; no production mutations or live labels/marketplace actions. |

### PS-027 Diagnosis Output

See `docs/ps-027-production-performance-diagnosis.md`.

## Official PS-028 Authenticated Production Timing + Supabase Pool Capture

DJ approved proceeding from PS-027 into authenticated production timing and Supabase pool/slow-query capture during real operations. This task is read-only diagnostics only.

| Task | Title | Priority | Problem | Scope | Definition of Done |
|---|---|---|---|---|---|
| PS-028 | Authenticated Production Timing + Supabase Pool/Slow Query Capture | Critical operations diagnosis | PS-027 could not collect protected production p95/p99 route timing or Supabase pool/slow-query data without an admin bearer token and database access. | Add/run a safe capture script for protected `/observability/status`, `/observability/api-timing`, `/sync/status`, `/worker/status`, public health, and read-only Supabase/Postgres activity/lock/slow-query aggregates. | At least one healthy baseline and one slow/hung incident capture are collected, reviewed, and used to decide whether to tune current stack, upgrade plans, or stage AWS migration. |

Docs and command:
- `docs/ps-028-authenticated-production-timing.md`
- `npm run diagnose:production-timing`

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

## Official PS-032 Connector Boundary Hardening Task

DJ approved PS-032 after confirming the architectural distinction that order pulling is still directly coded to ShipStation/Walmart/eBay paths rather than consistently routing through StoreConnector, and normal label creation is primarily routed through the ShipStation CarrierConnector rather than a provider-neutral carrier orchestrator.

| ID | Title | Risk | Why It Matters | Scope | Completion Evidence |
| --- | --- | --- | --- | --- | --- |
| PS-032 | Enforce StoreConnector/CarrierConnector Boundary for Orders, Rates, Labels, and Marketplace Confirmation | Critical architecture hardening | Future stores/carriers will keep bypassing the modular connector model unless direct provider API calls are isolated behind StoreConnector/CarrierConnector contracts and guarded. | Reconcile connector contracts, move order import/status sync through StoreConnector orchestration, move rates/labels/tracking/voids through CarrierConnector orchestration, preserve marketplace confirmation through fulfillment outbox, add guards/docs/tests. | Typecheck/build, connector architecture/registry guards, relevant direct-carrier/marketplace/label guards, mocked confirmation tests, and targeted tests proving no direct provider API calls from core routes/services. No real labels, postage, provider mutations, or live marketplace notifications. |

### PS-032 Copy/Paste Handoff

See [docs/ps-032-connector-boundary-task.md](docs/ps-032-connector-boundary-task.md) for the full task prompt, phasing, verification commands, definition of done, and return format.

Phase 0 audit baseline: [docs/ps-032-direct-provider-call-audit.md](docs/ps-032-direct-provider-call-audit.md)

Targeted guard: `npm run test:ps-032-connector-boundary`

Phase 1 orchestrator guard: `npm run test:ps-032-connector-orchestrators`

## Official PS-048 Orders Diagnostic Account Nickname Task

DJ requested PS-048 on 2026-06-01 to track the Orders diagnostic `Acct Nickname` column regression where persisted shipped rows can show carrier code text such as `ups` instead of the real shipping/account nickname.

| ID | Title | Risk | Why It Matters | Scope | Completion Evidence |
| --- | --- | --- | --- | --- | --- |
| PS-048 | Fix Orders Acct Nickname Diagnostic Column Showing Carrier Code | High operator UI correctness | Diagnostic columns are used to validate shipped-row carrier/account linkage. Showing `ups` in `Acct Nickname` hides the actual provider account nickname and can mislead production debugging. | Surgical display-only fix in Orders shipped-row account-nickname resolution, with account-nickname sources preferred and carrier-code/provider-ID fields forbidden as nickname fallbacks. Add browser E2E coverage proving Carrier Code, Provider ID, and Acct Nickname stay separated. | Typecheck, web build, source-of-truth guard, focused `web/e2e/orders-column-integrity.spec.js`, and Orders UX browser suite pass. No live labels, postage, marketplace notifications, production mutations, or shipped/cancelled protection weakening. |

### PS-048 Copy/Paste Handoff

See [docs/ps-048-orders-acct-nickname-diagnostic-column.md](docs/ps-048-orders-acct-nickname-diagnostic-column.md) for the full task prompt, source priority, guardrails, verification commands, definition of done, and return format.

## Official PS-050 Awaiting Shipment Rate Accuracy + Auto-Start Rating Task

DJ provided PS-050 on 2026-06-01 as an updated replacement task. This supersedes PS-049 and any earlier PS-050 draft; use the PS-050 packet below as the source of truth.

| ID | Title | Risk | Why It Matters | Scope | Completion Evidence |
| --- | --- | --- | --- | --- | --- |
| PS-050 | Make Awaiting Shipment Rates Accurate and Auto-Start Background Rating | Critical rate correctness and operator workflow | Awaiting Shipment rates can spin for minutes, saved table rates can differ from later live Rate Browser results, and current saved-rate validation is unsafe because dims-only matching can show stale or mismatched rates as current. | Add a full saved-rate validity model using request fingerprint, freshness, and completeness; make cache/backfill reuse exact-match only; auto-start passive Awaiting Shipment rating on plain page load; keep passive flow cache-first with bounded refresh/concurrency; preserve manual Rate Browser force-live behavior. | Typecheck, web build, source-of-truth guard, new browser E2E for rate accuracy/auto-start, existing Orders column-integrity E2E, lower-level fingerprint/freshness/completeness tests, cache/backfill exactness tests, and concurrency/rate-limit tests pass. No labels, postage, marketplace notifications, shipped/cancelled mutations, secrets, or PII exposure. |

### PS-050 Copy/Paste Handoff

See [docs/ps-050-awaiting-shipment-rate-accuracy-autostart.md](docs/ps-050-awaiting-shipment-rate-accuracy-autostart.md) for the full replacement task prompt, safety clarification, implementation requirements, test plan, verification commands, definition of done, and return format.

## Official PS-052 Orders SKU Sort Exact Composition Task

DJ provided PS-052 on 2026-06-01 as a standalone Orders SKU Sort/grouping correctness task. This is related to Orders SKU Sort/grouping, not label/rate work.

| ID | Title | Risk | Why It Matters | Scope | Completion Evidence |
| --- | --- | --- | --- | --- | --- |
| PS-052 | Fix SKU Sort Grouping to Require Exact SKU + Quantity Composition | High operator workflow correctness | Orders SKU Sort can group unrelated orders together when it relies on primary SKU, total quantity, or "contains SKU" behavior instead of the exact per-SKU quantity composition. Misleading groups can cause operators to batch the wrong orders. | Build a deterministic exact composition key from active line-item SKUs and per-SKU quantities; group rows only when the full composition key matches; make headers show single-SKU and mixed-SKU composition clearly; preserve existing SKU filtering/default ordering and move sort/group support server-side if needed for global pagination correctness. | Typecheck, web build, source-of-truth guard, focused composition-key tests, Orders grouping/UI coverage with Booster/HU-10 fixture cases, Orders UX/browser coverage, and Orders column-integrity E2E pass. No live orders/items, labels, postage, marketplace notifications, PII exposure, or shipped/cancelled lockdown changes. |

### PS-052 Copy/Paste Handoff

See [docs/ps-052-orders-sku-sort-exact-composition.md](docs/ps-052-orders-sku-sort-exact-composition.md) for the full task prompt, implementation requirements, pagination/global-sort considerations, test plan, definition of done, and return format.

## Official PS-053 Print To Queue Atomic Recovery Task

DJ provided PS-053 on 2026-06-01 as the official task for the Print to Queue partial-success failure where label/postage creation can succeed, the order can move shipped, but no print queue row is created.

| ID | Title | Risk | Why It Matters | Scope | Completion Evidence |
| --- | --- | --- | --- | --- | --- |
| PS-053 | Make Print to Queue Atomic and Recover Label-Created/Not-Queued Partial Success | Critical shipping workflow atomicity | Operators can buy postage and move an order to shipped while the label never appears in Print Queue, creating a paid-label/no-queue recovery gap and confusing red errors such as Buffer/Object type failures. | Make queue-mode label creation/recovery idempotent and atomic from the operator perspective; normalize object-shaped label URL/PDF payloads; recover active labels into queue after post-label errors; decouple marketplace confirmation failures from queue success; prevent duplicate postage and duplicate active queue rows. | Typecheck, web build, source-of-truth guard, Orders UX browser suite, Orders column-integrity E2E, and new focused PS-053 backend/workflow tests covering queue success, post-label partial success recovery, existing-label queueing, object-shaped label payloads, queue idempotency, and marketplace outbox failure behavior. No live postage, labels, marketplace notifications, shipped/cancelled production mutations, secrets, or PII exposure. |

### PS-053 Copy/Paste Handoff

See [docs/ps-053-print-to-queue-atomic-recovery.md](docs/ps-053-print-to-queue-atomic-recovery.md) for the full task prompt, safety invariant, implementation requirements, regression coverage, verification commands, definition of done, and return format.

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
