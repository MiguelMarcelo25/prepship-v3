// PS-261 (slice) — pure GATE that maps the PS-290 HUGRAB "$100 insurance COVERAGE STATUS" verdict
// to a label-PURCHASE decision. It does NOT re-derive the verdict; it CONSUMES it.
//
// insurance-coverage-status.ts (PS-290) is the canonical owner of the coverage verdict for a HUGRAB
// row's Best Rate; this module answers the next question for the buy path: "given that verdict, may
// we PURCHASE a HUGRAB label?" HUGRAB mandates $100 of insurance on every shipment, so a label may
// only be bought when that coverage is PROVEN included (or the mandate does not apply at all).
//
// DECISION TABLE (HUGRAB; the verdict already encodes HUGRAB-vs-not):
//   included      -> allow  (the $100 coverage is proven on the rate)
//   not_required  -> allow  (non-HUGRAB row; the $100 mandate does not apply)
//   not_included  -> BLOCK  (the mandatory $100 was explicitly NOT applied)
//   unknown       -> BLOCK  (requested but UNPROVEN — never buy on unproven coverage)
//   unsupported   -> BLOCK  (the rate cannot insure at all)
//   anything else -> BLOCK  (fail safe; never silently allow an unrecognized verdict)
//
// PURE + deterministic. No DB, no network, no live label. This is a backend source-of-truth
// decision; Create Label / Print Queue / Rate Browser will DELEGATE to it in follow-on slices and
// the FE never recomputes a purchase verdict from a heuristic.

import type { InsuranceCoverageStatus } from './insurance-coverage-status';

export type HugrabLabelPurchaseDecision = {
  /** True only when a HUGRAB label may be purchased for this coverage verdict. */
  allow: boolean;
  /** Short backend-owned reason (audit / operator-facing; display-only). */
  reason: string;
};

const DECISION: Record<InsuranceCoverageStatus, HugrabLabelPurchaseDecision> = {
  included: {
    allow: true,
    reason: 'HUGRAB $100 insurance coverage is proven included — purchase allowed.',
  },
  not_required: {
    allow: true,
    reason: 'Non-HUGRAB rate — the $100 insurance mandate does not apply — purchase allowed.',
  },
  not_included: {
    allow: false,
    reason: 'HUGRAB $100 insurance was explicitly NOT applied — purchase blocked.',
  },
  unknown: {
    allow: false,
    reason: 'HUGRAB $100 insurance coverage is requested but unproven — purchase blocked.',
  },
  unsupported: {
    allow: false,
    reason: 'This rate cannot carry the HUGRAB $100 insurance — purchase blocked.',
  },
};

const BLOCK_UNRECOGNIZED: HugrabLabelPurchaseDecision = {
  allow: false,
  reason: 'Unrecognized HUGRAB insurance coverage verdict — purchase blocked (fail safe).',
};

/**
 * PS-261 — map a PS-290 coverage verdict to a HUGRAB label-purchase decision.
 * Pure + deterministic. BLOCKs on not_included / unknown / unsupported (and any unrecognized
 * value); ALLOWs only on included / not_required.
 */
export function resolveHugrabLabelPurchaseGate(
  status: InsuranceCoverageStatus,
): HugrabLabelPurchaseDecision {
  return DECISION[status] ?? BLOCK_UNRECOGNIZED;
}
