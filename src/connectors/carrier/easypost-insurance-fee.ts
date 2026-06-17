// PS-261 — PURE parser for the EasyPost insurance fee actually billed on a BOUGHT shipment.
//
// Why this exists: an insured EasyPost rate carries no insurance premium in the rate-time
// estimate (the direct path is merged AFTER ShipStation's enrichRatesWithInsuranceCost pass,
// per scripts/ps-261-easypost-insurance-cost-guard.ts slice 1). After purchase, EasyPost's
// bought Shipment reports the REAL fee. This reads it from the purchase response so the
// connector return can carry an honest insuranceCost — WITHOUT touching postage cost.
//
// Source of truth on the EasyPost Shipment response:
//   - `fees`: Fee[] where the insurance line is `{ type: 'InsuranceFee', amount: '0.50', ... }`
//             (amount is a String dollar value; preferred — it's what EasyPost actually charged).
//   - `insurance`: a String dollar amount of the insured VALUE on the shipment (fallback only).
//
// HONESTY rule (the #1502 false-confirmation class): an UNPRICED insurance line is NOT a
// confirmed $0 cost. We return null when no positive fee is present, never a bare 0 that a
// downstream consumer could mistake for "confirmed, free". 0 is reserved for an explicit,
// positive-shaped fee that resolves to zero only if EasyPost ever sends one (it does not today).
//
// Pure + dependency-free → offline testable. No DB, no network, no postage mutation.

/** A single EasyPost Fee line as it appears on a bought Shipment. */
type EasyPostFee = {
  type?: unknown;
  amount?: unknown;
};

/** Parse a dollar amount (EasyPost sends Strings like "0.50") to a finite number, else null. */
function parseDollars(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extract the insurance fee (in dollars) actually billed on an EasyPost bought-shipment
 * response. Returns null when no positive insurance fee is present — an unpriced/absent
 * insurance line is NEVER reported as a confirmed $0 (false-confirmation guard). Rounds to
 * cents.
 */
export function parseEasyPostInsuranceCost(purchased: unknown): number | null {
  if (!purchased || typeof purchased !== 'object') return null;
  const shipment = purchased as { fees?: unknown; insurance?: unknown };

  // 1) Preferred: the InsuranceFee line in fees[] (what EasyPost actually charged).
  if (Array.isArray(shipment.fees)) {
    for (const raw of shipment.fees as EasyPostFee[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (String(raw.type ?? '').toLowerCase() !== 'insurancefee') continue;
      const amount = parseDollars(raw.amount);
      if (amount != null && amount > 0) return Math.round(amount * 100) / 100;
    }
  }

  // 2) Fallback: the shipment `insurance` value (insured value as a String). Only a positive
  // number counts — never coerce an absent/empty/zero value into a confirmed $0 cost.
  const insurance = parseDollars(shipment.insurance);
  if (insurance != null && insurance > 0) return Math.round(insurance * 100) / 100;

  return null;
}
