export type BestRateWorkflowState =
  | 'missing'
  | 'fresh'
  | 'stale'
  | 'mismatched_request'
  | 'partial_carrier_failure'
  | 'blocked'
  // PS-120: backend-owned in-progress states for the per-order rate job. 'pending' = queued for
  // backend backfill rating; 'rating' = the backfill job is actively rating it now. Both are bounded
  // by a watchdog in the FE classifier (bestRateStateAgeMs) so they can never become an infinite spinner.
  | 'pending'
  | 'rating'
  | 'unknown';

export type BestRateWorkflowSourceConfidence =
  | 'live'
  | 'cache_fresh'
  | 'cache_stale'
  | 'saved_override'
  | 'partial'
  | 'none';

export type BestRateWorkflowCarrierStatusValue =
  | 'live'
  | 'cached'
  | 'unavailable'
  | 'loading'
  | 'error'
  | 'blocked'
  | 'unknown'
  // PS-206: TERMINAL "this carrier has no cached coverage and was not live-
  // quoted in this (cached-only) lookup — a live check is required". Distinct
  // from 'loading' (an actual request is in flight) and from 'unavailable'
  // (the carrier WAS checked and returned nothing). The Rate Browser uses this
  // coverage identity — never a carrier COUNT — to decide its live follow-up.
  | 'uncached';

export type BestRateWorkflowCarrierStatus = {
  carrierId: string;
  carrierName?: string | null;
  carrierCode?: string | null;
  nickname?: string | null;
  status: BestRateWorkflowCarrierStatusValue;
  rateCount: number;
  durationMs?: number;
  error?: string;
  // PS-271 (Layer 4): this carrier answered, but with a KNOWN-THIN set — Shipp's observed-set retry
  // (Layer 1) accepted a partial at the cap (a non-empty 200 still missing an observed-expected
  // carrier). The carrier reached a terminal result, so it is NOT 'loading'/'error', but a best rate
  // sourced from a thin pass is unproven: isBestRateComplete treats a thin carrier as not-complete so
  // the row honestly shows thin/unproven instead of a false COMPLETE. Additive + display-only; absent
  // today and for every full (non-thin) pass.
  thin?: boolean;
};

export type BestRateWorkflowAllowedActions = {
  canUseSavedRate: boolean;
  requiresRerate: boolean;
  canCreateLabel: boolean;
  // PS-173 (Phase 1): row-level action verbs — present ONLY when the route passed
  // row context to withOrderRowWorkflow (legacy callers' output is byte-identical).
  canRate?: boolean;
  canBrowseRates?: boolean;
  canRecalculate?: boolean;
  canQueueLabel?: boolean;
  canMarkExternalShipped?: boolean;
  // PS-301: the card's named verbs on top of the PS-173 booleans. Present ONLY when
  // the route enriched the DTO via withOrderRowWorkflow (additive; absent for legacy
  // callers). canEditPackage/canSelectRow are awaiting-only, which REINFORCES the
  // shipped/cancelled lock (shipped/cancelled rows report not-selectable/not-editable).
  canApplyBestRate?: boolean;
  canPrintToQueue?: boolean;
  canEditPackage?: boolean;
  canSelectRow?: boolean;
};

// PS-173 (Phase 1) — the backend-owned ROW workflow state. A superset of the rate
// lifecycle: rate-centric states for awaiting rows (pending/final/stale_rate/
// missing_rate/needs_dims/blocked) + shipped-row states (external_shipped/
// local_shipped/missing_shipment_sync) so later phases can classify every row from
// ONE object (extend-never-parallel: this lives on BestRateWorkflowDto, not a
// second workflow object). Additive: only present when row context is provided.
export type OrderRowWorkflowState =
  | 'pending'
  | 'final'
  | 'blocked'
  | 'needs_dims'
  | 'stale_rate'
  | 'missing_rate'
  | 'external_shipped'
  | 'local_shipped'
  | 'missing_shipment_sync';

// PS-173 / PS-165b — the backend-owned carrier/service/account DISPLAY tuple. The
// precedence mirrors the FE's resolveDisplayCarrierCode/resolveDisplayServiceCode
// (PS-079/PS-165 rules) so the FE can prefer this tuple verbatim with zero display
// change: awaiting rows are best-rate-first; shipped rows canonical-first; test
// orders pin the test carrier.
export type OrderRowWorkflowDisplay = {
  carrierCode: string | null;
  serviceCode: string | null;
  accountNickname: string | null;
  providerAccountId: number | null;
};

