/**
 * PS-497 — stateful trend and severity detection for stranded inventory claims.
 *
 * ── Why this module exists ────────────────────────────────────────────────────────────
 *
 * The first alarm compared each source's current ratio against its own trailing baseline and
 * paged at 1.5x. Review proved that cannot work, in two ways:
 *
 *   1. A trailing baseline FOLLOWS the leak. A simulated 5%-per-day deterioration from 0.40
 *      to 1.00 never crossed the threshold, because the baseline rose behind it.
 *   2. An event-level stranded ratio cannot exceed 1.0, and both acknowledged paths are
 *      ALREADY at 1.0 in production. A 1.5x threshold against a 1.0 baseline is
 *      mathematically unreachable — those paths could grow without bound and never alert.
 *
 * So ratio detection needs a COMMITTED reference rather than a moving one, and saturated
 * paths need absolute severity instead. Both are here.
 *
 * Pure: every function takes state and measurements and returns new state plus a verdict.
 * No clock, no database, no I/O — the watchdog owns persistence and delivery, this owns the
 * policy. That split is what lets all 24 acceptance cases run without seeding anything.
 */

/** Newest completed day carries 20% weight; the prior estimate keeps 80%. */
export const CLAIM_ALARM_EWMA_ALPHA = 0.20;
/** Sustained rise over the committed baseline that counts as gradual deterioration. */
export const CLAIM_ALARM_EWMA_DEVIATION = 0.10;
/** Gradual findings must persist this many eligible completed days before paging. */
export const CLAIM_ALARM_EWMA_CONSECUTIVE_WINDOWS = 2;
/** A single completed day this far above baseline is an abrupt regression. */
export const CLAIM_ALARM_ABRUPT_DEVIATION = 0.20;
/** Below this much work, a day's ratio is noise and must not move the estimator. */
export const CLAIM_ALARM_MIN_EVENTS_PER_WINDOW = 20;
/** At or above this baseline there is no headroom for an upward ratio signal. */
export const CLAIM_ALARM_SATURATED_BASELINE = 0.90;

/** Acknowledged-path volume in 24h that means a materially new step-up, not the known rate. */
export const OPEN_INCIDENT_VOLUME_PAGE_24H = 400;
/** Backlog growth in 24h that means the same. */
export const OPEN_INCIDENT_BACKLOG_GROWTH_PAGE_24H = 400;
/** Backlog milestones page once each, on first crossing, from 3,000 upward in 500s. */
export const CLAIM_ALARM_COUNT_MILESTONE_STEP = 500;
export const CLAIM_ALARM_COUNT_MILESTONE_FLOOR = 3000;
/** Age milestones in days: 30, 45, 60, then every 30. */
export const CLAIM_ALARM_AGE_MILESTONES = [30, 45, 60, 90, 120, 150, 180];
/** An incident stays reminder-active while any of these hold. */
export const CLAIM_ALARM_REMINDER_COUNT = 1000;
export const CLAIM_ALARM_REMINDER_AGE_DAYS = 7;
export const CLAIM_ALARM_REMINDER_NEW_EVENTS_24H = 25;
/** One reminder per day, not one per hourly run. */
export const CLAIM_ALARM_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Threshold comparisons are float sums, so `0.4 + 0.20` is `0.6000000000000001` and a day
 * that exactly REACHES the threshold would silently miss it. The spec says "reaches", so a
 * scale-aware tolerance makes the boundary mean what it says — the same trap PS-457 fixed in
 * the money rounder.
 */
const atLeast = (value, threshold) => value >= threshold - Number.EPSILON * Math.max(1, Math.abs(threshold)) * 8;

/** Empty state, so a lost state file restarts deterministically rather than silently. */
export function initialClaimAlarmState() {
  return {
    version: 1,
    perSource: {},
    lastSeveritySnapshotAt: null,
    lastReviewCount: null,
    lastIncidentReminderAt: null,
    lastCountMilestone: null,
    lastAgeMilestone: null,
  };
}

/**
 * Per-source estimator state, seeded from the COMMITTED baseline.
 *
 * Deliberately not learned from whatever production is doing on first run — that would bless
 * an active outage as normal, which is precisely how a 22-day leak stays invisible.
 */
export function initialSourceState(policy) {
  const saturated = (policy?.baselineRatio ?? 0) >= CLAIM_ALARM_SATURATED_BASELINE;
  return {
    baselineVersion: policy?.baselineVersion ?? null,
    ewma: policy?.baselineRatio ?? 0,
    consecutiveDeviationWindows: 0,
    lastProcessedWindowKey: null,
    saturated,
  };
}

