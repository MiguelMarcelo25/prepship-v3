// PS-290 (slice 1) — CANONICAL owner of the HUGRAB "$100 insurance COVERAGE STATUS" verdict.
//
// PS-274's insurance-certainty.ts answers HOW SURE we are the requested value applies; PS-126's
// insurance-cost.ts answers HOW MUCH the premium is. This module answers a third, operator-facing
// question for a HUGRAB row's Best Rate cell: "is the mandatory $100 of insurance actually INCLUDED
// on this rate?" — a single coverage badge the frontend renders verbatim. The VERDICT is backend
// owned (this pure resolver + the DTO); the FE never recomputes it from a heuristic.
//
// HUGRAB mandates $100 of declared value on every shipment (services/rates.ts defaults HUGRAB to
// ParcelGuard / insured value 100; PS-214 makes it universal). So for a HUGRAB row:
//   - the declared/insured value MUST be >= $100 before coverage can read "included"; and
//   - "included" is only earned when the BACKEND has proof of the $100 coverage — either a
//     carrier-declared-value $0 first-$100 (carrier_declared_value provenance), a POSITIVE
//     ParcelGuard / EasyPost premium (the biller charged for it), or an explicitly_included
//     certainty (a direct verified carrier).
//
// RULES (HUGRAB; first match wins):
//   1. unsupported  — the rate is blocked from insuring at all (certainty 'unsupported' or an
//                     'unsupported'/'blocked' provenance). Never falsely "included".
//   2. not_included — explicit no-insurance: insuranceProvider 'none', insuredValue 0/absent, or
//                     certainty 'not_included'. The HUGRAB $100 was NOT applied.
//   3. unknown      — requested but UNPROVEN: insured value below the $100 floor, OR certainty
//                     'requested_application_uncertain' / 'proof_unavailable'. We asked; we can't prove it.
//   4. included     — $100+ insured AND proof: carrier_declared_value provenance, a positive
//                     parcelguard/easypost premium, or certainty 'explicitly_included'.
//   5. unknown      — HUGRAB with a >=100 declared value but no recognizable proof signal (honest
//                     fallback; never a false "included").
//
// Non-HUGRAB rows -> 'not_required' (the badge does not apply; the FE renders nothing).
//
// PURE + deterministic. No DB, no network, no money mutation. Coverage status NEVER blocks a rate;
// it is a display + persistence-honesty fact only. The type unions for certainty + provenance are
// IMPORTED from the existing PS-274 / PS-126 modules — they are not redefined here.

import { CARRIER_DECLARED_VALUE_FREE_CAP } from '../../lib/carrier-account-registry';
import type { InsuranceCertaintyState } from './insurance-certainty';
import type { InsuranceCostProvenance } from './insurance-cost';

export type InsuranceCoverageStatus =
  | 'included'
  | 'not_included'
  | 'unknown'
  | 'unsupported'
  | 'not_required';

export type InsuranceCoverageBadgeTone = 'green' | 'red' | 'amber' | 'neutral';
export type InsuranceCoverageProofSource = 'shipp_customs_value';

export type InsuranceCoverageStatusResult = {
  status: InsuranceCoverageStatus;
  /** Short operator-facing badge text (display-only). */
  badgeLabel: string;
  badgeTone: InsuranceCoverageBadgeTone;
  /** Optional audit source proving why an otherwise uncertain HUGRAB rate may be purchased. */
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null;
};

export type ResolveInsuranceCoverageStatusInput = {
  /** True ONLY for a HUGRAB row — the coverage badge applies to HUGRAB orders only. */
  isHugrab?: boolean | null;
  /** The insured provider on the rate, e.g. 'parcelguard' | 'carrier' | 'easypost' | 'none'. */
  insuranceProvider?: string | null;
  /** Declared/insured value on the rate; HUGRAB mandates >= 100. */
  insuredValue?: number | null;
  /** Resolved rate-time premium (>0 proves a biller charged for coverage). */
  insuranceCost?: number | null;
  /** Where the premium came from (insurance-cost.ts InsuranceCostProvenance). */
  insuranceProvenance?: InsuranceCostProvenance | string | null;
  /** PS-274 certainty state, when the backend stamped it (insurance-certainty.ts). */
  insuranceCertainty?: InsuranceCertaintyState | string | null;
  /** Provider-specific proof source, validated by the caller and re-checked here. */
  insuranceCoverageProofSource?: InsuranceCoverageProofSource | string | null;
  /** True only when the provider/account/service identity is SHIPP-brokered. */
  isShippBrokered?: boolean | null;
};

