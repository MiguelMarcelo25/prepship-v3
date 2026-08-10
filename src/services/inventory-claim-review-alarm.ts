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
 * How much worse than the baseline an acknowledged path must get before it alerts.
 * 1.5 = half again as many review claims per shipped event as expected.
 *
 * NOTE: this rule is retained only for the classes it can still decide. It CANNOT decide a
 * saturated path: an event-level ratio cannot exceed 1.0, so 1.5x a 1.0 baseline is
 * unreachable. Acknowledged sources are judged by the committed-baseline EWMA and absolute
 * severity in `inventory-claim-alarm-detector.mjs` instead.
 */
export const OPEN_INCIDENT_WORSENING_FACTOR = 1.5;

export type ClaimSourcePolicy = {
  class: ClaimSourceClass;
  /**
   * COMMITTED reference ratio for an acknowledged path. Deliberately a constant, not a
   * trailing measurement: a moving baseline follows a slow leak upward and never trips, and
   * learning it from live data on first run would bless an active outage as normal.
   *
   * A future non-saturated acknowledged source must have this calculated from cited
   * completed-window evidence and committed WITH a `baselineVersion`, so the number changes
   * only in review.
   */
  baselineRatio?: number;
  /** True when the ratio is at the ceiling and only absolute severity can detect worsening. */
  saturated?: boolean;
  baselineVersion?: string;
};

/**
 * The source policy table.
 *
 * `order_sync_status` and `external_shipped_classifier` are recorded at baselineRatio 1
 * because that is what production measures: 82/82 and 43/43 stranded on 2026-08-10. An
 * event-level ratio cannot exceed 1.0, so no upward ratio signal exists for them — they are
 * flagged `saturated` and detected by absolute volume, backlog growth and age instead.
 *
 * Moving a source from `open_incident` to `fixed` is the act of claiming it repaired, and it
 * flips the threshold to zero. That is intentional: the claim should be expensive.
 */
export const CLAIM_SOURCE_POLICIES: Readonly<Record<string, ClaimSourcePolicy>> = {
  shipment_sync: { class: 'fixed' },
  prepship_v2: { class: 'fixed' },
  order_sync_status: {
    class: 'open_incident',
    baselineRatio: 1,
    saturated: true,
    baselineVersion: 'ps-497-2026-08-10',
  },
  external_shipped_classifier: {
    class: 'open_incident',
    baselineRatio: 1,
    saturated: true,
    baselineVersion: 'ps-497-2026-08-10',
  },
};

/**
 * The two exported lists are DERIVED from the table above rather than written out again.
 * Two hand-maintained copies of the same classification is how a source ends up "fixed" in
 * one place and "acknowledged" in the other — and the difference between those two is a zero
 * threshold versus no threshold at all.
 */
function sourcesOfClass(target: ClaimSourceClass): readonly string[] {
  return Object.entries(CLAIM_SOURCE_POLICIES)
    .filter(([, policy]) => policy.class === target)
    .map(([source]) => source);
}

/**
 * Paths repaired on 2026-08-07. They must deduct now, so any review claim is a regression.
 * Adding a source to the table as `fixed` is a claim that it is repaired — the zero threshold
 * enforces it.
 */
export const FIXED_CLAIM_SOURCES: readonly string[] = sourcesOfClass('fixed');

/**
 * Paths knowingly still routing to review, pending DJ's policy ruling. Declared so that when
 * the ruling lands and they are repaired, moving them to `fixed` in the table flips them to a
 * zero threshold rather than leaving them permanently excused.
 */
export const OPEN_INCIDENT_CLAIM_SOURCES: readonly string[] = sourcesOfClass('open_incident');

export function classifyClaimSource(source: string): ClaimSourceClass {
  return CLAIM_SOURCE_POLICIES[source]?.class ?? 'unknown';
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
