// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.3) — the canonical
// occurrence-execution eligibility owner. This file is shipped-data LOCKED: it is the single authority that
// decides which fulfillment_line_claims may reach inventory movement, at ALL five boundaries (owner
// disposition/enqueue, occurrence enqueuer, recovery, the dedicated-worker claim query, and the executor
// re-check). No boundary duplicates the fence or the scope — they all delegate here. It writes no shipped
// data itself, but it authorizes movement, so it is [L].
//
// Fail-closed contract (Hermes Release B corrections #2/#3):
//   * canary mode REQUIRES a frozen pre-projection max occurrence id; a claim is eligible only when its
//     occurrence_id is strictly ABOVE that floor (the ~4,057 legacy backlog has occurrence_id NULL and is
//     fenced out entirely). broad mode lifts the floor but keeps every other fence.
//   * the scope is an approved allowlist of client/store/order ids; an empty/malformed/absent config yields
//     ZERO eligibility, never "all". At least one id dimension must be configured.
//   * the structural forward-only fence is invariant: occurrence_id NOT NULL, canonical_line_identity NOT
//     NULL, supply='prepship', status='pending', occurrence not superseded.
import { env } from '../../lib/env.js';

export type OccurrenceScopeMode = 'canary' | 'broad';

export interface OccurrenceExecutionScope {
  mode: OccurrenceScopeMode;
  clientIds: readonly number[];
  storeIds: readonly number[];
  orderIds: readonly number[];
  preProjectionMaxId: number | null;
  /** true only when the config is safe to execute against (see reason when false). */
  valid: boolean;
  reason: string;
}

/** The structural forward-only fence, as a stable list (documentation + the SQL builders below share it). */
export const OCCURRENCE_STRUCTURAL_FENCE = [
  'occurrence_id IS NOT NULL',
  'canonical_line_identity IS NOT NULL',
  "supply = 'prepship'",
  "status = 'pending'",
  'occurrence NOT superseded',
] as const;

/** Parse a comma/space/semicolon-separated id list fail-closed: any malformed token invalidates the whole list. */
function parseIdList(raw: string | undefined): { ids: number[]; malformed: boolean } {
  if (raw === undefined) return { ids: [], malformed: false };
  const tokens = raw.split(/[\s,;]+/).map((t) => t.trim()).filter((t) => t.length > 0);
  const ids: number[] = [];
  let malformed = false;
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) { malformed = true; continue; }
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n <= 0) { malformed = true; continue; }
    ids.push(n);
  }
  return { ids: Array.from(new Set(ids)), malformed };
}

export interface RawOccurrenceScopeConfig {
  mode: OccurrenceScopeMode;
  clientIds: string | undefined;
  storeIds: string | undefined;
  orderIds: string | undefined;
  preProjectionMaxId: number | null;
}

/** Read + validate the occurrence-execution scope from the environment (fail-closed). */
export function readOccurrenceExecutionScope(): OccurrenceExecutionScope {
  return buildOccurrenceExecutionScope({
    mode: env.FULFILLMENT_OCCURRENCE_SCOPE_MODE,
    clientIds: env.FULFILLMENT_OCCURRENCE_SCOPE_CLIENT_IDS,
    storeIds: env.FULFILLMENT_OCCURRENCE_SCOPE_STORE_IDS,
    orderIds: env.FULFILLMENT_OCCURRENCE_SCOPE_ORDER_IDS,
    preProjectionMaxId: env.FULFILLMENT_OCCURRENCE_PREPROJECTION_MAX_ID ?? null,
  });
}

