/**
 * PS-502 — the operator-visible replacement identity: `1321-REPLACE`, `1321-REPLACE-2`.
 *
 * PURE AND UNLOCKED. Given an order number and the references that already exist, it says
 * what the next one is. It does not read the database, take the order-scoped lock, or insert
 * anything — that create command requires `unlock shipped data` and is not in this slice.
 *
 * WHY A MODULE FOR STRING CONCATENATION
 *
 * The card bans string-building this at use sites: billing rows must carry
 * `order_number = replacement.reference` — "the ALLOCATED value incl. `-2`; never
 * string-build `${orderNumber}-REPLACE`". A use site that rebuilds the first form gets the
 * SECOND replacement's money filed under the first one's identity, and both rows look
 * plausible. One formatter, one parser, one allocator.
 *
 * `reference` is UNIQUE in `0096`, so the database is the final arbiter. This function makes
 * the common path correct; the unique index makes the racing path safe. Under concurrent
 * creation (AC-12) two writers can compute the same next value, and the loser must retry
 * against the re-read set rather than assume its first answer — which is why the order-scoped
 * lock in the create command is still required and this is not a substitute for it.
 */

/** The suffix that marks a replacement reference. Uppercase, matching the card verbatim. */
const REPLACE_SUFFIX = 'REPLACE';

/**
 * `<orderNumber>-REPLACE` optionally followed by `-<n>`.
 *
 * The greedy leading group is deliberate: order numbers may themselves contain hyphens, so
 * the anchor is the SUFFIX at the end, not the first hyphen. Backtracking resolves
 * "1321-A-REPLACE-2" to orderNumber "1321-A", sequence 2.
 */
const REFERENCE_PATTERN = new RegExp(`^(.*)-${REPLACE_SUFFIX}(?:-(\\d+))?$`);

export type ParsedReplacementReference = {
  orderNumber: string;
  /** 1 for the bare `-REPLACE` form. */
  sequence: number;
};

/**
 * Render a reference.
 *
 * Sequence 1 is the BARE form. Emitting `1321-REPLACE-1` would create a second spelling of
 * one identity that the UNIQUE index cannot catch, so `1321-REPLACE` and `1321-REPLACE-1`
 * could both exist and disagree about which is the first replacement.
 */
export function formatReplacementReference(orderNumber: string, sequence: number): string {
  const trimmed = orderNumber.trim();
  if (trimmed === '') {
    throw new Error('replacement reference requires a non-empty order number');
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`replacement sequence must be a positive integer, got ${sequence}`);
  }
  return sequence === 1
    ? `${trimmed}-${REPLACE_SUFFIX}`
    : `${trimmed}-${REPLACE_SUFFIX}-${sequence}`;
}

/**
 * Read a reference back, or null when it is not one.
 *
 * An explicit `-1`, `-0`, or a zero-padded `-02` is REJECTED rather than normalized. Each is
 * a non-canonical spelling of a value this module would never emit, and silently accepting
 * one would let two rows claim the same sequence past the unique index.
 */
export function parseReplacementReference(reference: string): ParsedReplacementReference | null {
  if (typeof reference !== 'string') return null;
  const match = REFERENCE_PATTERN.exec(reference.trim());
  if (!match) return null;

  const orderNumber = match[1] ?? '';
  if (orderNumber.trim() === '') return null;

  const rawSequence = match[2];
  if (rawSequence === undefined) return { orderNumber, sequence: 1 };

  // Reject anything this module would not have written.
  if (!/^[1-9]\d*$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  if (sequence < 2) return null;

  return { orderNumber, sequence };
}

/**
 * The next reference for an order, given every reference that already exists.
 *
 * Takes max + 1 and NEVER fills a gap. A cancelled or rejected replacement keeps its row and
 * therefore its `reference`, so reusing `-2` after cancelling it collides with the unique
 * index; worse, if that row were ever removed, reuse would silently attach a new
 * replacement's billing to an identity that already appeared on a customer's invoice.
 *
 * References belonging to other orders are ignored rather than treated as an error — callers
 * pass the result of a query, and being strict about unrelated rows here would turn a
 * harmless over-fetch into a failure.
 */
export function nextReplacementReference(
  orderNumber: string,
  existingReferences: readonly (string | null | undefined)[] = [],
): string {
  const trimmed = orderNumber.trim();
  if (trimmed === '') {
    throw new Error('replacement reference requires a non-empty order number');
  }

  let highest = 0;
  for (const candidate of existingReferences) {
    if (typeof candidate !== 'string') continue;
    const parsed = parseReplacementReference(candidate);
    if (!parsed || parsed.orderNumber !== trimmed) continue;
    if (parsed.sequence > highest) highest = parsed.sequence;
  }

  return formatReplacementReference(trimmed, highest + 1);
}

/** Does this string name a replacement? Used to keep ordinary order lookups from matching one. */
export function isReplacementReference(value: string): boolean {
  return parseReplacementReference(value) !== null;
}
