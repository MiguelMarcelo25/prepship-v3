# PS-085 Shipping Workflow Architecture Audit

Date: 2026-06-05
Branch: `prepshipv4-stable`
Scope: Full Shipping Workflow Deep Audit + Backend Orchestrator Refactor

This audit is specific to the current PrepShip V4 codebase. It intentionally
does not modify shipped/cancelled lockdown paths or the shipment persistence
flow. Code work in this slice is limited to a pure backend fingerprint and
selected-rate authority utility plus a guard script.

## Executive Summary

PrepShip's shipping workflow already has several strong safety pieces:

- `src/services/rates.ts` computes backend `bestRate` and rate cache keys.
- `src/routes/rates.ts` exposes exact cache-key metadata and marks rough
  weight/ZIP cache hits as approximate.
- `src/services/labels.ts` blocks label creation for shipped/cancelled orders,
  forces test clients into mock-label mode, persists label snapshots, and queues
  marketplace confirmation after real label creation.
- `src/services/print-queue.ts` validates label URLs, keeps queue state durable,
  and attempts recovery when label creation succeeded but queue insertion failed.
- `src/services/fulfillment/outbox.ts` owns retryable marketplace/source
  confirmation state.

The weak point is not a missing connector. It is ownership. Best Rate, Rate
Browser, selected rate, label payload construction, print queue, shipment
persistence, and marketplace confirmation are connected by many partial
contracts instead of one backend-owned shipping lifecycle. The frontend still
derives or reconciles shipping truth in large components:

- `web/src/components/Views/OrdersView.tsx` is still the operator workflow hub.
- `web/src/components/RateBrowserModal.tsx` still seeds, dedupes, groups, and
  selects/display-ranks rates.
- `web/src/lib/v2-apiClient.ts` still chooses label endpoints for direct vs
  ShipStation provider ids.
- `web/src/components/Views/orders-parity.ts` contains pure workflow decisions
  for auto-rate state, Browse Rates reconciliation, and queue routing.

DJ's safety rule should become a backend invariant: no postage purchase unless
the selected rate is an exact match for the current eligible label payload
fingerprint. Saved, cached, approximate, alternate, or display-only rates may
inform the UI, but must not become label purchase truth.

## Current Call Graph

### Awaiting Shipment Row Load

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Orders list request | Backend route | `src/routes/orders.ts` builds canonical shipping and best-rate display fields around `normalizeListBestRate`, `sanitizeAwaitingOverridesForShippingEligibility`, and `shipping.sourceMap`. | Reads `orders`, `order_overrides`, and latest `shipments` projection for display. Shipped rows intentionally hide awaiting best-rate data. |
| Frontend normalization | Frontend hook/view | `web/src/hooks/v2Hooks.ts` remaps `order_overrides.bestRateJson` into legacy `bestRate`; `web/src/components/Views/OrdersView.tsx` renders carrier/account/best-rate columns. | Frontend consumes backend fields, but still has fallback and display-state logic. |
| Awaiting rate cell state | Frontend pure helper | `web/src/components/Views/orders-parity.ts:713` `classifyAwaitingRateCellState`. | Explicit states exist for spinner/ready/terminal display, but not a durable backend workflow state. |

### Passive Best Rate Load

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Request fingerprint | Frontend plus backend | `web/src/components/Views/orders-parity.ts:770` `planSettledAutoRate`; `src/services/rates.ts:389` `rateCacheKey`; `src/services/shipping-workflow/rate-fingerprint.ts` added in this slice. | Before PS-085, backend fingerprint assembly lived inside `rates.ts`; frontend still keys passive entries by request key. |
| Backend rates | Backend service | `src/services/rates.ts:1179` `getRates`, `src/services/rates.ts:338` `resolveRateInput`, `src/services/rates.ts:470` `pickBestRate`. | Resolves credential context, eligible carriers, cache key, cache hit, live fetch, markup, and best rate. |
| Cache lookup | Backend route/service | `src/routes/rates.ts:451` `/rates/cached/bulk`; `src/services/rates.ts:1088` `selectRateCacheByKey`. | Exact cache keys are authoritative; rough weight/ZIP hits remain available but are flagged approximate. |
| Frontend settlement | Frontend view | `web/src/components/Views/OrdersView.tsx` consumes auto-rate entries and updates display/panel selection. | Still a source of UI staleness risk if the entry key and current label payload drift. |

