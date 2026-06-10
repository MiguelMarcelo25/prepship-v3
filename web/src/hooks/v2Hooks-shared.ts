// Shared React Query timing constants for the v2 hook shims.
//
// Extracted verbatim from v2Hooks.ts (PS-157) so per-domain hook modules
// (e.g. usePackages.ts) can split out of the v2Hooks barrel without
// duplicating these values. v2Hooks.ts re-imports them, keeping a single
// source of truth. Values are byte-for-byte identical to the originals.

export const ORDERS_STALE_MS = 30_000;
export const ORDERS_CACHE_MS = 10 * 60_000;
export const SHARED_DATA_STALE_MS = 5 * 60_000;
export const SHARED_DATA_CACHE_MS = 30 * 60_000;
