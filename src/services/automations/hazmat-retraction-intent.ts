// PS-475: decide whether the dangerous-goods mark should come back off.
//
// DJ: "if the rules is turn off it must untick and if i turn on it will
// automatically tick."
//
// This file used to SYNTHESISE a hazmat.retract intent so the retraction could
// ride the normal intent pipeline. That was structurally impossible and it
// failed in production: automation_action_results.ruleVersionId is
// `integer NOT NULL REFERENCES automation_rule_versions(id)`, so every effect
// row must be attributable to a persisted rule version. A retraction has no
// rule behind it by definition -- the rule is exactly what went away. The
// sentinel ids threw "Rule version ID must be a persisted numeric ID", retried
// five times, and died, leaving orders 3240/3241 still marked.
//
// So the decision stays here as a pure predicate, and the ACT is an explicit
// convergence step in the orchestrator rather than a fake intent. Nothing is
// lost by leaving the effect table alone: the hazmat declaration carries its
// own audit trail -- revision increments, decision_source, and the append-only
// shipment_hazmat_snapshots triggers -- which is where a compliance change
// belongs anyway.
import type { AutomationFacts, AutomationIntent } from './contracts.js';

/**
 * True when the evaluated rules no longer declare dangerous goods but the order
 * still carries an active declaration.
 *
 * Refusals encoded here:
 *   - terminal orders. A shipped or cancelled declaration is history.
 *   - unknown hazmat state. workflow.hazmatState is 'unknown' when no canonical
 *     declaration evidence was supplied; retracting on a guess is the wrong move.
 *   - a rule still declaring hazmat. The rule always wins over cleanup.
 *
 * NOT decided here: manual declarations. The facts carry no decisionSource, so
 * the convergence step makes that call -- a human tick must survive a rule
 * toggle.
 *
 * Optional chaining on `workflow` is deliberate: AutomationFacts types it as
 * required, but callers build partial facts (the PS-469 guard does), and
 * dereferencing it crashed every run there. Missing workflow is also the correct
 * fail-safe -- unknown state must never retract.
 */
export function shouldRetractAutomationHazmat(
  intents: AutomationIntent[],
  facts: AutomationFacts,
  terminal: boolean,
): boolean {
  if (terminal) return false;
  if (facts.workflow?.hazmatState !== 'active') return false;
  return !intents.some((intent) => intent.action.type === 'hazmat.add_declaration');
}
