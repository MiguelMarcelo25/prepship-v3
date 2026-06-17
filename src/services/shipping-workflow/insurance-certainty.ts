// PS-274 — CANONICAL owner of the insurance CERTAINTY fact for a rate / a created label.
//
// "Insurance cost" (insurance-cost.ts) answers HOW MUCH; this answers HOW SURE we are
// that the insured value will actually apply on the bought label. They are different
// facts and must not be conflated: a Shipp-BROKERED UPS quote can declare a value (we
// pass it as customsValue) yet give us NO final-label proof that UPS carrier declared
// value was actually applied at purchase. Stamping such a rate as
// 'carrier_declared_value' / "explicitly included" is the #1502 dishonesty class — it
// asserts a coverage state we have not proven.
//
// RULE (identity FIRST, carrier family SECOND):
//   1. Shipp-brokered UPS (a `shipp_` service code OR a Shipp account/provider) carrying a
//      declared value but no verified-direct proof  -> 'requested_application_uncertain'.
//      NEVER 'explicitly_included' — we requested it; we cannot prove UPS applied it.
//   2. A DIRECT, verified UPS account (isDirectVerifiedAccount) with a declared value
//      -> 'explicitly_included' (this is the only path that earns carrier_declared_value).
//   3. An insured rate with NO declared value (insuredValue<=0)     -> 'not_included'.
//   4. A provider that cannot insure at all                          -> 'unsupported'.
//   5. We have no signal either way                                  -> 'proof_unavailable'.
//
// PURE + dependency-free → offline-testable. No DB, no network, no money mutation. The
// certainty NEVER blocks a rate (Shipp HUGRAB rates stay visible — just tagged); it is a
// display + persistence-honesty fact only.

export type InsuranceCertaintyState =
  | 'explicitly_included'
  | 'requested_application_uncertain'
  | 'not_included'
  | 'unsupported'
  | 'proof_unavailable';

export type InsuranceCertaintyTone = 'positive' | 'caution' | 'neutral' | 'warning';

export type InsuranceCertaintyResult = {
  certainty: InsuranceCertaintyState;
  /** Short operator-facing chip text (display-only). */
  tagLabel: string;
  tagTone: InsuranceCertaintyTone;
  /** Where the certainty was derived from (audit trail). */
  proofSource: string;
};

export type ResolveInsuranceCertaintyInput = {
  /** Connector / account provider key, e.g. 'shipp' | 'easypost' | 'ups' | 'shipstation'. */
  provider?: string | null;
  /** A human/account identity string (nickname, account label) — used to detect Shipp brokering. */
  accountIdentity?: string | null;
  /** The rate's service code, e.g. 'shipp_ups_ground' (the `shipp_` prefix marks brokering). */
  serviceCode?: string | null;
  /** Declared/insured value on the rate; <=0 means no declared value. */
  insuredValue?: number | null;
  /** Resolved rate-time premium, if any (display context only). */
  insuranceCost?: number | null;
  /** Where the cost figure came from (insurance-cost.ts InsuranceCostProvenance). */
  provenance?: string | null;
  /** True ONLY for a direct carrier account whose declared-value path is verified-insured. */
  isDirectVerifiedAccount?: boolean | null;
};

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function finiteValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** True when the rate/account is Shipp-BROKERED (identity-first: provider, account, or `shipp_` service). */
export function isShippBrokered(input: ResolveInsuranceCertaintyInput): boolean {
  const provider = norm(input.provider);
  if (provider === 'shipp') return true;
  if (norm(input.accountIdentity).replace(/[^a-z0-9]+/g, '') === 'shipp') return true;
  return norm(input.serviceCode).startsWith('shipp_');
}

/** True when the provenance/provider says insurance cannot be purchased on this rate at all. */
function isUnsupported(input: ResolveInsuranceCertaintyInput): boolean {
  const provenance = norm(input.provenance);
  return provenance === 'unsupported' || provenance === 'blocked';
}

/**
 * PS-274 — resolve the authoritative insurance-certainty fact for one rate / label.
 * Pure + deterministic. Identity FIRST (Shipp brokering), carrier family second.
 */
export function resolveInsuranceCertainty(
  input: ResolveInsuranceCertaintyInput,
): InsuranceCertaintyResult {
  const insuredValue = finiteValue(input.insuredValue);
  const hasDeclaredValue = insuredValue > 0;

  // (4) Provider literally cannot insure -> unsupported (never falsely "included").
  if (isUnsupported(input)) {
    return {
      certainty: 'unsupported',
      tagLabel: 'Insurance unsupported',
      tagTone: 'warning',
      proofSource: 'provider_capability',
    };
  }

  // (3) No declared value at all — nothing was requested, so nothing is included.
  if (!hasDeclaredValue) {
    return {
      certainty: 'not_included',
      tagLabel: 'No insurance',
      tagTone: 'neutral',
      proofSource: 'no_declared_value',
    };
  }

  // (1) IDENTITY FIRST — a Shipp-brokered rate with a declared value but no
  // verified-direct proof is UNCERTAIN. We requested the value (customsValue); we
  // cannot prove the carrier applied declared value at purchase. NEVER carrier_declared_value.
  if (isShippBrokered(input)) {
    return {
      certainty: 'requested_application_uncertain',
      tagLabel: 'Insurance requested (unconfirmed)',
      tagTone: 'caution',
      proofSource: 'shipp_brokered_declared_value',
    };
  }

  // (2) Only a DIRECT, verified account earns "explicitly included" / carrier declared value.
  if (input.isDirectVerifiedAccount === true) {
    return {
      certainty: 'explicitly_included',
      tagLabel: 'Insurance included',
      tagTone: 'positive',
      proofSource: 'direct_verified_carrier_declared_value',
    };
  }

  // (5) A declared value on a non-Shipp, non-verified account — we have a request but
  // no proof the application is verified. Honest fallback, not a false "included".
  return {
    certainty: 'proof_unavailable',
    tagLabel: 'Insurance pending proof',
    tagTone: 'caution',
    proofSource: 'declared_value_unverified',
  };
}
