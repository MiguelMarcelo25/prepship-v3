/**
 * PS-521 — the RETURN line-type vocabulary, as a dependency-free LEAF.
 *
 * This is the one owner of "which billing_line_items.line_type spellings are return money", in
 * both shapes every caller needs: TypeScript predicates for classifying a row, and SQL `in (...)`
 * lists for the queries that bucket money. It imports nothing from this codebase on purpose.
 *
 * WHY A LEAF. PS-501/PS-515 gave the aggregate list one owner and PS-517 did the same for the
 * split buckets — but both lived in billing-row-status.ts, which imports
 * isCancelledBillingStatus from billing-cancelled-no-charge.ts. That file needs this vocabulary
 * too (a cancelled order must NOT strip a return charge), and importing it back the other way
 * is an import cycle. So it kept a private copy — the exact second-owner failure mode the owner
 * exists to end: a spelling added here and missed there changes which rows are treated as
 * return money, silently, with grand_total still footing. A module with no dependencies can be
 * imported from anywhere, cycle-free. billing-row-status.ts re-exports everything below so its
 * existing importers do not move.
 *
 * DOWNSTREAM COUPLING — the Client Portal SCRAPES these declarations.
 *
 * client-portal-prepship pins THIS file in contracts/prepship-billing-return-line-types.json
 * (path + blob sha) and re-derives the vocabulary from the three `..._LINE_TYPES = [ ... ]`
 * declarations in scripts/prepship-return-vocabulary-parity.mjs. Renaming or restructuring
 * them means re-pinning that contract in the same breath, or the portal's gate fails on its
 * next re-pin. That is also why BILLING_RETURN_LINE_TYPES stays a LITERAL list rather than a
 * spread of the buckets: a spread would not parse there, and it would reorder the SQL `in`
 * list. Membership cannot drift anyway — test:ps-521-return-vocabulary-leaf asserts, executed,
 * that the aggregate equals postage ∪ processing ∪ bare.
 */
import { sql, type SQL } from 'drizzle-orm';

/** The bare legacy spelling: a return line that predates the postage/processing split. */
export const BILLING_RETURN_BARE_LINE_TYPES = ['return'] as const;

/** Return postage, including the legacy `return_label` spelling. */
export const BILLING_RETURN_POSTAGE_LINE_TYPES = ['return_postage', 'return_label'] as const;

/** Return processing, including the legacy `return_processing` spelling. */
export const BILLING_RETURN_PROCESSING_LINE_TYPES = [
  'return_processing_fee',
  'return_processing',
] as const;

/**
 * PS-501: the AGGREGATE vocabulary — every spelling that is return money.
 *
 * The summary's return bucket has to sum exactly the line types the predicate accepts.
 * Re-listing them in a SQL `case` would create a second owner of the same fact, and the
 * failure mode is silent — a spelling present here and missing there drops return money
 * out of the bucket while leaving it in grandTotal, so the row simply stops reconciling.
 *
 * Kept in this ORDER: it is the order the aggregate SQL has always rendered, and the order
 * the portal's pinned contract carries. See the module comment for why it is not a spread.
 */
export const BILLING_RETURN_LINE_TYPES = [
  'return',
  'return_label',
  'return_processing',
  'return_postage',
  'return_processing_fee',
] as const;

export type BillingReturnLineType = (typeof BILLING_RETURN_LINE_TYPES)[number];

function normalizedLineType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function isBillingReturnLineType(lineType: unknown): boolean {
  const value = normalizedLineType(lineType);
  return value != null && (BILLING_RETURN_LINE_TYPES as readonly string[]).includes(value);
}

export function isBillingReturnPostageLineType(lineType: unknown): boolean {
  const value = normalizedLineType(lineType);
  return value != null && (BILLING_RETURN_POSTAGE_LINE_TYPES as readonly string[]).includes(value);
}

export function isBillingReturnProcessingLineType(lineType: unknown): boolean {
  const value = normalizedLineType(lineType);
  return value != null
    && (BILLING_RETURN_PROCESSING_LINE_TYPES as readonly string[]).includes(value);
}

/**
 * The vocabularies as SQL `in (...)` lists.
 *
 * Deliberately NOT case-normalising: these render into existing `b.line_type in (...)` arms,
 * and adding lower() here would change which rows are counted — a money-display change
 * wearing a refactor's clothes. The predicates lowercase because they classify arbitrary
 * input; the SQL matches the rows the SQL has always matched.
 */
function inList(lineTypes: readonly string[]): SQL {
  return sql`(${sql.join(lineTypes.map((lineType) => sql`${lineType}`), sql`, `)})`;
}

/** Every return spelling, for the aggregate return bucket. */
export function billingReturnLineTypesSql(): SQL {
  return inList(BILLING_RETURN_LINE_TYPES);
}

export function billingReturnPostageLineTypesSql(): SQL {
  return inList(BILLING_RETURN_POSTAGE_LINE_TYPES);
}

export function billingReturnProcessingLineTypesSql(): SQL {
  return inList(BILLING_RETURN_PROCESSING_LINE_TYPES);
}
