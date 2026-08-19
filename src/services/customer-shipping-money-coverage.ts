import { roundMoney } from '../lib/money.js';
import type { CustomerShippingMoneyClassKind } from './customer-shipping-money-classification.js';

/**
 * PS-508 step 1 — the coverage report's arithmetic, separated from its queries.
 *
 * ── WHY EXCLUSIONS ARE COUNTED, NOT DROPPED ─────────────────────────────────────────────
 *
 * The plan review required the excluded population be reported separately. That is not
 * presentation: a return, a replacement, a voided row, a $0 test label and a shipment with no
 * billable cost are all CORRECTLY without an outbound tuple. Folding them into "no tuple" inflates
 * the gap and makes coverage look catastrophic when it is fine — which would then be used to
 * justify a backfill over rows that must never receive one.
 *
 * ── WHY malformed AND unknown ARE TRACKED SEPARATELY FROM legacy_absent ─────────────────
 *
 * Only `legacy_absent` may take the recompute fallback after cutover. `malformed_known_version`
 * is a row we wrote and got wrong; `unknown_version` belongs to a policy this build cannot read.
 * Both must be ZERO in the activation population — a non-zero count is a stop condition, not a
 * statistic, which is why `activationBlockers` is computed rather than left for a human to notice.
 *
 * Pure: no database, no env. The IO shell supplies rows; this owns the counting.
 */

export type CoverageExclusionReason =
  | 'return'
  | 'replacement'
  | 'voided'
  | 'test_offline'
  | 'no_billable_cost';

export type CoverageRow = {
  shipmentId: number;
  clientId: number | null;
  source: string | null;
  /** Set when the row is NOT an ordinary billable outbound shipment. */
  excluded: CoverageExclusionReason | null;
  /** Classification of selected_rate_json. Only meaningful when `excluded` is null. */
  kind: CustomerShippingMoneyClassKind;
  /** The frozen customer amount, when a valid tuple exists. */
  tupleAmount: number | null;
  /**
   * What billing would compute for this row today, or null when it could not be computed.
   * A null here is itself a finding: it means the row has a tuple but no comparable recompute.
   */
  recomputeAmount: number | null;
};

export type CoverageDeltaBucket = {
  key: string;
  rows: number;
  differing: number;
  signedDollars: number;
  absoluteDollars: number;
};

export type CoverageReport = {
  total: number;
  excluded: Record<CoverageExclusionReason, number>;
  excludedTotal: number;
  inScope: number;
  byKind: Record<CustomerShippingMoneyClassKind, number>;
  compared: number;
  differing: number;
  signedDollars: number;
  absoluteDollars: number;
  maxAbsoluteDelta: { shipmentId: number; delta: number } | null;
  /** Rows with a valid tuple where billing could NOT produce a comparison. */
  uncomparable: number;
  byClient: CoverageDeltaBucket[];
  bySource: CoverageDeltaBucket[];
  /** Non-empty means the population is NOT safe to activate tuple precedence over. */
  activationBlockers: string[];
};

const ZERO_EXCLUSIONS: Record<CoverageExclusionReason, number> = {
  return: 0, replacement: 0, voided: 0, test_offline: 0, no_billable_cost: 0,
};
const ZERO_KINDS: Record<CustomerShippingMoneyClassKind, number> = {
  valid_ps508: 0, valid_ps437: 0, legacy_absent: 0,
  malformed_known_version: 0, unknown_version: 0,
};

/**
 * Cent-safe comparison, through the ONE canonical owner.
 *
 * The first cut of this file defined a local `cents()` that scaled by 100 and rounded. That is a
 * SECOND cent-rounding policy, and audit-money-rounding-guard exists to forbid exactly that — it
 * caught this. It is also the same defect that turned CI red for seventeen consecutive pushes
 * earlier in PS-502, when the replacement planner minted its own `cents()`.
 *
 * roundMoney already restores representation dust and rounds ties away from zero, so comparing
 * rounded dollars is cent-safe without inventing a parallel rule: 12.00 vs 11.999999 collapse to
 * the same value, which is the property this needs.
 */
function deltaOf(tuple: number, recompute: number): number {
  return roundMoney(roundMoney(tuple) - roundMoney(recompute));
}

