// Strict selected-rate snapshot enforcement observability.
//
// Purchase authorization is backend-snapshot-only. This module records whether
// the snapshot resolved, was rejected, or was not referenced. It has no DB or
// provider side effects and must never alter the purchase decision.

export type RateProofEnforcementOutcome =
  | 'snapshot_enforced'
  | 'snapshot_rejected'
  | 'snapshot_reference_missing';

type Counters = Record<string, number>;

const counters: Counters = Object.create(null) as Counters;

function bump(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

export function recordRateProofEnforcement(
  outcome: RateProofEnforcementOutcome,
  reason?: string,
): void {
  try {
    bump(`outcome:${outcome}`);
    if (reason) bump(`reason:${reason}`);
    if (outcome !== 'snapshot_enforced') {
      console.warn(
        `[rate-proof-enforcement] ${outcome} reason=${reason ?? 'unknown'} mode=strict`,
      );
    }
  } catch {
    // Observability must never affect a purchase decision.
  }
}

export function getRateProofEnforcementStats(): {
  mode: 'strict';
  outcomes: Counters;
  reasons: Counters;
} {
  const outcomes: Counters = Object.create(null) as Counters;
  const reasons: Counters = Object.create(null) as Counters;
  for (const [key, value] of Object.entries(counters)) {
    if (key.startsWith('outcome:')) outcomes[key.slice('outcome:'.length)] = value;
    else if (key.startsWith('reason:')) reasons[key.slice('reason:'.length)] = value;
  }
  return { mode: 'strict', outcomes, reasons };
}

export function resetRateProofEnforcementStats(): void {
  for (const key of Object.keys(counters)) delete counters[key];
}
