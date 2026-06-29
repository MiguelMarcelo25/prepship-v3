# PS-352 - Architecture-first shipping workflow SOT map + wrapper deletion plan

Status: implementation audit / planning artifact only.

Trello: https://trello.com/c/9IjFnCDa

PS-352 is the architecture-first child under PS-346. It does not change runtime
behavior, delete code, buy labels, queue labels, call providers, or mutate
production data. Its job is to name the current owners, the duplicated unsafe
owners, and the exact cleanup path before PS-349, PS-350, PS-351, PS-353,
PS-355, PS-332, PS-311, and final PS-331 deletion work.

## Canonical Rule

Shipping workflow truth must live in backend source-of-truth owners:

- Current package/rate facts are owned by backend rate and shipping-workflow
  services.
- Best Rate ranking is owned by `src/services/rates-combined.ts` and the
  backend rate producer, not React.
- Rate Browser, Awaiting rows, Recalculate/apply, Print Queue preflight, and
  label purchase must consume backend-issued DTO/proof identity.
- Frontend code may render backend fields, gather operator intent, and poll
  backend jobs. It must not rank, reconcile, mint proof, decide label
  permission, decide queue eligibility, or hide stale/unproven facts behind
  display fallbacks.

## Imperfect Data Injection Points

Bad or less-than-perfect shipping data can first enter at these boundaries:

- Provider quote payloads: ShipStation, direct carrier, and store-carrier
  adapters can return partial, delayed, thin, missing, or differently marked
  costs.
- Cache writes: `rate_cache` and `order_overrides.bestRateJson` can carry stale
  package/address/insurance/account facts unless fingerprinted and checked.
- Operator panel input: dimensions, weight, package, insurance, confirmation,
  account, and service can change after a saved rate was created.
- Rate Browser click/apply: an applied row can cross customer amount, provider
  cost, insurance, markup, and house tuple fields if the backend does not issue
  one final selected-rate DTO.
- Orders list refresh: frontend refetch bursts can display old rows while
  backend rate/queue jobs are still running.
- Print Queue batch send: label purchase, shipment persistence, queue insert,
  and durable job status can succeed/fail independently.
- Date/count filters: UI state can drift from backend query scope and make
  selected-count or shipped-count proof look wrong.

## Decision Ownership Matrix

