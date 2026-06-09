// PS-133: per-route step-timing + slow-route logging helpers, extracted VERBATIM from
// routes/inventory.ts (behavior-preserving — the only guard-safe + DTO-safe slice of the inventory
// analytics decomposition; the analytics query/DTO logic itself is guard-pinned and byte-identity
// critical, so it stays in the route). These are PURE (performance.now + console.info only) — no DB,
// no response DTO. Used by the inventory list + ledger handlers. The `[inventory:<route>] completed`
// log format and the 750ms/500ms slow-route thresholds are kept char-for-char.
export type InventoryRouteTimings = Record<string, number>;

export function msSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export async function timedInventoryStep<T>(
  timings: InventoryRouteTimings,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = msSince(startedAt);
  }
}

export function logSlowInventoryRoute(
  route: string,
  timings: InventoryRouteTimings,
  totalMs: number,
  meta: Record<string, unknown>,
): void {
  const slowestStepMs = Math.max(0, ...Object.values(timings));
  if (totalMs < 750 && slowestStepMs < 500) return;
  console.info(`[inventory:${route}] completed`, {
    ...meta,
    totalMs,
    timings,
  });
}
