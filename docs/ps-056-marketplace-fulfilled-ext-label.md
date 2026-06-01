# PS-056 - Permanently Classify Marketplace-Fulfilled Shipped Orders as Ext. Label

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Status: New standalone task. This must fix the current Missing shipment sync regression for genuinely marketplace/external shipped orders and make the behavior immutable with guards/tests/certification.

## Context

DJ sent a Shipped Orders screenshot where multiple rows show yellow `Missing shipment sync` badges in Carrier, Shipping Account, and Selected Rate. DJ expects those rows to show `Ext. Label` when the order is genuinely marketplace/external fulfilled and no PrepShip/ShipStation label exists.

Investigation findings from current repo:

- This does not appear to be a simple code revert in `OrdersView`.
- `OrdersView` currently has PS-036 logic that intentionally renders `Missing shipment sync` for shipped rows that have no local shipment data and no explicit external flag:
  - `renderMissingShipmentSyncBadge()`: `web/src/components/Views/OrdersView.tsx`
  - `hasExplicitExternalFlag()`: reads `flags.externallyShipped` / `flags.externallyFulfilled` / `order.externalShipped`
  - `getShippedDataState()`: external if explicit flag, local if shipment data, otherwise missing
  - `shouldShowCarrierExtLabel()`: shows `Ext. Label` only when `getIsExternallyFulfilled(order)` is true
- That PS-036 behavior was added by commit `be7e336` (`PS-036: fix false Ext. Label + make Orders column integrity a mandatory E2E`). It fixed a prior bug where real unsynced ShipStation labels were incorrectly labeled `Ext. Label`.
- Later, commit `cb05517` added `scripts/reconcile-external-shipped-orders.ts` because some genuinely marketplace-fulfilled shipped orders were still showing `Missing shipment sync`.
- The script classifies:
  - shipped + no local non-voided shipment + no upstream ShipStation shipment + no upstream ShipStation fulfillment => external, should be flagged so UI renders `Ext. Label`
  - shipped + upstream shipment or fulfillment => recoverable missing-sync, not external
- Current dry-run evidence:
  - Command run: `npm run shipstation:external-shipped:dry-run -- --days 7 --limit 20`
  - Result: scanned 20, external 20, recoverable 0, lookup_failed 0, flagged 0 because dry-run only
  - Sample order numbers included Amazon/Walmart style IDs such as `113-8698268-9877044`, `200014985891746`, `200015079411551`, etc.
- Existing guards pass:
  - `npm run test:external-shipped-reconcile`
  - `npm run test:shipstation-fulfillment-backfill`
- The missing operational step appears to be that external candidates were identified but not persistently flagged/applied, and/or the immutable certification does not prove the production Shipped table no longer shows marketplace-external candidates as `Missing shipment sync`.

## Root Cause To Verify

The UI is obeying the current contract: no explicit external flag => `Missing shipment sync`.

The regression is likely data/classification/operationalization: marketplace-fulfilled orders that have no ShipStation shipment/fulfillment have not been persisted as `externally_shipped=true` / `flags.externallyShipped=true`, so `OrdersView` cannot know to render `Ext. Label`.

## Core Invariant

A shipped order must render exactly one honest shipment state:

1. `LOCAL LABEL / LOCAL SHIPMENT DATA`: render real carrier/account/rate/tracking from local shipment/selected-rate/canonical shipping data.
2. `RECOVERABLE MISSING SYNC`: if upstream ShipStation has a non-voided shipment or tracked fulfillment that is not locally linked yet, render `Missing shipment sync` and route to backfill/recovery.
3. `EXTERNAL / MARKETPLACE-FULFILLED`: if no local shipment and no upstream ShipStation shipment/fulfillment exists, mark/persist it as external and render `Ext. Label`.

## Files To Inspect First

- `web/src/components/Views/OrdersView.tsx`
  - `renderExtLabelBadge`
  - `renderMissingShipmentSyncBadge`
  - `hasExplicitExternalFlag`
  - `hasLocalShipmentData`
  - `getShippedDataState`
  - `getIsExternallyFulfilled`
  - `getIsMissingShipmentSync`
  - `shouldShowCarrierExtLabel`
  - Carrier / Shipping Account / Selected Rate render cases