// PS-177 (Phase 5): backend-owned row MONEY display — computed by the pure
// rate-money module from the same canonical picks the shipping model uses.
import {
  buildOrderRowMoneyDisplay,
  buildOrderRowMarketplace,
  type MarkupRule,
  type MarketplaceFeeRule,
  type OrderRowMoneyDisplay,
  type OrderRowMarketplaceDisplay,
} from './rate-money';

export type { OrderRowMoneyDisplay };

// PS-301 — the named state-axis contract. Axes + the named action policy live in
// small pure modules; this DTO is their single consumer (extend-never-parallel).
import type {
  OrderRowLifecycleState,
  OrderRowRateState,
  OrderRowLabelState,
  OrderRowQueueState,
  OrderRowPackageState,
  OrderRowBlockedReasons,
} from './order-row-states';
import {
  deriveOrderRowLifecycleState,
  deriveOrderRowRateState,
  deriveOrderRowLabelState,
  deriveOrderRowQueueState,
  deriveOrderRowPackageState,
} from './order-row-state-axes';
import { deriveOrderRowNamedActions, deriveOrderRowBlockedReasons } from './order-row-allowed-actions';
// Awaiting best-rate DISPLAY-freshness window (separate from the 24h purchase TTL). A saved rate older
// than this is still purchasable but "due for a re-check" so the table can detect carrier price drift.
import { RATE_DISPLAY_FRESH_MS } from '../rate-display-freshness';

export type {
  OrderRowLifecycleState,
  OrderRowRateState,
  OrderRowLabelState,
  OrderRowQueueState,
  OrderRowPackageState,
  OrderRowBlockedReasons,
} from './order-row-states';

export type BestRateSelectedRateState = 'matches_best_rate' | 'mismatched_best_rate' | 'missing' | 'unknown';

const BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response';

// PS-196 — DISPLAY-ONLY classification of the saved best rate, deliberately separate from the
// purchase authority (allowedActions + the selected-rate proof asserts, which are unchanged):
//   'fresh'          proven + current → display AND purchase-authorized (canCreateLabel)
//   'stale'          proven but expired / fingerprint-mismatched → display as saved/stale; re-rate to buy
//   'saved_unproven' legacy saved rate: positive amount + carrier/service identity but missing the
//                    newer proof metadata (requestFingerprint/isComplete/cacheExpiresAt) → display
//                    as saved; NEVER purchase-authorized until re-rated with current proof
//   'none'           nothing displayable (no saved rate, or no usable display identity)
export type BestRateSavedRateDisplay = 'fresh' | 'stale' | 'saved_unproven' | 'none';

export type BestRateWorkflowDto = {
  bestRateState: BestRateWorkflowState;
  requestFingerprint: string | null;
  backendRequestKey: string | null;
  sourceConfidence: BestRateWorkflowSourceConfidence;
  carrierStatuses: BestRateWorkflowCarrierStatus[];
  selectedRateState?: BestRateSelectedRateState;
  allowedActions: BestRateWorkflowAllowedActions;
  // PS-120: age (ms) of a backend-owned in-progress state (pending/rating). Only present when
  // the orders payload OVERRODE bestRateState to pending/rating from the order_rate_jobs row.
  // The FE classifier uses it as a WATCHDOG so a stuck job can never be an infinite spinner.
  bestRateStateAgeMs?: number;
  // PS-196: display-only saved-rate verdict (see BestRateSavedRateDisplay). The FE renders the
  // saved rate immediately on reload when this is fresh/stale/saved_unproven; purchase authority
  // is UNCHANGED (allowedActions + backend proof asserts still require a current fresh rate).
  savedRateDisplay: BestRateSavedRateDisplay;
  // PS-299: backend-owned final-display verdict. Awaiting UI may show a
  // dollar amount only when this is true.
  canDisplayFinalRate: boolean;
  // PS-300: display and purchase are separate backend-owned decisions. A stale
  // exact saved rate may remain visible while a checker runs, but purchase stays
  // blocked until the saved proof is fresh/current/complete.
  canUseDisplayedRateForPurchase: boolean;
  // Awaiting best-rate DISPLAY-freshness: TRUE when a displayable saved rate for the CURRENT request
  // is older than the display window (RATE_DISPLAY_FRESH_MS) — i.e. still purchasable but "due for a
  // re-check" so the table can detect carrier price drift. The FE consumes this to re-quote the row
  // LIVE instead of silently rendering a stale cache; it never recomputes the threshold itself.
  // Independent of the 24h purchase TTL (fresh/stale): a 'fresh' row can still need a display refresh.
  needsDisplayRefresh: boolean;
  activeRateCheckState: 'none' | 'pending' | 'rating';
  activeRateCheckAgeMs?: number;
  // PS-173 (Phase 1): backend-owned row state + display tuple — present ONLY when the
  // route enriched the DTO with row context via withOrderRowWorkflow (additive).
  rowState?: OrderRowWorkflowState;
  display?: OrderRowWorkflowDisplay;
  // PS-176 (Phase 4): backend-owned queue ROUTING policy — which path a
  // queue/label intent takes ('backend' Render job vs 'direct-create' Vercel
  // direct-carrier purchase). The FE's never-buy safety ladder (existing label,
  // test order, operator options) still runs LIVE before consulting this, so a
  // stale list-time value can never cause a re-buy.
  queueRoute?: 'backend' | 'direct-create';
  // PS-301: the named state-axis contract + per-verb blocked reasons — present ONLY
  // when enriched via withOrderRowWorkflow (additive; absent for legacy callers). The
  // FE renders/gates from these instead of reconstructing shippability decisions.
  lifecycleState?: OrderRowLifecycleState;
  rateState?: OrderRowRateState;
  labelState?: OrderRowLabelState;
  queueState?: OrderRowQueueState;
  packageState?: OrderRowPackageState;
  blockedReasons?: OrderRowBlockedReasons;
  // PS-177 (Phase 5): backend-owned row MONEY display (base/marked/markup/
  // insurance/margin) — present only when the route passed money facts AND the
  // viewer can see financials. Display-only: purchase amounts still come from
  // the proof-backed selected rate at label time, never from this tuple.
  money?: OrderRowMoneyDisplay | null;
  // PS-239: marketplace fee + profit (subtotal − fee − best-rate-incl-markup).
  // Same canViewFinancials gate as `money`; computed independently of the rate so
  // the fee shows pre-rating (profit stays null until a marked rate exists).
  marketplace?: OrderRowMarketplaceDisplay | null;
};

