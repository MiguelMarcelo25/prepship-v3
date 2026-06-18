# Incoming tickets PS-287 → PS-291 (+ PS-258 Card 13 / PS-166) — monitor

Created 2026-06-18. Branch `prepshipv4-stable`. These are NEW cards pasted by DJ for tracking.
REAL % is verified against the current source (not self-reported). Updated as work lands.

| Ticket | Title | REAL % | State (source-verified 2026-06-18) |
|---|---|---:|---|
| PS-287 | Normalize Print Queue label artwork to centered 4×6 | 15 | page-size normalize exists (print-queue-pdf.ts appendNormalizedLabelPages); content-aware artwork-bounds detection/trim/center = net-new |
| PS-288 | Recover ShipStation labels when Print-to-Queue buys but persistence fails | 32 | PS-286 label_url recovery + idempotent (order,client) upsert + partial-label recovery exist; orphan-detection + queue-recovery-for-shipped + label_id≠shipment_id fix + operator path = net-new |
| PS-289 | Multi-package shipment groups (N labels/tracking per order) | 3 | XL; NO shipment_groups/packages model; one-order-one-label everywhere (labels.ts findActiveLabelForOrder LIMIT 1, markOrderShipped, print_queue unique(order,client)). Almost entirely net-new |
| PS-290 | HUGRAB Best Rate explicit $100 insurance coverage badges | 30 | STRONG overlap w/ PS-274 (insurance-certainty resolver + tag + RateRowItem render ALL exist — audit agent wrongly said helpers missing). Net-new: typed InsuranceCoverageStatus on order-rate-dto + Awaiting Best Rate column green/red/amber badge + HUGRAB-specific verdict |
| PS-291 | New Manual Order rate preview: real ship-from, saved/custom origins, account-labeled rates | 38 | NewOrderModal + rate preview + LocationsView + POST /orders/manual ALL exist (audit agent wrongly said endpoint absent — it is orders.ts:3065, sets isTest:true). Net-new: ship-from selector, custom-origin save, marketplace exclusion, account-nickname display, selected-rate preserve, flip isTest→false, optional line items |
| PS-258 (Card 13) | OrdersView decomposition (hooks + memoized rows) | 40 | slices A+B+C shipped; bulk (usePassiveAutoRating/usePanelState/useFilteredOrders + memoized rows) = canary-loop; needs real PS-166 DOM-contract cert (does not exist) |
| PS-166 | Deep OrdersView extraction (~10 hooks + ~8 components) | 75 (boss) | many W3/W4 slices merged; no dedicated test:ps-166-* guard / DOM-contract cert; needs remaining-extraction checklist |

> NOTE on the audit: 3 of 5 incoming-ticket agents made errors (PS-290 "helpers missing" = false; PS-291 "/orders/manual absent" = false; both verified against source). Numbers above are corrected. Pattern holds: verify agent verdicts against source before trusting.

---

## PS-287 — Normalize Print Queue carrier label artwork to centered 4×6
- **Created against** origin/prepshipv4-stable @ f541b500. Has the 4×6 before/after screenshot (UPS Ground Saver / USPS handoff label with excess whitespace).
- **Problem:** `appendNormalizedLabelPages()` (src/services/print-queue.ts) only does PAGE-SIZE normalization — pages near 4×6 or rotated are copied byte-for-byte, so internally shifted/small/off-center artwork is preserved unchanged.
- **DoD:** content-aware artwork normalization — 288×432 canvas, detect visible artwork bounds, trim whitespace, scale proportionally, center, preserve aspect/barcodes, handle rotation deliberately, consistent across all carriers; batch header pages untouched.
- **Files:** src/services/print-queue.ts (`appendNormalizedLabelPages`), routes/print-queue.ts, OrdersView, v2-apiClient.
- **Tests:** test:print-queue-label-normalization, test:print-queue-pdf-merge (add if absent) + fixtures (usps-standard, ups-ground-saver-offset, fedex-oversized, easypost-small, rotated).