| Decision | Bad data can first enter at | Current owners/files | Duplicated or unsafe current owners | Canonical owner after cleanup | Old code to delete or disable | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| Rate current/stale | Saved `bestRateJson`, cache hit, panel package/address/account edits | `src/services/shipping-workflow/rate-fingerprint.ts`, `src/services/shipping-workflow/best-rate-workflow-dto.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | `web/src/components/Views/orders-parity.ts` functions `savedBestRateCanDisplayForCurrentRequest` and `classifyAwaitingRateCellStateWithWorkflow`; `web/src/components/Views/OrdersView.tsx` fallback display checks | PS-349 backend order shipping state DTO backed by `rate-fingerprint` and quote snapshot proof | Frontend current/stale fallback checks that decide displayability or retry state | PS-333, PS-349 |
| Displayable rate | Orders route aliases and frontend fallback shapes | `src/routes/orders.ts`, `src/services/shipping-workflow/best-rate-workflow-dto.ts`, `web/src/components/Views/orders-rate-cells.tsx` | `OrdersView.tsx` functions `renderRateCellFallback` and `renderAwaitingRateFallback`; legacy alias readers in `orders-parity.ts` | PS-349 backend DTO with explicit `rateDisplayState`, `amounts`, `freshness`, and `allowedActions` | UI fallback branches that infer "Rate unavailable", spinner, or stale state from mixed fields | PS-349 |
| Best Rate | Provider quote totals, markup, insurance, house tuple stamping | `src/services/rates-combined.ts` functions `rateTotal`, `rateCostTotal`, `combineCarrierUniverses`; `src/services/rate-browse-response-producer.ts`; `src/services/shipping-workflow/best-rate-workflow-dto.ts` | `web/src/lib/rate-browser-money.ts`, `web/src/lib/rate-browser-best-emission.ts`, local Rate Browser grouping/sort in `RateBrowserModal.tsx` | Backend rate engine and rate-browse response producer only | Frontend official best-rate ranking, amount reconciliation, and selected proof derivation | PS-333, PS-350 |
| Selected rate | Rate Browser row click, stale table row, carried request metadata | `src/services/shipping-workflow/rate-selection-proof.ts`, `src/services/shipping-workflow/rate-quote-snapshot.ts`, `src/services/shipping-workflow/apply-best-rate.ts` | `RateBrowserModal.tsx` `handleRateClick`; `OrdersView.tsx` `applyRateSelection`, `withRateRequestMetadata`, and `persistAppliedRateForOrder` call glue | Backend selected-rate DTO containing customer amount, house/internal amount, insurance/markup, fingerprint, freshness, carrier/account/service, and proof identity | Frontend-applied row object construction and local amount repair | PS-333, PS-349, PS-350 |
| Proof validity | Cache/snapshot miss, panel change after proof, stale selected PID | `src/services/shipping-workflow/rate-proof-enforcement.ts`, `src/services/shipping-workflow/rate-fingerprint.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | Frontend metadata pass-through that can look authoritative when backend response is incomplete | Backend proof validator and selected-rate workflow state | Frontend proof minting or proof completion fallback | PS-333, PS-349 |
| Can print queue | Missing label URL, stale rate, package lock, existing shipped label, current job duplicate | `src/services/print-queue.ts`, `src/services/print-queue/queue-send-status.ts`, `src/routes/print-queue.ts` | `web/src/components/Views/orders-parity.ts` `buildQueueAddPayload` and `classifyQueueOrderRoute`; `OrdersView.tsx` batch panel action gating | PS-351 backend queue/preflight job owner plus PS-349 allowed-actions DTO | Frontend queue route classification and queueable label payload construction as authority | PS-351 |
| Label purchase permission | Operator panel payload, selected rate proof mismatch, existing label/shipments row, provider timeout | `src/services/labels.ts`, `src/services/shipping-workflow/hugrab-label-purchase-gate.ts`, `src/services/shipping-workflow/hugrab-label-purchase-preflight.ts` | `web/src/lib/v2-apiClient.ts` provider endpoint classifier; `OrdersView.tsx` label payload assembly | Backend label purchase gate/orchestrator; frontend sends intent and backend-selected proof identity only | Frontend endpoint/provider decision and label payload authority | PS-349, PS-351, shipped lockdown review |
| Shipped/cancelled lock | Status transition or shipped/cancelled route use | `src/routes/orders.ts` `assertOrderEditable`, `src/services/labels.ts`, `web/src/components/Views/OrdersView.tsx` read-only gates | Any new route/helper that bypasses the lock | Existing locked backend guards remain authoritative | None under PS-352. Do not delete or weaken protected code without explicit override. | AGENTS lockdown |
| Batch status | In-memory job state, settings snapshot, label/queue partial success, stale UI selection | `src/services/print-queue.ts`, `src/services/print-queue/queue-send-status.ts`, `src/routes/print-queue.ts`, `src/services/settings-json.ts` | `OrdersView.tsx` persistent queue job progress, local selected-count carryover, toast summary | PS-351 durable batch/preflight job records with per-order status and retry/blocker reason | `queueSendJobs` as source truth, settings JSON blobs as final job truth, cumulative frontend progress state | PS-351 |
| Count/date filters | UI date params, All Dates toggle, selected orders across refetch, sidebar counts | `src/routes/orders.ts`, Orders query parameters, stats/read model | `OrdersView.tsx` local selection scope and count labels | PS-353 backend query/count DTO and single frontend consumer | UI-only count/date truth and stale selection count reuse | PS-353 |

## Wrapper / Resolver Inventory

