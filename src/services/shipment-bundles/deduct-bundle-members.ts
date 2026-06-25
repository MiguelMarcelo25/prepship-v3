// PS-312 (S6) — combined-shipment deduct-once fan-out. A bundle has ONE label (on the primary), so
// the per-label inventory trigger deducts only the primary and UNDER-deducts the children. Once the
// bundle is LABELED, this fans out to deduct every OTHER member exactly once. It is PURE ORCHESTRATION:
// it reads the bundle, delegates WHICH-orders to the planBundleInventoryDeduction policy, then calls
// the INJECTED member-loader + the INJECTED deductInventoryForOrder owner (kept unchanged, still
// INVENTORY_AUTO_DEDUCT-gated + ship-ledger idempotent). It owns no stock math, no direct table IO,
// and never marks orders shipped — which also keeps it unit-testable without the inventory/orders tables.
import { db } from '../../db/client';
import type { orders } from '../../db/schema/orders';
import { getBundleForOrder } from './bundle-read-model';
import { planBundleInventoryDeduction } from './bundle-inventory-policy';

type MemberOrder = typeof orders.$inferSelect;

export type LoadMemberOrdersFn = (orderIds: number[]) => Promise<MemberOrder[]>;
export type BundleMemberDeductFn = (
  order: MemberOrder,
  input: { shipmentId: number; source: string },
) => Promise<unknown>;

/**
 * Deduct every OTHER bundle member's inventory exactly once after the primary's ONE label is bought.
 * No-op (returns []) for a non-primary order or a still-'draft' bundle (planBundleInventoryDeduction
 * gates on the bundle being labeled). The primary is treated as already-deducted — its own per-label
 * trigger handled it. Returns the member order ids passed to the deductor. Cross-call idempotency is
 * the deductInventoryForOrder owner's job (the per-(orderId,inventoryId) ship-ledger).
 */
export async function deductBundleMembersOnce(
  primaryOrderId: number,
  shipmentId: number,
  loadMemberOrders: LoadMemberOrdersFn,
  deduct: BundleMemberDeductFn,
  conn: typeof db = db,
): Promise<number[]> {
  const bundle = await getBundleForOrder(primaryOrderId, conn);
  if (!bundle || bundle.role !== 'primary') return [];
  const plan = planBundleInventoryDeduction(bundle, [primaryOrderId]);
  if (plan.orderIdsToDeduct.length === 0) return [];
  const memberOrders = await loadMemberOrders(plan.orderIdsToDeduct);
  const deducted: number[] = [];
  for (const memberOrder of memberOrders) {
    await deduct(memberOrder, { shipmentId, source: 'bundle' });
    deducted.push(memberOrder.id);
  }
  return deducted;
}
