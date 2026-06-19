// PS-261 (slice) — the BACKEND-OWNED preflight that maps a pre-purchase HUGRAB rate context to a
// label-purchase decision, so a HUGRAB label can NEVER be bought while its mandatory $100 of
// insurance coverage is missing, unproven, or unsupported.
//
// This is a THIN orchestration of three existing source-of-truth owners — it adds NO new policy:
//   1. resolveInsuranceCertainty   (PS-274) — identity-first certainty of the requested value
//                                             (a Shipp-brokered declared value is UNPROVEN).
//   2. resolveInsuranceCoverageStatus (PS-290) — the canonical HUGRAB $100-coverage verdict
//                                             (included | not_included | unknown | unsupported |
//                                              not_required).
//   3. resolveHugrabLabelPurchaseGate (PS-261) — maps that verdict to allow / BLOCK.
//
// The certainty resolver is consulted FIRST so the coverage verdict for a brokered Shipp rate is
// honestly 'unknown' (requested-but-unproven) rather than a fabricated 'included' — the buy path
// then BLOCKS on it. PURE + deterministic: no DB, no network, no live label. The route/service
// caller turns a `allow === false` result into a structured, operator-facing block BEFORE any
// postage is purchased; it never alters a successful purchase.

import {
  HUGRAB_REQUIRED_INSURED_VALUE,
  resolveInsuranceCoverageStatus,
  type InsuranceCoverageBadgeTone,
  type InsuranceCoverageProofSource,
  type InsuranceCoverageStatus,
} from './insurance-coverage-status';
import { resolveInsuranceCertainty, isShippBrokered } from './insurance-certainty';
import type { InsuranceCostProvenance } from './insurance-cost';
import {
  resolveHugrabLabelPurchaseGate,
  type HugrabLabelPurchaseDecision,
} from './hugrab-label-purchase-gate';

export type HugrabLabelPurchasePreflightInput = {
  /** True ONLY for a HUGRAB order — the $100 coverage mandate applies to HUGRAB rows only. */
  isHugrab?: boolean | null;
  /** Insured provider on the rate being purchased, e.g. 'parcelguard' | 'carrier' | 'none'. */
  insuranceProvider?: string | null;
  /** Declared/insured value on the rate; HUGRAB mandates >= 100. */
  insuredValue?: number | null;
  /** Resolved rate-time premium (>0 proves a biller charged for coverage). */
  insuranceCost?: number | null;
  /** Premium provenance, when the backend already stamped one (insurance-cost.ts). */
  insuranceProvenance?: InsuranceCostProvenance | string | null;
  /** Connector / account provider key, e.g. 'shipp' | 'ups' | 'stamps_com'. */
  provider?: string | null;
  /** Account identity (nickname/label) — used to detect Shipp brokering. */
  accountIdentity?: string | null;
  /** The rate's service code, e.g. 'shipp_ups_ground' (the `shipp_` prefix marks brokering). */
  serviceCode?: string | null;
  /** True ONLY for a direct carrier account whose declared-value path is verified-insured. */
  isDirectVerifiedAccount?: boolean | null;
  /** Optional provider-specific proof source, supplied only by flagged callers. */
  insuranceCoverageProofSource?: InsuranceCoverageProofSource | string | null;
};

export type HugrabLabelPurchasePreflightResult = HugrabLabelPurchaseDecision & {
  /** The PS-290 coverage verdict the decision was made on (audit / operator-facing). */
  status: InsuranceCoverageStatus;
  /** Display-only badge fields from the PS-290 coverage owner. */
  insuranceBadgeLabel: string;
  insuranceBadgeTone: InsuranceCoverageBadgeTone;
  /** Optional audit source explaining why the gate allowed an otherwise uncertain rate. */
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null;
};

function finiteValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function resolveShippCustomsValueProofSource(input: {
  enabled?: boolean | null;
  provider?: string | null;
  accountIdentity?: string | null;
  serviceCode?: string | null;
  insuredValue?: number | null;
}): InsuranceCoverageProofSource | null {
  if (input.enabled !== true) return null;
  if (finiteValue(input.insuredValue) < HUGRAB_REQUIRED_INSURED_VALUE) return null;
  return isShippBrokered({
    provider: input.provider ?? null,
    accountIdentity: input.accountIdentity ?? null,
    serviceCode: input.serviceCode ?? null,
    insuredValue: input.insuredValue ?? null,
  })
    ? 'shipp_customs_value'
    : null;
}

/**
 * PS-261 — resolve the HUGRAB label-purchase preflight decision for one rate, pre-purchase.
 * Pure + deterministic. Reuses the PS-274 certainty + PS-290 coverage owners, then delegates the
 * allow/BLOCK call to the PS-261 gate. Non-HUGRAB rows are always allowed ('not_required').
 */
export function resolveHugrabLabelPurchasePreflight(
  input: HugrabLabelPurchasePreflightInput,
): HugrabLabelPurchasePreflightResult {
  // Identity FIRST: a Shipp-BROKERED declared value is requested-but-unproven — we cannot prove the
  // carrier applied it at purchase. The PS-290 coverage resolver only learns this through the PS-274
  // certainty signal, so we forward the certainty ONLY when brokering makes coverage uncertain.
  // For a genuine (non-brokered) rate we forward NO certainty so the resolver's own positive-premium /
  // carrier-declared-value proof decides — otherwise a legitimate ParcelGuard rate (certainty
  // 'proof_unavailable') would be wrongly downgraded to 'unknown' and block a successful buy.
  const certainty = resolveInsuranceCertainty({
    provider: input.provider ?? null,
    accountIdentity: input.accountIdentity ?? null,
    serviceCode: input.serviceCode ?? null,
    insuredValue: input.insuredValue ?? null,
    insuranceCost: input.insuranceCost ?? null,
    provenance: input.insuranceProvenance ?? null,
    isDirectVerifiedAccount: input.isDirectVerifiedAccount ?? null,
  });
  const brokered = isShippBrokered({
    provider: input.provider ?? null,
    accountIdentity: input.accountIdentity ?? null,
    serviceCode: input.serviceCode ?? null,
  });
  const insuranceCoverageProofSource = resolveShippCustomsValueProofSource({
    enabled: input.insuranceCoverageProofSource === 'shipp_customs_value',
    provider: input.provider ?? null,
    accountIdentity: input.accountIdentity ?? null,
    serviceCode: input.serviceCode ?? null,
    insuredValue: input.insuredValue ?? null,
  });

  const coverage = resolveInsuranceCoverageStatus({
    isHugrab: input.isHugrab ?? null,
    insuranceProvider: input.insuranceProvider ?? null,
    insuredValue: input.insuredValue ?? null,
    insuranceCost: input.insuranceCost ?? null,
    insuranceProvenance: input.insuranceProvenance ?? null,
    insuranceCoverageProofSource,
    isShippBrokered: brokered,
    // Forward certainty only when it is DECISIVE: brokered-uncertain or unsupported (so coverage
    // reads 'unknown' / 'unsupported' and blocks), or a direct-verified 'explicitly_included' (so a
    // $0-premium carrier-declared-value account earns 'included'). Otherwise leave it null and let
    // the resolver's own positive-premium proof speak — a legitimate ParcelGuard rate must not be
    // downgraded to 'unknown' by a non-decisive 'proof_unavailable'.
    insuranceCertainty:
      brokered ||
      certainty.certainty === 'unsupported' ||
      certainty.certainty === 'explicitly_included'
        ? certainty.certainty
        : null,
  });

  const decision = resolveHugrabLabelPurchaseGate(coverage.status);
  return {
    ...decision,
    status: coverage.status,
    insuranceBadgeLabel: coverage.badgeLabel,
    insuranceBadgeTone: coverage.badgeTone,
    insuranceCoverageProofSource: coverage.insuranceCoverageProofSource,
  };
}