| File/function area | Current role | Classification | Required cleanup |
| --- | --- | --- | --- |
| `src/services/rates-combined.ts` `rateTotal`, `rateCostTotal`, `combineCarrierUniverses` | Backend rate ranking and carrier universe merge | KEEP ACTIVE | Keep as backend owner. Do not copy ranking into UI. |
| `src/services/rate-browse-response-producer.ts` `produceRateBrowsePayload` | Backend Rate Browser payload producer | KEEP ACTIVE | Keep as rate browse producer and expand partial job output in PS-350. |
| `src/services/shipping-workflow/best-rate-workflow-dto.ts` | Backend Awaiting/Best Rate DTO owner | KEEP ACTIVE | Extend into PS-349 order shipping state DTO. |
| `src/services/shipping-workflow/rate-fingerprint.ts` and `rate-quote-snapshot-store.ts` | Backend freshness/proof ingredients | KEEP ACTIVE | Use for selected-rate proof validity and no-stale-label purchase gates. |
| `src/routes/rates.ts` | Rate route boundary | KEEP ACTIVE | Keep thin: validate, call backend rate producer/workflow, return DTO. |
| `src/routes/orders.ts` | Orders list/read model and guarded awaiting mutations | MIGRATE FIRST | Return PS-349 shipping state DTO. Do not add UI-shaped business fallbacks. |
| `src/services/rate-browse-workflow.ts` and `src/services/rate-browse-workflow-store.ts` | Transitional backend workflow snapshots | MIGRATE FIRST | Standardize into PS-350 durable/shared-limited rate jobs. |
| `src/services/print-queue.ts` | Current label+queue batch job owner | BLOCKED BY CONDITIONAL CARD | PS-351 decides durable owner. Do not delete yet. Shipped/shipments touch requires lockdown review. |
| `src/services/print-queue/queue-send-status.ts` | Backend queue status DTO and stale-job classification | KEEP ACTIVE | Keep until PS-351 replaces or hardens durable status records. |
| `src/services/settings-json.ts` | Settings-backed job snapshot helper | MIGRATE FIRST | Allowed as transitional persistence helper; not final durable job truth. |
| `src/services/labels.ts` | Label purchase and shipment persistence owner | BLOCKED BY CONDITIONAL CARD | Future label gate work must be backend-owned and respect shipped/cancelled lockdown. |
| `web/src/lib/v2-apiClient.ts` | Frontend transport layer | MIGRATE FIRST | Keep HTTP transport only. Remove provider endpoint classifier and business fallback behavior when backend endpoints own those decisions. |
| `web/src/hooks/useRateBrowseWorkflow.ts` | UI polling hook for backend workflow | KEEP ACTIVE | Keep as display/polling only. It must not call ranking/proof helpers or repair amounts. |
| `web/src/components/RateBrowserModal.tsx` | Rate Browser modal UI, cached open, live browse button, row click | MIGRATE FIRST | Render backend rows and send backend proof identity. Delete local amount reconciliation, official ranking, and applied row construction. |
| `web/src/lib/rate-browser-money.ts`, `web/src/lib/rate-browser-house-tuple.ts`, `web/src/lib/rate-browser-best-emission.ts` | Frontend display compatibility helpers | MIGRATE FIRST | Keep only display formatting until PS-350/PS-333 prove backend DTO completeness; then delete resolver fallbacks. |
| `web/src/components/Views/OrdersView.tsx` | Large operator workflow hub | MIGRATE FIRST | Split new workflow consumers/components. Remove rate, label, queue business decisions after backend DTOs exist. |
| `web/src/components/Views/orders-parity.ts` | Mixed UI helpers and workflow classifiers | MIGRATE FIRST | Keep visual/table utilities; delete or delegate `classifyAwaitingRateCellState`, `savedBestRateCanDisplayForCurrentRequest`, `buildQueueAddPayload`, and `classifyQueueOrderRoute` as backend DTOs land. |
| `web/src/components/Views/orders-rate-cells.tsx` | Table cell rendering | KEEP ACTIVE | Keep as thin renderer of backend fields only. |
| `web/src/components/Views/print-queue-preflight-state.ts` and `print-queue-preflight-saved-rate.ts` | Frontend preflight display helpers | MIGRATE FIRST | Replace authority with PS-351 backend preflight DTO; keep only rendering text/colors. |
| Legacy Vercel/API shipping paths under `api/` | Historical compatibility endpoints | DOCUMENT ONLY | Do not revive. Delete only after PS-331 dependency acceptance proves no live caller. |

## Cutover Plan

