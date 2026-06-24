// PS-312/PS-317 (S6) — PURE bundle inventory-deduction policy: the single source of truth for
// "deduct inventory ONCE for every order in a combined-shipment bundle." A bundle has ONE label
// (on the primary), so the normal per-label deduction trigger fires only for the primary and would
// UNDER-deduct the children. This policy says: once the bundle is LABELED, deduct every member
// order exactly once — and never twice (idempotent against an already-deducted set). It decides
// WHICH orders to deduct; the live deductInventoryForOrder owner (governed by INVENTORY_AUTO_DEDUCT)
// performs the actual movement, behind a default-OFF flag + DJ canary. No DB, no IO, no stock math.
import type { BundleRowDto } from './bundle-read-model.js';

export type BundleDeductionPlan = {
  // Member orders whose SKUs must be deducted now (children included), each exactly once.
  orderIdsToDeduct: number[];
  // Members skipped because they were already deducted (idempotency proof).
  skippedAlreadyDeducted: number[];
  // Why nothing is deductible yet, when applicable (e.g. the bundle has no label).
  reason: string | null;
};

/**
 * Plan the once-only inventory deduction for a bundle. Nothing deducts until the bundle's ONE label
 * is bought (status beyond 'draft'); then every member not already in `alreadyDeductedOrderIds`
 * deducts exactly once. Deterministic + idempotent: re-running with the prior result's deducted
 * orders folded into `alreadyDeductedOrderIds` yields an empty plan.
 */
export function planBundleInventoryDeduction(
  bundle: BundleRowDto,
  alreadyDeductedOrderIds: Iterable<number> = [],
): BundleDeductionPlan {
  if (bundle.status === 'draft') {
    return { orderIdsToDeduct: [], skippedAlreadyDeducted: [], reason: 'bundle-not-labeled' };
  }
  const already = new Set(alreadyDeductedOrderIds);
  const orderIdsToDeduct: number[] = [];
  const skippedAlreadyDeducted: number[] = [];
  for (const orderId of bundle.memberOrderIds) {
    if (already.has(orderId)) skippedAlreadyDeducted.push(orderId);
    else orderIdsToDeduct.push(orderId);
  }
  return { orderIdsToDeduct, skippedAlreadyDeducted, reason: null };
}