- `scripts/reconcile-external-shipped-orders.ts`
  - dry-run/apply classifier and candidate query
- `scripts/external-shipped-reconcile-guard.ts`
- `scripts/backfill-shipstation-fulfillments.ts`
- `scripts/shipstation-fulfillment-backfill-guard.ts`
- `src/routes/orders.ts`
  - `flags.externallyShipped` / `flags.externallyFulfilled` API payload
  - shipped-row shipment enrichment
- `src/db/schema/orders.ts`
  - `orders.externally_shipped`
  - `order_overrides.externally_shipped_source`
- `web/e2e/orders-column-integrity.spec.js`
- `scripts/shipping-certification-guard.mjs`
- Any cron/worker/scheduled certification that should keep this classification fresh.

## Implementation Requirements

### 1. Verify Root Cause With Read-Only Evidence

- Pick several visible/current rows that show `Missing shipment sync`.
- For each, determine:
  - local order id/order number/status/client/store
  - whether a non-voided local shipment exists
  - whether `flags.externallyShipped` / `flags.externallyFulfilled` are true in the API payload
  - whether ShipStation has a non-voided `/shipments` row
  - whether ShipStation has a non-voided tracked `/fulfillments` row
- Classify each as `LOCAL`, `RECOVERABLE_MISSING_SYNC`, or `EXTERNAL`.
- Do not mutate first. Produce dry-run evidence.

### 2. Fix Immediate Production/Data Classification Safely

- For rows classified `EXTERNAL`, persist the explicit external flag through the same safe path as operator Mark Shipped External:
  - `orders.externally_shipped = true`
  - `order_overrides.externally_shipped_source = 'marketplace_fulfilled'` or equivalent audit source
- Use dry-run first. Apply/write mode must be explicit and should be run only after DJ approval for the exact candidate set.
- Do not flag rows with upstream shipments/fulfillments as external. Those remain recoverable `Missing shipment sync` and should go through shipment/fulfillment backfill.
- Do not delete, rewrite, void, create labels, buy postage, or notify marketplaces.

### 3. Make It Immutable / Non-Regressing

- Add a permanent guard/certification that fails if a row that meets the `EXTERNAL` classifier still renders `Missing shipment sync`.
- Add a permanent guard/certification that fails if a row with upstream shipment or fulfillment gets incorrectly rendered `Ext. Label`.
- Add a production/read-only certification command that reports counts:
  - shipped missing local shipment and external flag false
  - classified external candidates
  - recoverable candidates
  - lookup failures
  - rows already flagged external
- The command must be dry-run/read-only by default and safe to run in CI/certification without secrets when mocked, and against production only when credentials are available.
- If this needs a scheduled worker/cron, add it as dry-run report by default or require explicit approval before any write mode. Do not silently mutate production from a generic guard.

### 4. Preserve PS-036 / PS-039 Safety

- Do not revert to the old behavior where all missing shipment metadata becomes `Ext. Label`.
- Do not hide real shipment-sync/backfill problems by labeling recoverable ShipStation labels as external.
- Maintain the distinction:
  - upstream shipment/fulfillment exists => `Missing shipment sync` / recoverable
  - no upstream shipment/fulfillment exists => external / `Ext. Label`
- Keep `#1010` / manual fulfillment recovery behavior protected.

### 5. UI Expectations

- For explicit external rows, Carrier / Shipping Account / Selected Rate should render `Ext. Label` or the existing external-label visual treatment consistently.
- For recoverable rows, `Missing shipment sync` remains acceptable and should explain that sync/backfill is needed.
- Badge/tooltips should make the difference clear to operators.

## Guardrails / Forbidden Changes

- Do not buy postage, create labels, void labels, reissue labels, or notify marketplaces.
- Do not mutate shipped/cancelled rows except the explicit reversible external flag path approved by DJ after dry-run review.
- Do not delete or rewrite shipment/order history.
- Do not expose secrets, API keys, labels, raw provider payloads with PII, or cross-client data in logs/screenshots/task summaries.
- Do not weaken auth, RBAC, client/store scope, shipped/cancelled lockdown, source-of-truth rules, or financial redaction.
- Do not make UI-only changes that simply rename `Missing shipment sync` to `Ext. Label` without data classification.

