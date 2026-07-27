import { getAutomationActionDefinition, type AutomationAction } from './catalog.js';

/**
 * Decides whether publishing a rule must be preceded by a simulation.
 *
 * PS-466 originally required a simulation for every publish. That is correct
 * for anything that can move money or block fulfilment, but it also made a
 * tag-only rule -- which ShipStation publishes in one step -- cost three.
 *
 * The line is drawn at the action registry rather than at the UI: an action
 * needs a simulation when it is anything other than low risk, or when it
 * invalidates rate proof. Today only tag.add clears both bars, and that is the
 * point -- every other action either spends money, blocks a shipment, or wipes
 * a selected rate, and none of those should reach live orders unproven.
 *
 * Deriving this from risk/invalidatesRateProof rather than an explicit list
 * means a new action is gated by default: it can only become exempt by being
 * declared low risk AND rate-proof-neutral, which is a deliberate act.
 */
export function actionRequiresSimulation(action: AutomationAction): boolean {
  const definition = getAutomationActionDefinition(action.type);
  // An unknown action type is gated. Validation rejects it separately; this
  // must never be the reason something dangerous slipped through.
  if (!definition) return true;
  return definition.risk !== 'low' || definition.invalidatesRateProof;
}

/**
 * True when any action in the document requires a simulation before publish.
 * An empty action list is gated -- publishing a rule that does nothing is a
 * mistake worth stopping, and document validation already requires at least
 * one action.
 */
export function documentRequiresSimulation(actions: readonly AutomationAction[]): boolean {
  if (!Array.isArray(actions) || actions.length === 0) return true;
  return actions.some((action) => actionRequiresSimulation(action));
}