/**
 * Advance one source's estimator by one COMPLETED day.
 *
 * Completed days, not rolling 24h windows: an hourly watchdog re-reading an overlapping
 * window would count almost the same events repeatedly and give the estimator an
 * unpredictable effective weight. `windowKey` (a UTC date string) makes the advance
 * idempotent — the same day seen twice advances once.
 */
export function advanceSourceEwma(state, policy, completedWindow) {
  const next = { ...state };
  const reasons = [];

  if (state.saturated) {
    return { state: next, ratioState: 'saturated', page: false, reasons };
  }
  if (completedWindow == null) {
    return { state: next, ratioState: 'no_window', page: false, reasons };
  }
  if (completedWindow.windowKey === state.lastProcessedWindowKey) {
    return { state: next, ratioState: 'already_processed', page: false, reasons };
  }
  if (completedWindow.shippedEvents < CLAIM_ALARM_MIN_EVENTS_PER_WINDOW) {
    // Preserve the estimator AND the streak: a quiet day is not evidence either way.
    return { state: next, ratioState: 'insufficient_activity', page: false, reasons };
  }

  const baseline = policy?.baselineRatio ?? 0;
  const ratio = completedWindow.shippedEvents > 0
    ? completedWindow.reviewClaims / completedWindow.shippedEvents
    : 0;

  next.lastProcessedWindowKey = completedWindow.windowKey;
  next.ewma = CLAIM_ALARM_EWMA_ALPHA * ratio + (1 - CLAIM_ALARM_EWMA_ALPHA) * state.ewma;

  // Abrupt: one completed day far above the committed reference.
  const abruptThreshold = Math.min(1, baseline + CLAIM_ALARM_ABRUPT_DEVIATION);
  if (atLeast(ratio, abruptThreshold)) {
    next.consecutiveDeviationWindows = 0;
    reasons.push({
      code: `inventory_claim.ewma_abrupt.${completedWindow.source}`,
      source: completedWindow.source,
      message: `${completedWindow.source} stranded ${ratio.toFixed(3)} of one day's work against a committed ${baseline.toFixed(3)} baseline`,
    });
    return { state: next, ratioState: 'abrupt', page: true, reasons };
  }

  // Gradual: the estimator sits above the reference for consecutive eligible days.
  if (atLeast(next.ewma, baseline + CLAIM_ALARM_EWMA_DEVIATION)) {
    next.consecutiveDeviationWindows = state.consecutiveDeviationWindows + 1;
    if (next.consecutiveDeviationWindows >= CLAIM_ALARM_EWMA_CONSECUTIVE_WINDOWS) {
      reasons.push({
        code: `inventory_claim.ewma.${completedWindow.source}`,
        source: completedWindow.source,
        message: `${completedWindow.source} has deteriorated: EWMA ${next.ewma.toFixed(3)} over a committed ${baseline.toFixed(3)} baseline for ${next.consecutiveDeviationWindows} eligible days`,
      });
      return { state: next, ratioState: 'gradual', page: true, reasons };
    }
    return { state: next, ratioState: 'deviating', page: false, reasons };
  }

  next.consecutiveDeviationWindows = 0;
  return { state: next, ratioState: 'ok', page: false, reasons };
}

/** Highest crossed milestone at or above the floor, else null. */
export function countMilestoneFor(reviewCount) {
  if (reviewCount < CLAIM_ALARM_COUNT_MILESTONE_FLOOR) return null;
  return Math.floor(reviewCount / CLAIM_ALARM_COUNT_MILESTONE_STEP) * CLAIM_ALARM_COUNT_MILESTONE_STEP;
}

/** Highest crossed age milestone, else null. */
export function ageMilestoneFor(oldestAgeDays) {
  let hit = null;
  for (const milestone of CLAIM_ALARM_AGE_MILESTONES) {
    if (oldestAgeDays >= milestone) hit = milestone;
  }
  return hit;
}

/**
 * Absolute severity — the detector that still works when a path is saturated.
 *
 * Thresholds are fixed, NOT scaled from the moving baseline: the known working-day incident
 * is ~90-110 stranded events and the Monday catch-up reaches ~294-314, so 400 sits above the
 * known pattern and below a genuine new step-up. Scaling from the baseline would let the
 * incident raise its own alarm threshold, which is the defect this replaces.
 */
