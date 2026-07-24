/**
 * PS-286 — close the "applied a rate in the Rate Browser, then immediately hit
 * Send/Print-Queue on a row that hasn't reconciled yet" race.
 *
 * applyRateSelection / onBestRateResolved persist the chosen rate (dims + selected
 * PID + best rate) through the backend rate authority. That was fire-and-forget
 * (`void persist(...)`) and the Rate Browser closed immediately, so the operator
 * could act before the authoritative write landed.
 *
 * The row is only reachable once the modal CLOSES, and the operator's next Send runs
 * on a later render — so the safe synchronization point is the close: register each
 * in-flight backend persist by orderId, and have the close await the relevant ones
 * before it actually hides the modal. Non-authoritative read-model reconciliation
 * may continue in the background after that write succeeds. These are pure helpers
 * (no React, no rate/price math); the component owns the Map ref + the setState close.
 */

/**
 * Register an in-flight applied-rate persist for an order; it auto-clears from the
 * map when it settles (success OR failure). Returns the same promise for chaining.
 */
export function trackAppliedRatePersist(
  inFlight: Map<number, Promise<unknown>>,
  orderId: number,
  persist: Promise<unknown>,
): Promise<unknown> {
  inFlight.set(orderId, persist);
  // allSettled never rejects, so the auto-clear chain can't raise an unhandled
  // rejection even if `persist` itself rejects (the caller owns its own error toast).
  void Promise.allSettled([persist]).then(() => {
    if (inFlight.get(orderId) === persist) inFlight.delete(orderId);
  });
  return persist;
}

/**
 * Wait for any in-flight applied-rate persist for the given orders to SETTLE
 * (resolve or reject — the persist owns its own error toast, so we never rethrow
 * here). Resolves immediately when nothing is pending, keeping the close snappy in
 * the common case.
 */
export async function awaitAppliedRatePersists(
  inFlight: Map<number, Promise<unknown>>,
  orderIds: Array<number | null | undefined>,
): Promise<void> {
  const pending = orderIds
    .map((id) => (id == null ? undefined : inFlight.get(id)))
    .filter((p): p is Promise<unknown> => Boolean(p));
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}