## Testing Applicability

This is an operator-visible Shipped Orders source-of-truth/display regression and crosses the ShipStation/external marketplace boundary. It requires read-only data-flow verification, classifier tests, Orders table/browser coverage, and a permanent certification guard. No live label/postage/marketplace mutation is allowed.

## Required Verification

Existing guards must pass:

- `npm run test:external-shipped-reconcile`
- `npm run test:shipstation-fulfillment-backfill`

Add/update focused tests proving:

- explicit external flag => Orders renders `Ext. Label` in Carrier / Shipping Account / Selected Rate
- no local shipment + upstream shipment exists => `Missing shipment sync`, not `Ext. Label`
- no local shipment + upstream tracked fulfillment exists => `Missing shipment sync`, not `Ext. Label`
- no local shipment + no upstream shipment/fulfillment => classifier returns external, and after persisted external flag the row renders `Ext. Label`
- lookup failure does not silently flip to external

Browser/E2E coverage:

- Update `web/e2e/orders-column-integrity.spec.js` or closest maintained Orders shipped-table spec with fixtures for `LOCAL`, `RECOVERABLE_MISSING_SYNC`, and `EXTERNAL`.
- Assert the exact rendered columns, not just non-empty cells.

Read-only production/dry-run evidence:

- Run `npm run shipstation:external-shipped:dry-run -- --days 7 --limit 20` or appropriate scoped command.
- Report scanned/external/recoverable/lookup_failed/already flagged counts.
- If applying flags, provide the exact approved candidate set and before/after proof that those rows now render `Ext. Label`.

Run at minimum and report exact output:

- `npm run typecheck`
- `npm run build:web`
- `npm run test:external-shipped-reconcile`
- `npm run test:shipstation-fulfillment-backfill`
- `npm run guard:shipping-certification`
- `npm run test:orders-column-integrity:browser` or `npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line`
- the new immutable certification/guard command added for this task

## Definition Of Done

- Current marketplace/external shipped orders no longer show `Missing shipment sync` once classified and explicitly flagged; they show `Ext. Label`.
- Recoverable ShipStation shipment/fulfillment gaps still show `Missing shipment sync` and are not mislabeled external.
- The distinction is protected by permanent tests/guards/browser certification.
- There is a safe read-only certification/report command that can be rerun after future deploys.
- If write/apply mode is used, it is explicit, audited, reversible-flag-only, and scoped to DJ-approved candidates.
- No labels/postage/marketplace notifications were created.

## Scheduler Automation

PS-056 can run automatically from the existing worker/API scheduler. The scheduled classifier always scans both shipped and cancelled rows with no local shipment data using the same rule as the manual command:

`no local non-voided shipment + no upstream ShipStation shipment/fulfillment => external`

Render env controls:

- `ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER=true`
  - Enables the 30-minute automatic PS-056 classifier/certification tick.
  - The tick includes cancelled rows, equivalent to manual `--include-cancelled`.
- `ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY=true`
  - Allows the scheduled tick to apply the reversible `externally_shipped=true` flag to rows classified external.
  - If omitted/false, the scheduled tick is dry-run/report-only.

Safety:

- Automatic apply only sets the reversible external flag and audit source.
- It does not create labels, buy postage, void labels, rewrite shipment history, or notify marketplaces.
- Recoverable rows with upstream shipment/fulfillment evidence are never flagged external; they remain for shipment/fulfillment backfill.

## Return Format

Reply with:

1. What reverted / root cause summary with commit/file evidence.
2. Dry-run classification counts and sample affected order numbers.
3. Exact rows/candidates flagged if apply mode was approved and used.
4. Explanation of immutable guard/certification added.
5. Exact commands run and pass/fail results.
6. Browser/UI evidence showing `Ext. Label` vs `Missing shipment sync` for the three state types.
7. Explicit statement that no labels, postage purchases, marketplace notifications, or shipment-history rewrites were performed.
