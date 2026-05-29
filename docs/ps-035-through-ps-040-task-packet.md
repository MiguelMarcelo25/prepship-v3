# PS-035 Through PS-040 - PrepShip Task Packet

Created from DJ handoff on 2026-05-29.

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Assignee: `<@714064895963955211>`

## Safety Baseline For This Packet

- Do not buy postage, create live labels, void labels, or notify marketplaces from automated tests.
- Do not expose secrets, raw labels, raw provider payloads, customer PII, or cross-client data in logs, docs, fixtures, or summaries.
- Do not weaken auth, RBAC, client/store scope, shipped/cancelled lockdown, label safety, provider isolation, or credential protections.
- Shipped/cancelled and `shipments` changes remain governed by `AGENTS.md`.
- Any real production backfill/write mode requires separate DJ approval after a sanitized dry-run report.

## PS-035 - Build Complete PrepShip Full-Workflow Certification Coverage Matrix

Priority: High

Goal: turn `test:full-site-certification` into a meaningful full operator workflow certification suite that covers order ingestion through rates, label creation, print queue, shipment persistence, marketplace confirmation, inventory/billing side effects, recovery states, and RBAC/client scope.

Deliverables:

- Create/update `docs/full-workflow-certification-matrix.md`.
- Add a stronger master script, suggested `npm run test:full-workflow-certification`, while preserving `test:full-site-certification`.
- Organize mocked/offline Playwright/API workflow coverage for the major checkpoints:
  rate browser partial-carrier failures, carrier account verification, source connector sync, preflight, label state machine, shipment persistence, print queue durability, shipped-label reprint, marketplace outbox, inventory side effects, billing capture, post-shipment table behavior, critical error/recovery states, auth/RBAC/client scope, package/dims/rate selection, and production-safe health smoke.
- Document current status for each checkpoint as covered, partial, or missing; include the current script/spec, gap/risk, proposed test, and whether it is mocked/offline, sandbox, or DJ-supervised live-only.

Verification targets:

- `npm run typecheck`
- `npm run build:web`
- `npm run test:api-contracts`
- `npm run test:frontend-failure-states`
- `npm run test:full-site-certification`
- `npm run test:full-workflow-certification`
- Any new focused browser scripts added for rate browser, label flow, print queue, marketplace confirmation, carrier settings, auth scope, and post-shipment workflow.

Return summary must include coverage matrix summary, scripts added, workflow tests added, commands/results, remaining gaps with recommended PS follow-ups, and confirmation of no live labels/postage/marketplace notifications/credential changes/secrets/PII exposure/unauthorized live mutations.

## PS-036 - Fix ShipStation Sync + Make Orders Column Integrity Mandatory E2E

Priority: Critical - shipped/awaiting shipment data integrity and certification gap.

Problem: Shipped Orders shows false `Ext. Label` values in Carrier, Shipping Account, and Selected Rate when ShipStation has real shipment rows. Suspected root cause is ShipStation v1 date parameters being generated as UTC wall-clock strings with timezone stripped, causing ShipStation to interpret them as account-local times and skip labels.

Required work:

- Verify and fix ShipStation v1 date formatting in `src/services/shipment-sync.ts`, `src/connectors/store/shipstation.ts`, and any similar formatter that strips `toISOString()` timezone data for `createDateStart` or `modifyDateStart`.
- Prefer an explicit account-local timezone, likely `America/Los_Angeles`, unless the app already has a configured source.
- Add code comments documenting ShipStation v1 account-local date behavior.
- Add a dry-run-first missed-shipment recovery/backfill command that reports ShipStation shipments found, local rows present, missing rows, orders that would gain carrier/account/rate data, and unmatched/orphan shipments. Write mode must be explicit and never run automatically in tests.
- Update `web/src/components/Views/OrdersView.tsx` so shipped rows do not infer external fulfillment only because local shipment metadata is missing. True external labels may still render `Ext. Label`; missing local synced shipment data without an external flag must render an honest state such as `Missing shipment sync`.
- Make Orders column integrity a permanent E2E/certification invariant for both Awaiting Shipment and Shipped. Tests must compare rendered cells against API/fixture/source-of-truth payloads, not just non-empty cells or page render.

Minimum Orders column coverage:

