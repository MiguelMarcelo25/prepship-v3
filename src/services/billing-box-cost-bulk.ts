// PS-311 — Bulk-apply a reviewed box cost to every order in a (client + date range + box)
// scope, instead of editing one order at a time.
//
// Source-of-truth (ARCHITECTURE.md / PS-207): the operator's box-cost decision is written to
// billing_box_resolutions — the per-order directive that range regeneration consults FIRST and
// NEVER deletes — then billing_line_items are regenerated so totals reflow. This module NEVER
// overwrites client_package_prices (that table is TIMELESS / global; the card forbids changing
// it for a date range). Finalized (invoiced) rows are excluded from the change.
//
// Slice 1 (this commit): the read-only PREVIEW (dry-run) — no writes. The apply is slice 2.

import { sql, and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingLineItems } from '../db/schema/billing.js';

export type BulkBoxCostScope = {
  clientId: number;
  dateFrom: string; // inclusive ISO lower bound (UTC midnight)
  dateTo: string; //   EXCLUSIVE ISO upper bound (day-after midnight)
  packageId: number; // the billed box to re-price
  newCost: number; //  the reviewed per-order box cost to apply
};

// One matched order in the scope: its current billed box cost + whether it's finalized.
export type BulkBoxCostOrderRow = {
  orderId: number;
  orderNumber: string | null;
  currentBoxCost: number;
  invoiced: boolean;
};

export type BulkBoxCostPreview = {
  matchedOrderCount: number; //   every order in scope billed for this box
  finalizedOrderCount: number; // invoiced → SKIPPED (cannot bulk-edit a finalized invoice)
  editableOrderCount: number; //  the orders that WOULD change
  newCost: number;
  beforeTotal: number; //         current Σ package_cost across editable orders
  afterTotal: number; //          newCost × editableOrderCount
  delta: number; //               afterTotal − beforeTotal (what the invoice total moves by)
  sampleOrderNumbers: string[]; //first few editable orders, for the confirm modal
};

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/**
 * PURE: given the orders matched by a (client + range + box) scope, compute the bulk-apply
 * preview. Finalized (invoiced) orders are reported but EXCLUDED from the before/after math —
 * the apply will refuse to touch them. No DB, no IO; fully guard-testable.
 */
export function computeBulkBoxCostPreview(
  rows: BulkBoxCostOrderRow[],
  newCost: number,
): BulkBoxCostPreview {
  const cost = round2(newCost);
  const editable = rows.filter((r) => !r.invoiced);
  const finalized = rows.filter((r) => r.invoiced);
  const beforeTotal = round2(
    editable.reduce((sum, r) => sum + (Number.isFinite(r.currentBoxCost) ? r.currentBoxCost : 0), 0),
  );
  const afterTotal = round2(editable.length * cost);
  return {
    matchedOrderCount: rows.length,
    finalizedOrderCount: finalized.length,
    editableOrderCount: editable.length,
    newCost: cost,
    beforeTotal,
    afterTotal,
    delta: round2(afterTotal - beforeTotal),
    sampleOrderNumbers: editable.slice(0, 10).map((r) => r.orderNumber ?? `#${r.orderId}`),
  };
}

/**
 * Fetch the orders in scope billed for `packageId`, with their current package_cost total and
 * finalized flag. The route passes a billing-client scope predicate so cross-client/store data
 * can never leak. Read-only.
 */
export async function fetchBulkBoxCostOrderRows(
  scope: BulkBoxCostScope,
  clientScopePredicate: ReturnType<typeof sql> | undefined,
): Promise<BulkBoxCostOrderRow[]> {
  const rows = await db
    .select({
      orderId: billingLineItems.orderId,
      orderNumber: billingLineItems.orderNumber,
      // The billed box cost is the generated package_cost line; package_cost_missing rows are $0.
      currentBoxCost: sql<number>`coalesce(sum(case when ${billingLineItems.lineType} = 'package_cost' then ${billingLineItems.totalCost} else 0 end), 0)`,
      // The order is finalized if ANY of its billed lines is invoiced.
      invoiced: sql<boolean>`bool_or(coalesce(${billingLineItems.invoiced}, false))`,
    })
    .from(billingLineItems)
    .where(
      and(
        eq(billingLineItems.clientId, scope.clientId),
        eq(billingLineItems.packageId, scope.packageId),
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
      currentBoxCost: round2(Number(r.currentBoxCost)),
      invoiced: r.invoiced === true,
    }));
}

/** Orchestrate the read-only preview for a (client + range + box) scope. No writes. */
export async function previewBulkBoxCost(
  scope: BulkBoxCostScope,
  clientScopePredicate: ReturnType<typeof sql> | undefined,
): Promise<BulkBoxCostPreview> {
  const rows = await fetchBulkBoxCostOrderRows(scope, clientScopePredicate);
  return computeBulkBoxCostPreview(rows, scope.newCost);
}
