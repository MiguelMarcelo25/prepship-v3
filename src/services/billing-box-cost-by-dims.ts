// PS-311b — Bulk-apply a reviewed box cost to every NEEDS-REVIEW (unmatched) order that shares the
// SAME box signature (e.g. "Custom 6.5x4x2") within a (client + date range) scope, started from one
// such order in the Edit Billing Detail modal.
//
// Source-of-truth: an unmatched/custom-dims box emits a `package_cost_missing` review line whose
// `description` is the deterministic dims signature (services/billing-box-policy.ts describeBoxReview)
// and is part of the billing_line_items unique key — so identical description == identical box. We
// match on THAT, staying entirely in the billing read model (no shipment-dims re-join, no
// shipped/cancelled read). The reviewed cost is written as a per-order billing_box_resolutions
// override (PS-207 directive: packageId null + overridePrice = the cost) — which the generator reads
// FIRST and never deletes, so the box is resolved and the value survives regeneration. Finalized
// (invoiced) orders are SKIPPED. NEVER writes client_package_prices. Billing/awaiting data only.
//
// This is the dims-based companion to billing-box-cost-bulk.ts (which matches an already-resolved
// packageId). The pure preview/split math + result types are reused from that module verbatim.

import { sql, and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingLineItems, billingBoxResolutions } from '../db/schema/billing.js';
import { ensureBillingBoxResolutionsSchema } from './billing.js';
import {
  computeBulkBoxCostPreview,
  splitBulkBoxCostApplyTargets,
  type BulkBoxCostOrderRow,
  type BulkBoxCostPreview,
  type BulkBoxCostApplyResult,
} from './billing-box-cost-bulk.js';

const REVIEW_LINE_TYPE = 'package_cost_missing';

export type ByDimsScope = {
  clientId: number;
  dateFrom: string; // inclusive ISO lower bound (UTC midnight)
  dateTo: string; //   EXCLUSIVE ISO upper bound (day-after midnight)
  sourceOrderId: number; // the needs-review order the operator started from (its box = the target)
  newCost: number; //  the reviewed per-order box cost to apply
};

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/**
 * The dims SIGNATURE of a needs-review order = the `description` of its package_cost_missing line
 * (e.g. "Unmatched box (Custom 6.5x4x2) — no package matches the shipment box"). Deterministic for a
 * given box and part of the line's unique key, so identical text == identical box. Returns null when
 * the order has no review line (it is NOT a needs-review order — nothing to bulk-resolve). The
 * caller re-derives this server-side from the orderId; it never trusts an FE-supplied signature.
 */
export async function fetchBoxReviewSignature(
  clientId: number,
  sourceOrderId: number,
  conn: typeof db = db,
): Promise<string | null> {
  const [row] = await conn
    .select({ description: billingLineItems.description })
    .from(billingLineItems)
    .where(
      and(
        eq(billingLineItems.clientId, clientId),
        eq(billingLineItems.orderId, sourceOrderId),
        eq(billingLineItems.lineType, REVIEW_LINE_TYPE),
      ),
    )
    .limit(1);
  return row?.description ?? null;
}

/**
 * Every NEEDS-REVIEW order in the (client + range) scope whose review-line description matches the
 * source order's signature — i.e. the same unmatched box size. currentBoxCost is 0 (a review line
 * bills $0.00 until resolved). The route passes a billing-client scope predicate so cross-client
 * data can never leak. Read-only.
 */
