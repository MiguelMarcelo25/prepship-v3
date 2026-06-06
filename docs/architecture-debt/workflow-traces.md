# Workflow Traces

Each trace lists the current path and the recommended canonical owner. These are
read-only observations; no behavior changes were made.

## 1. Awaiting Shipment Order Load + Passive Saved-Rate Display

| Field | Current path |
|---|---|
| User action | Open Awaiting Shipment / filter/search/select orders. |
| Frontend | `OrdersView` (`web/src/components/Views/OrdersView.tsx:2035`) loads and renders rows; rate display helpers around `getBestRate*`, `renderAwaitingRateFallback`, and `classifyAwaitingRateCellState` in `orders-parity.ts`. |
| API client | `web/src/lib/v2-apiClient.ts` order fetch/normalization and `fetchMatchingOrdersForSelection` for across-page actions. |
| Backend route | `src/routes/orders.ts:1175` list route and detail/full routes at `:2380`, `:2415`. |
| DB reads | `orders`, `order_overrides`, `shipments`, `clients`, `order_items` projections. |
| Partial windows | Saved `bestRateJson` may exist while dims/weight/account scope has changed. |
| Duplicate decisions | Awaiting rate state is classified in frontend while backend owns rate cache and best-rate metadata. |
| Canonical owner | Backend Orders workflow DTO should provide rate-state, selected-rate-state, and allowed actions. |

## 2. Best Rate Calculation / Refresh

| Field | Current path |
|---|---|
| User action | Passive auto rating, side-panel Recalculate, or Recalculate All. |
| Frontend | `OrdersView` helpers: `getAutoBestRateRequest`, `buildStrictBestRateRequest`, `applyStrictBestRateResponse`, `runStrictBestRateRecalculation`, `startBatchRecalculateBestRates`. |
| API client | `v2-apiClient.ts:4143` `browseRates`; older `fetchRates` still exists at `:4024`. |
| Backend route | `src/routes/rates.ts:287` `/rates/browse`; `:221` raw rates; `:451` cached bulk. |
| Service | `src/services/rates.ts:338` `resolveRateInput`, `:387` `rateCacheKey`, `:911` `fetchLiveRatesWithDiagnostics`, `:1177` `getRates`, `:468` `pickBestRate`. |
| DB reads/writes | `rate_cache`, carrier account/client credentials, automation rules, order overrides when persisted through orders route. |
| Provider calls | ShipStation/ShipEngine and direct carrier connector quote paths. |
| Partial windows | Some carriers can fail/time out; strict recalculation should block uncertain orders rather than save partial truth. |
| Duplicate decisions | `pickBestRate` backend vs frontend display/panel selection and rate reconciliation. |
| Canonical owner | Backend rate workflow service owns strict live best-rate result and confidence state. |

## 3. Rate Browser Browse/Refetch + Selected-Rate Apply

| Field | Current path |
|---|---|
| User action | Open Browse Rates, choose account/service/rate, apply selected rate. |
| Frontend | `RateBrowserModal.tsx:823` component; `browseRates` at `:1103`; `handleRateClick` at `:1476`; `toAppliedRate` at `:1502`; row rendering at `:1528`. |
| API client | `v2-apiClient.ts:4143` `browseRates`; combines ShipStation/direct results and exposes `bestRate`. |
| Backend route | `src/routes/rates.ts:287` `/rates/browse`. |
| DB reads/writes | Reads rates/carrier accounts; selected/best rate persists through `src/routes/orders.ts` PATCH and order override fields (`bestRateJson`, `bestRateDims`, `selectedPid`). |
| Provider calls | Rate connector calls only, no labels. |
| Partial windows | Modal can show live result while table/sidebar still shows saved/stale result until persistence/refetch converges. |
| Duplicate decisions | Modal dedupe/group/display (`dedupeRateRows`, `rateDisplayTotal`) overlaps backend rate identity and markups. |
| Canonical owner | Backend returns authoritative applied-rate DTO; modal displays and sends operator intent. |

## 4. Create + Print Label