/** HUGRAB's mandatory minimum declared value mirrors the carrier-declared-value free cap ($100). */
export const HUGRAB_REQUIRED_INSURED_VALUE = CARRIER_DECLARED_VALUE_FREE_CAP;

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function finiteValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasFiniteValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n);
}

const RESULT: Record<InsuranceCoverageStatus, InsuranceCoverageStatusResult> = {
  included: { status: 'included', badgeLabel: '$100 INS. INCL.', badgeTone: 'green', insuranceCoverageProofSource: null },
  not_included: { status: 'not_included', badgeLabel: 'NO INSURANCE', badgeTone: 'red', insuranceCoverageProofSource: null },
  unknown: { status: 'unknown', badgeLabel: 'INSURANCE UNKNOWN', badgeTone: 'amber', insuranceCoverageProofSource: null },
  unsupported: { status: 'unsupported', badgeLabel: 'INSURANCE UNSUPPORTED', badgeTone: 'amber', insuranceCoverageProofSource: null },
  not_required: { status: 'not_required', badgeLabel: '', badgeTone: 'neutral', insuranceCoverageProofSource: null },
};

function withProofSource(
  result: InsuranceCoverageStatusResult,
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null,
): InsuranceCoverageStatusResult {
  return insuranceCoverageProofSource ? { ...result, insuranceCoverageProofSource } : result;
}

/**
 * PS-290 — resolve the authoritative HUGRAB $100-insurance coverage status for one rate.
 * Pure + deterministic. Non-HUGRAB rows always return 'not_required'.
 */
export function resolveInsuranceCoverageStatus(
  input: ResolveInsuranceCoverageStatusInput,
): InsuranceCoverageStatusResult {
  // Coverage badge applies to HUGRAB rows only.
  if (input.isHugrab !== true) return RESULT.not_required;

  const provider = norm(input.insuranceProvider);
  const provenance = norm(input.insuranceProvenance);
  const certainty = norm(input.insuranceCertainty);
  const proofSource = norm(input.insuranceCoverageProofSource);
  const hasInsuredValue = hasFiniteValue(input.insuredValue);
  const insuredValue = finiteValue(input.insuredValue);
  const premium = finiteValue(input.insuranceCost);

  // (1) Blocked from insuring at all — never falsely "included".
  if (certainty === 'unsupported' || provenance === 'unsupported' || provenance === 'blocked') {
    return RESULT.unsupported;
  }

  // (2) Explicit no-insurance — the HUGRAB $100 was NOT applied.
  if (provider === 'none' || certainty === 'not_included' || (hasInsuredValue && insuredValue <= 0)) {
    return RESULT.not_included;
  }

  // PS-404: legacy shipped HUGRAB rows can have flat selected/label cost while
  // missing proof fields. Missing proof is not explicit no-insurance.
  if (!hasInsuredValue) {
    return RESULT.unknown;
  }

  // (3) Requested but UNPROVEN - below the $100 floor is never enough.
  if (insuredValue < HUGRAB_REQUIRED_INSURED_VALUE) {
    return RESULT.unknown;
  }

  // (3b) Explicit SHIPP customsValue proof can satisfy the purchase gate only when the caller
  // intentionally enabled it and the identity is SHIPP-brokered. This does not change PS-274
  // certainty: the rate remains requested_application_uncertain, but HUGRAB can buy under flag.
  const hasShippCustomsValueProof =
    proofSource === 'shipp_customs_value' && input.isShippBrokered === true;
  if (hasShippCustomsValueProof) {
    return withProofSource(RESULT.included, 'shipp_customs_value');
  }

  // (3c) Requested but UNPROVEN - uncertain/unproven certainty remains blocked unless the
  // provider-specific proof source above intentionally allowed it.
  if (certainty === 'requested_application_uncertain' || certainty === 'proof_unavailable') {
    return RESULT.unknown;
  }

  // (4) $100+ insured AND proof of the coverage.
  const hasCarrierDeclaredValueProof = provenance === 'carrier_declared_value';
  const hasPositivePremiumProof =
    premium > 0 && (provenance === 'parcelguard_schedule' || provenance === 'easypost' ||
      provenance === 'shipstation_estimate' || provenance === 'shipstation_v2_label' ||
      provenance === 'shipstation_v1_shipment');
  const hasExplicitCertainty = certainty === 'explicitly_included';
  if (hasCarrierDeclaredValueProof || hasPositivePremiumProof || hasExplicitCertainty) {
    return RESULT.included;
  }

  // (5) HUGRAB, >=100 declared, but no recognizable proof signal — honest unknown.
  return RESULT.unknown;
}
