/**
 * PS-497 — when should a stranded inventory-claim backlog page someone?
 *
 * Pure decision. No database, no clock, no environment: it takes measured counts and returns
 * a verdict, so every branch below is testable without seeding anything.
 *
 * ── Why not simply alert on `reviewLast24h` ────────────────────────────────────────────
 *
 * Because this business ships nothing at weekends. A rolling 24-hour window reads ZERO every
 * Sunday and Monday morning regardless of whether the leak is fixed, so "inflow is zero"
 * pages every weekend and "inflow is non-zero" goes quiet exactly when a real stall begins.
 * Both readings were observed: my own `reviewLast24h: 0` and Hermes' `5` were the same
 * weekend artifact, and each of us drew a conclusion from it before checking.
 *
 * So the verdict is ACTIVITY-NORMALISED. The denominator is the canonical shipped work each
 * source actually processed in the window. A weekend has no shipped work, so it reports
 * `no_activity` — not healthy, not alarming, because nothing happened and silence proves
 * nothing.
 *
 * ── Why per source ────────────────────────────────────────────────────────────────────
 *
 * The four lifecycle sources are in different states and need different rules:
 *
 *   FIXED paths (`shipment_sync`, `prepship_v2`) — these were repaired on 2026-08-07 and
 *   must now deduct. ANY review inflow here is a regression, so the threshold is zero. This
 *   is the check that would have caught the original outage on day one instead of day 22.
 *
 *   OPEN paths (`order_sync_status`, `external_shipped_classifier`) — these are a KNOWN,
 *   acknowledged incident awaiting DJ's ruling on whether an order shipping outside PrepShip
 *   should deduct PrepShip stock. Paging on every one of ~90-110 expected claims per working
 *   day would train everyone to ignore this alarm within a week. They alert only on material
 *   WORSENING against the expected ratio.
 *
 *   UNKNOWN sources — a source nobody has classified is the most dangerous case, because it
 *   is a leak in a path no one is watching. Any inflow alerts.
 */

/** A lifecycle source's measured behaviour in one settled window. */
export type ClaimSourceWindow = {
  source: string;
  /** New claims that landed in `review` from this source during the window. */
  reviewClaims: number;
  /**
   * Canonical shipped work this source processed in the same window — the denominator.
   * Zero means the source did no work, which is the weekend/holiday case.
   */
  shippedEvents: number;
};

export type ClaimSourceClass = 'fixed' | 'open_incident' | 'unknown';

export type ClaimSourceVerdict = {
  source: string;
  class: ClaimSourceClass;
  reviewClaims: number;
  shippedEvents: number;
  /** review claims per shipped event, or null when no work was processed. */
  ratio: number | null;
  alert: boolean;
  state: 'ok' | 'no_activity' | 'regression' | 'worsening' | 'unclassified_source';
  reason: string;
};

export type InventoryClaimReviewAlarmVerdict = {
  alert: boolean;
  state: 'ok' | 'no_activity' | 'alarm';
  reason: string;
  sources: ClaimSourceVerdict[];
};

/**
 * Paths repaired on 2026-08-07. They must deduct now, so any review claim is a regression.
 * Adding a source here is a claim that it is fixed — the zero threshold enforces it.
 */
export const FIXED_CLAIM_SOURCES: readonly string[] = ['shipment_sync', 'prepship_v2'];

/**
 * Paths knowingly still routing to review, pending DJ's policy ruling. Listed explicitly so
 * that when the ruling lands and they are repaired, moving them to FIXED_CLAIM_SOURCES flips
 * them to a zero threshold rather than leaving them permanently excused.
 */
export const OPEN_INCIDENT_CLAIM_SOURCES: readonly string[] = [
  'order_sync_status',
  'external_shipped_classifier',
];

/**
 * How much worse than the baseline an acknowledged path must get before it alerts.
 * 1.5 = half again as many review claims per shipped event as expected.
 */
export const OPEN_INCIDENT_WORSENING_FACTOR = 1.5;

export function classifyClaimSource(source: string): ClaimSourceClass {
  if (FIXED_CLAIM_SOURCES.includes(source)) return 'fixed';
  if (OPEN_INCIDENT_CLAIM_SOURCES.includes(source)) return 'open_incident';
  return 'unknown';
}