### Rate Browser Open/Load

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Open modal | Frontend | `web/src/components/Views/OrdersView.tsx:8956`, `:9158`, `:10941` creates `RateBrowserModal`. | The modal receives order and shipping account data from the view. |
| Seed from saved best rate | Frontend modal | `web/src/components/RateBrowserModal.tsx:485` `buildOrderBestRateSeed`. | Saved `order.bestRate` can seed display if it has account/service/cost metadata. |
| Test rates | Frontend modal | `web/src/components/RateBrowserModal.tsx:621` `buildTestMockRateSeeds`. | Mock rate generation is client-side for test-mode UX. |
| Dedupe/group/display | Frontend modal | `web/src/components/RateBrowserModal.tsx:733` `rateRowDedupeKey`; `:1317` sorting; `:1485` rate mapping. | Duplicate display logic mirrors backend rate identity imperfectly. |

### Browse Rates / Refresh Rates

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Backend browse | Backend route | `src/routes/rates.ts:287` `/rates/browse`. | Calls `getRates`, filters requested carriers, computes cheapest among filtered rates, and returns `requestKey`. |
| Frontend API aggregation | Frontend API client | `web/src/lib/v2-apiClient.ts:4026`, `:4062`, `:4156`, `:4213`. | Combines ShipStation and direct-carrier results, exposes combined `bestRate`. |
| Reconcile table best | Frontend pure helper | `web/src/components/Views/orders-parity.ts:806` `planBrowseRateReconcile`. | Good explicit decision, but still frontend-owned. |

### Selected Rate Persistence

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Save best/selected into overrides | Frontend -> backend orders route | `web/src/lib/v2-apiClient.ts:2220`; `src/routes/orders.ts:2669`, `:2734`, `:2924`. | Saves `bestRateJson` and `bestRateDims`; `selectedRateJson` is normalized but not an `order_overrides` column. |
| Saved best-rate metadata | Backend backfill | `src/services/rates-backfill.ts:380` stamps `requestFingerprint`, `cacheKey`, freshness, completeness, and `matchType`. | This is closer to the desired model but not consistently required before label purchase. |
| Final selected rate | Backend label persistence | `src/services/labels.ts:772` `persistCreatedLabel` writes `shipments.selectedRateJson`. | The final durable truth is created after label purchase. It currently stores service/account/cost but not full request fingerprint. |

### Create Label

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Frontend payload assembly | Frontend | `web/src/components/Views/OrdersView.tsx` label payload block guarded by PS-078 tests. | Uses panel-selected account/service; avoids stale `order.bestRate` service-name fallback for non-test labels. Still not backend canonical. |
| Endpoint routing | Frontend API client | `web/src/lib/v2-apiClient.ts:2435` `createLabel`, `:2443` store-account block, direct carrier route to `/carriers/labels`, else `/labels`. | Provider-boundary decision lives in frontend. PS-083 is likely touching adjacent direct-carrier visibility/scope logic. |
| ShipStation label route | Backend route | `src/routes/labels.ts:105` `/labels`; `:116` `/labels/create`; `:127` `/labels/create-batch`. | Thin route into `createLabelV2`. |
| Label orchestration | Backend service | `src/services/labels.ts:895` `createLabelV2`. | Loads order, rejects shipped/cancelled, resolves client, applies insurance and eligibility, checks existing labels, builds payload, calls connector, persists shipment, marks order shipped, enqueues confirmation. |
| Connector boundary | Backend service | `src/services/carrier-connector-orchestrator.ts:73` `createCarrierLabel`. | Thin connector resolver plus service eligibility assert. |