| Field | Current path |
|---|---|
| User action | Click Create + Print Label in side panel or batch action. |
| Frontend | `OrdersView.tsx:4944` `createOrQueueLabel`; proof builder at `:5423`; label PDF helpers at `:4907`. |
| API client | `v2-apiClient.ts:2475` `createLabel`; direct-vs-ShipStation routing currently occurs here. |
| Backend route | ShipStation: `src/routes/labels.ts:119`, `:130`; direct carriers: `api/carriers/labels.ts`. |
| Service | `src/services/labels.ts:900` `createLabelV2`; `:777` `persistCreatedLabel`; `:839` `markOrderShipped`; `src/services/direct-label-persistence.ts:32`. |
| DB writes | `shipments`, `orders.orderStatus`, `order_overrides.trackingNumber`, queue cleanup, outbox enqueue, inventory/package ledger when enabled. |
| Provider calls | `createCarrierLabel('shipstation', ...)` or direct carrier connector calls. |
| Queue/outbox | `enqueueShipmentConfirmation` after label creation; inventory/package deductions are backgrounded. |
| Partial windows | Provider label succeeds before local shipment/order/queue/outbox operations all finish. |
| Duplicate decisions | Frontend builds irreversible label payload; backend revalidates but should own all final purchase truth. |
| Canonical owner | Idempotent backend label operation orchestrator before any provider call. |

## 5. Print To Queue / Batch Queue Send

| Field | Current path |
|---|---|
| User action | Click Print to Queue, batch queue selected/all, queue existing labels. |
| Frontend | `OrdersView.tsx:4483` `buildQueueSendOrderPayload`, `:4692` `sendOrdersToQueueBackend`, `:4831` `queueExistingLabels`, `:6878` batch action. |
| API client | `v2-apiClient.ts:2706` `addToQueue` and print queue status/open methods. |
| Backend route | `src/routes/print-queue.ts:338` `/add`, `:409` `/batch-send`, status at `:463`, print endpoints at `:580`, `:623`, `:653`. |
| Service | `src/services/print-queue.ts:662` `processQueueSendOrder`, `:757` `addToQueue`, `:814` `startQueueSendJob`, `:853` `runQueueSendJob`. |
| DB writes | `print_queue_orders`; possibly `shipments`/`orders` if queue-send creates labels. |
| Provider calls | Only when queue path creates missing labels. Existing-label queue should not buy postage. |
| Partial windows | Label created but queue insertion fails; recovery attempts existing label lookup. |
| Duplicate decisions | Frontend classifies direct/create/backend/existing route; backend also validates queue payload. |
| Canonical owner | Queue operation service tied to label operation id and durable per-order state. |

## 6. Direct-Carrier Label Creation, Including SHIPP

| Field | Current path |
|---|---|
| User action | Select direct carrier rate/account and create/queue label. |
| Frontend | `OrdersView.tsx:4630` `createDirectCarrierLabelThenQueue`; `v2-apiClient.ts` routes to `/carriers/labels` when provider ids indicate direct/store account. |
| Backend route | `api/carriers/labels.ts`; selected-rate proof guard at `:1109`; SHIPP/Walmart/direct persistence blocks around `persistDirectCarrierLabel`. |
| Service | `src/services/direct-label-persistence.ts:32` writes local shipment/order transition; direct connector logic in `src/connectors/carrier/shipp.ts`, `walmart-shipping.ts`, `ups.ts`, `easypost.ts`. |
| DB writes | `shipments`, `orders`, `print_queue_orders` cleanup, `fulfillment_outbox`. |
| Provider calls | Direct carrier connectors; SHIPP creates label outside ShipStation. |
| Partial windows | Serverless direct path duplicates some label/outbox behavior from `createLabelV2`. |
| Duplicate decisions | Synthetic provider id mapping, carrier account scope, selected-rate proof, and confirmation enqueue are repeated. |
| Canonical owner | Same backend shipping orchestrator should own direct and ShipStation purchase boundaries. |

## 7. Label Retrieval / Reprint

| Field | Current path |
|---|---|
| User action | Reprint label, open label PDF, print existing queue label. |
| Frontend | `OrdersView.tsx:6330` `reprintLabel`; `v2-apiClient.ts:2587` `openLabelPdf`. |
| Backend route | `src/routes/labels.ts:232` retrieve label; print queue signed/download routes in `src/routes/print-queue.ts`. |
| Service | `src/services/labels.ts` retrieve functions; `src/services/print-queue.ts` merge/validate label URLs. |
| DB reads | `shipments`, `mock_labels`, `print_queue_orders`. |
| Provider calls | May retrieve/refresh from upstream depending path; most reprint should use stored local label URL. |
| Partial windows | Missing/invalid label URL needs safe error, not raw provider payload. |
| Duplicate decisions | Frontend and backend both normalize/open label URLs; backend owns validation. |
| Canonical owner | Label retrieval service returns safe label access descriptor; UI only opens it. |

