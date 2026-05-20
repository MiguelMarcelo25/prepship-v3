# PrepShip Inventory Repair / Apply Plan

## Executive Summary

This Phase 6 / Phase 11 control plan defines what an inventory repair/apply workflow may do later. This batch is planning-only: no repair mode is implemented, no stock is changed, and no orders, shipped/cancelled rows, shipments, labels, or billing rows are mutated.

Latest read-only dry-run evidence from May 20, 2026:

| Metric | Value |
|---|---:|
| Rows scanned | 968 |
| Matched rows | 861 |
| Mismatch rows | 107 |
| Total `inventory.stockQty` vs `inventory_ledger` delta | -1 |
| Total `inventory.stockQty` vs `effectiveStock` delta | -425 |
| Total `inventory_ledger` vs `effectiveStock` delta | 424 |
| `client_sku_collision_risk` classifications | 93 |
| `sold_exceeds_received` classifications | 14 |

Interpretation: `inventory.stockQty` and `inventory_ledger` are nearly aligned. The larger drift is between ledger/cache stock and order-derived `effectiveStock`, and the first classification pass shows most mismatches are client/SKU collision risk rather than simple cache-repair candidates. The next engineering step is to save reviewable dry-run artifacts and inspect the 14 `sold_exceeds_received` rows with the inventory owner before any apply mode exists.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| No owner-approved repair policy | A script could overwrite the wrong source of truth | DJ/OpenClaw approve exact repair scope before implementation | Signed plan / issue reference |
| Dry-run evidence is not persisted as an artifact | Repair cannot be audited later | Save JSON/CSV dry-run output before every apply run | Artifact path or dashboard link |
| Source-of-truth direction is ambiguous | `effectiveStock` could overwrite ledger/cache incorrectly | Repair mode must state whether it corrects cache, ledger, or reporting math | Code review checklist |
| Client/SKU matching can cross tenants | Same SKU across clients can produce wrong stock changes | Every repair row must include `client_id` and SKU scope | seeded client/SKU collision test |
| Shipped/cancelled lockdown | Inventory repair can accidentally mutate protected order surfaces | Repair must not update orders, shipped/cancelled rows, shipments, or labels | static guard and DB audit log |

## High-Risk Issues

- `effectiveStock` can be lower than ledger/cache because historical shipped order sales exist without matching receive ledger entries.
- Negative `inventory.stockQty` rows may be operationally valid after overselling, so repair logic must not normalize them to zero automatically.
- Multi-client SKU reuse requires client-scoped reconciliation. SKU-only repair is unsafe.
- Voids/returns/externally shipped orders can change operational truth without a simple stock-cache correction.
- A future apply mode must be idempotent and rerunnable without double-adjusting stock.

## Medium-Risk Issues

- Dry-run output is currently CLI-only; operator-facing summaries and CSV export are still future work.
- Reporting metrics for sold 7d, sold 30d, velocity, days supply, and restock are still separate from this repair plan.
- Package ledger/package stock reconciliation is not covered by this inventory repair plan.
- Browser inventory displays should remain stable while reconciliation work continues.

## Recommended Patches

- [x] Add `npm run inventory:reconcile:dry-run`.
- [x] Add `npm run test:inventory-reconciliation-dry-run`.
- [x] Document latest dry-run evidence and client impact.
- [x] Add this owner-approval plan before any repair/apply code.
- [x] Add mismatch classification:
  - missing receive ledger
  - order-derived sold exceeds received
  - cache differs from ledger
  - client/SKU collision risk
  - inactive/deactivated SKU
- [x] Add `classificationCounts`, `recommendedAction`, and `safeToAutoRepair=false` to dry-run output.
- [ ] Add JSON/CSV artifact capture for dry-run output.
- [ ] Add owner-approved apply mode in a separate reviewed batch only after dry-run evidence is accepted.

## Allowed Future Apply Scope

A future apply mode may be considered only for narrowly scoped cache repair:

- It may update `inventory.stockQty` from a reviewed source of truth only after owner approval.
- It must require explicit flags such as `--apply`, `--client-id`, and either `--sku` or a saved dry-run artifact id.
- It must produce before/after evidence for every row.
- It must run inside a transaction.
- It must write an audit event.
- It must be idempotent.

## Explicitly Disallowed

- No mutation of `orders`.
- No mutation of shipped/cancelled order rows.
- No mutation of `shipments`.
- No mutation of label, manifest, billing, or fulfillment side-effect records.
- No automatic correction from `effectiveStock` into `inventory.stockQty` until mismatch causes are classified.
- No broad all-client apply run without a saved dry-run artifact and owner approval.

## Test Plan

Current planning/guard checks:

- `npm run test:inventory-repair-plan`
- `npm run test:inventory-reconciliation-dry-run`
- `npm run test:inventory-source-of-truth`
- `npm run test:reconciliation-plan`
- `npm run test:inventory-client-scope`
- `npm run test:orders-ux`

Future apply-mode tests before any repair code can ship:

- apply mode refuses to run without `--apply`
- apply mode refuses to run without `--client-id`
- apply mode refuses all-client repair by default
- apply mode does not mutate orders, shipped/cancelled rows, shipments, labels, billing, or fulfillment rows
- apply mode writes before/after audit events
- apply mode is idempotent on repeated run
- rollback can restore previous `inventory.stockQty` from saved artifact

## Deployment / Rollback Notes

- This plan is safe to deploy because it is documentation and guard-only.
- No stock repair/apply mode is added yet.
- Any future apply mode must ship behind an explicit command, not a page load or background worker.
- Rollback for future repair must use the saved before/after artifact from the exact apply run.

## Recommended Implementation Order

1. Review this plan and the latest dry-run evidence with DJ/OpenClaw.
2. Review classified mismatch output by client and SKU.
3. Persist dry-run JSON/CSV artifacts.
4. Implement an owner-approved cache repair mode in a separate batch if still needed.
5. Add worker-generated sold/velocity/restock reporting metrics after reconciliation ownership is settled.
