# Hotspot Baseline

Date measured: 2026-06-05  
Branch: `prepshipv4-stable`  
Commit inspected: `9456c1ac`

## Method

Measurements used `git ls-files` so only tracked repository files were counted.
Excluded dependency/build/cache outputs: `node_modules`, `dist`, `build`,
`.next`, `coverage`, `test-results`, `package-lock.json`, and `drizzle/meta`
for the app-source baseline.

Optional textual duplication check:

```bash
npx --yes jscpd --pattern "**/*.{ts,tsx,js,jsx}" --ignore "**/node_modules/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**,**/test-results/**" --reporters console --threshold 0
```

Result: command exited 0 and did not print clone blocks. This means PS-100 should
prioritize semantic/source-of-truth duplication over pure copy/paste findings.

## Size Baseline

| Measurement | Count |
|---|---:|
| Tracked code-like files, including lockfile/drizzle meta | 663 |
| Tracked code-like lines, including lockfile/drizzle meta | 202,027 |
| App-source files, excluding lockfile/drizzle meta | 645 |
| App-source lines, excluding lockfile/drizzle meta | 162,586 |

## LOC By Major Area

| Area | LOC |
|---|---:|
| `web/src/components` | 56,923 |
| `scripts` | 30,236 |
| `web/src/lib` | 6,625 |
| `src/connectors/carrier` | 4,651 |
| `web/src/pages` | 4,601 |
| `api/carriers` | 4,090 |
| `src/routes/orders.ts` | 3,592 |
| `src/services/print-queue.ts` | 2,192 |
| `web/src/hooks` | 1,996 |
| `src/services/labels.ts` | 1,833 |
| `drizzle` SQL migrations | 1,716 |
| `src/routes/inventory.ts` | 1,712 |
| `src/services/billing.ts` | 1,698 |
| `src/connectors/store` | 1,362 |
| `web/src/utils` | 1,283 |
| `src/services/rates.ts` | 1,262 |
| `src/lib/shipstation` | 1,214 |
| `src/db/schema` | 1,068 |
| `src/services/reporting-metrics.ts` | 1,055 |

## Largest Source Files

| Rank | LOC | File |
|---:|---:|---|
| 1 | 11,750 | `web/src/components/Views/OrdersView.tsx` |
| 2 | 5,159 | `web/src/components/Views/InventoryView.tsx` |
| 3 | 4,818 | `web/src/lib/v2-apiClient.ts` |
| 4 | 3,918 | `web/src/components/Views/DashboardView.tsx` |
| 5 | 3,614 | `web/src/components/Settings/CarrierIntegrationsCard.tsx` |
| 6 | 3,592 | `src/routes/orders.ts` |
| 7 | 2,660 | `web/src/components/RateBrowserModal.tsx` |
| 8 | 2,237 | `web/src/components/Views/SettingsView.tsx` |
| 9 | 2,214 | `web/src/components/Views/AnalysisView.tsx` |
| 10 | 2,192 | `src/services/print-queue.ts` |
| 11 | 2,018 | `web/src/components/Views/BillingView.tsx` |
| 12 | 1,833 | `src/services/labels.ts` |
| 13 | 1,712 | `src/routes/inventory.ts` |
| 14 | 1,698 | `src/services/billing.ts` |
| 15 | 1,647 | `web/src/components/Views/PackagesView.tsx` |
| 16 | 1,605 | `api/carriers/labels.ts` |
| 17 | 1,333 | `web/src/hooks/v2Hooks.ts` |
| 18 | 1,262 | `src/services/rates.ts` |
| 19 | 1,234 | `web/src/components/ui/Table.tsx` |
| 20 | 1,226 | `web/src/components/OrderDetailDrawer.tsx` |

## Frontend Hotspots

| File | Evidence | Concern |
|---|---|---|
| `web/src/components/Views/OrdersView.tsx` | 11,750 LOC; functions include `createOrQueueLabel`, `openRateBrowser`, `recalculateBestRate`, `startBatchRecalculateBestRates`, `buildSelectedRateProofPayload`, `refreshPanelBestRate`, `buildQueueSendOrderPayload` | Operator UI owns domain decisions for shipping, rates, queue, labels, and display convergence. |
| `web/src/components/RateBrowserModal.tsx` | 2,660 LOC; has `browseRates`, `dedupeRateRows`, `groupRatesByProviderId`, `handleRateClick`, `toAppliedRate`, `rateBlockedReason` | Modal duplicates rate-domain sorting, grouping, blocked-rate, and selection semantics. |
| `web/src/lib/v2-apiClient.ts` | 4,818 LOC; methods include `fetchRates`, `browseRates`, `createLabel`, `createLabelBatch`, `addToQueue`, `openLabelPdf`, `generateBilling`, inventory/package normalizers | Single facade mixes transport, compatibility mapping, source filtering, provider routing, and DTO normalization. |
| `web/src/components/Views/InventoryView.tsx` | 5,159 LOC | Inventory UI owns many operational transformations that should stay behind inventory services. |
| `web/src/components/Settings/CarrierIntegrationsCard.tsx` | 3,614 LOC | Carrier/account/source promotion and display logic are coupled to Settings UI. |

