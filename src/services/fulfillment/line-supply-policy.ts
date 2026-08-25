// PS-497 Slice 2 (S2.1) — per-line SUPPLY authority and claim disposition. PURE (no DB, no I/O) and
// UNWIRED in Release A: nothing in production calls it yet; the Release-B owner cutover (S2.4) does.
//
// Supply and line-evidence are ORTHOGONAL dimensions (Hermes v3):
//   * supply  = who physically fulfilled it: 'prepship' | 'external' | 'unknown' (a canonical fact).
//   * evidence = how good the per-line data is: exact shipment lines / whole-order fallback / unavailable.
// A PrepShip shipment with unusable lines stays supply='prepship' but the claim goes to review — it never
// becomes a pseudo-supply 'review'. Only the executor may finally move stock, and it re-checks supply='prepship'.

export type LineSupply = 'prepship' | 'external' | 'unknown';
export type ClaimStatus = 'pending' | 'review' | 'not_applicable';
export type LineEvidence = 'exact_shipment' | 'whole_order_fallback' | 'unavailable';
export type OccurrenceDiscriminator = 'provider_shipment' | 'local_shipment' | 'whole_order';

export interface ClaimDisposition {
  supply: LineSupply;
  status: ClaimStatus;
  /** Whether an inventory-deduction outbox intent should be created for this claim. */
  enqueue: boolean;
}

/**
 * The occurrence-level supply class, derived from canonical facts only:
 *   * a shipment-backed occurrence (a real PrepShip shipment exists) → 'prepship';
 *   * a genuinely-external whole-order occurrence (external_shipped / webhook) → 'external';
 *   * a status-only whole-order projection with no shipment/line ownership → 'unknown'.
 * `external` is passed by the resolver from the transition (external_shipped) — never inferred from a
 * mutable source string.
 */
export function resolveOccurrenceSupply(input: {
  discriminatorKind: OccurrenceDiscriminator;
  external: boolean;
}): LineSupply {
  if (input.discriminatorKind === 'provider_shipment' || input.discriminatorKind === 'local_shipment') {
    return 'prepship';
  }
  return input.external ? 'external' : 'unknown';
}

/**
 * The frozen disposition matrix. A line is deductible ONLY when the occurrence is PrepShip-supplied AND
 * the line evidence is trustworthy:
 *   prepship + exact shipment-scoped lines               → pending  (deductible; EVEN for a split shipment)
 *   prepship + whole-order fallback lines + sole outbound → pending  (deductible)
 *   prepship + unavailable / invalid / not-sole-fallback → review   (no movement)
 *   external + any                                        → not_applicable (never deducts)
 *   unknown  + any                                        → review   (no movement)
 */
export function decideClaimDisposition(input: {
  supply: LineSupply;
  evidence: LineEvidence;
  /** the line carries an identified SKU. */
  hasCanonicalSku: boolean;
  /** a proved positive integer quantity. */
  quantity: number | null;
  /** true only when this is provably the sole active outbound shipment for the order. */
  soleOutbound: boolean;
}): ClaimDisposition {
  const { supply } = input;
  if (supply === 'external') return { supply, status: 'not_applicable', enqueue: false };
  if (supply === 'unknown') return { supply, status: 'review', enqueue: false };

  // supply === 'prepship'
  const validLine = input.hasCanonicalSku && typeof input.quantity === 'number' && input.quantity > 0;
  if (!validLine) return { supply, status: 'review', enqueue: false };
  if (input.evidence === 'exact_shipment') return { supply, status: 'pending', enqueue: true };
  if (input.evidence === 'whole_order_fallback') {
    return input.soleOutbound
      ? { supply, status: 'pending', enqueue: true }
      : { supply, status: 'review', enqueue: false };
  }
  // evidence === 'unavailable'
  return { supply, status: 'review', enqueue: false };
}
