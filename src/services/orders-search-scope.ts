/**
 * PS-210 — Orders list status-scope semantics (pure, DB-free).
 *
 * Operator report: searching a customer from the Awaiting tab returned
 * nothing while the same search found the order on the Shipped tab. The UI
 * already CLAIMED global search ("Searching all orders") and the
 * bulk-selection matcher already omitted the status filter during search —
 * but the visible table query still pinned `order_status = <active tab>`, so
 * a Shipped match could never surface from Awaiting.
 *
 * This module is the single owner of the rule:
 *
 *   A NON-EMPTY search with searchScope=global is a GLOBAL read across the
 *   order lifecycle (awaiting_shipment, shipped, cancelled). Everything else
 *   (no search, empty/whitespace search, scope not requested) stays the
 *   normal status-tab-local filter — clearing search restores tab behavior.
 *
 * Only the STATUS predicate widens. Auth/RBAC, client/store scope,
 * hidden-test-client behavior, assignee filtering, and the awaiting
 * visibility predicate all still apply — the route composes them around the
 * mode this resolver returns. Mutation gating is untouched: shipped/
 * cancelled rows surfaced by global search remain read-only at the backend
 * via assertOrderEditable() exactly as before.
 */

export const GLOBAL_SEARCH_LIFECYCLE_STATUSES = ['awaiting_shipment', 'shipped', 'cancelled'] as const;

export type OrdersStatusScope =
  | { mode: 'global_lifecycle'; statuses: readonly string[] }
  | { mode: 'single_status'; status: string }
  | { mode: 'unfiltered' };

export function resolveOrdersStatusScope(q: {
  status?: string | null;
  search?: string | null;
  searchScope?: string | null;
}): OrdersStatusScope {
  const search = String(q.search ?? '').trim();
  const scope = String(q.searchScope ?? '').trim().toLowerCase();
  if (search.length > 0 && scope === 'global') {
    return { mode: 'global_lifecycle', statuses: GLOBAL_SEARCH_LIFECYCLE_STATUSES };
  }
  const status = String(q.status ?? '').trim();
  if (status) return { mode: 'single_status', status };
  return { mode: 'unfiltered' };
}