export type BuildBestRateWorkflowInput = {
  currentRequestFingerprint?: string | null;
  backendRequestKey?: string | null;
  savedBestRate?: unknown | null;
  selectedRateState?: BestRateSelectedRateState;
  source?: 'live' | 'cache' | 'saved_override' | 'none' | null;
  carrierStatuses?: BestRateWorkflowCarrierStatus[];
  now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function amountIsPositive(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  const amount = finiteNumberOrNull(rate.amount);
  if (amount != null) return amount > 0;
  const shipmentCost = finiteNumberOrNull(rate.shipmentCost) ?? finiteNumberOrNull(rate.cost) ?? 0;
  const otherCost = finiteNumberOrNull(rate.otherCost) ?? 0;
  if (shipmentCost + otherCost > 0) return true;
  const shippingAmount = isRecord(rate.shipping_amount)
    ? finiteNumberOrNull(rate.shipping_amount.amount)
    : null;
  const rawOtherAmount = isRecord(rate.other_amount)
    ? finiteNumberOrNull(rate.other_amount.amount)
    : null;
  const confirmationAmount = isRecord(rate.confirmation_amount)
    ? finiteNumberOrNull(rate.confirmation_amount.amount)
    : null;
  const insuranceAmount = isRecord(rate.insurance_amount)
    ? finiteNumberOrNull(rate.insurance_amount.amount)
    : null;
  return (shippingAmount ?? 0) + (rawOtherAmount ?? 0) + (confirmationAmount ?? 0) + (insuranceAmount ?? 0) > 0;
}

function savedRateFingerprint(rate: Record<string, unknown> | null): string | null {
  if (!rate) return null;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  const raw = isRecord(rate.raw) ? rate.raw : null;
  return (
    stringOrNull(rate.requestFingerprint) ??
    stringOrNull(rate.rateRequestFingerprint) ??
    stringOrNull(rate.cacheKey) ??
    stringOrNull(metadata?.requestFingerprint) ??
    stringOrNull(metadata?.cacheKey) ??
    stringOrNull(raw?.requestFingerprint) ??
    stringOrNull(raw?.cacheKey)
  );
}

function savedRateIsComplete(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  if (rate.isComplete === true) return true;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  return metadata?.isComplete === true;
}

function savedRateExpiresAt(rate: Record<string, unknown> | null): string | null {
  if (!rate) return null;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  return stringOrNull(rate.cacheExpiresAt) ?? stringOrNull(metadata?.cacheExpiresAt);
}

// The saved rate's FETCH time (when the carrier price was actually quoted), used for the display-
// freshness verdict. cacheCreatedAt is stamped == fetchedAt by both rates.ts and the backfill, so it
// is the true age of the PRICE (unlike order_overrides.bestRateAt, which a cache-hit re-stamps to now).
function savedRateCreatedAt(rate: Record<string, unknown> | null): string | null {
  if (!rate) return null;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  return stringOrNull(rate.cacheCreatedAt) ?? stringOrNull(metadata?.cacheCreatedAt);
}

function savedRateHasBackendIssuedProof(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  const metadata = isRecord(rate.metadata) ? rate.metadata : null;
  const raw = isRecord(rate.raw) ? rate.raw : null;
  return (
    stringOrNull(rate.proofSource) === BACKEND_RATE_PROOF_SOURCE ||
    stringOrNull(metadata?.proofSource) === BACKEND_RATE_PROOF_SOURCE ||
    stringOrNull(raw?.proofSource) === BACKEND_RATE_PROOF_SOURCE
  );
}

function isFreshAt(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > now.getTime();
}

/**
 * PS-111 — canonical owner of "is the best rate COMPLETE?" A best rate is complete
 * only when every eligible carrier reached a TERMINAL result (live / cached / empty
 * /unavailable / blocked) — never while a carrier is still `loading`, and never when
 * a carrier `error`ed. The backend stamps this onto the saved/returned best rate so
 * the frontend consumes it instead of asserting completeness itself. Empty input is
 * NOT complete (nothing was actually rated yet).
 *
 * PS-271 (Layer 4) — a carrier flagged `thin` (Shipp's observed-set retry accepted a
 * partial at the cap: a non-empty 200 still missing an observed-expected carrier) is
 * ALSO not-complete here. It reached a terminal status, but a best sourced from a
 * known-thin pass is unproven, so completeness flows through the thin signal the same
 * way it flows through loading/error — the row honestly shows thin/unproven instead
 * of a false COMPLETE. Default-inert: no status is ever `thin` unless Layer 1 ran.
 */
export function isBestRateComplete(
  carrierStatuses: ReadonlyArray<Pick<BestRateWorkflowCarrierStatus, 'status' | 'thin'>> | null | undefined,
): boolean {
  if (!Array.isArray(carrierStatuses) || carrierStatuses.length === 0) return false;
  return carrierStatuses.every(
    (status) =>
      status.status !== 'loading' &&
      status.status !== 'error' &&
      status.status !== 'uncached' &&
      status.status !== 'unknown' &&
      status.thin !== true,
  );
}

function sanitizeCarrierStatus(status: BestRateWorkflowCarrierStatus): BestRateWorkflowCarrierStatus {
  const safeStatus: BestRateWorkflowCarrierStatusValue =
    status.status === 'live' ||
    status.status === 'cached' ||
    status.status === 'unavailable' ||
    status.status === 'loading' ||
    status.status === 'error' ||
    status.status === 'blocked' ||
    status.status === 'unknown' ||
    status.status === 'uncached'
      ? status.status
      : 'unknown';
  const rateCount = Number.isFinite(status.rateCount) ? Math.max(0, Math.trunc(status.rateCount)) : 0;
  const durationMs = Number.isFinite(status.durationMs) ? Math.max(0, Math.round(status.durationMs!)) : undefined;
  const error = stringOrNull(status.error);
  return {
    carrierId: String(status.carrierId ?? '').trim(),
    carrierName: status.carrierName ?? null,
    carrierCode: status.carrierCode ?? null,
    nickname: status.nickname ?? null,
    status: safeStatus,
    rateCount,
    ...(durationMs != null ? { durationMs } : {}),
    ...(error ? { error: error.slice(0, 160) } : {}),
    // PS-271 (Layer 4): preserve the thin flag through sanitization (additive; absent unless set).
    ...(status.thin === true ? { thin: true } : {}),
  };
}

function sourceConfidenceFor(input: {
  state: BestRateWorkflowState;
  source: BuildBestRateWorkflowInput['source'];
}): BestRateWorkflowSourceConfidence {
  if (input.state === 'missing') return 'none';
  if (input.state === 'partial_carrier_failure') return 'partial';
  if (input.state === 'blocked') return input.source === 'none' ? 'none' : 'partial';
  if (input.state === 'stale') return 'cache_stale';
  if (input.state === 'fresh') {
    if (input.source === 'live') return 'live';
    if (input.source === 'cache') return 'cache_fresh';
    return 'saved_override';
  }
  if (input.state === 'mismatched_request') {
    return input.source === 'cache' ? 'cache_stale' : 'saved_override';
  }
  return input.source === 'cache' ? 'cache_stale' : input.source === 'live' ? 'live' : 'none';
}

function actionsFor(state: BestRateWorkflowState): BestRateWorkflowAllowedActions {
  const canUseSavedRate = state === 'fresh';
  return {
    canUseSavedRate,
    requiresRerate: state !== 'fresh',
    canCreateLabel: canUseSavedRate,
  };
}

// PS-196 — does the saved rate carry enough identity to RENDER (amount + carrier/service/account)?
// Tolerant of both the camelCase v2 shape and snake_case provider fields, matching what
// rates-backfill persists into order_overrides.best_rate_json across eras.
function savedRateHasDisplayIdentity(rate: Record<string, unknown> | null): boolean {
  if (!rate) return false;
  return Boolean(
    stringOrNull(rate.serviceCode) ??
      stringOrNull(rate.service_code) ??
      stringOrNull(rate.carrierCode) ??
      stringOrNull(rate.carrier_code) ??
      stringOrNull(rate.carrierNickname) ??
      stringOrNull(rate.carrier_nickname) ??
      stringOrNull(rate.providerAccountNickname) ??
      stringOrNull(rate.serviceName) ??
      stringOrNull(rate.service_type),
  );
}

/**
 * PS-196 — DISPLAY-ONLY verdict for the saved rate, decoupled from purchase authority.
 * 'fresh' mirrors the proven+current state; 'stale' = proven-but-expired/mismatched (display the
 * saved value, re-rate to buy); 'saved_unproven' = a legacy saved rate with a positive amount and
 * display identity but missing the newer proof metadata — display it instead of a spinner, but it
 * is NEVER purchase-authorized (allowedActions/proof asserts unchanged).
 */
function savedRateDisplayFor(
  state: BestRateWorkflowState,
  savedRate: Record<string, unknown> | null,
  hasSavedRate: boolean,
): BestRateSavedRateDisplay {
  if (!hasSavedRate || !savedRateHasDisplayIdentity(savedRate)) return 'none';
  if (state === 'fresh') return 'fresh';
  if (state === 'stale') return 'stale';
  // 'unknown' is the legacy bucket: saved amount + identity, but no fingerprint/isComplete/expiry.
  // missing/blocked have no saved rate (hasSavedRate=false) — unreachable here; pending/rating are
  // reader-side overrides applied AFTER this builder runs.
  return 'none';
}

// ── PS-173 (Phase 1): row-context enrichment ─────────────────────────────────

export type OrderRowWorkflowFacts = {
  orderStatus: string | null;
  externallyShipped: boolean | null;
  canonicalStatus: string | null;
  isTest: boolean;
  hasCompleteDims: boolean;
  hasWeight: boolean;
  hasShipment: boolean;
  // PS-176: queue-routing facts — an existing queueable label and a
  // direct-carrier selection (synthetic 10M+ provider id) decide the path.
  hasQueueableLabel: boolean;
  isDirectCarrierSelection: boolean;
  // PS-165b inputs — the SAME canonical picks + best-rate identity the row payload
  // already computed; the tuple is derived here so the precedence has ONE owner.
  bestRateCarrierCode: string | null;
  bestRateServiceCode: string | null;
  canonicalCarrierCode: string | null;
  canonicalServiceCode: string | null;
  canonicalAccountNickname: string | null;
  selectedRateCarrierCode: string | null;
  providerAccountId: number | null;
  // PS-301: OPTIONAL granular label/package facts for the named state axes. Absent for
  // callers that don't provide them; the derivers degrade to the safest value, so
  // existing callers emit byte-identical lifecycle/rate/queue axes without them.
  labelQueued?: boolean;
  labelPrinted?: boolean;
  labelDuplicateRisk?: boolean;
  hasLabelUrl?: boolean;
  packageSource?: string | null;
  packageStaleRateImpact?: boolean;
  // PS-177 (Phase 5): OPTIONAL money facts — when present (and canViewFinancials),
  // the DTO carries the backend-owned money tuple. Optional so existing callers
  // (guards, earlier routes) compile and emit byte-identical output unchanged.
  money?: {
    canViewFinancials: boolean;
    bestRateBaseAmount: number | null;
    selectedRateBaseAmount: number | null;
    labelFinalCost: number | null;
    markupRule: MarkupRule | null;
    // PS-798 (slice 2b): the canonical (per-account override -> per-client default) markup; supersedes
    // markupRule in the row money tuple so the Best Rate column matches the invoice. Pass-through only.
    markupRuleCanonical?: { pct: number; flat: number } | null;
    insuranceAddOn: number | null;
    // PS-220 (slice 4b): the SHIPP house customer_rate for this row (projected for
    // awaiting, realized for shipped). Present => the money tuple's house branch
    // fires (marked = customer_rate, base = SHIPP drp_cost, carrier markup suppressed).
    houseMarkedAmount?: number | null;
    // PS-239: marketplace-fee facts (display-only, redacted with the rest of money).
    productSubtotal?: number | null;
    marketplaceFeeRule?: MarketplaceFeeRule | null;
  };
};

const ROW_TEST_CARRIER_CODE = 'prepship_test';

/**
 * PS-173 — the row workflow state. Shipped/cancelled classification first (it
 * trumps any rate state), then dims, then the rate lifecycle the base DTO
 * already classified. Pure.
 */
function rowStateFor(facts: OrderRowWorkflowFacts, bestRateState: BestRateWorkflowState): OrderRowWorkflowState {
  if (facts.orderStatus === 'cancelled' || facts.canonicalStatus === 'cancelled') return 'blocked';
  if (facts.externallyShipped === true) return 'external_shipped';
  if (facts.orderStatus === 'shipped') {
    return facts.hasShipment ? 'local_shipped' : 'missing_shipment_sync';
  }
  if (!facts.hasCompleteDims || !facts.hasWeight) return 'needs_dims';
  switch (bestRateState) {
    case 'fresh':
      return 'final';
    case 'pending':
    case 'rating':
      return 'pending';
    case 'missing':
      return 'missing_rate';
    case 'blocked':
      return 'blocked';
    // stale / mismatched_request / partial_carrier_failure / unknown: a saved value
    // may display (PS-196), but acting on it requires a re-rate.
    default:
      return 'stale_rate';
  }
}

/**
 * PS-173 — row action verbs. Strictly NARROWER than or equal to today's behavior:
 * canCreateLabel keeps its existing fresh-only meaning and additionally requires an
 * actionable row; canQueueLabel covers BOTH create-and-queue (awaiting, final) and
 * queue-the-existing-label (local_shipped reprint recovery — never new postage,
 * which createLabelV2's shipped block enforces independently).
 */
function rowActionsFor(state: OrderRowWorkflowState, base: BestRateWorkflowAllowedActions): BestRateWorkflowAllowedActions {
  const awaitingActionable = state === 'final' || state === 'stale_rate' || state === 'missing_rate' || state === 'pending';
  const canRate = awaitingActionable;
  const canBrowseRates = awaitingActionable || state === 'needs_dims';
  const canRecalculate = awaitingActionable;
  const canCreateLabel = base.canCreateLabel && state === 'final';
  const canQueueLabel = canCreateLabel || state === 'local_shipped';
  const canMarkExternalShipped = awaitingActionable || state === 'needs_dims';
  return {
    ...base,
    canCreateLabel,
    canRate,
    canBrowseRates,
    canRecalculate,
    canQueueLabel,
    canMarkExternalShipped,
  };
}

/**
 * PS-165b — the backend display tuple, byte-compatible with the FE's
 * resolveDisplayCarrierCode/resolveDisplayServiceCode precedence (PS-079 rules):
 * test → prepship_test; awaiting → best-rate-first; shipped/other → canonical-first.
 */
function displayTupleFor(facts: OrderRowWorkflowFacts): OrderRowWorkflowDisplay {
  const isAwaiting = facts.orderStatus === 'awaiting_shipment';
  const carrierCode = facts.isTest
    ? ROW_TEST_CARRIER_CODE
    : isAwaiting
      ? facts.bestRateCarrierCode ?? facts.canonicalCarrierCode ?? facts.selectedRateCarrierCode
      : facts.canonicalCarrierCode ?? facts.selectedRateCarrierCode ?? facts.bestRateCarrierCode;
  const serviceCode = isAwaiting && facts.bestRateServiceCode
    ? facts.bestRateServiceCode
    : facts.canonicalServiceCode ?? facts.bestRateServiceCode;
  return {
    carrierCode: carrierCode ?? null,
    serviceCode: serviceCode ?? null,
    accountNickname: facts.canonicalAccountNickname ?? null,
    providerAccountId: facts.providerAccountId ?? null,
  };
}

/**
 * PS-176 — the queue ROUTING policy: which path a queue/label intent takes.
 * Mirrors the FE classifyQueueOrderRoute base ladder (test/existing-label →
 * backend; direct-carrier needing a label → the Vercel direct purchase path;
 * everything else → the backend job). The FE's LIVE never-buy overrides
 * (operator options, fresh label facts) still run before this value is used.
 */
function queueRouteFor(facts: OrderRowWorkflowFacts): 'backend' | 'direct-create' {
  if (facts.isTest) return 'backend';
  if (facts.hasQueueableLabel) return 'backend';
  if (facts.isDirectCarrierSelection) return 'direct-create';
  return 'backend';
}

/**
 * PS-173 (Phase 1) — enrich an already-built workflow DTO with the backend-owned
 * row state, action verbs, and display tuple. ADDITIVE BY CONSTRUCTION: callers
 * that never invoke this (e.g. /rates/browse) produce byte-identical output to
 * before PS-173, and the base fields (bestRateState, savedRateDisplay, the three
 * original allowedActions semantics) are never weakened — canCreateLabel can only
 * get NARROWER here. Apply AFTER the PS-120 pending/rating override so the row
 * state reflects the operator-visible rate state.
 */
export function withOrderRowWorkflow(dto: BestRateWorkflowDto, facts: OrderRowWorkflowFacts): BestRateWorkflowDto {
  const rowState = rowStateFor(facts, dto.bestRateState);
  // PS-301 — the named state axes + action policy, derived from the SAME facts/rowState
  // the DTO already classified (no new heuristics). Read-model only.
  const lifecycleState = deriveOrderRowLifecycleState(facts);
  const rateState = deriveOrderRowRateState(facts, dto.bestRateState);
  const labelState = deriveOrderRowLabelState(facts);
  const queueState = deriveOrderRowQueueState(facts, rowState);
  const packageState = deriveOrderRowPackageState(facts);
  const baseActions = rowActionsFor(rowState, dto.allowedActions);
  const named = deriveOrderRowNamedActions(rowState, lifecycleState, baseActions);
  const allowedActions: BestRateWorkflowAllowedActions = { ...baseActions, ...named };
  const blockedReasons = deriveOrderRowBlockedReasons(
    {
      browseRates: allowedActions.canBrowseRates === true,
      recalculate: allowedActions.canRecalculate === true,
      applyBestRate: named.canApplyBestRate,
      createLabel: allowedActions.canCreateLabel === true,
      printToQueue: named.canPrintToQueue,
      markExternalShipped: allowedActions.canMarkExternalShipped === true,
      editPackage: named.canEditPackage,
      selectRow: named.canSelectRow,
    },
    { lifecycle: lifecycleState, rateState, labelState },
  );
  // PS-177 money + PS-239 marketplace: only when the route provided facts;
  // redacted (non-financial) viewers get null for both. Marketplace rides a
  // SEPARATE field so the existing money tuple + its FE getter are untouched.
  let moneyPatch: Partial<BestRateWorkflowDto> = {};
  if (facts.money) {
    const money = facts.money.canViewFinancials
      ? buildOrderRowMoneyDisplay({
          isAwaiting: facts.orderStatus === 'awaiting_shipment',
          bestRateBaseAmount: facts.money.bestRateBaseAmount,
          selectedRateBaseAmount: facts.money.selectedRateBaseAmount,
          labelFinalCost: facts.money.labelFinalCost,
          markupRule: facts.money.markupRule,
          markupRuleCanonical: facts.money.markupRuleCanonical,
          insuranceAddOn: facts.money.insuranceAddOn,
          houseMarkedAmount: facts.money.houseMarkedAmount ?? null,
        })
      : null;
    const marketplace = facts.money.canViewFinancials
      ? buildOrderRowMarketplace({
          productSubtotal: facts.money.productSubtotal ?? null,
          marketplaceFeeRule: facts.money.marketplaceFeeRule ?? null,
          markedAmount: money?.markedAmount ?? null,
        })
      : null;
    moneyPatch = { money, marketplace };
  }
  return {
    ...dto,
    rowState,
    lifecycleState,
    rateState,
    labelState,
    queueState,
    packageState,
    allowedActions,
    blockedReasons,
    display: displayTupleFor(facts),
    queueRoute: queueRouteFor(facts),
    ...moneyPatch,
  };
}

export function buildBestRateWorkflowDto(input: BuildBestRateWorkflowInput): BestRateWorkflowDto {
  const now = input.now ?? new Date();
  const savedRate = isRecord(input.savedBestRate) ? input.savedBestRate : null;
  const savedFingerprint = savedRateFingerprint(savedRate);
  const currentFingerprint = stringOrNull(input.currentRequestFingerprint) ?? savedFingerprint;
  const backendRequestKey = stringOrNull(input.backendRequestKey) ?? currentFingerprint;
  const carrierStatuses = (input.carrierStatuses ?? [])
    .map(sanitizeCarrierStatus)
    .filter((status) => status.carrierId);
  const hasCarrierFailure = carrierStatuses.some(
    (status) => status.status === 'error' || status.status === 'blocked',
  );
  // PS-271 (Layer 4) — reconcile the thin-source signal with the PS-111 completeness owner at the
  // WORKFLOW DTO too (not only in rates-combined). A carrier flagged `thin` (Shipp's observed-set
  // retry accepted a non-empty-but-thin partial at the cap) reached a TERMINAL status, but a best
  // sourced from a thin pass is unproven — so it must NOT resolve to `fresh`, exactly like a
  // still-loading/errored carrier blocks completeness in isBestRateComplete. We treat a live thin
  // carrier as a partial-completeness signal: it demotes `fresh` to `partial_carrier_failure`
  // (re-rate required, saved value may still display via PS-196). Scoped to `thin === true` ONLY
  // (NOT general !isBestRateComplete, which is false for the common EMPTY/loading carrier set and
  // would wrongly demote saved-rate-only DTOs) — default-inert: `status.thin` is never set unless
  // Layer 1 ran, so today's full/empty passes are byte-identical.
  const hasThinCarrier = carrierStatuses.some((status) => status.thin === true);
  const hasIncompleteCarrierCoverage =
    carrierStatuses.length > 0 && !isBestRateComplete(carrierStatuses);
  const hasSavedRate = amountIsPositive(savedRate);
  const matchesRequest =
    Boolean(currentFingerprint && savedFingerprint && currentFingerprint === savedFingerprint) ||
    Boolean(savedFingerprint && !input.currentRequestFingerprint);
  const complete = savedRateIsComplete(savedRate);
  const fresh = isFreshAt(savedRateExpiresAt(savedRate), now);
  // DISPLAY-freshness: a saved rate for the SAME request that has aged past the display window is
  // "due for a re-check" (carrier price may have drifted within the 24h purchase TTL). Scoped to
  // matchesRequest so a mismatched/missing row — already a re-rate by the states below — is untouched.
  const savedCreatedAt = savedRateCreatedAt(savedRate);
  const savedAgeMs = savedCreatedAt ? now.getTime() - Date.parse(savedCreatedAt) : null;
  const needsDisplayRefresh =
    hasSavedRate &&
    matchesRequest &&
    savedAgeMs != null &&
    Number.isFinite(savedAgeMs) &&
    savedAgeMs > RATE_DISPLAY_FRESH_MS;
  const hasDisplayIdentity = savedRateHasDisplayIdentity(savedRate);
  const hasBackendIssuedProof = savedRateHasBackendIssuedProof(savedRate);

  let bestRateState: BestRateWorkflowState;
  if (!hasSavedRate) {
    bestRateState = hasCarrierFailure ? 'blocked' : 'missing';
  } else if (currentFingerprint && savedFingerprint && currentFingerprint !== savedFingerprint) {
    bestRateState = 'mismatched_request';
  } else if (hasCarrierFailure || hasThinCarrier || hasIncompleteCarrierCoverage) {
    // PS-271 (Layer 4): a thin carrier is treated exactly like a failed carrier here — the saved
    // best is unproven, so the row shows partial (re-rate required) instead of a false `fresh`.
    bestRateState = 'partial_carrier_failure';
  } else if (matchesRequest && complete && fresh) {
    bestRateState = 'fresh';
  } else if (matchesRequest && complete && !fresh) {
    bestRateState = 'stale';
  } else {
    bestRateState = 'unknown';
  }

  const hasCompleteCarrierCoverage =
    !hasCarrierFailure && !hasThinCarrier && !hasIncompleteCarrierCoverage;
  const canDisplayFinalRate =
    hasSavedRate &&
    hasDisplayIdentity &&
    hasBackendIssuedProof &&
    matchesRequest &&
    complete &&
    hasCompleteCarrierCoverage &&
    (bestRateState === 'fresh' || bestRateState === 'stale');
  const canUseDisplayedRateForPurchase =
    canDisplayFinalRate && fresh && bestRateState === 'fresh';
  const allowedActions = actionsFor(bestRateState);
  allowedActions.canUseSavedRate = canUseDisplayedRateForPurchase;
  allowedActions.canCreateLabel = canUseDisplayedRateForPurchase;
  allowedActions.requiresRerate = !canUseDisplayedRateForPurchase;

  return {
    bestRateState,
    requestFingerprint: currentFingerprint,
    backendRequestKey,
    sourceConfidence: sourceConfidenceFor({ state: bestRateState, source: input.source ?? null }),
    carrierStatuses,
    ...(input.selectedRateState ? { selectedRateState: input.selectedRateState } : {}),
    allowedActions,
    savedRateDisplay: savedRateDisplayFor(bestRateState, savedRate, hasSavedRate),
    canDisplayFinalRate,
    canUseDisplayedRateForPurchase,
    needsDisplayRefresh,
    activeRateCheckState: 'none',
  };
}