export function evaluateSeverity(state, severity, nowMs) {
  const reasons = [];
  let page = false;

  if (severity.acknowledgedNewEvents24h >= OPEN_INCIDENT_VOLUME_PAGE_24H) {
    page = true;
    reasons.push({
      code: 'inventory_claim.open_volume_24h',
      message: `${severity.acknowledgedNewEvents24h} acknowledged-source stranded events in 24h, at or above the ${OPEN_INCIDENT_VOLUME_PAGE_24H} step-up threshold`,
    });
  }

  const growth = state.lastReviewCount == null ? null : severity.reviewCount - state.lastReviewCount;
  if (growth != null && growth >= OPEN_INCIDENT_BACKLOG_GROWTH_PAGE_24H) {
    page = true;
    reasons.push({
      code: 'inventory_claim.backlog_growth_24h',
      message: `backlog grew by ${growth} since the previous severity snapshot`,
    });
  }

  const countMilestone = countMilestoneFor(severity.reviewCount);
  if (countMilestone != null && (state.lastCountMilestone == null || countMilestone > state.lastCountMilestone)) {
    page = true;
    reasons.push({
      code: `inventory_claim.count_milestone.${countMilestone}`,
      message: `backlog crossed ${countMilestone} stranded claims`,
    });
  }

  const ageMilestone = ageMilestoneFor(severity.oldestAgeDays);
  if (ageMilestone != null && (state.lastAgeMilestone == null || ageMilestone > state.lastAgeMilestone)) {
    page = true;
    reasons.push({
      code: `inventory_claim.age_milestone.${ageMilestone}`,
      message: `oldest stranded claim reached ${ageMilestone} days`,
    });
  }

  const reminderActive =
    severity.reviewCount >= CLAIM_ALARM_REMINDER_COUNT ||
    severity.oldestAgeDays >= CLAIM_ALARM_REMINDER_AGE_DAYS ||
    severity.acknowledgedNewEvents24h >= CLAIM_ALARM_REMINDER_NEW_EVENTS_24H;
  const dueSince = state.lastIncidentReminderAt == null
    ? Infinity
    : nowMs - state.lastIncidentReminderAt;
  const reminderDue = reminderActive && dueSince >= CLAIM_ALARM_REMINDER_INTERVAL_MS;

  const next = {
    ...state,
    lastReviewCount: severity.reviewCount,
    lastSeveritySnapshotAt: nowMs,
    ...(countMilestone != null && (state.lastCountMilestone == null || countMilestone > state.lastCountMilestone)
      ? { lastCountMilestone: countMilestone } : {}),
    ...(ageMilestone != null && (state.lastAgeMilestone == null || ageMilestone > state.lastAgeMilestone)
      ? { lastAgeMilestone: ageMilestone } : {}),
    ...(reminderDue ? { lastIncidentReminderAt: nowMs } : {}),
  };

  return { state: next, page, reminderDue, reminderActive, reasons };
}

/**
 * The whole verdict: immediate findings, trend, and severity.
 *
 * `page` and `reminderDue` are separate on purpose. A known incident at its known rate must
 * produce one reminder a day, not a page every hour — an alarm that cries wolf hourly gets
 * muted, and then the regression it exists to catch goes unseen.
 *
 * Every outcome is restartEligible:false. No inventory-claim condition is ever fixed by
 * restarting the API.
 */
export function evaluateClaimAlarm(input) {
  const state = input.state ?? initialClaimAlarmState();
  const perSource = { ...(state.perSource ?? {}) };
  const reasons = [...(input.immediateReasons ?? [])];
  let page = reasons.length > 0;

  const ratioStates = {};
  for (const window of input.completedWindows ?? []) {
    const policy = input.policies?.[window.source];
    if (!policy || policy.class !== 'open_incident') continue;
    const current = perSource[window.source] ?? initialSourceState(policy);
    const advanced = advanceSourceEwma(current, policy, window);
    perSource[window.source] = advanced.state;
    ratioStates[window.source] = advanced.ratioState;
    if (advanced.page) page = true;
    reasons.push(...advanced.reasons);
  }

  const severity = evaluateSeverity(
    { ...state, perSource },
    input.severity,
    input.nowMs,
  );
  if (severity.page) page = true;
  reasons.push(...severity.reasons);

  const nextState = { ...severity.state, perSource };
  const state_ =
    page ? 'alarm'
    : severity.reminderDue ? 'incident_reminder'
    : severity.reminderActive ? 'open_incident'
    : 'ok';

  return {
    state: state_,
    page,
    reminderDue: severity.reminderDue,
    restartEligible: false,
    ratioStates,
    reasons,
    nextState,
  };
}