### Print To Queue

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Single existing-label queue | Frontend -> backend | `web/src/components/Views/orders-parity.ts:505` `buildQueueAddPayload`; `src/routes/print-queue.ts:338` `/print-queue/add`; `src/services/print-queue.ts:757` `addToQueue`. | Queue add requires a label URL; service normalizes and validates it. |
| Create label then queue | Backend service | `src/services/print-queue.ts:662` `processQueueSendOrder`; `:677` calls `createLabelV2`; `:698` calls `addToQueue`. | Partial-success recovery tries existing label lookup if label creation succeeded but later queue work failed. |
| Print queue status/UI | Frontend/API | `web/src/lib/v2-apiClient.ts:2651`; `web/src/components/Views/OrdersView.tsx:10554` queue panel. | Durable queue state exists, but UI state still owns operator progress display. |

### Batch Send / Batch Queue

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Frontend route decision | Frontend pure helper | `web/src/components/Views/orders-parity.ts:841` `classifyQueueOrderRoute`. | Decides direct-create vs backend route for direct carriers, existing labels, and batch test mode. |
| Backend batch queue job | Backend route/service | `src/routes/print-queue.ts:409` `/print-queue/batch-send`; `src/services/print-queue.ts:814` `startQueueSendJob`; `:853` `runQueueSendJob`. | Good durable progress snapshots, but label creation and queue insertion still happen as a chained workflow rather than an orchestrator transaction/state machine. |
| Batch label endpoint | Backend route/service | `src/routes/labels.ts:127`; `src/services/labels.ts:1206` `createBatchV2`. | Calls `createLabelV2` per order and returns created/failed arrays. |

### Shipped Status Transition

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Label-created shipped | Backend service | `src/services/labels.ts:834` `markOrderShipped`. | Updates `orders.orderStatus='shipped'` and writes tracking override. |
| External shipped | Backend orders route | `src/routes/orders.ts:2995` external shipped body and comments around marketplace notify toggles. | Locked surface; not touched in PS-085. |
| Marketplace/source status reconcile | Backend service/scripts | `api/_lib/marketplace-status-reconciliation.ts`; `scripts/reconcile-marketplace-order-status.ts`. | Separate from label creation confirmation lifecycle. |

### Label Retrieval/Reprint

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Retrieve endpoint | Backend route/service | `src/routes/labels.ts:218` `/labels/:lookup/retrieve`; `src/services/labels.ts` `retrieveLabelV2`. | Reads local shipment label URL and may refresh upstream. |
| Frontend open label | Frontend API client | `web/src/lib/v2-apiClient.ts:2514` `openLabelPdf`. | Handles mock labels, auth-gated API URLs, data URLs, and external CDN URLs. |
| Shipped label queue | Frontend | `web/src/components/Views/OrdersView.tsx:8411`, `:8935`, `:8951`. | Lockdown-adjacent UI allows requeue/reprint of existing labels without destructive edit controls. |

### Fulfillment Outbox Enqueue/Process

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Enqueue after label | Backend service | `src/services/labels.ts:1165`, `:1174`; `src/services/fulfillment/outbox.ts:261` `enqueueShipmentConfirmation`. | Enqueue failure is logged and does not fail the label response. |
| Lifecycle planning | Backend service | `src/services/fulfillment/outbox.ts:150` `buildShipmentConfirmationLifecyclePlan`. | Explicit states exist for no shipment, pending, not required, not supported, already succeeded, create pending. |
| Process | Backend service | `src/services/fulfillment/outbox.ts:877` `processOutboxRow`; `:927` `processFulfillmentOutboxOnce`; `:952` `processFulfillmentOutboxById`. | Retryable outbox owns source confirmation attempts and failure state. |

### Marketplace/Source Confirmation

| Step | Current owner | Code references | Notes |
|---|---|---|---|
| Store connector boundary | Backend service | `src/services/store-connector-orchestrator.ts:69` `confirmStoreShipment`. | Thin connector boundary for marketplace shipment confirmation. |
| Direct-carrier Vercel path | Serverless function | `api/carriers/labels.ts` imports `confirmStoreShipment`, `enqueueShipmentConfirmation`, and `processFulfillmentOutboxOnce`. | Direct labels have their own confirmation flow, increasing duplicate boundary risk. |
| Scheduler recovery | Backend scheduler | `src/services/sync-scheduler.ts` runs fulfillment outbox and missing confirmation recovery. | Important safety net; should be orchestrator-owned long term. |

