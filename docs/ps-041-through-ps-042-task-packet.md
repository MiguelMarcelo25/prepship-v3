# PS-041 Through PS-042 - PrepShip Task Packet

Created from DJ handoff on 2026-05-29.

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Assignee: `<@714064895963955211>`

## Safety Baseline For This Packet

- Do not buy postage, create real labels, void labels, or notify marketplaces from automated tests.
- Do not expose secrets, raw provider payloads, raw labels, customer PII, or cross-client data in logs, docs, fixtures, screenshots, Trello, or Discord summaries.
- Do not weaken auth, RBAC, client/store scope, source-of-truth boundaries, secret redaction, shipped/cancelled lockdown, or provider isolation.
- Do not mutate shipped/cancelled/terminal orders unless DJ explicitly approves the exact operation.
- Provider/live-path checks must be read-only or dry-run unless DJ explicitly approves an apply/import/write operation.

## PS-041 - Fix ShipStation Timezone Sync Gap + Add Mandatory E2E/Live-Path Coverage Standard

Priority: Critical - live ShipStation order visibility and testing standard.

Status: New approved PrepShip V4 task from DJ. This covers the live ShipStation order-sync issue discovered from HUGRAB orders `1042` through `1045` and establishes the testing expectation that applicable fixes include E2E/workflow/live-path coverage, not just code patches.

Problem:

- Shopify/ShipStation orders `1042`, `1043`, `1044`, and `1045` were visible in the ShipStation source dashboard but missing from PrepShip.
- Direct ShipStation API order-number lookups found all four in the main ShipStation account, store `378060`, status `awaiting_shipment`.
- Local PrepShip DB had `0` rows for `1042` through `1045` and no orders after `2026-05-28 15:00 PT` at the time of investigation.
- Worker heartbeat and scheduled jobs were fresh/succeeding, so this is not simply a dead worker.
- Direct ShipStation query behavior showed:
  - `modifyDateStart=2026-05-28 15:00:00` returned affected orders.
  - `modifyDateStart=2026-05-28 22:00:00` returned `0`.
- Current code formats ShipStation date filters from UTC ISO text without timezone. ShipStation v1 appears to interpret timezone-less timestamps as account/local time, creating an approximate 7-hour future window during PT business hours and skipping orders.

Files/docs to inspect first:

- `AGENTS.md`
- `src/connectors/store/shipstation.ts`
- `src/services/order-sync.ts`
- `src/services/shipment-sync.ts`
- `src/routes/sync.ts`
- `src/services/worker-status.ts`
- `scripts/status-sync.ts`
- `scripts/reconcile-shipstation-awaiting.ts`
- `scripts/store-connector-source-guard.ts`
- `scripts/shipstation-awaiting-parity-guard.ts`
- `scripts/sync-advisory-lock-guard.mjs`
- Existing full-site/workflow certification tests that cover Orders sync visibility.

Required work:

- Confirm the exact root cause before changing behavior:
  how ShipStation v1 interprets timezone-less `modifyDateStart` / `createDateStart`, every production sync path using the format, and whether orders and shipments differ.
- Fix ShipStation order sync so recent account-local/PT `awaiting_shipment` orders are not skipped by UTC/no-zone query formatting.
- Preserve incremental watermark behavior, multi-account/client credential behavior, store/client scoping, and shipped/cancelled forward-only safety.
- Determine whether shipment sync has the same timezone bug. Fix it if affected, or document why it is safe and add/adjust tests to lock the distinction.
- Add a safe dry-run-first recovery/backfill path for recent ShipStation awaiting orders. Live apply/import must be explicit and report what will be imported before writing.
- Include recovery guidance for HUGRAB/store `378060` orders `1042` through `1045`.
- Add mandatory regression coverage at the highest meaningful safe layer:
  unit/static guard for date formatting/query construction, API/integration coverage for the actual ShipStation order sync path, read-only live-path/dry-run reconciliation when credentials are available, and browser/workflow certification if Orders sync visibility is part of launch/full-site certification.
- Update relevant task/certification docs or guards so future PrepShip fixes ask whether they require browser E2E, workflow certification, API integration, provider live-path dry-run, or lower-level tests only.
- Make bad live-path outcomes visible: missing credentials must warn/fail clearly, and a zero-order provider response caused by a bad date window must be diagnosable.