function bucketOf(map: Map<string, CoverageDeltaBucket>, key: string): CoverageDeltaBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { key, rows: 0, differing: 0, signedDollars: 0, absoluteDollars: 0 };
    map.set(key, bucket);
  }
  return bucket;
}

export function buildCoverageReport(rows: readonly CoverageRow[]): CoverageReport {
  const excluded = { ...ZERO_EXCLUSIONS };
  const byKind = { ...ZERO_KINDS };
  const byClient = new Map<string, CoverageDeltaBucket>();
  const bySource = new Map<string, CoverageDeltaBucket>();

  let inScope = 0;
  let compared = 0;
  let differing = 0;
  let signedTotal = 0;
  let absoluteTotal = 0;
  let uncomparable = 0;
  let maxAbsoluteDelta: { shipmentId: number; delta: number } | null = null;

  for (const row of rows) {
    if (row.excluded) {
      excluded[row.excluded] += 1;
      continue;
    }
    inScope += 1;
    byKind[row.kind] += 1;

    const hasTuple = row.kind === 'valid_ps508' || row.kind === 'valid_ps437';
    if (!hasTuple || row.tupleAmount == null) continue;
    if (row.recomputeAmount == null) {
      // A tuple with nothing to compare against. Counted, never silently skipped — it means the
      // cutover would bill from a number no current code path can reproduce.
      uncomparable += 1;
      continue;
    }

    const delta = deltaOf(row.tupleAmount, row.recomputeAmount);
    compared += 1;
    signedTotal = roundMoney(signedTotal + delta);
    // Accumulated independently of the signed total, never derived from it: opposite-signed
    // deltas cancel, so a signed total of zero can sit on top of real per-line divergence.
    absoluteTotal = roundMoney(absoluteTotal + Math.abs(delta));

    const clientBucket = bucketOf(byClient, row.clientId == null ? 'unassigned' : String(row.clientId));
    const sourceBucket = bucketOf(bySource, row.source ?? 'unknown');
    for (const bucket of [clientBucket, sourceBucket]) {
      bucket.rows += 1;
      bucket.signedDollars = roundMoney(bucket.signedDollars + delta);
      bucket.absoluteDollars = roundMoney(bucket.absoluteDollars + Math.abs(delta));
    }

    if (delta !== 0) {
      differing += 1;
      clientBucket.differing += 1;
      sourceBucket.differing += 1;
      if (!maxAbsoluteDelta || Math.abs(delta) > Math.abs(maxAbsoluteDelta.delta)) {
        maxAbsoluteDelta = { shipmentId: row.shipmentId, delta };
      }
    }
  }

  const activationBlockers: string[] = [];
  if (byKind.malformed_known_version > 0) {
    activationBlockers.push(
      `${byKind.malformed_known_version} malformed_known_version row(s) — written by us and invalid; `
      + 'these must not silently fall back to recompute',
    );
  }
  if (byKind.unknown_version > 0) {
    activationBlockers.push(
      `${byKind.unknown_version} unknown_version row(s) — a policy this build cannot read; `
      + 'never repair or overwrite these',
    );
  }
  if (uncomparable > 0) {
    activationBlockers.push(
      `${uncomparable} row(s) carry a valid tuple that billing could not reproduce — `
      + 'the divergence is unmeasurable, not zero',
    );
  }

  const sortByAbsolute = (a: CoverageDeltaBucket, b: CoverageDeltaBucket) =>
    b.absoluteDollars - a.absoluteDollars;
  const excludedTotal = Object.values(excluded).reduce((sum, n) => sum + n, 0);

  return {
    total: rows.length,
    excluded,
    excludedTotal,
    inScope,
    byKind,
    compared,
    differing,
    signedDollars: signedTotal,
    absoluteDollars: absoluteTotal,
    maxAbsoluteDelta,
    uncomparable,
    byClient: [...byClient.values()].sort(sortByAbsolute),
    bySource: [...bySource.values()].sort(sortByAbsolute),
    activationBlockers,
  };
}

/**
 * Coverage over the population that could actually carry an outbound tuple — in-scope rows only.
 *
 * Deliberately NOT total-based. Dividing by every shipment would let a large return or test
 * population drag the number down and make an otherwise-complete rollout look unfinished.
 */
export function outboundCoveragePct(report: CoverageReport): number | null {
  if (report.inScope === 0) return null;
  return Math.round((report.byKind.valid_ps508 / report.inScope) * 1000) / 10;
}
