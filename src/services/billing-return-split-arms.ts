import { sql, type SQL } from 'drizzle-orm';
import {
  billingReturnPostageLineTypesSql,
  billingReturnProcessingLineTypesSql,
} from './billing-row-status.js';

/**
 * PS-517 r3 — the four invoice-detail arms that split return money into POSTAGE vs PROCESSING,
 * built here rather than spelled out at the call site.
 *
 * PS-517 gave the two vocabularies one owner, and a source-regex guard checked that the invoice
 * detail query consumed them. Review then defeated that guard: it kept the canonical token alive
 * in a COMMENT so the occurrence count still read 2, moved the live `bool_or` arm to a
 * hand-spelled DOUBLE-QUOTED list, and changed one member to `return_postage_typo`. The guard
 * passed while the presence flag stopped matching canonical `return_postage` — a customer-visible
 * absent-versus-zero regression on the invoice.
 *
 * The lesson is that a guard reading source text can always be satisfied by text. So the arms
 * moved here, where a test can IMPORT and RENDER them and assert the bound parameters really are
 * the canonical vocabulary. Text can lie about what the query does; rendered SQL cannot.
 *
 * Shape is unchanged from the literals it replaces, so the rendered statement is byte-identical.
 *
 * `detailAmount` is the caller's cancelled-no-charge amount expression; it is threaded through
 * rather than rebuilt, because which rows are zeroed on a cancelled order is that owner's rule.
 */
export type BillingReturnSplitArms = {
  /** Return POSTAGE money for the group, as the invoice's `return_postage_amt` text column. */
  postageAmount: SQL;
  /** Return PROCESSING money for the group, as the invoice's `return_processing_amt` column. */
  processingAmount: SQL;
  /**
   * PS-488 M3 PRESENCE, which is not the same fact as amount: `coalesce(sum(...), 0)` cannot
   * tell "never charged postage" from "charged 0.00 postage", and a processing-only return
   * exported postage as 0.00 on a client-facing document until this existed.
   */
  hasPostageLine: SQL;
  hasProcessingLine: SQL;
};

export function billingReturnSplitInvoiceArms(detailAmount: SQL): BillingReturnSplitArms {
  const postage = billingReturnPostageLineTypesSql();
  const processing = billingReturnProcessingLineTypesSql();
  return {
    postageAmount: sql`coalesce(sum(case when b.line_type in ${postage} then ${detailAmount} else 0 end), 0)::text`,
    processingAmount: sql`coalesce(sum(case when b.line_type in ${processing} then ${detailAmount} else 0 end), 0)::text`,
    hasPostageLine: sql`bool_or(b.line_type in ${postage})`,
    hasProcessingLine: sql`bool_or(b.line_type in ${processing})`,
  };
}