/**
 * Evaluate one source against its class.
 *
 * `baselineRatio` is the accepted review-claims-per-shipped-event for an acknowledged path.
 * It is supplied rather than derived so the caller owns where the baseline comes from and
 * this stays pure.
 */
export function evaluateClaimSource(
  window: ClaimSourceWindow,
  baselineRatio: number | null,
): ClaimSourceVerdict {
  const sourceClass = classifyClaimSource(window.source);
  const ratio = window.shippedEvents > 0 ? window.reviewClaims / window.shippedEvents : null;
  const base = {
    source: window.source,
    class: sourceClass,
    reviewClaims: window.reviewClaims,
    shippedEvents: window.shippedEvents,
    ratio,
  };

  // No work processed: report it plainly. Reporting "ok" here is how a weekend gets mistaken
  // for a fix, which is exactly the error both readings of `reviewLast24h` made.
  if (window.shippedEvents === 0) {
    return {
      ...base,
      alert: window.reviewClaims > 0,
      state: window.reviewClaims > 0 ? 'regression' : 'no_activity',
      reason: window.reviewClaims > 0
        ? `${window.reviewClaims} review claim(s) from ${window.source} with no shipped work in the window — claims without work is never expected`
        : `${window.source} processed no shipped work in this window; silence proves nothing`,
    };
  }

  if (sourceClass === 'fixed') {
    return {
      ...base,
      alert: window.reviewClaims > 0,
      state: window.reviewClaims > 0 ? 'regression' : 'ok',
      reason: window.reviewClaims > 0
        ? `${window.source} is a REPAIRED path and produced ${window.reviewClaims} review claim(s) — the 2026-07-16 outage has regressed`
        : `${window.source} deducted all ${window.shippedEvents} shipped event(s) without stranding a claim`,
    };
  }

  if (sourceClass === 'unknown') {
    return {
      ...base,
      alert: window.reviewClaims > 0,
      state: window.reviewClaims > 0 ? 'unclassified_source' : 'ok',
      reason: window.reviewClaims > 0
        ? `${window.source} is not a known claim source and produced ${window.reviewClaims} review claim(s) — an unwatched path is leaking`
        : `${window.source} is unclassified but produced no review claims`,
    };
  }

  // Acknowledged incident: alert only on material worsening, never on the expected rate.
  if (baselineRatio == null) {
    return {
      ...base,
      alert: false,
      state: 'ok',
      reason: `${window.source} is a known open incident with no baseline yet; ratio ${ratio!.toFixed(3)} recorded`,
    };
  }
  const threshold = baselineRatio * OPEN_INCIDENT_WORSENING_FACTOR;
  const worsening = ratio! > threshold;
  return {
    ...base,
    alert: worsening,
    state: worsening ? 'worsening' : 'ok',
    reason: worsening
      ? `${window.source} is worsening: ${ratio!.toFixed(3)} review claims per shipped event against a ${baselineRatio.toFixed(3)} baseline`
      : `${window.source} is a known open incident holding at ${ratio!.toFixed(3)} against a ${baselineRatio.toFixed(3)} baseline`,
  };
}

/** Roll per-source verdicts into the one the watchdog reads. */
export function evaluateInventoryClaimReviewAlarm(
  windows: readonly ClaimSourceWindow[],
  baselines: Readonly<Record<string, number>> = {},
): InventoryClaimReviewAlarmVerdict {
  const sources = windows.map((w) => evaluateClaimSource(w, baselines[w.source] ?? null));
  const alerting = sources.filter((s) => s.alert);
  if (alerting.length) {
    return {
      alert: true,
      state: 'alarm',
      reason: alerting.map((s) => s.reason).join('; '),
      sources,
    };
  }
  // Every source idle is NOT health. Say so, so a silent window is never read as a fix.
  if (sources.length > 0 && sources.every((s) => s.state === 'no_activity')) {
    return {
      alert: false,
      state: 'no_activity',
      reason: 'no shipped work was processed in this window; this is not evidence of health',
      sources,
    };
  }
  return {
    alert: false,
    state: 'ok',
    reason: sources.length
      ? 'every claim source is within its expected behaviour for the work it processed'
      : 'no claim sources reported',
    sources,
  };
}
