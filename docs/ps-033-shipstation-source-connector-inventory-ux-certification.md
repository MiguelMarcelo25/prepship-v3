# PS-033 - Certify ShipStation Source Connector Flow and Fix Inventory UX Certification Blockers

Task ID: PS-033

Title: Certify ShipStation Source Connector Flow and Fix Inventory UX Certification Blockers

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

## Copy/Paste Codex Prompt

You are working in PrepShip V4.

Task PS-033: Certify ShipStation Source Connector Flow and Fix Inventory UX Certification Blockers

Assignee: Lawrence / `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

## Goal

PrepShip V4 needs a clean certification path before we can say the ShipStation source connector is fully configured and all ShipStation awaiting orders are flowing correctly. Current static connector guards pass, and live ShipStation API calls return 200s, but dry-run reconciliation still reports local/live status mismatches. Full-site certification is also blocked by Inventory UX regressions.

## Important Current Evidence From Review Environment

- `npm run test:store-connector-source` passes.
- `npm run test:connector-registry` passes.
- `npm run test:shipstation-awaiting-parity` passes.
- `npm run shipstation:awaiting:diff` reaches ShipStation successfully with 200 OK responses for configured stores.
- Dry run reported: `liveAwaiting=4 localChecked=1985 findings=32 safeCandidates=1 blocked=1 needsConfirmation=30`.
- One safe candidate was reported: Walmart order `200014894429696` / local id `947584`, local `awaiting_shipment` -> `shipped`, evidence `marketplace terminal status`.
- One blocked shipped/cancelled-lockdown item was reported: order `1010` / local id `1138616`, local `shipped` but ShipStation/raw says `awaiting_shipment`, latest shipment voided. Do not mutate this without explicit DJ approval because terminal/shipped data is locked.
- Most remaining findings are `local_awaiting_missing_from_shipstation`, including test rows and older Walmart rows that need confirmation before changing.
- `npm run test:inventory-default-view` currently fails: `FAIL Stock Levels table body scrolls within laptop-sized viewports`.
- `npm run test:receive-sku-picker` currently fails: `FAIL: Receive Inventory SKU dropdown aligns to the input width instead of forcing a wide menu`.
- `npm run test:full-site-certification` is currently blocked later by mobile Inventory SKU picker instability: Playwright timeout clicking combobox `SKU or product name`, element detached from DOM.

## Files / Docs To Inspect First

- `AGENTS.md` / shipped-cancelled lockdown rules
- `package.json` test scripts around connector/source/inventory/full-site certification
- `scripts/reconcile-shipstation-awaiting.ts`
- `scripts/store-connector-source-guard.ts`
- `scripts/shipstation-awaiting-parity-guard.ts`
- `src/connectors/store/shipstation.ts`
- `src/services/normalized-order-persistence.ts`
- `src/services/order-sync.ts`
- `src/domain/fulfillment/types.ts`
- `src/connectors/types.ts`
- Inventory UI files, especially `web/src/components/Views/InventoryView.tsx` and related Autosuggest/SKU picker components
- `scripts/inventory-default-view-guard.mjs`
- `scripts/receive-sku-picker-guard.mjs`
- `web/e2e/inventory-ux.spec.js`

## Implementation Requirements

### 1. ShipStation Source Connector Certification / Reconciliation

- Verify the connector boundaries still pass:
  - `npm run test:store-connector-source`
  - `npm run test:connector-registry`
  - `npm run test:shipstation-awaiting-parity`
- Run `npm run shipstation:awaiting:diff` and classify every finding into one of:
  - safe automated reconciliation candidate
  - test fixture/data cleanup candidate
  - needs human/marketplace confirmation
  - blocked by shipped/cancelled lockdown
- Do not blindly mutate live terminal/shipped/cancelled data.
- Do not apply reconciliation to live orders unless DJ explicitly approves the exact candidate(s).
- If code changes are needed because reconciliation is noisy, fix the reconciliation logic so test rows, missing-store rows, or known non-live rows are classified clearly and safely.
- If there is a legitimate connector/order-sync bug, fix the source connector path without bypassing the StoreConnector source-of-truth boundaries.
- Preserve thin connector architecture. Provider API calls should stay inside connector implementations or connector-owned helpers where practical.
- Do not overengineer a new connector framework unless required. Prefer small, direct, testable fixes.
- Produce a final ShipStation flow certification summary that answers: "Is the source connector configured, and are ShipStation awaiting orders flowing correctly?" with evidence.

### 2. Inventory Stock Levels Laptop Viewport Fix

- Fix the Stock Levels table shell/body layout so the table body scrolls properly within laptop-sized viewports while the pagination/footer remains usable and visible.
- Preserve responsive behavior and avoid horizontal/vertical overflow regressions.
- Make `npm run test:inventory-default-view` pass.

### 3. Receive Inventory SKU Picker Dropdown Fix

- Fix the Receive Inventory SKU dropdown so it aligns to the input width instead of forcing a wide menu.
- Ensure the dropdown escapes worksheet overflow clipping where intended.
- Preserve full selected-client SKU lookup behavior, including inactive rows and no small default cap.
- Make `npm run test:receive-sku-picker` pass.

### 4. Mobile Inventory SKU Picker Stability

- Fix the mobile Inventory UX flake where Playwright times out clicking the `SKU or product name` combobox because the element detaches from the DOM.
- The combobox/dropdown should remain stable during mobile click/search/select flows.
- Avoid fixes that only add arbitrary timeouts. Fix the component/render/layout cause.
- Make `npm run test:inventory-ux:browser` pass.

### 5. Full Certification Loop

After targeted fixes pass, run full relevant certification:

- `npm run typecheck`
- `npm run build:web`
- `npm run test:store-connector-source`
- `npm run test:connector-registry`
- `npm run test:shipstation-awaiting-parity`
- `npm run shipstation:awaiting:diff` in dry-run mode
- `npm run test:inventory-default-view`
- `npm run test:receive-sku-picker`
- `npm run test:inventory-ux:browser`
- `npm run test:full-site-certification`

If `test:full-site-certification` fails on an unrelated existing blocker, capture the exact failing command/spec/error and run all surrounding targeted checks needed to prove this task's work is complete.

## Guardrails / Forbidden Changes

- Do not expose secrets, tokens, API keys, raw provider payloads, label URLs, customer PII, or cross-client data in logs, screenshots, tests, comments, or PR summary.
- Do not create real labels or buy postage.
- Do not send real marketplace notifications.
- Do not mutate live orders, shipped/cancelled orders, or terminal state unless DJ explicitly approves the exact operation.
- Do not weaken auth/RBAC, client/store scope, source-of-truth constraints, secret redaction, label safety, or shipped/cancelled lockdown.
- Do not modify shipped/cancelled locked surfaces unless DJ provides the explicit unlock/approval required by `AGENTS.md`.
- Do not replace connector boundaries with direct provider calls from core routes/services.
- Do not mark complete with only static guard success; browser/full-site behavior must be exercised.

## Definition Of Done

- ShipStation source connector guards pass.
- ShipStation awaiting reconciliation dry run is cleanly classified, with any remaining live-data mismatches documented and no unsafe mutation performed.
- Inventory Stock Levels laptop scroll guard passes.
- Receive SKU picker guard passes.
- Mobile Inventory UX browser test passes.
- Full-site certification passes, or any unrelated blocker is documented with proof that PS-033-targeted checks pass.
- Final PR/report clearly states whether ShipStation orders are flowing correctly, what reconciliation findings remain, and whether any DJ approval is needed for live-data cleanup.

## Return Format

1. Summary of code changes.
2. ShipStation connector/order-flow certification result.
3. Reconciliation dry-run result table or concise classification summary.
4. Inventory UX fixes made.
5. Commands run with pass/fail results.
6. Any remaining blockers or DJ approvals needed.
7. Confirmation that no real labels, postage, marketplace notifications, secrets, PII exposure, or unauthorized live shipped/cancelled mutations occurred.