Required verification commands:

- `npm run typecheck`
- `npm run test:store-connector-source`
- `npm run test:connector-registry`
- `npm run test:shipstation-awaiting-parity`
- `npm run status:sync -- --json` or updated equivalent sync status guard
- `npm run shipstation:awaiting:diff` or updated read-only reconciliation command
- Any new focused timezone/query-window guard, for example `npm run test:shipstation-sync-window`
- Any updated workflow/full-site certification command if Orders sync visibility is included.

Return summary must include root cause, files changed, exact behavior changed, testing applicability decision, commands/results, redacted live-path/dry-run reconciliation result, recovery status for `1042` through `1045`, approval needed for apply/import, and confirmation no forbidden live operations occurred.

## PS-042 - Fix Billing Summary Total Row Column Alignment + Add E2E Coverage

Priority: High - visible Billing summary UI correctness.

Status: New approved PrepShip V4 task from DJ. DJ reported that the Billing summary Total row values are not lining up under the appropriate columns.

Problem:

- Billing summary Total row is visually misaligned under the table columns.
- Columns include Client, Orders, Pick & Pack, Add Units/Addl Units, Box Cost, Storage, Shipping, and Fulfillment Fee.
- The Total row should show full-dataset totals and each value must sit directly beneath its matching header/cell regardless of column order, visibility, resized widths, sorting, and pagination.

Files to inspect first:

- `AGENTS.md`
- `web/src/components/Views/BillingView.tsx`
- `web/src/components/ui/Table.tsx`
- `web/src/components/Views/billing-parity.ts`
- Existing Billing/Billing UI guards and Playwright tests under `web/e2e` and `scripts/*billing*`.
- `package.json` scripts related to Billing, UI tables, full-site certification, and workflow certification.

Required work:

- Reproduce and identify the exact alignment root cause before changing behavior.
- Verify whether the issue comes from BillingView `footerRow`, Table primitive footer rendering, column width persistence, hidden/reordered columns, resized columns, border/padding mismatch, text alignment, missing width constraints, or another layout issue.
- Fix Billing summary Total row alignment:
  Total label under Client, total orders under Orders, total pick/pack under Pick & Pack, total additional units under Add Units/Addl Units, total box cost under Box Cost, total storage under Storage, total shipping under Shipping, and total fulfillment fee under Fulfillment Fee.
- Keep alignment correct when columns are reordered, hidden/shown, resized, sorted, and paginated where supported.
- Preserve full-dataset totals. Do not change billing math unless investigation proves totals are numerically wrong.
- Prefer a reusable Table-level fix if footer rendering is the root cause. Footer cells should share the same width/maxWidth/data-col-key/data-col-label/data-col-align semantics as normal body cells when applicable.
- Preserve export/invoice behavior, client/store scope, billing source-of-truth, and fee calculations.

Testing requirements:

- Browser E2E/workflow coverage is mandatory because this is a visible operator Billing table bug.
- Add/update a Playwright or equivalent browser test that loads the Billing summary table and verifies footer Total cells line up with corresponding headers/body columns.
- Include default column order and at least one operator-customized state if the Table supports persisted reorder/hide/resize via localStorage.
- Verify semantic and visual alignment, not just text presence.
- Recommended assertions:
  locate columns by stable data attributes or visible header labels; compare footer cell x-position/width with matching header/body cell within a small tolerance; verify after hide/reorder/resize where supported; verify Total row remains bottom and full-dataset totals still display.
- If stable selectors are missing, add safe data attributes to the Table primitive that help tests/accessibility without leaking data.

Required verification commands:

- `npm run typecheck`
- `npm run test:billing-client-scope`
- `npm run test:billing-formula`
- Any existing Billing UI/UX guard relevant to the summary table
- New/updated Billing summary Total-row E2E/browser test command, for example `playwright test web/e2e/billing-summary-total-alignment.spec.js --reporter=line` or an npm script wrapper.
- If shared `Table.tsx` behavior changes, run at least one surrounding table workflow/UX suite for Orders/Inventory/Analysis table rendering.

Return summary must include root cause, files changed, exact UI behavior changed, testing applicability/E2E coverage, commands/results, screenshot or concise visual evidence, and confirmation that billing math/source-of-truth/auth/client-scope protections were not weakened.
