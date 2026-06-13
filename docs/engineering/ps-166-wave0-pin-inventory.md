# PS-166 Wave 0 — pin inventory + DOM contract + Wave-1 slice plan

Baseline: prepshipv4-stable @ f7ea6026, 2026-06-13. OrdersView.tsx = 11,604 lines.
Full roundtrip certification at baseline: PASS (78/78 offline suites).

## Source-reading guards (78)

These scripts read `web/src/components/Views/OrdersView.tsx` as text and pin exact
strings. ANY extraction must grep this list for the moved region's symbols and
re-anchor matches in the SAME commit (rule R4 of the plan):

awaiting-carrier-badge-nickname-fallback, batch-recalculate-best-rate, best-rate-dims,
combo-package-default, daily-strip-progress, date-time-standard, frontend-failure-states,
multi-sku-product-dims-rate-fallback, order-detail-drawer-lazy, order-editable-lockdown,
orders-request-pressure, orders-startup-requests, orders-ux, print-queue-signed-pdf,
print-queue-sku-grouping, print-to-queue-selected-rate-proof, ps-050-rate-accuracy,
ps-051-shipping-options (+rework), ps-053-print-queue-atomic-recovery,
ps-056-external-label-certification, ps-057-hugrab-ground-saver,
ps-058-select-all-matching, ps-060-combo-save-defaults, ps-077-selected-rate-width,
ps-078-connector-matrix, ps-079-best-rate-source-of-truth,
ps-084-direct-carrier-print-queue, ps-095-selected-rate-proof-pass-through,
ps-098-shipping-purchase-boundary, ps-099-create-print-shipp-label-output,
ps-099-orders-rate-cache-first, ps-103-remove-frontend-fingerprint-authority,
ps-105-backend-rate-snapshot-id, ps-109-multi-sku-header-names,
ps-111-backend-rate-authority, ps-119-passive-best-rate-live-retry,
ps-121-group-rate-recalc, ps-123-insured-rate-browser-display, ps-126-zip4-rate-parity,
ps-127-address-classification-parity, ps-128-129-upstream-shipping-safety,
ps-164-fe-normalizer-delegation, ps-173-order-row-workflow,
ps-175-strict-recalc-decision, ps-176-queue-route-authority, ps-177-dims-defaults,
ps-177-row-money-display, ps-178-fe-authority-ratchet, ps-181-backend-admin-authority,
ps-182-dead-stub-ui, ps-183-backend-cache-ttl, ps-184-legacy-client-id-passthrough,
ps-186-test-label-authority, ps-189-backend-service-catalog, ps-190-label-conflict-codes,
ps-191-retry-eligibility, ps-193-dirty-flag-auto-persist,
ps-194-confirm-printed-persistence, ps-196-cache-first-display,
ps-198-rate-quote-proof-passthrough, ps-203-best-rate-universe, ps-204-account-binding,
ps-207-shipped-box-billing-policy, ps-210-global-orders-search,
ps-215-shipped-display-state, rate-browser-dynamic-service-selection,
rate-browser-manual-selection-table-sync, recalculate-all-live,
recalculate-best-rate-strict, selected-rate-proof-purchase-boundary,
shipment-tracking-retirement, shipstation-fulfillment-backfill,
side-panel-hover-image-preview, single-sku-default-qty-scope, source-of-truth,
test-order-queue-label.

## DOM contract (8 Playwright specs)

carrier-print-to-queue, orders-column-integrity, orders-combo-package-default,
orders-daily-strip-resilience, orders-expedited, orders-global-search,
orders-rate-accuracy-and-autostart, orders-ux.

Frozen selectors/classes (render byte-identical from any new home):
`#ordersTable`, `tbody tr.order-row`, `#row-{orderId}`, `td[data-col="…"]`,
`.expedited-badge(--tier)`, `.row-expedited(--tier)`, `data-expedited`,
`.ps-shipping-pill`, `[data-testid="off-tab-status-pill"]`, `#searchClear`,
`.client-badge`, `.customer-name`, `.od-order-link`, `.order-num`, checkbox cells
`td[data-col="select"] input[type="checkbox"]`, row ids and column keys.

## Wave-1 slice plan + per-slice pin findings (pre-checked 2026-06-13)

| Slice | Module | Source range | Pinned by | Re-anchor action |
|---|---|---|---|---|
| W1a | orders-persistent-queue-job.ts | ~262–420 (types, storage key, createQueueOrderSnapshot → getPersistentQueueJobProgress, yieldToBrowser) | ps-176-queue-route-authority (`function createQueueOrderSnapshot` index anchor; `resumePersistentQueueJob` stays in OrdersView) | re-anchor the snapshot block read to the new module |
| W1b | orders-formatting.ts | ~910–1010 (truncate, date/weight/age formatters, client palette, carrier/service formatters) | none found | none |
| W1c | orders-items.ts | ~1014–1240 (normalizeItems → getDimensions: item/order/shipTo accessors, isTestOrder, buildSearchText) | test-order-queue-label pins a CALL SITE (`const weightOz = getOrderWeightOz(order, orderDetail)`) which stays in OrdersView | verify call site unchanged; no guard edit expected |
| W1d | orders-rate-input.ts | ~422–540 (normalizeConfirmationForRates, inferCarrierFromServiceCode, normalizeInsuranceForRates) | ps-164-fe-normalizer-delegation pins the DEFINITION shapes in OrdersView source | re-anchor both regexes to read the new module |

## Explicitly deferred (documented, not forgotten)

- **Test-rate fixtures (≈780–880: seededTestUnit … buildTestRateBrowserAccounts):**
  these are PS-187 part 2 DELETION candidates (FE fixture removal gated on DJ's live
  parity check). Extracting them would churn code slated to die — leave in place until
  PS-187 part 2 resolves.
- **Display-state block (~1245–1597: getRequestedService … getSortValue,
  getShippedDataState family, getExpeditedBadge):** pure but the highest pin-density
  region (ps-215/ps-056/ps-036 display guards, PS-165 carrier display, PS-038
  expedited). Becomes the FIRST Wave-2 slice with its own dedicated re-anchor pass.
- **Infra helpers (~544–650: column-prefs localStorage, scheduleNonCriticalOrdersWork,
  daily-stats rollover time math):** cohesive with their Wave-3 hook clusters
  (use-orders-column-prefs / use-orders-daily-stats) — move WITH the clusters.
- **buildEmptyPanel (~1597) + useDebouncedValue (~1657):** move in Wave 2/3 with their
  consumers.

## Per-slice QA battery (every Wave-1 commit)

1. `npm run typecheck` (new module is strict — no @ts-nocheck in extracted files)
2. R2 leftover grep: every moved symbol appears in OrdersView ONLY as the new import
3. `npm run build:web`
4. Affected-guard runs (W1a: test:ps-176-queue-route-authority + print-queue set;
   W1d: test:ps-164-fe-normalizer-delegation; all slices: ps-191/193/194/210 spot set)
5. FULL `npm run test:shipping-roundtrip-certification`
6. Commit (one slice per commit) + triple push
