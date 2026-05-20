# PrepShip Reconciliation Reports Plan

## Executive Summary

This Phase 12 deliverable scopes the reconciliation reports PrepShip needs before it can be called enterprise-ready. Reconciliation is different from normal page loading: it proves that local PrepShip data agrees with canonical external systems, generated outputs, and internal ledgers.

This is a planning/control batch only. It does not modify order, shipment, label, inventory, package, billing, or fulfillment logic. The goal is to define canonical sources, mismatch detection, repair workflow, and tests before implementation starts. Inventory reconciliation now references `INVENTORY_SOURCE_OF_TRUTH_PLAN.md` for the rule that `inventory_ledger` is canonical movement history and `inventory.stockQty` is a materialized/cache balance, and exposes `npm run inventory:reconcile:dry-run` as the first read-only report. This is the dry-run reconcile path for ledger/cache/effective-stock drift.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No formal reconciliation dashboard/report set | Data drift can stay hidden until a client/operator notices | Scheduled and on-demand reconciliation reports | Report tests with seeded mismatches |
| Inventory/package stock truth can diverge | Warehouse stock, billing, and order fulfillment can disagree | Ledger-to-cache reconciliation with repair workflow | Reconciliation query and repair dry-run test |
| Billing/label cost truth can diverge | Client invoices may not match actual label/package activity | Billing output compared to labels, packages, and generated line items | Billing reconciliation report test |
| External sync truth can diverge | Local orders/shipments can differ from ShipStation/marketplaces | External-vs-local mismatch detection and runbook | Sync reconciliation smoke test |

## High-Risk Issues

| Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Orders | Sync paths exist and `order_items` normalization is mostly in place | Missing/duplicated/stale orders can hide behind normal pagination | Reconcile local orders against ShipStation/store sources |
| Shipments/labels | Label and shipment data flows through provider APIs and local tables | Label exists but shipment/billing/fulfillment state diverges | Reconcile labels, shipments, billing, and fulfillment outbox |
| Inventory | `inventory_ledger`, cached stock, effective stock, and sales metrics all exist | Stock trust erodes when values disagree | `INVENTORY_SOURCE_OF_TRUTH_PLAN.md`, ledger canonical report, and stock cache repair workflow |
| Packages | Package library, usage, and package stock can diverge | Box cost/usage/billing can be wrong | Package ledger and package usage reconciliation |
| Billing | Generated line items exist, summaries/read models are partial | Zero or stale billing totals can look valid | Reconcile summaries against generated line items |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Rate cache | Cached/best rates can differ from actual label cost | Add rate-cache-vs-label-cost report |
| Fulfillment outbox | Confirmations can fail or duplicate | Add outbox-vs-provider/marketplace confirmation report |
| Clients/stores/carriers | Connected accounts can drift from ShipStation/stores | Add account inventory report with inactive/missing accounts |
| order_items | Backfill and trigger status need production proof | Add `orders.items` vs `order_items` parity report |

## Reconciliation Matrix

| Reconciliation | Canonical Source | Local Source | Mismatch Detection | Repair Process | Owner | Test |
|---|---|---|---|---|---|---|
| ShipStation orders vs local orders | ShipStation/store APIs | `orders` | missing local, missing upstream, stale status/date/store/client | resync by external id/date range | Sync owner | seeded missing/stale order report |
| `orders.items` vs `order_items` | `orders.items` ingestion payload | `order_items` | order item count/qty/revenue mismatch | rerun order_items repair/backfill | Analytics owner | order_items parity test |
| ShipStation shipments vs local shipments | ShipStation shipments/labels API | `shipments` | missing shipment, tracking mismatch, cost mismatch | resync shipment by id/order | Fulfillment owner | shipment mismatch report |
| Labels vs billing line items | label/provider cost + package usage | billing line items | missing line item, cost mismatch, duplicate charge | regenerate billing lines for range/client | Billing owner | billing-label parity test |
| Billing summaries vs billing line items | generated line items | summary/read-model tables/API | summary total/order count/client mismatch | rebuild summary/read model | Billing owner | summary parity test |
| Inventory ledger vs displayed stock | `inventory_ledger` | `inventory.stockQty` / effective stock | ledger total differs from displayed/cache stock | `npm run inventory:reconcile:dry-run`, then approved cache rebuild | Inventory owner | `npm run test:inventory-reconciliation-dry-run` |
| Package ledger vs package stock | package ledger/mutations | package stock/cache | stock quantity and usage mismatch | package stock rebuild from ledger | Package owner | package-stock parity test |
| Rate cache vs actual label cost | label purchase cost | `rate_cache` / best-rate fields | selected cached/best rate differs from paid label cost | mark stale cache and refresh future rates | Rate owner | rate-label cost report |
| Fulfillment outbox vs sent confirmations | marketplace/provider confirmation state | fulfillment outbox/job state | sent missing, duplicate, failed without retry | replay idempotently or mark terminal failure | Fulfillment owner | outbox confirmation report |
| Clients/stores vs ShipStation stores | ShipStation stores/accounts | clients/store accounts | missing store id, inactive account, duplicate mapping | update client/store mapping | Ops owner | client-store mapping report |
| Carrier accounts vs credential records | ShipStation/carrier account list | carrier/store credential records | missing/inactive/duplicate account | refresh account metadata and disable stale credentials | Credential owner | carrier account report |

## Recommended Patches

- [ ] Add a `reconciliation_runs` table to persist report metadata, status, counts, and downloadable artifact location.
- [ ] Add read-only reconciliation query services before any repair operation.
- [ ] Add dry-run repair mode for inventory/package/billing/order_items.
- [x] Add `INVENTORY_SOURCE_OF_TRUTH_PLAN.md` as the prerequisite inventory ownership policy.
- [x] Add `npm run inventory:reconcile:dry-run` as the read-only inventory ledger/cache/effective-stock report.
- [x] Add `npm run test:inventory-reconciliation-dry-run` to guard no mutation and no apply mode.
- [ ] Add operator-facing reports for mismatch counts and CSV export.
- [ ] Add worker scheduled reconciliation for low-risk reports.
- [ ] Keep label/shipment/order repair operations behind explicit human review and role checks.

## Test Plan

- `npm run test:reconciliation-plan`
- `npm run test:inventory-reconciliation-dry-run`
- Future implementation tests:
  - seeded `orders.items` vs `order_items` mismatch is detected
  - billing summary mismatch against line items is detected
  - inventory ledger/cache mismatch is detected
  - package ledger/cache mismatch is detected
  - rate cache vs label cost mismatch is detected
  - fulfillment outbox stuck/duplicate state is detected

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Reconciliation reporting should be read-only first.
- Repair workflows must be separate from detection workflows and should require explicit operator/admin action.
- Shipment/order repair work must be reviewed separately because it can touch locked operational surfaces.
- Rollback for report code should disable scheduled runs without deleting historical report output.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and approve report ownership.
2. Implement read-only `order_items` parity and billing summary parity reports first.
3. Review `npm run inventory:reconcile:dry-run` output, then implement package ledger parity reports.
4. Implement rate cache vs label cost report.
5. Implement external orders/shipments/client-store reconciliation.
6. Add repair dry-runs only after report correctness is proven.
