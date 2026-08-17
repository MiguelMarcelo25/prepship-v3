/**
 * PS-502 section A — the ONE way a replacement's source line is fingerprinted.
 *
 * PURE AND UNLOCKED. No database, no shipment, no order read. It turns facts a caller
 * already holds into a string, which is what keeps it in the card's "no unlock" list.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE COMPARATOR
 *
 * `replacement-state-machine.ts` can already decide whether two fingerprints differ. Nothing
 * could BUILD one, so the format was implicitly whatever the first caller happened to write.
 * Two callers inventing their own layout is worse than having none: every stored fingerprint
 * mismatches every freshly-computed one, every replacement lands in `review`, and the drift
 * check degrades into noise that operators learn to click through. Identity formats belong in
 * exactly one place.
 *
 * WHAT IT IS NOT
 *
 * Not a permanent identifier — the card is explicit. It is drift DETECTION: proof that a
 * volatile coordinate still points at what it pointed at. If imported item JSON ever exposes
 * a durable marketplace line-item id, that becomes the preferred identity, and inventing such
 * a column requires its own source-contract audit.
 *
 * WHY line_index ALONE CANNOT CARRY THIS
 *
 * `0025_order_items_sync_trigger.sql` deletes and reinserts every row for an order on any
 * `items` update, computing `line_index` as `(item.ordinality - 1)` — raw JSON array
 * position. It also filters AFTER computing that ordinal (`WHERE sku IS NOT NULL AND
 * quantity > 0 AND adjustment NOT IN (...)`), so indices legitimately have GAPS and a
 * SKU-less or adjustment element inserted earlier in the array silently shifts every line
 * after it while producing no row of its own.
 */

/**
 * Format version. Bumping it makes every existing fingerprint mismatch DELIBERATELY, which
 * routes affected replacements to `review` — the safe direction. Without it, a change to the
 * layout would look identical to real product drift and be indistinguishable in an audit.
 */
export const REPLACEMENT_FINGERPRINT_VERSION = 'rlf1';

/** The facts the card names, and only those. */
export type ReplacementSourceLineFacts = {
  orderId: number;
  orderLineIndex: number;
  /** As stored on the line. Normalized here, so callers must not pre-normalize. */
  sku: string | null | undefined;
  name?: string | null;
  /**
   * A durable marketplace/source line id when the imported JSON carries one. Absent on most
   * payloads; when present it is the strongest fact in the tuple, because it is the only one
   * that survives a reorder.
   */
  sourceItemId?: string | number | null;
  /**
   * Ordered quantity on the ORIGINAL line — not the replacement quantity.
   *
   * `order_items.quantity` is numeric(12,3) and arrives as a string like "2.000", so this
   * accepts either and canonicalises. This field is what defeats the card's worst case:
   * duplicate-SKU lines reordered. A SKU-only check passes when `SKU-A qty 1` swaps with
   * `SKU-A qty 5`; including the quantity catches it.
   */
  originalOrderedQuantity: number | string | null | undefined;
};

/**
 * SKU comparison is trim + lowercase, matching `order_items_lower_sku_idx` — the house
 * convention is that SKUs differing only in case are the same SKU, so a case change must not
 * read as drift.
 */
function normalizeSku(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Names are trimmed but NOT lowercased and NOT dropped.
 *
 * The card lists name among the fingerprint inputs while also warning names are editable, so
 * a rename DOES land in `review`. That is the intended cost: review is a prompt, not a
 * rejection, and the alternative — ignoring the name — discards a signal precisely when a
 * line has been edited underneath a pending replacement.
 */
function normalizeName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Canonical decimal string, so "2", "2.0" and "2.000" are one value.
 *
 * numeric(12,3) round-trips through several representations depending on driver and
 * migration; without this, a harmless representation change would be indistinguishable from
 * a real quantity edit and would send healthy replacements to review.
 */
function normalizeQuantity(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return null;
  // Three decimals is the column's scale; trailing zeros and a bare "." are stripped.
  const fixed = parsed.toFixed(3);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function normalizeSourceItemId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Build the frozen fingerprint.
 *
 * Encoded with `JSON.stringify` over a fixed-order array rather than a delimiter-joined
 * string. A SKU or name containing the delimiter would otherwise let two genuinely different
 * lines produce one fingerprint — a collision in a drift check reads as "unchanged", which is
 * the silent-retarget outcome this whole mechanism exists to prevent. JSON escaping is
 * already correct for every input, so there is no hand-rolled escape to get wrong.
 */
export function buildReplacementSourceLineFingerprint(facts: ReplacementSourceLineFacts): string {
  return JSON.stringify([
    REPLACEMENT_FINGERPRINT_VERSION,
    facts.orderId,
    facts.orderLineIndex,
    normalizeSku(facts.sku),
    normalizeSourceItemId(facts.sourceItemId),
    normalizeName(facts.name),
    normalizeQuantity(facts.originalOrderedQuantity),
  ]);
}

/**
 * The fingerprint for whatever currently occupies the frozen coordinate, or null when nothing
 * does.
 *
 * Null is the "referenced line removed" case, and `evaluateReplacementSourceLineDrift` already
 * treats a null current fingerprint as DRIFT rather than a pass. Returning null rather than a
 * fabricated empty fingerprint keeps that distinction intact.
 */
export function currentSourceLineFingerprint(
  lines: readonly {
    orderId: number;
    lineIndex: number;
    sku: string | null | undefined;
    name?: string | null;
    sourceItemId?: string | number | null;
    quantity: number | string | null | undefined;
  }[],
  frozen: { orderId: number; orderLineIndex: number },
): string | null {
  const line = lines.find(
    (candidate) => candidate.orderId === frozen.orderId && candidate.lineIndex === frozen.orderLineIndex,
  );
  if (!line) return null;
  return buildReplacementSourceLineFingerprint({
    orderId: line.orderId,
    orderLineIndex: line.lineIndex,
    sku: line.sku,
    name: line.name,
    sourceItemId: line.sourceItemId,
    originalOrderedQuantity: line.quantity,
  });
}

/**
 * Does the frozen SKU still appear on the order, and where?
 *
 * The card requires review to show "whether the frozen SKU appears elsewhere" — that is what
 * lets an operator tell "this line moved" apart from "this product is gone", which are the
 * same 409 but completely different decisions. Read-only; it proposes nothing.
 */
export function findFrozenSkuElsewhere(
  lines: readonly { lineIndex: number; sku: string | null | undefined }[],
  frozen: { orderLineIndex: number; sku: string | null | undefined },
): number[] {
  const target = normalizeSku(frozen.sku);
  if (target === '') return [];
  return lines
    .filter((line) => line.lineIndex !== frozen.orderLineIndex && normalizeSku(line.sku) === target)
    .map((line) => line.lineIndex)
    .sort((a, b) => a - b);
}