- Awaiting Shipment: Order Date, Client, Order #, Recipient, Item Name, SKU, Qty, Weight, Ship To, Carrier/best-rate carrier state, Shipping Account, Order Total, Best Rate/selected rate amount and service data where expected, and any diagnostic carrier/account/service certification columns.
- Shipped: Order Date, Client, Order #, Recipient, Item Name, SKU, Qty, Weight, Ship To, Carrier, Shipping Account, Order Total, Selected Rate, Tracking/label-created columns when visible or part of status view, and diagnostic certification columns.

Required row classes:

- Awaiting Shipment with valid dims/weight and best-rate data.
- Awaiting Shipment missing dims/weight with expected placeholder.
- Shipped with persisted ShipStation shipment row.
- Shipped explicit external label.
- Shipped missing shipment row and no external flag, expected `Missing shipment sync`, not `Ext. Label`.
- Multi-item order with SKU/Qty rendering.

Return summary must include root cause confirmed/corrected, why previous E2E missed it, permanent column-integrity assertions added, files changed, implementation details, commands/results, dry-run recovery counts, and explicit production-mutation statement.

## PS-037 - Save/Auto-Apply Package Defaults by Client SKU+Qty Combination

Priority: High - new-client shipping efficiency and package/rate correctness.

Problem: current SKU-level defaults can pollute individual SKU package defaults for mixed-SKU orders. Hugrab-style orders require package defaults by exact client plus complete SKU/quantity combination.

Required work:

- Add a persistent client-scoped SKU-combination package default model with unique `(clientId, comboKey)`.
- Normalize SKUs case-insensitively, trim whitespace, combine duplicate line items into total qty per SKU, sort by normalized SKU, and include qty in the key.
- Store selected package id/package code and optionally dims/weight snapshot; include `createdAt` and `updatedAt`.
- Add backend save/retrieve endpoints or services. Backend should derive/validate combo keys from order data where practical and must not trust only frontend keys.
- Update `OrdersView.tsx` panel package resolution order:
  per-order override, exact client SKU+qty combo default, single-SKU SKU-level product default only when truly single unique SKU, matched package by complete dims, then blank/add dims flow.
- Ensure multi-SKU saves do not stamp selected package onto each individual SKU as a global SKU default.
- Preserve current single-SKU defaults and Products tab behavior.

Required tests:

- Unit/static combo-key tests for SKU casing/whitespace, sort-order independence, duplicate SKU summing, quantity sensitivity, and client scoping.
- Backend save/retrieve/upsert tests.
- UI/functionality tests proving Awaiting Shipment orders auto-select combo defaults on panel open.
- Regression test proving multi-SKU package save does not overwrite individual SKU package defaults.
- Hugrab-style E2E/certification coverage with at least three combinations and one reversed-line-order case.

Return summary must include implementation summary, files changed, migration/table summary, combo-key rules, commands/results, evidence that combinations auto-select correctly, and confirmation of no live labels/postage/marketplace notifications or shipped/cancelled mutations.

## PS-038 - Flag Expedited Shipping Orders in Awaiting Shipment + Shipped Tables

Priority: High - operator visibility and shipping SLA protection.

Problem: orders expecting expedited shipping must be visually called out in both Awaiting Shipment and Shipped Orders tables.

Required work:

- Determine the source of truth for buyer/requested shipping method or service level from source/marketplace/ShipStation order data. Awaiting Shipment needs this before label creation.
- Add safe normalized Orders payload fields such as `requestedShippingService`, `requestedShippingCode`, `requestedShippingIsExpedited`, and/or `requestedShippingSpeedDays` if missing.
- Centralize expedited detection. Detect common one-day, next-day, overnight, priority overnight, two-day, second-day, 2nd day, express 2 day, and clear carrier/service expedited codes. Avoid false positives for ground, economy, standard, media mail, parcel select, and similar services.
- Add a compact badge above/on top of the Order Date cell and apply a readable red row tint/highlight for expedited rows in both Awaiting Shipment and Shipped.
- Preserve row interactions and states including selection, active/hover, shipped/cancelled read-only behavior, queue indicators, row striping, and test-order styling.

Required tests:

- Unit tests for expedited detection positive and negative cases.
- API/backend tests proving normalized expedited flag/label in Awaiting and Shipped Orders payloads.
- Frontend/rendering tests proving Awaiting and Shipped badges/highlights and proving non-expedited rows remain normal.
- E2E/certification coverage so the SLA warning remains permanent.

Return summary must include source of truth found, files changed, detection rules/examples, Awaiting and Shipped badge/highlight evidence, commands/results, and confirmation of no live labels/postage/marketplace notifications or shipped/cancelled production mutations.