## Backend Hotspots

| File | Evidence | Concern |
|---|---|---|
| `src/routes/orders.ts` | 3,592 LOC; route surface covers list, full order, patches, external shipped, dims, export, picklist | Main read/write route owns too many DTO projections and workflow updates. |
| `src/services/print-queue.ts` | 2,192 LOC; `processQueueSendOrder`, `addToQueue`, `startQueueSendJob`, `runQueueSendJob` | Label creation plus queue insertion plus recovery live in one service; durable state exists but not as a full shipping lifecycle. |
| `src/services/labels.ts` | 1,833 LOC; `createLabelV2`, `persistCreatedLabel`, `markOrderShipped`, `enqueueShipmentConfirmation` | Label purchase chains provider call, shipment persistence, shipped transition, inventory/package deduction, and outbox enqueue. |
| `api/carriers/labels.ts` | 1,605 LOC; direct carrier label serverless flow; `persistDirectCarrierLabel`; SHIPP/Walmart/direct paths | Direct label path duplicates ShipStation label boundaries and marketplace confirmation plumbing. |
| `src/services/rates.ts` | 1,262 LOC; `resolveRateInput`, `rateCacheKey`, `fetchLiveRatesWithDiagnostics`, `getRates`, `pickBestRate` | Strong backend owner for rates, but frontend still duplicates selection/display logic. |
| `src/services/billing.ts` | 1,698 LOC | Billing generation mixes live reads and frozen line items; line-item ownership should be explicit. |
| `src/routes/inventory.ts` | 1,712 LOC | Route owns many inventory transformations in addition to service calls. |

## High-Coupling Indicators

- Repeated provider identity fields appear across `orders`, `order_overrides`,
  `shipments`, rate rows, frontend DTOs, and direct-carrier synthetic ids:
  `shippingProviderId`, `providerAccountId`, `carrierAccountId`, `selectedPid`,
  `carrierCode`, `serviceCode`.
- Rate request identity exists in both backend (`src/services/rates.ts`,
  `src/services/shipping-workflow/rate-fingerprint.ts`) and frontend
  (`OrdersView.tsx` request-key helpers).
- Label URL normalization appears in backend services/routes and frontend
  `openLabelPdf`; backend must own safety, frontend should only display/open.
- Inventory has a good ledger model (`inventory_ledger`), but route/UI code still
  contains derived stock and enrichment paths.
- Billing has frozen line items (`billing_line_items`), but generation and detail
  views still need clearer separation from live order/shipment reads.

## Import Hotspots

Top import specs are expected for platform libraries (`react`, `hono`,
`drizzle-orm`, `zod`), but these domain imports show coupling:

| Import | Count | Interpretation |
|---|---:|---|
| `../db/client` and `../src/db/client` | 83 combined | Many scripts/routes/services reach DB directly. |
| `../db/schema/orders` and `../src/db/schema/orders` | 26 combined | Order table is a broad dependency across domains. |
| `../db/schema/shipments` and `../src/db/schema/shipments` | 16 combined | Shipment snapshot data is widely read. |
| `../../types/api` | 9 | Shared API DTO shape is important but not enough to enforce ownership. |

## Repeated Helper Names

Raw repeated-name counts are noisy because guard scripts intentionally repeat
`assert`, `check`, and `packageJson`. More meaningful repeated concepts:

- `normalize*` helpers across frontend API client, rate modal, routes, connectors,
  and backend services.
- `shippingProviderId`/`providerAccountId`/`carrierAccountId` mapping helpers in
  `OrdersView.tsx`, `RateBrowserModal.tsx`, `v2-apiClient.ts`, `src/services/rates.ts`,
  `api/carriers/labels.ts`, and `src/services/labels.ts`.
- `rate*Key` and `fingerprint` helpers in frontend and backend.
- label URL safety helpers in `src/services/print-queue.ts`,
  `src/routes/print-queue.ts`, `src/lib/shipstation/labels.ts`, and
  `web/src/lib/v2-apiClient.ts`.

