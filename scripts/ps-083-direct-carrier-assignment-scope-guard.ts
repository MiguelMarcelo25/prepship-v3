// PS-083 — Hide unassigned direct carriers from Rate Browser + enforce scope.
//
// Pins the shared assignment-scope rule that BOTH the frontend Rate Browser
// filter (web/src/lib/v2-apiClient.ts) and the backend rate/label gates
// (api/carriers/rates.ts, api/carriers/labels.ts) delegate to. If this guard
// passes, an unassigned direct carrier (the reported SHIPP bug) cannot appear
// in the Rate Browser, cannot be quoted for a scoped order, and cannot buy a
// label for a scoped order.

import {
  directCarrierVisibleForScope,
  directCarrierHasAnyAssignment,
  directCarrierAssignedToClient,
  evaluateDirectCarrierScope,
  normalizeAssignedClientIds,
} from '../src/lib/direct-carrier-scope';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Client ids used in the fixtures.
const HUGRAB = 11;
const KFG = 22;
const DRP = 33;

// ── Fixtures mirroring the bug report ────────────────────────────────────────
// The reported SHIPP carrier: active, client_id null, assigned to nobody.
const unassignedShipp = { provider: 'shipp', clientId: null, assignedClientIds: [] as number[] };
// SHIPP assigned (junction) to HUGRAB only.
const shippAssignedHugrab = { provider: 'shipp', clientId: null, assignedClientIds: [HUGRAB] };
// Legacy single-owner carrier (client_id column, no junction rows).
const legacyDrpCarrier = { provider: 'easypost', clientId: DRP, assignedClientIds: [] as number[] };
// Marketplace store-scoped shipping provider (must never go global).
const walmartShipping = { provider: 'walmart_shipping', clientId: null, assignedClientIds: [] as number[] };

// ── normalizeAssignedClientIds ───────────────────────────────────────────────
assert(
  JSON.stringify(normalizeAssignedClientIds([HUGRAB, '22', null, undefined, 'x', NaN])) ===
    JSON.stringify([HUGRAB, KFG]),
  'normalizeAssignedClientIds should coerce numerics and drop junk',
);
assert(
  JSON.stringify(normalizeAssignedClientIds(null)) === JSON.stringify([]),
  'normalizeAssignedClientIds(null) should be []',
);

// ── directCarrierHasAnyAssignment ────────────────────────────────────────────
assert(!directCarrierHasAnyAssignment(unassignedShipp), 'unassigned SHIPP has no assignment');
assert(directCarrierHasAnyAssignment(shippAssignedHugrab), 'junction-assigned SHIPP has an assignment');
assert(directCarrierHasAnyAssignment(legacyDrpCarrier), 'legacy client_id counts as an assignment');

// ── directCarrierAssignedToClient ────────────────────────────────────────────
assert(!directCarrierAssignedToClient(unassignedShipp, HUGRAB), 'unassigned SHIPP never assigned to a client');
assert(!directCarrierAssignedToClient(unassignedShipp, null), 'unassigned SHIPP not global');
assert(directCarrierAssignedToClient(shippAssignedHugrab, HUGRAB), 'assigned SHIPP visible to HUGRAB');
assert(!directCarrierAssignedToClient(shippAssignedHugrab, KFG), 'assigned SHIPP hidden from KFG');
assert(directCarrierAssignedToClient(legacyDrpCarrier, DRP), 'legacy carrier visible to its client');
assert(!directCarrierAssignedToClient(legacyDrpCarrier, KFG), 'legacy carrier hidden from other clients');

// ── Rate Browser visibility (order/client scoped) ────────────────────────────
// THE BUG: unassigned SHIPP must be HIDDEN for unrelated clients.
assert(
  !directCarrierVisibleForScope(unassignedShipp, { clientId: HUGRAB }),
  'REGRESSION: unassigned SHIPP must be hidden for HUGRAB',
);
assert(
  !directCarrierVisibleForScope(unassignedShipp, { clientId: KFG }),
  'REGRESSION: unassigned SHIPP must be hidden for KFG',
);
// Assigned carrier shows only for its client.
assert(
  directCarrierVisibleForScope(shippAssignedHugrab, { clientId: HUGRAB }),
  'assigned SHIPP must show for HUGRAB',
);
assert(
  !directCarrierVisibleForScope(shippAssignedHugrab, { clientId: KFG }),
  'assigned SHIPP must NOT leak to KFG',
);
assert(
  directCarrierVisibleForScope(legacyDrpCarrier, { clientId: DRP }),
  'legacy carrier must show for its client',
);

// ── Browse Rates standalone view (includeAllDirectCarriers, no scope) ─────────
// Unassigned carrier stays hidden even in the "show all" view.
assert(
  !directCarrierVisibleForScope(unassignedShipp, { includeAllDirectCarriers: true }),
  'REGRESSION: unassigned SHIPP must be hidden in Browse Rates (empty assignment is not global)',
);
// A carrier assigned to someone shows in the global rate-shopping view.
assert(
  directCarrierVisibleForScope(shippAssignedHugrab, { includeAllDirectCarriers: true }),
  'assigned SHIPP should appear in Browse Rates',
);
assert(
  directCarrierVisibleForScope(legacyDrpCarrier, { includeAllDirectCarriers: true }),
  'legacy-assigned carrier should appear in Browse Rates',
);
// Marketplace store-scoped providers never appear via the direct path.
assert(
  !directCarrierVisibleForScope(walmartShipping, { includeAllDirectCarriers: true }),
  'store-scoped walmart_shipping must not appear via the direct Browse Rates path',
);

// ── Backend rate/label gate (evaluateDirectCarrierScope) ─────────────────────
// Scoped request against an unassigned carrier → rejected.
const unassignedScoped = evaluateDirectCarrierScope(unassignedShipp, { orderId: 999, clientId: HUGRAB });
assert(!unassignedScoped.allowed, 'scoped rate/label on unassigned carrier must be rejected');
assert(
  unassignedScoped.allowed === false && /not assigned to any client/i.test(unassignedScoped.reason),
  'unassigned rejection must carry a clear, secret-free reason',
);

// Scoped request, wrong client → rejected.
const wrongClient = evaluateDirectCarrierScope(shippAssignedHugrab, { orderId: 5, clientId: KFG });
assert(!wrongClient.allowed, 'assigned carrier must be rejected for the wrong client');

// Scoped request, right client → allowed.
assert(
  evaluateDirectCarrierScope(shippAssignedHugrab, { orderId: 5, clientId: HUGRAB }).allowed,
  'assigned carrier must be allowed for its client',
);

// Scopeless Settings credential test → allowed even when unassigned (lets an
// operator verify a carrier BEFORE assigning it).
assert(
  evaluateDirectCarrierScope(unassignedShipp, {}).allowed,
  'scopeless credential test must be allowed for an unassigned carrier',
);

// Store-only scope (client unknown) against an ASSIGNED carrier → allowed (we
// can't prove a mismatch, and the goal is to block unassigned carriers only).
assert(
  evaluateDirectCarrierScope(shippAssignedHugrab, { storeId: 700 }).allowed,
  'assigned carrier with unresolved client (store-only) must not be blocked',
);
// Store-only scope against an UNASSIGNED carrier → still rejected.
assert(
  !evaluateDirectCarrierScope(unassignedShipp, { storeId: 700 }).allowed,
  'unassigned carrier must be rejected even when only store scope is present',
);

console.log('PASS PS-083 direct-carrier assignment-scope guard');
