// PS-244 Phase 4 — purchase-boundary snapshot ENFORCEMENT mode + canary.
//
// Per user override unlock shipped data on 2026-06-15.
//
// The label-purchase boundary (assertLabelPurchaseRateSelection) PREFERS the
// backend-owned rate-quote snapshot and FALLS BACK to the FE-carried proof when the
// snapshot does not resolve (snapshot_missing / snapshot_expired /
// selected_rate_not_in_snapshot / proof_invalid). Before we trust the snapshot
// enough to DROP that fallback ("strict" enforcement), we need production proof that
// a supplied snapshot ref resolves essentially every time. This module is that
// proof: it COUNTS, per outcome + reason, how often the snapshot path wins vs. falls
// back, and emits one structured `[rate-proof-canary]` line on every fallback so the
// misses are greppable in Render logs.
//
// SAFETY: this module has ZERO purchase-path side effects — it never throws, never
// writes to the DB, never touches a provider. The boundary's actual safety still
// lives entirely in the strict proof validator (assertSelectedRateProofForLabelPurchase).
// The enforcement MODE defaults to 'canary' (today's dual-path), so the deployed
// behavior is byte-identical until DJ flips RATE_PROOF_ENFORCEMENT=strict after the
// canary reads green. The flip is one env var and instantly reversible.

export type RateProofEnforcementMode = 'canary' | 'strict';

/**
 * The active enforcement mode for the snapshot purchase boundary.
 *
 * - 'canary' (DEFAULT): snapshot preferred, FE-carried proof fallback retained, every
 *   fallback instrumented. Deployed behavior is identical to before PS-244 Phase 4.
 * - 'strict': a supplied snapshot ref MUST resolve; no silent fallback to the FE
 *   proof. Flip here ONLY after the canary proves the snapshot resolves ~always.
 *
 * Anything other than the literal 'strict' resolves to 'canary' — the safe default.
 */
export function rateProofEnforcementMode(): RateProofEnforcementMode {
  return process.env.RATE_PROOF_ENFORCEMENT === 'strict' ? 'strict' : 'canary';
}

export type RateProofCanaryOutcome =
  // a snapshot ref was supplied AND resolved server-side (the path we want to trust)
  | 'snapshot_enforced'
  // a snapshot ref was supplied but did NOT resolve -> this is the event a strict
  // flip would block; in canary we fall back to the FE proof and record the reason
  | 'snapshot_fallback'
  // no snapshot ref was supplied at all -> straight to the legacy carried proof
  | 'legacy_only';

type Counters = Record<string, number>;

// Process-local tally. Reset on restart — that is fine: the canary measures the rate
// of fallbacks, not a lifetime total, and /observability also reports uptime.
const counters: Counters = Object.create(null) as Counters;

function bump(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

/**
 * Record one purchase-boundary outcome. Never throws. `reason` is the resolver's
 * failure reason on a fallback (snapshot_missing / snapshot_expired /
 * selected_rate_not_in_snapshot / proof_invalid).
 */
export function recordRateProofCanary(outcome: RateProofCanaryOutcome, reason?: string): void {
  try {
    bump(`outcome:${outcome}`);
    if (reason) bump(`reason:${reason}`);
    // Log ONLY on fallback — the event a strict flip would have blocked. The happy
    // paths (snapshot_enforced / legacy_only) stay counter-only to avoid log spam on
    // every label; their totals are visible on /observability.
    if (outcome === 'snapshot_fallback') {
      const enforced = counters['outcome:snapshot_enforced'] ?? 0;
      const fallback = counters['outcome:snapshot_fallback'] ?? 0;
      console.warn(
        `[rate-proof-canary] snapshot_fallback reason=${reason ?? 'unknown'} ` +
          `mode=${rateProofEnforcementMode()} enforced=${enforced} fallback=${fallback}`,
      );
    }
  } catch {
    /* canary instrumentation must never affect a purchase */
  }
}

/** Read-only snapshot of the canary counters for the /observability surface + tests. */
export function getRateProofCanaryStats(): {
  mode: RateProofEnforcementMode;
  outcomes: Counters;
  reasons: Counters;
} {
  const outcomes: Counters = Object.create(null) as Counters;
  const reasons: Counters = Object.create(null) as Counters;
  for (const [key, value] of Object.entries(counters)) {
    if (key.startsWith('outcome:')) outcomes[key.slice('outcome:'.length)] = value;
    else if (key.startsWith('reason:')) reasons[key.slice('reason:'.length)] = value;
  }
  return { mode: rateProofEnforcementMode(), outcomes, reasons };
}

/** Test-only: clear the tally between assertions. */
export function resetRateProofCanaryStats(): void {
  for (const key of Object.keys(counters)) delete counters[key];
}