## PS-288 — Recover ShipStation labels when Print-to-Queue buys postage but queue persistence fails
- **Live incident:** orders 16-14771-56978 (shipment 26413) + 06-14786-98727 (26415) — bought UPS surepost labels, became shipped/greyed, label_url missing, no print_queue_orders row. DJ manually repaired both.
- **Clue:** local `shipments.label_shipment_id` held the ShipStation label_id (not shipment_id) — recovery paths assuming it's a shipment id miss these.
- **DoD:** atomic/recoverable post-purchase; recover label_url from ShipStation by tracking / label_id / shipment_id; queue recovery for shipped rows with active label + no queue row (no new postage); idempotent upsert by (order_id, client_id); operator recover/retry message instead of dead-end.
- **Files:** services/print-queue.ts, routes/print-queue.ts, services/labels.ts, lib/shipstation/labels.ts, connectors/carrier/shipstation.ts, OrdersView, orders-parity.ts; guards print-queue-durable/persistence/invalid-label, shipstation-label-url-guard.
- **Adjacent done:** PS-286 (label_url NULL-fill from sync + backfill) overlaps the recovery primitive.

## PS-289 — Multi-package shipment groups: multiple labels/tracking for one order (XL)
- **Problem:** one-order-one-label assumption everywhere; need qty>1 split into N boxes, each its own label/tracking, all under one order; provider-specific marketplace confirmation (eBay multi-fulfillment quantity-aware); Print Queue all child labels; billing/inventory not double-counted.
- **DoD:** NEW backend `shipment_groups` + `shipment_packages` model; package-plan API; full-plan rate proof; idempotent multi-label purchase (recover partial); status partially_purchased→shipped; provider-specific confirmation planner; Print Queue group-aware; preserve duplicate-postage guard for normal single-label.
- **Files:** db/schema/shipments.ts, services/labels.ts (CreateLabelInputDto), findActiveLabelForOrder, markOrderShipped, outbox/marketplaceConfirmationPayload, print-queue, billing, inventory.
- **Note:** largest card (XL); deep new model. Mostly net-new.

## PS-290 — HUGRAB Best Rate explicit $100 insurance coverage badges
- **Follow-up to PS-214 (closed).** Operator-facing coverage-status read-model + badges. Builds on PS-274 insurance-certainty work.
- **DoD:** backend-owned typed `InsuranceCoverageStatus` (included/not_included/unknown/unsupported/not_required) + badge fields on best-rate/selected-rate/workflow DTOs; populated from backend resolver (not FE heuristic); Awaiting Best Rate column shows green "$100 INS. INCL." / red "NO INSURANCE" / amber "INSURANCE UNKNOWN"; Rate Browser + side-panel parity; positive premium shows alongside badge; $0 carrier-declared = green (not "missing"); label/queue proof reflects same state; guard ps-290.
- **Files:** services/order-rate-dto.ts, rates.ts, labels.ts, shipping-service-eligibility.ts, shipping-options.ts, shipping-workflow/insurance-cost.ts, rate-fingerprint.ts, rate-money.ts, orders-row-display.tsx, OrdersView, RateBrowserModal; guards ps-072/083/102/057.
- **Adjacent done:** PS-274 insurance-certainty SOT + tag (insurance-certainty.ts, RateRowItem) — strong overlap with the "unknown/uncertain" state.

## PS-291 — New Manual Order rate preview: real ship-from, saved/custom origins, account-labeled rates
- **DoD:** Ship-From selector (saved locations dropdown + Custom expandable + "save this location"); rate preview uses full selected origin (not hard-coded `defaultFromZip`); exclude marketplace-owned providers (ebay_shipping/walmart_shipping) from manual preview; show account nickname above service (Rate Browser parity); preserve selected preview rate on the saved order; manual orders REAL (not isTest:true / raw.test:true) by default; line items OPTIONAL (allow items:[]).
- **Files:** NewOrderModal.tsx, RateBrowserModal.tsx, OrdersView, v2-apiClient.ts, routes/orders.ts (/orders/manual), routes/rates.ts, services/rates.ts, services/labels.ts, LocationsView.tsx + location API/schema.
- **Note:** operator-facing + shipping-money-path adjacent (selected-rate proof must hold).

## PS-258 Card 13 / PS-166 — OrdersView decomposition
- **PS-258:** slices A (column-prefs), B (non-critical-scheduler), C (table-density hook) shipped byte-identically + guards. Bulk hook/component decomposition (usePassiveAutoRating/usePanelState/useFilteredOrders + memoized rows) remains — gated on a real PS-166 DOM-contract cert (byte-equality of serialized rendered table before/after) which does NOT yet exist.
- **PS-166 (boss @75% 2026-06-16):** many W3/W4 side-panel extractions merged (OrdersDailyStrip, OrdersPanelSections, SaveSkuDefaultsLink, PackageDimsLine, ShipFromRow, WeightRow, SizeRow, ShippedLabelActions). No dedicated test:ps-166-* guard; needs explicit remaining-extraction checklist + behavior-preserving boundary cert.