export async function fetchUnmatchedBoxOrdersByDims(
  scope: ByDimsScope,
  signature: string,
  clientScopePredicate: ReturnType<typeof sql> | undefined,
  conn: typeof db = db,
): Promise<BulkBoxCostOrderRow[]> {
  const rows = await conn
    .select({
      orderId: billingLineItems.orderId,
      orderNumber: billingLineItems.orderNumber,
      invoiced: sql<boolean>`bool_or(coalesce(${billingLineItems.invoiced}, false))`,
    })
    .from(billingLineItems)
    .where(
      and(
        eq(billingLineItems.clientId, scope.clientId),
        eq(billingLineItems.lineType, REVIEW_LINE_TYPE),
        eq(billingLineItems.description, signature),
        gte(billingLineItems.shipDate, new Date(scope.dateFrom)),
        lt(billingLineItems.shipDate, new Date(scope.dateTo)),
        clientScopePredicate,
      ),
    )
    .groupBy(billingLineItems.orderId, billingLineItems.orderNumber);

  return rows
    .filter((r): r is typeof r & { orderId: number } => r.orderId != null)
    .map((r) => ({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      currentBoxCost: 0, // a needs-review box bills $0.00 until resolved
      invoiced: r.invoiced === true,
    }));
}

/**
 * Read-only PREVIEW of the same-box needs-review sweep. Returns a zero-impact preview (and a null
 * signature) when the source order is NOT a needs-review order, so the UI can explain "nothing to
 * apply" instead of silently doing nothing. The `signature` lets the UI label the box.
 */
export async function previewBulkBoxCostByDims(
  scope: ByDimsScope,
  clientScopePredicate: ReturnType<typeof sql> | undefined,
  conn: typeof db = db,
): Promise<BulkBoxCostPreview & { signature: string | null }> {
  const signature = await fetchBoxReviewSignature(scope.clientId, scope.sourceOrderId, conn);
  if (!signature) {
    return { ...computeBulkBoxCostPreview([], scope.newCost), signature: null };
  }
  const rows = await fetchUnmatchedBoxOrdersByDims(scope, signature, clientScopePredicate, conn);
  return { ...computeBulkBoxCostPreview(rows, scope.newCost), signature };
}

/**
 * Apply the reviewed box cost to every EDITABLE same-signature needs-review order by upserting an
 * override-price resolution (packageId null — a custom box has no package row; the override is the
 * FINAL line amount, no markup). Finalized (invoiced) orders are SKIPPED. ONE transaction — all
 * editable orders get the resolution or none do. The CALLER regenerates billing_line_items afterward
 * (resolutions survive regeneration). NEVER writes client_package_prices. Billing data only.
 */
export async function applyBulkBoxCostByDimsResolutions(
  scope: ByDimsScope,
  clientScopePredicate: ReturnType<typeof sql> | undefined,
  resolvedBy: string | null,
  note: string | null,
  conn: typeof db = db,
): Promise<BulkBoxCostApplyResult & { signature: string | null }> {
  // Only the production singleton path ensures the real schema (the injected pglite test conn
  // creates its own table and must never reach the production singleton — the `conn === db` guard).
  if (conn === db) await ensureBillingBoxResolutionsSchema();
  const signature = await fetchBoxReviewSignature(scope.clientId, scope.sourceOrderId, conn);
  if (!signature) {
    return { matchedOrderCount: 0, appliedOrderCount: 0, skippedFinalizedCount: 0, newCost: round2(scope.newCost), signature: null };
  }
  const rows = await fetchUnmatchedBoxOrdersByDims(scope, signature, clientScopePredicate, conn);
  const { editable, skippedFinalized } = splitBulkBoxCostApplyTargets(rows);
  const overridePrice = round2(scope.newCost).toFixed(2);

  if (editable.length > 0) {
    await conn.transaction(async (tx) => {
      for (const r of editable) {
        await tx
          .insert(billingBoxResolutions)
          .values({ orderId: r.orderId, packageId: null, overridePrice, note, resolvedBy })
          .onConflictDoUpdate({
            target: billingBoxResolutions.orderId,
            set: {
              packageId: null,
              overridePrice,
              ...(note != null ? { note } : {}),
              resolvedBy,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            },
          });
      }
    });
  }

  return {
    matchedOrderCount: rows.length,
    appliedOrderCount: editable.length,
    skippedFinalizedCount: skippedFinalized.length,
    newCost: round2(scope.newCost),
    signature,
  };
}