### Error/Recovery Flows

| Flow | Current owner | Code references | Risk |
|---|---|---|---|
| Rate carrier diagnostics | Backend routes/services | `src/services/rates.ts:913` `fetchLiveRatesWithDiagnostics`; `src/routes/rates.ts:331` carrier statuses. | Good per-carrier status exists, but frontend still interprets display state. |
| Queue label URL validation | Backend service/route | `src/services/print-queue.ts` label URL normalizers/errors; `src/routes/print-queue.ts:189` label URL error response. | Good hardening for `[object Object]` and invalid URLs. |
| Label-created, queue-failed | Backend service | `src/services/print-queue.ts:662` recovery in `processQueueSendOrder`. | Recovery exists but is local to print queue, not a lifecycle state. |
| Confirmation failed | Backend outbox | `src/services/fulfillment/outbox.ts:840` `failOutboxRow`; `:877` process. | Failure state exists; operator workflow still needs clearer workflow DTO visibility. |

## Data Ownership Map

| Data | Canonical owner today | Non-canonical cache/projection | Frontend derivation/override points |
|---|---|---|---|
| Order state | `orders.order_status` in `src/db/schema/orders.ts` | Orders list DTO in `src/routes/orders.ts`; sidebar counts | `OrdersView.tsx` read-only view gating and status-specific actions |
| Dimensions | `order_overrides.rateDimsL/W/H` override, else `orders.raw.dimensions`/columns | `bestRateDims` string on `order_overrides` | Panel form dims, `saveOrderDims` in `web/src/lib/v2-apiClient.ts` |
| Weight | `order_overrides.rateWeightOz` override, else `orders.weight_oz` | Rate request payloads and cached keys | Panel form, batch/test labels |
| Saved Best Rate | `order_overrides.bestRateJson`, `bestRateAt`, `bestRateDims` | `rate_cache.bestRate`; frontend auto-rate entry | `buildOrderBestRateSeed`, auto-rate entries, Browse Rates reconcile |
| Selected rate before label | Currently panel/form state and saved best-rate DTO, not one DB owner | `order_overrides.bestRateJson`; API client translated rate rows | `OrdersView.tsx` label payload, `RateBrowserModal.tsx` selected row |
| Final selected rate | `shipments.selectedRateJson` | Orders DTO `selectedRate`; billing projections | Order detail display reads raw `selectedRate`/`bestRate` fallbacks |
| Label/shipment | `shipments` table | Label response DTO; mock label in-memory/DB cache | `openLabelPdf`, queue panel, reprint UI |
| Print queue item | `print_queue_orders` in `src/db/schema/print-queue.ts` | In-memory/durable queue send and merge job snapshots | Queue panel groups/search/progress |
| Fulfillment outbox | `fulfillment_outbox` in `src/db/schema/fulfillment-outbox.ts` | Scheduler status/logs | Little direct UI state; mostly diagnostics |
| Marketplace confirmation | `shipments.confirmationStatus`, `fulfillment_outbox.status`, `orders.canonical_status` | Scripts and status endpoints | Operator sees partial status indirectly |
| Provider account scope | `clients`, credential account tables, connector resolution, automation rules | `V2_CARRIER_ACCOUNT_REFS`, carrier-account route DTOs | `v2-apiClient.ts` endpoint classification; `RateBrowserModal.tsx` source labels |

## State Machine Gap Analysis

Intended backend-owned states:

