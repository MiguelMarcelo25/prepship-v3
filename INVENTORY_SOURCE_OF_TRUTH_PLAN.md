# PrepShip Inventory Source-Of-Truth Plan

## Executive Summary

This Phase 6 / Phase 11 deliverable defines the canonical ownership model for PrepShip inventory quantities, adds a read-only dry-run reconciliation report with mismatch classification, and points future repair work to `INVENTORY_REPAIR_APPLY_PLAN.md`. It does not mutate stock, orders, shipments, labels, shipped rows, or cancelled rows.

Canonical rule:

- `inventory_ledger` is the source of truth for inventory movement history.
- `inventory.stockQty` is a materialized/cache balance used for fast reads and legacy compatibility.
- The Inventory page should display the operator-facing stock value from `effectiveStock` when available.
- `effectiveStock` is currently computed as `total_received - total_sold_shipped_all_time`.
- Reporting/read models should own velocity fields such as sold 7d, sold 30d, days supply, and restock recommendations.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Inventory truth is split across ledger, cache, and order-derived calculations | Operators may see stock values that disagree between pages | One documented source-of-truth model | `npm run test:inventory-source-of-truth` |
| `inventory.stockQty` can drift from ledger/effective stock | Fast UI cache can become stale after imports, labels, voids, or manual changes | Approved dry-run reconciliation report and owner-approved repair plan before any repair | `npm run inventory:reconcile:dry-run`; `npm run test:inventory-reconciliation-dry-run`; `npm run test:inventory-repair-plan` |
| Sold/velocity metrics can require expensive live scans | Inventory page can slow down under volume | Worker-generated reporting metrics for sold/velocity/days-supply | reporting metrics test and browser smoke |
| Returns/voids are not fully modeled into effective stock | Edge cases may require manual repair | explicit reconciliation workflow and owner approval | reconciliation report evidence |

## High-Risk Issues

| Area | Current Status | Risk If Unchanged | Recommended Patch |
|---|---|---|---|
| Stock movement writes | `applyMovement()` updates `inventory.stockQty` and inserts `inventory_ledger` in one transaction | cache remains useful, but ledger/cache drift can still happen from non-standard paths | make all future stock mutations go through a shared inventory movement service |
| Inventory display stock | Inventory UI prefers backend `effectiveStock` and keeps cached `stockQty` as tooltip/audit fallback | if backend omits `effectiveStock`, UI can fall back to stale cache | keep `effectiveStock` on list/read-model responses |
| Reconciliation | `/admin/reconcile-inventory-stock` exists as a repair path | repair without dry-run evidence could surprise operators | require dry-run report and owner approval before apply |
| Reporting metrics | reporting metrics direction exists | live inventory calculations remain expensive | materialize inventory risk/velocity/read-model rows in worker |

## Medium-Risk Issues

| Area | Concern | Recommendation |
|---|---|---|
| Negative stock | negative values can be valid when shipped history exceeds received history | keep negative stock visible; do not clamp to zero |
| Legacy rows | older rows may have no complete receive history | report as reconciliation findings, not silent rewrites |
| Returns | return quantity by item is not fully represented | add return-aware reconciliation later if return volume increases |
| Locked shipped/cancelled data | stock analytics may read shipped data, but should not mutate locked rows | keep reconciliation mutations limited to inventory cache unless explicitly approved |

## Canonical Data Ownership

| Data | Canonical Owner | Derived/Cache | Notes |
|---|---|---|---|
| Movement history | `inventory_ledger` | none | every receive/adjust/pick/ship/return/damage movement should be represented here |
| Fast stock cache | `inventory.stockQty` | materialized from movement writes or reconciliation | useful for fast reads and compatibility, but not the audit source |
| Display stock | `effectiveStock` | derived from ledger/order-item data or reporting metrics | Inventory page should prefer this value when present |
| Sold 7d / sold 30d | reporting metrics from `order_items` | cached read model | do not live-scan full orders on normal page load |
| Days supply / restock recommendation | reporting metrics | cached read model | worker refresh should own this |

## Phase Checklist

- [x] Document `inventory_ledger` as canonical movement history.
- [x] Document `inventory.stockQty` as materialized/cache balance.
- [x] Document Inventory page preference for `effectiveStock`.
- [x] Add static guard for inventory source-of-truth policy.
- [x] Add dry-run inventory ledger/cache reconciliation report.
- [x] Add static guard for dry-run-only reconciliation behavior.
- [x] Add mismatch classifications, recommended actions, and classification counts to the dry-run report.
- [x] Add `INVENTORY_REPAIR_APPLY_PLAN.md` before any repair/apply implementation.
- [x] Add static guard for inventory repair/apply planning.
- [ ] Add owner-approved cache rebuild path with before/after evidence.
- [ ] Move sold/velocity/days-supply/restock to worker-generated reporting metrics.
- [ ] Add browser smoke evidence for Inventory after reporting metrics rollout.

## Recommended Patches

- [x] Keep `applyMovement()` as the shared service for normal inventory movement writes.
- [x] Keep the Inventory page displaying `effectiveStock` when the backend provides it.
- [x] Add a dry-run reconciliation script that compares:
  - ledger-derived stock
  - cached `inventory.stockQty`
  - backend `effectiveStock`
  - visible Inventory page stock
- [x] Keep the dry-run script read-only with no repair/apply mode.
- [x] Report `classificationCounts`, row-level `classification`, `recommendedAction`, and `safeToAutoRepair=false`.
- [x] Document owner approval, saved artifacts, rollback, and prohibited mutations in `INVENTORY_REPAIR_APPLY_PLAN.md`.
- [ ] Require approval before applying any cache repair.
- [ ] Add worker-generated inventory metrics for velocity/restock.

## Test Plan

- `npm run test:inventory-source-of-truth`
- `npm run test:inventory-reconciliation-dry-run`
- `npm run test:inventory-repair-plan`
- `npm run test:inventory-client-scope`
- `npm run test:reconciliation-plan`
- `npm run test:frontend-failure-states`
- `npm run typecheck`
- `npm run build:web`

Future implementation tests:

- dry-run reconciliation reports row count, mismatch count, and no mutation
- `npm run inventory:reconcile:dry-run -- --limit 50`
- `npm run inventory:reconcile:dry-run -- --client-id 3 --json`
- `npm run inventory:reconcile:dry-run -- --sku "ABC-123"`
- apply mode updates only `inventory.stockQty` after approval
- Inventory page uses `effectiveStock` and exposes cached stock only as audit/tooltip fallback
- shipped/cancelled order rows and `shipments` are not mutated by inventory reconciliation

## Deployment / Rollback Notes

- This batch is safe to deploy because it adds documentation and a static guard only.
- No stock repair/apply mode is added yet.
- Repair/apply implementation is now gated by `INVENTORY_REPAIR_APPLY_PLAN.md`.
- Future inventory reconciliation apply mode must be deployed separately and reviewed with production dry-run output.
- Rollback for future cache repairs should be based on a saved before/after reconciliation report.
- Do not modify shipped/cancelled order rows or the `shipments` table as part of inventory cache repair.

## Recommended Implementation Order

1. Land this source-of-truth plan and static guard.
2. Land the read-only dry-run reconciliation report for ledger/cache/effective stock.
3. Review dry-run output and `INVENTORY_REPAIR_APPLY_PLAN.md` with DJ/OpenClaw and assign an inventory owner.
4. Add approved cache rebuild/apply mode in a separate reviewed batch only after saved dry-run evidence is accepted.
5. Move sold/velocity/days-supply/restock into worker-generated reporting metrics.
6. Browser-audit Inventory and Dashboard after reporting metrics are live.