/** Pure builder (no env / no IO) — the validation + fail-closed policy live here for unit testing. */
export function buildOccurrenceExecutionScope(raw: RawOccurrenceScopeConfig): OccurrenceExecutionScope {
  const mode = raw.mode;
  const client = parseIdList(raw.clientIds);
  const store = parseIdList(raw.storeIds);
  const order = parseIdList(raw.orderIds);
  const preProjectionMaxId = raw.preProjectionMaxId;

  const anyMalformed = client.malformed || store.malformed || order.malformed;
  const anyConfigured = client.ids.length > 0 || store.ids.length > 0 || order.ids.length > 0;

  let valid = true;
  let reason = 'ok';
  if (anyMalformed) { valid = false; reason = 'scope id list contains a malformed token (fail-closed: zero eligibility)'; }
  else if (!anyConfigured) { valid = false; reason = 'no approved client/store/order id configured (fail-closed: zero eligibility, never all)'; }
  else if (mode === 'canary' && (preProjectionMaxId === null || preProjectionMaxId < 0)) {
    valid = false; reason = 'canary mode requires a frozen non-negative pre-projection max occurrence id';
  }

  return {
    mode,
    clientIds: client.ids,
    storeIds: store.ids,
    orderIds: order.ids,
    preProjectionMaxId,
    valid,
    reason,
  };
}

/** Throw if the scope is not safe to execute against — the dedicated occurrence worker calls this at startup. */
export function assertExecutionScopeReady(scope: OccurrenceExecutionScope): void {
  if (!scope.valid) {
    throw new Error(`[occurrence-execution-scope] refusing to execute: ${scope.reason}`);
  }
}

export interface FenceCandidate {
  occurrenceId: number | null;
  canonicalLineIdentity: string | null;
  supply: string | null;
  status: string | null;
  /** true when the owning occurrence has been superseded (superseded_by_occurrence_id IS NOT NULL). */
  superseded: boolean;
  clientId: number | null;
  storeId: number | null;
  orderId: number | null;
}

/**
 * THE single authoritative eligibility decision. Every boundary that could lead to inventory movement runs
 * this in code (the SQL pre-filters below are optimizations that must be re-confirmed here under lock). A
 * claim is eligible only when the structural fence holds AND it is within the approved allowlist AND (canary)
 * strictly above the frozen pre-projection floor.
 */
export function claimEligibleForExecution(candidate: FenceCandidate, scope: OccurrenceExecutionScope): { eligible: boolean; reason: string } {
  if (!scope.valid) return { eligible: false, reason: `scope invalid: ${scope.reason}` };
  if (candidate.occurrenceId == null) return { eligible: false, reason: 'occurrence_id is null (legacy backlog fence)' };
  if (candidate.canonicalLineIdentity == null || candidate.canonicalLineIdentity.length === 0) return { eligible: false, reason: 'canonical_line_identity is null' };
  if (candidate.supply !== 'prepship') return { eligible: false, reason: `supply=${candidate.supply} (only prepship deducts)` };
  if (candidate.status !== 'pending') return { eligible: false, reason: `status=${candidate.status} (only pending executes)` };
  if (candidate.superseded) return { eligible: false, reason: 'occurrence superseded' };
  if (scope.mode === 'canary') {
    if (scope.preProjectionMaxId == null) return { eligible: false, reason: 'no pre-projection floor in canary mode' };
    if (candidate.occurrenceId <= scope.preProjectionMaxId) return { eligible: false, reason: `occurrence_id ${candidate.occurrenceId} not above canary floor ${scope.preProjectionMaxId}` };
  }
  // Allowlist: each CONFIGURED dimension is a required match; an unconfigured (empty) dimension is not a filter
  // (scope.valid already guaranteed at least one dimension is configured).
  if (scope.clientIds.length > 0 && (candidate.clientId == null || !scope.clientIds.includes(candidate.clientId))) {
    return { eligible: false, reason: 'client not in approved scope' };
  }
  if (scope.storeIds.length > 0 && (candidate.storeId == null || !scope.storeIds.includes(candidate.storeId))) {
    return { eligible: false, reason: 'store not in approved scope' };
  }
  if (scope.orderIds.length > 0 && (candidate.orderId == null || !scope.orderIds.includes(candidate.orderId))) {
    return { eligible: false, reason: 'order not in approved scope' };
  }
  return { eligible: true, reason: 'ok' };
}