| Lifecycle | Intended states | Current gaps |
|---|---|---|
| Rate requested | `not_requested`, `pending`, `succeeded`, `failed`, `partial` | Mostly transient frontend state plus rate diagnostics; not durable per order. |
| Rate resolved | `current_exact`, `stale`, `approximate`, `unresolved`, `partial_failure` | `requestFingerprint`, `isComplete`, and `matchType` exist in some saved/cache rows but are not uniformly required. |
| Exact selected rate available | `selected_exact`, `missing`, `fingerprint_mismatch`, `not_in_current_eligible_rates` | Added pure backend validator in PS-085, but label purchase is not yet wired to it due lockdown-safe slice. |
| Label purchase | `not_started`, `pending`, `succeeded`, `failed`, `duplicate_blocked`, `test_mocked` | `createLabelV2` has guards and errors, but no durable pre-label operation record/idempotency key. |
| Print queue | `not_required`, `pending`, `succeeded`, `failed`, `recovered`, `printed` | Queue rows have `queued/printed`; queue-send job has progress. No single label+queue operation state. |
| Shipment persisted | `pending`, `persisted`, `persist_failed`, `duplicate_existing` | Shipment insert happens after real provider side effect. Persist failure after postage remains a high-risk window. |
| Fulfillment outbox | `not_required`, `not_supported`, `pending`, `processing`, `succeeded`, `failed` | Backend outbox has this concept; not surfaced as a workflow DTO. |
| Marketplace/source confirmation | `not_required`, `not_supported`, `pending`, `processing`, `succeeded`, `failed` | Exists across `shipments` and `fulfillment_outbox`; direct-carrier Vercel path has duplicate immediate-confirm logic. |

Ambiguous booleans/nulls:

- `labelUrl` null can mean no label, provider omitted URL, invalid URL, or label
  created but retrieval failed.
- `confirmationStatus` null can mean not attempted, not required, unsupported,
  or missing schema/backfill.
- `bestRateJson` present does not by itself prove current fingerprint,
  freshness, completeness, or current eligible carrier set.
- Local `orderStatus='shipped'` means a label exists locally; it does not prove
  marketplace/source confirmation succeeded.

Partial-success windows:

- Provider label/postage succeeds, then `shipments` insert fails.
- `shipments` insert succeeds, then `markOrderShipped` fails.
- Label purchase succeeds, then print queue insertion fails.
- Label purchase succeeds, then fulfillment outbox enqueue/process fails.
- Local shipped state succeeds, but marketplace/source confirmation fails or is
  not supported.

## Duplicate Logic Inventory

| Topic | Duplicated across | Risk |
|---|---|---|
| Best Rate selection/display | `src/services/rates.ts`, `src/routes/rates.ts`, `web/src/lib/v2-apiClient.ts`, `RateBrowserModal.tsx`, `OrdersView.tsx`, `orders-parity.ts` | Different "best" can win by backend total, frontend combined array, saved seed, or display amount. |
| Fingerprint/package/dims/weight | `rateCacheKey`, `orders-parity` request keys, `bestRateDims`, label payload dims | Dims-only or stale cache can look valid when weight/address/options/account scope changed. |
| Carrier account visibility/scope | `resolveRateInput`, `getCarrierAccountsForRateContext`, carrier-account routes, `RateBrowserModal`, `v2-apiClient` endpoint classifier | PS-083 overlap: unassigned direct carriers can be treated as globally available if any layer misses scope. |
| Direct vs ShipStation routing | `v2-apiClient.ts`, `api/carriers/labels.ts`, `src/services/carrier-connector-orchestrator.ts`, `src/services/labels.ts` | Wrong endpoint can send direct ids to ShipStation or bypass direct provider handling. |
| Label payload construction | `OrdersView.tsx`, `print-queue.ts` queue send labels, `labels.ts` ShipStation payload, `api/carriers/labels.ts` direct labels | Operator panel truth can diverge from final provider payload. |
| Print Queue insertion/recovery | `OrdersView.tsx`, `v2-apiClient.ts`, `src/routes/print-queue.ts`, `src/services/print-queue.ts` | Queue success can be mistaken for print/confirm success. |
| Marketplace confirmation | `src/services/labels.ts`, `api/carriers/labels.ts`, `src/services/fulfillment/outbox.ts`, scheduler/scripts | Duplicate immediate/outbox paths can hide provider-specific failures. |
| UI diagnostics | `OrdersView.tsx`, `RateBrowserModal.tsx`, `v2-apiClient.ts`, route error mappers | Operator can see generic success/error rather than exact lifecycle state. |

