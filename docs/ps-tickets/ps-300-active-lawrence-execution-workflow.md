# PS-300 Active Lawrence PS Ticket Execution Workflow

Date: 2026-06-22

## Scope

This document is the status owner for the active Lawrence PS execution workflow.
It covers only the active Lawrence PS queue from the latest Trello regen:

- PS-166
- PS-258
- PS-285
- PS-287
- PS-289
- PS-290
- PS-292
- PS-294
- PS-295
- PS-296
- PS-300
- PS-301
- PS-302
- PS-303
- PS-304
- PS-305
- PS-306
- PS-307
- PS-308

Trello policy is report first. Codex may read and report card status, but must
not add comments, move cards, edit cards, or create cards unless the user
explicitly runs or approves `task update` for that run.

## Preflight and Dedupe

Before each sprint batch:

- Run `task regen` to refresh the Lawrence To Do, Lawrence In Progress, and
  Final Review - Lawrence PS card map.
- Confirm no duplicate PS card exists for the work.
- Map unnumbered cards into existing PS tickets instead of creating new cards.
- Freeze the ticket checklist before coding.

Known dedupe mapping:

- OrdersView frontend shipping authority cards map to PS-300 through PS-306.
- SHIPP label-size or mis-sized PDF cards map to PS-287 and PS-294.
- SHIPP Create+Print versus Print Queue orchestration maps to PS-303, with
  label-size output covered by PS-287 and PS-294.
- Rate comparison by customer charge maps to PS-307.
- SHIPP tuple display replacement maps to PS-308; PS-308 supersedes PS-292 for
  the final no-tuple UI direction.

## Multi-Agent Roles

Use parallel read-only agents for research, QA, regression, and audit. Keep
implementation serialized when tickets touch the same files.

- Orchestrator: ticket order, scope, final verdict, percent, next action.
- Trello Researcher: card details, comments, checklist extraction.
- Backend Engineer: canonical source-of-truth implementation.
- Full-Stack Engineer: frontend/API delegation with no frontend-owned business
  truth.
- QA Tester: focused guards, repros, acceptance checks.
- Auditor: money, rate, label, shipped/cancelled safety.
- Release/Runtime Verifier: env flags, build, deploy, canary evidence.
- Regression Agent: related old tickets and no drift.

## Lane 1 - Backend Shipping Authority

Execution order is PS-300 -> PS-301 -> PS-302 -> PS-303 -> PS-304 -> PS-305 -> PS-306.

- PS-300: dependency and migration gate for OrdersView backend-boundary work.
- PS-301: backend row workflow DTO owns allowed actions, row status, and
  purchase/queue eligibility. Guard: `test:ps-301-row-workflow-authority`.
- PS-302: backend owns Apply Best Rate; frontend stops rebuilding proof/rate
  truth. Guard: `test:ps-302-apply-best-rate-authority`.
- PS-303: backend owns Print Queue create/recover/queue; no frontend direct
  label-purchase orchestration. Guard: `test:ps-303-print-queue-authority`.
- PS-304: backend owns package, carrier, account, and display facts. Guard:
  `test:ps-304-shipping-display-facts-authority`. Current closeout note:
  carrier/service/account display prefer the backend tuple, but older frontend
  compatibility candidates still need PS-306 cutover review before Final Review.
- PS-305: docs/CI/static guards prove rates, labels, billing, package, and
  display authority cannot drift back into frontend. Guard:
  `test:ps-305-authority-drift`.
- PS-306: decompose OrdersView only after backend owners exist, preserving DOM
  and workflow parity. Guard: `test:ps-306-ordersview-parity-cutover`.

## Lane 2 - Money, Rates, House Account

- PS-307: compare rates by backend-stamped customer or marked charge, not raw
  carrier/internal cost.
- PS-308: replace SHIPP tuple UI with separate Best/Selected Rate, Rate Cost,
  and Shipping Margin. Rate Cost is internal/admin only.
- PS-292: close or supersede tuple-display work carefully; PS-308 owns the
  final no-tuple UI direction.