1. PS-349 - Canonical backend order shipping state.
   - Add a backend DTO for Awaiting row, panel, Rate Browser seed, rate freshness,
     selected-rate proof status, queue eligibility, label permission, and allowed
     actions.
   - Frontend table/panel code consumes that DTO and stops deriving current/stale,
     spinner, queue eligibility, and label permission.
   - Retire frontend truth in `orders-parity.ts`, `OrdersView.tsx`, and
     `orders-rate-cells.tsx` one helper at a time.

2. PS-350 - Backend rate jobs, partial results, and shared limiter.
   - Promote rate browse workflow snapshots from transitional settings-backed
     state into the canonical backend job owner.
   - Return partial carrier statuses, partial priced rows, final selected best
     DTO, and request-count proof without blocking the whole UI on slow carriers.
   - Keep `/rates/browse` compatibility, but make Rate Browser live browse use
     the backend job contract.
   - Retire frontend Rate Browser amount repair and official row selection logic.

3. PS-351 - Durable Print Queue/preflight jobs.
   - Create backend-owned preflight/batch job truth with per-order results,
     retryability, blocker reason, selected count, queued count, failed count, and
     job identity.
   - Retire process-local `queueSendJobs` as source truth, settings JSON job blob
     truth, generic all-failed UI, cumulative selected-count state, and
     non-cancelling timeout races as authoritative behavior.
   - Keep shipped/cancelled lockdown intact. Any locked-file edit must report why
     it was necessary and prove protections were not weakened.

4. PS-353 - Count/date filter source of truth.
   - Backend owns query scope, page counts, date range, All Dates state, selected
     count proof, and shipped progress math.
   - Frontend displays the backend count/query DTO and clears impossible
     selections after scope changes.

5. PS-355 and PS-332 - Remaining money display and margin/account labels.
   - Make Other Cost and account-label comparisons consume backend-owned rate and
     shipment DTOs only.
   - Prevent UI calculations from becoming a second money source.

6. PS-331 - Safe deletion last.
   - Delete only after PS-349/350/351/353/355/332/311 acceptance proves the old
     wrappers are not live truth.
   - Each deletion slice needs its own guard and focused proof.

## Risk Map

| Risk | Current symptom | Source of truth that must own the fix | Blocking follow-up |
| --- | --- | --- | --- |
| Stale or unproven rate buys a label | Row, Rate Browser, and applied amount can differ | Backend selected-rate proof and label purchase gate | PS-333, PS-349 |
| Hidden All Dates / count mismatch | Operator sees 10/10 then 20/20 drift or old selection carryover | Backend query/count DTO and frontend scope reset | PS-353 |
| Indefinite spinner or Rate unavailable rows | Slow/partial carriers block visible useful state | Backend partial rate job/status DTO | PS-350 |
| Slow provider blocks Rate Browser | `/rates/browse` final response waits for all families | Shared limiter plus partial workflow snapshots | PS-350 |
| Print Queue in-memory job loss | Queue progress can vanish/reload wrong or show all failed | Durable preflight/batch job owner | PS-351 |
| Label purchase timeout race | Provider side effect can succeed while UI/backend thinks failure | Backend label operation idempotency and recovery | PS-351, shipped lockdown review |
| Frontend wrapper becomes permanent truth | Compatibility helper keeps old object-shape fallback alive | PS-349/350 DTO completeness plus PS-331 deletion guard | PS-331 |

## Verification

PS-352 guard:

```bash
npm run test:ps-352-shipping-workflow-sot-map -- --no-color
```

Dependency gates to keep this map anchored:

```bash
npm run test:ps-102-best-rate-workflow-dto -- --no-color
npm run test:ps-105-backend-rate-snapshot-id -- --no-color
npm run test:ps-340-backend-rate-engine -- --no-color
npm run test:ps-345-rate-loading-sot -- --no-color
npm run test:ps-346-rate-order-slow-paths -- --no-color
npm run typecheck
```

## Safety

This PS-352 slice is docs and guard only.

- No deletion performed.
- No labels, postage, provider calls, marketplace notifications, billing,
  inventory, shipment history, shipped-order mutation, cancelled-order mutation,
  or production SQL performed.
- Locked shipped/cancelled surfaces remain untouched.
- Future code work must create focused modules/components instead of growing
  large owner files unless the existing architecture requires touching them.