## Risky Fallback Inventory

Highest-risk fallback classes found:

1. Saved or cached Best Rate can seed UI (`RateBrowserModal.tsx:485`) before
   proving current label payload fingerprint.
2. `/rates/cached/bulk` still returns rough weight/ZIP hits for legacy support;
   it flags them approximate, but every consumer must honor that flag.
3. Frontend API aggregation can expose `combined.bestRate` from mixed
   ShipStation/direct results (`web/src/lib/v2-apiClient.ts:4156`) without a
   backend workflow state proving provider scope.
4. Frontend label endpoint classification blocks store-account rates and routes
   direct carriers (`v2-apiClient.ts:2435`), but backend should own this final
   decision.
5. Print queue recovery can find an existing queueable label after a failed
   post-label step (`src/services/print-queue.ts:662`), but the operator sees a
   queue job result rather than a canonical label+queue lifecycle state.
6. Local shipped state is set before marketplace/source confirmation completes.
   This is operationally necessary, but the UI must not imply upstream success.

## Provider Boundary Map

| Boundary | Current owner | Target owner |
|---|---|---|
| ShipStation source orders | `order-sync`, `orders` rows, ShipStation parity/reconcile scripts | Store/source connector facade under shipping orchestrator |
| Direct store orders | Store connectors and `store_orders`/`orders` import paths | Store/source connector facade under shipping orchestrator |
| ShipStation rates/labels | `src/services/rates.ts`, `src/services/labels.ts`, ShipStation connector | Carrier connector called only by orchestrator |
| Direct carrier rates/labels | `api/carriers/labels.ts`, carrier connectors, frontend endpoint classifier | Carrier connector called only by orchestrator |
| Marketplace confirmation | `fulfillment_outbox`, direct label function immediate paths, store connectors | Orchestrator creates confirmation operation, outbox executes connector |
| Carrier account assignment/scope | Credential account services/routes, automation rules, rate resolver, frontend display | Backend eligibility resolver returns scoped eligible accounts to orchestrator |
| Credential redaction/logging | Route DTO redaction, connector-specific logging | Connector boundary enforces sanitized inputs/outputs and redacted events |

## Refactor Risk Ranking

| Rank | Risk | Why high risk | Recommended PS follow-up |
|---|---|---|---|
| 1 | Duplicate labels/postage | Provider label side effect can succeed before DB/queue/outbox steps finish. | Idempotent label operation table + recovery command. |
| 2 | Wrong carrier/rate purchased | Selected UI rate can be stale or not from current eligible payload. | Wire PS-085 `validateExactSelectedRate` into label orchestrator after unlock/review. |
| 3 | Cross-client/provider leak | Carrier scope is split across backend resolver and frontend direct-carrier UI. | Complete PS-083, then move final provider scope decision backend-side. |
| 4 | Missing queue item after label | Queue send creates label then queues; recovery is local, not lifecycle-owned. | Orchestrator-owned label+queue operation state. |
| 5 | Missing marketplace confirmation | Enqueue/process failure does not block label response. | Workflow DTO should show confirmation pending/failed/not_supported. |
| 6 | Stale UI state | Massive frontend components derive display truth from multiple caches. | Backend workflow state DTO consumed by Orders and Rate Browser. |
| 7 | Operator confusion | Shipped/queued/confirmed have separate meanings but similar success affordances. | Surface per-order lifecycle badges/actions. |

## Target Backend-Orchestrator Architecture

Introduce `src/services/shipping-workflow/orchestrator.ts` over several small
modules, not a giant rewrite:

| Module | Responsibility |
|---|---|
| `shipping-workflow/rate-fingerprint.ts` | Current request fingerprint, selected-rate authority key, exact selected-rate validation. Added in PS-085. |
| `shipping-workflow/eligibility.ts` | Resolve eligible carrier/account/service set for client/store/source. |
| `shipping-workflow/state.ts` | Backend DTO for rate, selected-rate, label, queue, shipment, outbox, confirmation lifecycle. |
| `shipping-workflow/label-operation.ts` | Idempotent label purchase guard, duplicate-label protection, provider call boundary. |
| `shipping-workflow/queue-operation.ts` | Print queue insertion/recovery tied to label operation id. |
| `shipping-workflow/confirmation-operation.ts` | Fulfillment outbox enqueue/process/recovery planning. |
| `connectors/carrier/*` | Thin carrier API boundaries only: quote, create label, void, track. |
| `connectors/store/*` | Thin source marketplace boundaries only: import/status/confirm shipment. |