- PS-295: prove SHIPP House shipped row plus billing/export/invoice use
  `customer_rate`, not internal cost.
- PS-296: finish shipping-margin backend read model and Dashboard/Billing thin
  consumers.
- PS-290: keep HUGRAB insurance status badges backend-owned and consistent with
  the label gate.

## Lane 3 - Labels and Print Output

- PS-287: shared Print Queue content-aware 4x6 label normalization with offline
  fixtures.
- PS-294: SHIPP-specific 4x6 output uses the shared normalization path.
  Standalone Create+Print and Print Queue both receive corrected output.
- Related unnumbered SHIPP/label-size cards map here; do not create a new PS
  card for that work.

## Lane 4 - Multi-Package

- PS-289: finish sidecar schema, shipment group planning, mocked label flow,
  purchased label orchestration, print queue sidecar, marketplace confirmation
  sidecar, and closeout guard.
- No live labels, postage, marketplace notification, or operator canary until
  mocked workflow is green and DJ explicitly approves the exact canary.

## Lane 5 - Broad Refactors and Umbrellas

- PS-166 and PS-258: one OrdersView extraction slice at a time, with DOM/parity
  guard before each slice.
- PS-285: do not close the umbrella from one slice. Check every PS-245 through
  PS-259 phase and only close when all child evidence exists.

## Closeout Rules

A card is eligible for Final Review - Lawrence at 89% or higher when the
checklist is evidence-backed and no known blocker remains for review. A card is
100% only when all of the following are true:

- card objectives mapped
- checklist complete
- code complete
- focused guards passing
- `git diff --check` passing
- `npm run typecheck` passing
- `npm run build:web` passing
- independent audit sign-off
- safety proof attached
- no hidden acceptance criteria left behind

## Required Focused Guards

- PS-287 and PS-294: `test:ps-287-print-queue-label-normalization`,
  `test:ps-287-print-queue-label-normalization-closeout`,
  `test:ps-294-shipp-4x6-placement`, `test:ps-294-shipp-4x6-closeout`
- PS-289: all `test:ps-289-multi-package-*` scripts plus
  `test:ps-289-multi-package-closeout`
- PS-292, PS-295, PS-296: `test:ps-292-house-tuple-display`,
  `test:ps-292-final-review-closeout`, `test:ps-295-house-customer-rate-proof`,
  `test:ps-295-house-customer-rate-closeout`, `test:ps-296-shipping-margin`,
  `test:ps-296-shipping-margin-closeout`
- PS-279/PS-300 authority regression: `test:ps-279-*` plus PS-300 through
  PS-308 guards as they are added
- PS-307: `test:ps-307-marked-rate-comparison`
- PS-290/PS-300 first authority gates:
  `test:ps-290-hugrab-insurance-coverage-badge`,
  `test:ps-290-hugrab-insurance-coverage-badge-closeout`,
  `test:ps-300-active-lawrence-workflow`,
  `test:ps-300-backend-shipping-authority`,
  `test:ps-300-backend-authority-lane-closeout`,
  `test:ps-301-row-workflow-authority`,
  `test:ps-302-apply-best-rate-authority`,
  `test:ps-303-print-queue-authority`,
  `test:ps-304-shipping-display-facts-authority`,
  `test:ps-305-authority-drift`,
  `test:ps-306-ordersview-parity-cutover`,
  `test:ps-307-marked-rate-comparison`

## Safety

No live labels, postage, voids, marketplace notifications, production order
mutation, or shipped/cancelled data mutation are part of this workflow artifact.

The frontend must not own money, rate, label, billing, inventory, marketplace
notification, auth/scope, or shipped/cancelled safety decisions. Those decisions
belong to backend source-of-truth owners; the frontend fetches, displays, and
submits user intent.

Do not expose internal Rate Cost, margin, SHIPP cost, secrets, or cross-client
data to client/user surfaces. Internal/admin-only money facts must stay behind
backend ownership and explicit visibility controls.