## 8. Shipped Transition + Shipment Persistence

| Field | Current path |
|---|---|
| User action | Label purchase or manual/external shipped action. |
| Frontend | Create label path; manual mark as shipped in `OrdersView.tsx` for allowed statuses. |
| Backend route/service | Label-created transition in `src/services/labels.ts:839` `markOrderShipped`; direct carrier persistence in `src/services/direct-label-persistence.ts`; order mutation routes in `src/routes/orders.ts`. |
| DB writes | `shipments`, `orders.orderStatus`, `order_overrides.trackingNumber`, queue cleanup. |
| Protected surface | `orders` shipped/cancelled rows and entire `shipments` table are locked for AI mutation per `AGENTS.md`; PS-100 audit only read these paths. |
| Partial windows | Local shipped can precede marketplace confirmation and inventory/background deductions. |
| Canonical owner | Shipping lifecycle service with explicit side-effect state. |

## 9. Fulfillment Outbox / Marketplace Confirmation

| Field | Current path |
|---|---|
| Trigger | Label created or recovery detects missing confirmation. |
| Service | `src/services/fulfillment/outbox.ts:261` `enqueueShipmentConfirmation`, `:150` lifecycle planner, `:877` processor, `:927` process once. |
| Connector | `src/services/store-connector-orchestrator.ts` calls store connector `confirmShipment`. |
| DB writes | `fulfillment_outbox.status`, attempts, last error; shipment confirmation columns; sometimes order confirmation marker fields. |
| Background work | `src/services/sync-scheduler.ts` and cron route run outbox/recovery. |
| Partial windows | Confirmation failure does not block label response; operator needs clear state. |
| Duplicate decisions | Direct-carrier serverless path has SQL enqueue/process pieces adjacent to backend service. |
| Canonical owner | Fulfillment confirmation operation under shipping lifecycle DTO. |

## 10. Billing Generation

| Field | Current path |
|---|---|
| User action | Generate billing, view summary/details/invoice. |
| Frontend | `BillingView.tsx`; `v2-apiClient.ts:3832` `generateBilling`, `:3858` summary, `:3920` details. |
| Backend route | `src/routes/billing.ts:256` generate, `:276` summary, `:294` details, `:432` invoice. |
| Service | `src/services/billing.ts`; detail helpers in `src/services/billing-detail-utils.ts`. |
| DB reads/writes | Reads `orders`, `shipments`, `packages`, `billing_config`, `client_package_prices`; writes `billing_line_items`; reads `billing_ref_rates`. |
| Partial windows | Live order/shipment values can differ from generated line items. |
| Duplicate decisions | Billing detail UI and service both calculate/display package/rate facts. |
| Canonical owner | Billing generation freezes line items; invoice/detail reads line items first and only uses live reads for explicit diagnostics. |

## 11. Inventory / Package Deduction

| Field | Current path |
|---|---|
| Trigger | Label-created shipment, ShipStation status sync, manual inventory actions. |
| Backend service | `src/services/fulfillment-deductions.ts:82` `deductPackageForShipment`, `:159` `deductInventoryForOrder`; kill switch at `:153`; `src/services/inventory.ts:15` `applyMovement`. |
| Backend routes | `src/routes/inventory.ts` receive/adjust/import/sync; package receive/adjust in `src/routes/packages.ts`. |
| DB writes | `inventory.stockQty`, `inventory_ledger`, `packages.stockQty`, `package_ledger`. |
| Partial windows | Label response can return before background deduction completes. |
| Duplicate decisions | Item parsing exists in deduction service, inventory route imports, combo defaults, and UI helpers. |
| Canonical owner | Inventory/package domain services own movement math; shipping lifecycle records deduction status. |

## 12. Client Portal Order Display

| Field | Current path |
|---|---|
| Current repo evidence | No dedicated client-facing order portal screen was found in `web/src`. `source='portal'` appears in account onboarding/promotion flows (`api/carrier-accounts.ts`, `api/store-accounts.ts`, `src/services/credential-accounts.ts`). |
| Risk | Portal-source credentials/accounts are an integration source state, not an order-display source of truth. |
| Canonical owner | If a separate client portal exists, it should read backend DTOs scoped by client/store and never derive shipping, billing, or inventory truth from frontend transforms. |

