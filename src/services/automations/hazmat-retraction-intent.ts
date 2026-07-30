// PS-475: make the dangerous-goods mark follow the rules in BOTH directions.
//
// DJ: "if the rules is turn off it must untick and if i turn on it will
// automatically tick."
//
// Ticking already worked -- a matching rule emits hazmat.add_declaration and the
// handler writes it. Unticking did not, for a structural reason: when no rule
// asks for hazmat there is no intent, so no handler runs, so nothing retracts.
// Orders 3240/3241/3242 kept their HAZMAT badge with every rule paused.
//
// Rather than bolt a special case onto the apply loop, the engine synthesises a
// retract intent BEFORE reduction. It then flows through the normal pipeline --
// conflict reduction, effect lease, idempotency key, effect row, rate-proof
// invalidation -- and inherits all of it instead of re-implementing any of it.
import type { AutomationFacts } from './contracts.js';
import type { AutomationIntent } from './contracts.js';

/** Sentinel provenance: no rule authored this, the engine did. */
export const HAZMAT_RETRACTION_RULE_ID = 'system:hazmat-convergence';
export const HAZMAT_RETRACTION_VERSION_ID = 'system';
export const HAZMAT_RETRACTION_INTENT_ID = `${HAZMAT_RETRACTION_RULE_ID}:0`;

/**
 * Append a hazmat retraction intent when the evaluated rules no longer declare
 * dangerous goods but the order still carries an active declaration.
 *
 * Deliberately NOT handled here:
 *   - manual declarations. The facts carry no decisionSource, so the handler
 *     makes that call. A human tick must survive a rule toggle, and the handler
 *     already refuses to overwrite decisionSource 'manual'.
 *
 * Handled here:
 *   - terminal orders. A shipped or cancelled order is history and its
 *     declaration is a compliance record; we do not even propose a change.
 *   - unknown hazmat state. workflow.hazmatState is 'unknown' when the caller
 *     supplied no canonical declaration evidence (PS-465 is the sole owner and
 *     nothing infers it from tags or provider payloads). Retracting on a guess
 *     is precisely the wrong move, so only an explicit 'active' qualifies.
 */
export function withHazmatRetractionIntent(
  intents: AutomationIntent[],
  facts: AutomationFacts,
  terminal: boolean,
): AutomationIntent[] {
  if (terminal) return intents;
  // Optional chaining is deliberate. AutomationFacts types `workflow` as
  // required, but callers construct partial facts (the PS-469 guard does), and
  // dereferencing it crashed every run there. A missing workflow block is also
  // the correct fail-safe: unknown state must never retract.
  if (facts.workflow?.hazmatState !== 'active') return intents;
  if (intents.some((intent) => intent.action.type === 'hazmat.add_declaration')) return intents;
  if (intents.some((intent) => intent.action.type === 'hazmat.retract')) return intents;

  return [
    ...intents,
    {
      intentId: HAZMAT_RETRACTION_INTENT_ID,
      ruleId: HAZMAT_RETRACTION_RULE_ID,
      versionId: HAZMAT_RETRACTION_VERSION_ID,
      // Lowest precedence: a real rule's decision always sorts ahead of the
      // engine's cleanup. In practice they never coexist -- the retraction is
      // only added when no add_declaration intent exists -- but if that ever
      // changes, the rule must win.
      priority: Number.MAX_SAFE_INTEGER,
      position: Number.MAX_SAFE_INTEGER,
      actionIndex: 0,
      action: { type: 'hazmat.retract', schemaVersion: 1, config: {} },
    },
  ];
}