Backend-owned lifecycle rules:

- Backend owns current rate request fingerprint.
- Backend owns eligible carrier/account/service resolution.
- Backend owns Best Rate selection.
- Backend validates exact selected rate against the current label payload before
  any real label purchase.
- Backend coordinates label purchase, shipment persistence, queue insertion,
  outbox enqueue, marketplace confirmation, idempotency keys, and sanitized
  workflow event logging.
- Unresolved exact Best Rate blocks label purchase or returns an explicit
  unresolved state. No stale/alternate/cache-derived fallback can buy postage.

Frontend allowed:

- Display backend workflow state.
- Request actions: quote, select, create label, queue, print, retry
  confirmation.
- Show provider-specific errors and recovery actions.
- Maintain temporary form state before submitting an action.

Frontend forbidden:

- Decide canonical Best Rate.
- Decide final carrier/provider scope.
- Assemble irreversible label purchase truth from stale table/sidebar/modal
  data.
- Treat cached/sidebar/order display data as source-of-truth for postage.
- Treat local queued/shipped state as marketplace/source confirmation success.

Connector boundaries:

- Carrier connectors own external carrier rate/label payload translation only.
- Store connectors own source-order and marketplace-confirmation payload
  translation only.
- The orchestrator coordinates both but must preserve provider-specific failure
  states; it should not collapse them into generic success.

## First Safe Refactor Slice Implemented

Chosen slice: centralize backend shipping rate fingerprint + exact selected-rate
validation in a pure module.

Why this slice:

- It directly supports DJ's no-fallback postage rule.
- It avoids PS-083 direct-carrier assignment UI overlap.
- It avoids locked shipped/shipments mutation code paths.
- It is reviewable and testable without DB, provider, label, postage, or
  marketplace side effects.
- It provides the exact authority check that a later orchestrator/label slice
  can call before purchase.

Files added/changed:

- `src/services/shipping-workflow/rate-fingerprint.ts`
- `src/services/rates.ts`
- `scripts/ps-085-shipping-workflow-guard.ts`
- `package.json`
- `docs/shipping-workflow-architecture-audit.md`

Behavior impact:

- `src/services/rates.ts` now delegates rate cache fingerprint assembly to the
  shared backend utility.
- Existing fingerprint ingredients and output format are preserved.
- No label purchase path was wired in this slice because that would modify
  shipment-writing code under the current lockdown policy.

Guard coverage:

- Fingerprint normalizes ZIP.
- Fingerprint is stable for reordered carrier ids.
- Fingerprint changes for same dimensions but changed weight.
- Fingerprint changes for provider/client scope.
- Fingerprint does not expose raw API keys.
- Exact selected rate with current fingerprint is accepted.
- ShipStation `se-123` and numeric provider ids normalize to the same selected
  rate authority key.
- Stale fingerprint, alternate service, and missing fingerprint are rejected.

## Recommended Follow-up PS Tasks

1. PS-086: Backend shipping workflow state DTO for Awaiting Shipment and Rate
   Browser, including rate/selected-rate/label/queue/outbox/confirmation states.
2. PS-087: Wire `validateExactSelectedRate` into a new pre-label orchestrator
   guard after DJ confirms shipped-data override scope for label service edits.
3. PS-088: Idempotent label operation table/keys for provider-label success
   before DB/queue/outbox completion.
4. PS-089: Move final direct-vs-ShipStation/store-account endpoint decision from
   `v2-apiClient.ts` into backend provider scope resolution, after PS-083 lands.
5. PS-090: Surface marketplace/source confirmation lifecycle in Orders and label
   recovery UI without implying local shipped equals upstream confirmed.
