/**
 * PS-488 M2 — the ONE owner of the outbound rebuild sweep.
 *
 * WHY THIS MODULE EXISTS
 *
 * Range regeneration deletes and rebuilds OUTBOUND billing lines. It is not the owner
 * of return money — canonical return rows belong to the RETURN_BILLING_ENABLED pass,
 * and frozen legacy return rows belong to history. Before PS-488 M2 the delete
 * carried no line_type exclusion at all, so regenerating a range with the return
 * writer disabled deleted return charges and nothing put them back.
 *
 * The exclusion lives here, as a callable, rather than being written inline in the
 * generator and copied into a test. A test that reproduces the DELETE proves the
 * copy's semantics, not production's, and the two drift silently. Production and the
 * PostgreSQL 17 proof both call `deleteOutboundBillingLinesForRebuild`, so there is
 * exactly one implementation and the test cannot pass while production diverges.
 *
 * WHAT IS PRESERVED
 *
 * Every governed return line type — canonical AND frozen legacy. A legacy row without
 * relational identity still carries real historical return money, and no path
 * recreates it: outbound rebuild does not emit return lines, the canonical writer
 * never emits legacy aliases, a disabled flag stops the return pass, and pre-cutover
 * policy permanently excludes old returns. Absence of relational identity does not
 * make money disposable.
 *
 * Converting or removing legacy rows is a separately reviewed reconciliation, never a
 * side effect of outbound regeneration.
 */
import { and, sql, type SQL } from 'drizzle-orm';
import { billingLineItems } from '../db/schema/billing';
import { ALL_GOVERNED_RETURN_LINE_TYPES } from './billing-return-event-contract';
import { REPLACEMENT_LINE_TYPES } from './replacement-billing-planner';

/**
 * The line types the outbound sweep must never delete.
 *
 * PS-502 (AC-6) adds the replacement types, and they are here for EXACTLY the reason the
 * return types are. A replacement billing line carries `order_id = originalOrder.id`,
 * because the charge belongs to that customer order — so a routine regeneration of order
 * 1321 would sweep away the postage and pick/pack for a re-ship that already consumed
 * stock, and nothing would put them back. Outbound rebuild does not emit replacement
 * lines: they are written once, by the atomic shipped command.
 *
 * Nothing would have errored. The client would simply have stopped being billed.
 *
 * The two vocabularies stay SEPARATE and are unioned here. A replacement is an outbound
 * re-ship and a return is inbound; folding replacement types into the return contract
 * would make every reader that asks "is this a return?" answer yes.
 */
export const OUTBOUND_SWEEP_PRESERVED_LINE_TYPES = [
  ...ALL_GOVERNED_RETURN_LINE_TYPES,
  ...REPLACEMENT_LINE_TYPES,
] as const;

/**
 * `line_type not in (...)` over the full governed return vocabulary.
 *
 * Exported separately so a reader can see the predicate in isolation, and so a guard
 * can assert the generator composes it rather than hand-rolling an equivalent.
 */
/**
 * Kept under its historical name so PS-488's guards and proofs still bind to it, and
 * aliased below for readers who arrive through PS-502.
 */
export function outboundSweepReturnExclusion(): SQL {
  return sql`${billingLineItems.lineType} not in (${sql.join(
    OUTBOUND_SWEEP_PRESERVED_LINE_TYPES.map((lineType) => sql`${lineType}`),
    sql`, `,
  )})`;
}

/** Minimal surface the sweep needs, so tests can pass a plain drizzle instance. */
export type OutboundSweepExecutor = {
  delete: (table: typeof billingLineItems) => {
    where: (predicate: SQL | undefined) => Promise<unknown>;
  };
};

/**
 * Delete the editable outbound lines a rebuild is about to replace.
 *
 * `scope` carries the caller's own window/client/editability predicates; this owner
 * contributes the return-preservation term and performs the delete. Callers must not
 * issue their own DELETE against billingLineItems for rebuild purposes.
 */
export async function deleteOutboundBillingLinesForRebuild(
  executor: OutboundSweepExecutor,
  scope: SQL | undefined,
): Promise<void> {
  await executor.delete(billingLineItems).where(and(scope, outboundSweepReturnExclusion()));
}

/**
 * The same predicate, named for what it now does: preserve every line type the outbound
 * rebuild does not own — returns AND replacements.
 */
export const outboundSweepPreservedExclusion = outboundSweepReturnExclusion;
