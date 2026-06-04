// PS-083 — Direct-carrier assignment scope (single source of truth).
//
// "Direct carriers" are rows in `carrier_accounts` (SHIPP, EasyPost, UPS,
// FedEx, USPS, eHub, simulator, …) that quote rates / buy labels through the
// Vercel `/api/carriers/*` functions, as opposed to ShipStation carriers
// (which are scoped by the v2 API key) or marketplace store accounts.
//
// THE RULE this module enforces:
//
//   An active direct carrier with NO client assignment is NOT a globally
//   shared carrier. Empty assignment = hidden / blocked everywhere — never an
//   implicit "available to all clients". Making a carrier available to all
//   clients must be an EXPLICIT assignment, not an accident of leaving the
//   assignment list blank.
//
// Before PS-083, the frontend Rate Browser treated `assignedClientIds === []`
// + `clientId === null` as "globally visible", so an unassigned SHIPP carrier
// leaked into every Rate Browser scope (with a red error badge). The backend
// `/carriers/rates` and `/carriers/labels` functions did no assignment check
// at all.
//
// This module is intentionally dependency-free so the SAME decision can be
// imported by:
//   • the frontend Rate Browser filter   (web/src/lib/v2-apiClient.ts)
//   • the backend rate gate              (api/carriers/rates.ts)
//   • the backend label-purchase gate    (api/carriers/labels.ts)
//   • the PS-083 guard test               (scripts/ps-083-…-guard.ts)
// Keeping one copy means frontend hiding and backend rejection can never drift.

/** Marketplace-owned shipping APIs are scoped by store, never globally shared. */
const STORE_SCOPED_SHIPPING_PROVIDERS = new Set<string>([
  'walmart_shipping',
  'ebay_shipping',
]);

export function normalizeProviderKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function isStoreScopedShippingProvider(provider: unknown): boolean {
  return STORE_SCOPED_SHIPPING_PROVIDERS.has(normalizeProviderKey(provider));
}

/** Parse a value to a finite client id, or null when it is not a usable id. */
export function parseFiniteClientId(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a raw `assignedClientIds` value into a clean number[]. */
export function normalizeAssignedClientIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => parseFiniteClientId(item))
    .filter((item): item is number => item != null);
}

export type DirectCarrierAssignment = {
  /** Legacy single-owner column on carrier_accounts. */
  clientId?: number | null;
  /** Junction-table assignment (carrier_account_clients). */
  assignedClientIds?: ReadonlyArray<number | null | undefined> | null;
};

/**
 * True when the carrier is assigned to at least one client — via the junction
 * table OR the legacy `client_id` column. Unassigned carriers are hidden
 * everywhere (no implicit global).
 */
export function directCarrierHasAnyAssignment(account: DirectCarrierAssignment): boolean {
  return (
    normalizeAssignedClientIds(account.assignedClientIds).length > 0 ||
    parseFiniteClientId(account.clientId) != null
  );
}

/**
 * True when the carrier is assigned to the specific client. Returns false for
 * unassigned carriers regardless of context (blank assignment is never global),
 * and false when the context has no resolvable client id.
 */
export function directCarrierAssignedToClient(
  account: DirectCarrierAssignment,
  contextClientId: number | null,
): boolean {
  const assigned = normalizeAssignedClientIds(account.assignedClientIds);
  if (assigned.length > 0) {
    return contextClientId != null && assigned.includes(contextClientId);
  }
  const legacy = parseFiniteClientId(account.clientId);
  if (legacy != null) {
    return contextClientId != null && legacy === contextClientId;
  }
  // Unassigned: hidden / blocked. NOT global.
  return false;
}

export type DirectCarrierVisibilityContext = {
  clientId?: unknown;
  storeId?: unknown;
  /**
   * Standalone "Browse Rates" rate-shopping view passes this. It is NOT scoped
   * to a client/store, but it must STILL hide carriers with no assignment.
   */
  includeAllDirectCarriers?: unknown;
};

/**
 * Frontend display rule for a direct `carrier_accounts` row (store_accounts
 * rows are matched separately by the caller). Returns whether the carrier
 * should appear in the given Rate Browser scope.
 */
export function directCarrierVisibleForScope(
  account: DirectCarrierAssignment & { provider?: string | null },
  context: DirectCarrierVisibilityContext,
): boolean {
  const provider = normalizeProviderKey(account.provider);
  const contextClientId = parseFiniteClientId(context.clientId);
  const contextStoreId = parseFiniteClientId(context.storeId);

  // "Browse Rates" standalone view: no order/client/store scope. Show every
  // direct carrier that is assigned to SOMEONE; keep store-scoped marketplace
  // shipping APIs out (they are scoped via store_accounts), and keep fully
  // unassigned carriers hidden (PS-083: blank assignment is never global).
  if (context.includeAllDirectCarriers === true && contextClientId == null && contextStoreId == null) {
    if (isStoreScopedShippingProvider(provider)) return false;
    return directCarrierHasAnyAssignment(account);
  }

  // Order/client-scoped view: only carriers assigned to this client.
  return directCarrierAssignedToClient(account, contextClientId);
}

export type DirectCarrierScopeRequest = {
  clientId?: unknown;
  storeId?: unknown;
  orderId?: unknown;
};

export type DirectCarrierScopeDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Backend gate for a rate/label request against a direct `carrier_accounts`
 * row. Returns `{ allowed: true }` when the request may proceed, or
 * `{ allowed: false, reason }` (safe, secret-free) when it must be rejected.
 *
 * Semantics:
 *   • A request with NO order/client/store scope is the Settings credential-
 *     test demo — allowed, so operators can verify a carrier BEFORE assigning.
 *   • A SCOPED request against a carrier with NO assignment is rejected (this
 *     is the unassigned-SHIPP leak — the core of PS-083).
 *   • A SCOPED request whose client is known but does not match the carrier's
 *     assignment is rejected (wrong-client).
 *   • A SCOPED request whose client cannot be resolved (e.g. store-only) against
 *     an ASSIGNED carrier is allowed — we can't prove a mismatch, and the goal
 *     is to block unassigned carriers, not legitimate assigned ones.
 */
export function evaluateDirectCarrierScope(
  account: DirectCarrierAssignment,
  request: DirectCarrierScopeRequest,
): DirectCarrierScopeDecision {
  const contextClientId = parseFiniteClientId(request.clientId);
  const hasScope =
    contextClientId != null ||
    parseFiniteClientId(request.storeId) != null ||
    parseFiniteClientId(request.orderId) != null;

  // Scopeless credential test (Settings demo) — allow.
  if (!hasScope) return { allowed: true };

  if (!directCarrierHasAnyAssignment(account)) {
    return {
      allowed: false,
      reason:
        'This carrier is not assigned to any client. Assign it to a client in Settings before quoting rates or buying labels.',
    };
  }

  // Assigned carrier, but we could not resolve the request's client — do not
  // block a legitimately-assigned carrier on an unknown client.
  if (contextClientId == null) return { allowed: true };

  if (!directCarrierAssignedToClient(account, contextClientId)) {
    return {
      allowed: false,
      reason: "This carrier is not assigned to this order's client.",
    };
  }

  return { allowed: true };
}
