/**
 * PS-502 / CP-061 — the canonical customer-safe replacement reason contract.
 *
 * The reason VOCABULARY is owned by the create command (`REPLACEMENT_REASONS`); the display
 * LABELS are owned HERE and are the single source of truth the Client Portal renders. CP must
 * NOT keep its own code->label map (DJ decision 2026-08-12: reason is a customer-safe
 * enum/label — `Damaged` / `Wrong item` / `Lost in transit` / `Other` — never raw free text).
 *
 * Versioned so a code-set or label change is an explicit contract bump the Client Portal pins,
 * not a silent drift. Pure and additive: no database, no shipped-order read, no mutation — it
 * only pairs four static labels with the codes the command already enforces.
 */
import { REPLACEMENT_REASONS, type ReplacementReason } from './replacement-create-command';

/**
 * The contract version. Bump when the code set OR any label changes; the Client Portal pins
 * this string and fails closed on a mismatch rather than rendering a stale label map.
 */
export const REPLACEMENT_REASON_CONTRACT_VERSION = 'replacement-request-v1';

/**
 * The customer-safe display label for every reason code. Typed as a TOTAL map over
 * `ReplacementReason`, so a new code cannot compile without a label here — the vocabulary and
 * its labels can never silently drift apart. These are the only strings a client ever sees for
 * a reason; the raw stored value is never disclosed.
 */
export const REPLACEMENT_REASON_LABELS: Record<ReplacementReason, string> = {
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  lost_in_transit: 'Lost in transit',
  other: 'Other',
};

export type ReplacementReasonContractEntry = {
  code: ReplacementReason;
  label: string;
};

export type ReplacementReasonContract = {
  version: string;
  reasons: ReplacementReasonContractEntry[];
};

/**
 * The contract the Client Portal consumes: the canonical codes in their frozen order, each
 * paired with its customer-safe label. Built FROM `REPLACEMENT_REASONS`, so the list can never
 * include a code the create command would reject, nor omit one it accepts.
 */
export function getReplacementReasonContract(): ReplacementReasonContract {
  return {
    version: REPLACEMENT_REASON_CONTRACT_VERSION,
    reasons: REPLACEMENT_REASONS.map((code) => ({
      code,
      label: REPLACEMENT_REASON_LABELS[code],
    })),
  };
}