## PS-039 - Investigate + Backfill Order #1010 Shipment Metadata From ShipStation Shipment #289653129

Priority: Critical - shipped order data integrity and false `Ext. Label` display.

Problem: order `1010` is showing `Ext. Label` but should have real ShipStation shipment metadata from shipment `289653129`.

Investigation requirements:

- Use read-only local DB queries to find order `1010`, source/external IDs, status, external flags, and any non-voided `shipments` rows linked by order id, order number, ShipStation shipment id, tracking number, or label shipment id.
- Identify whether any shipment row exists but is orphaned or linked to the wrong order, order number, client, source, or bucket.
- Use read-only ShipStation API access to confirm shipment `289653129` or search around order `1010` if direct lookup is unavailable.
- Capture sanitized fields only: shipment ID, ShipStation order ID/order number, carrier, service, tracking, dates, cost, provider account id/nickname if available, and safe label metadata only if already supported. Do not print secrets, raw labels, raw payloads, or PII.
- Determine whether the root cause is PS-036 timezone gap, failed matching, wrong bucket/client linkage, shipped status before shipment metadata, or UI false external fallback.

Backfill requirements:

- Build or use a dry-run-first recovery path for this specific order.
- Dry-run must report matching local order ids, existing local shipment row ids, insert/update action, exact fields that would change, and whether a new shipment row or orphan repair is needed.
- Prepare write mode but do not execute it without DJ approval.
- Do not create a new label, buy postage, void/reissue labels, or notify marketplaces.
- Add targeted regression/guard coverage for a real ShipStation-backed shipped order not rendering `Ext. Label`, and for missing metadata rendering a missing-sync warning unless explicitly external.
- Add or reuse a reconciliation report mode for similar cases, dry-run by default.

Return summary must include order `1010` root cause, sanitized ShipStation fields, sanitized local DB state before repair, dry-run recovery output, whether DJ approval is required for write mode, files changed, commands/results, and explicit confirmation no live labels/postage/voids/marketplace notifications or production write-mode backfill occurred unless approved.

## PS-040 - Fix Billing Detail Item Qty Display + Repair Missing Shipment/Box Linkage

Priority: Critical - billing accuracy and fulfillment cost visibility.

Problem:

- Billing Detail Item Name and SKU columns drop per-line quantity, making mixed-SKU order quantities ambiguous.
- Recent shipped orders can show blank Carrier, Box Size, Box Cost, and Shipping in Billing Detail even when shipment rows exist because `billing_line_items.shipment_id` remained null after shipment sync gaps.

Required item/SKU display work:

- Replace or extend `itemSummary()` in `src/services/billing.ts` so it preserves and aggregates per-item quantities while skipping adjustment/discount rows as current logic does.
- Prefer SKU as identity when present, aggregate duplicate SKU lines, and preserve deterministic ordering matching order item order where possible.
- Display quantity suffix only when qty > 1:
  `Booster Gel x2`, `Booster-gel-001 x2`; do not show `x1`.
- Keep total Qty column as total billable units, not number of lines.

Required billing shipment-linkage work:

- Investigate why `generateLineItems()` left `shipment_id IS NULL` even when matching non-voided shipments now exist.
- Confirm whether conflict handling on `order_id`, `line_type`, and `description` prevents corrected rows.
- Build a dry-run-first repair path that detects shipped orders with null-shipment billing rows and now-present non-voided shipments by order id/order number.
- Dry-run must include affected order numbers/ids, billing line item ids/types/descriptions, matching shipment id/carrier/cost/dims, and proposed update/regenerate/create actions.
- Do not run write-mode repair/regeneration until DJ approves the dry-run output.
- Use a safe, idempotent strategy that preserves manual billing edits or clearly identifies impacted rows requiring approval.
- Prevent recurrence with tests for billing generated before shipment sync and then regenerated/repaired after shipment sync.

Required tests:

- Item summary tests for qty 1 no suffix, qty 2 suffix, two SKUs qty 1 + qty 2, duplicate SKU aggregation, and adjustment/discount exclusion.
- Backend tests for billing repair/regeneration.
- Frontend Billing Detail tests for item/SKU qty display.
- Billing Detail UI/E2E test proving 1026-style rows show carrier, box size, shipping, and fulfillment after repair/regeneration.

Return summary must include root causes, files changed, qty display rules, repair strategy/dry-run output, whether DJ approval is required for write mode, evidence/screenshots, commands/results, and confirmation of no live labels/postage/voids/marketplace notifications or production write-mode repair unless approved.
