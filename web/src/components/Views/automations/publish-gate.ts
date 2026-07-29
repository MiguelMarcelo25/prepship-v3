/**
 * Mirrors the backend publish gate for display purposes only.
 *
 * The backend decides whether a simulation was required from the draft's own
 * actions and rejects a publish that skipped one, so this cannot let anything
 * through. It exists so the builder can offer a one-step "Save & activate" for
 * rules that genuinely do not need testing, instead of showing every operator
 * the three-step flow that only money-path rules require.
 *
 * requiresSimulation is read from the catalog rather than recomputed from risk,
 * so the rule has one owner (src/services/automations/publish-gate.ts).
 */

export type GateableAction = { type: string };
export type GateableCatalogAction = { type: string; requiresSimulation?: boolean };

/**
 * True when any action needs a simulation. Unknown action types and an empty
 * action list are treated as gated, matching the backend's fail-closed stance.
 */
export function draftNeedsSimulation(
  actions: readonly GateableAction[],
  catalogActions: readonly GateableCatalogAction[],
): boolean {
  if (actions.length === 0) return true;
  return actions.some((action) => {
    const definition = catalogActions.find((entry) => entry.type === action.type);
    if (!definition) return true;
    return definition.requiresSimulation !== false;
  });
}

export type PublishGateState = {
  /** The rule's Active toggle. */
  activeRule: boolean;
  /** A server-side draft exists. */
  hasDraft: boolean;
  /** On-screen document differs from the last persisted draft. */
  isDirty: boolean;
  /** This rule's actions require a test before publishing. */
  needsSimulation: boolean;
  /** A test result is held, and how it came back. */
  simulation: { blocked: boolean; conflictCount: number } | null;
};

/**
 * Why publishing is not allowed right now, or null when it is.
 *
 * Extracted from AutomationsView on 2026-07-29 after a live defect: publish()
 * posts only the simulation hash, so the backend publishes the SAVED DRAFT and
 * never the on-screen document. Opening a published rule immediately clones a
 * draft, so `hasDraft` was true from the first render and an edited-but-unsaved
 * rule sailed through. An operator changed tag.add to hazmat.add_declaration,
 * published three times, and every version came back byte-identical -- the edit
 * was dropped silently, each time, with a green "Ready to publish".
 *
 * `isDirty` is checked BEFORE the simulation rules on purpose. simulate() also
 * posts only { orderId }, so a test describes the saved draft too; letting a
 * stale pass satisfy the gate is how a green tick ended up attached to a rule
 * nobody was looking at.
 *
 * Pure so it can be tested directly -- this decision is too easy to get wrong
 * to live inline in a component.
 */
export function resolvePublishBlockReason(state: PublishGateState): string | null {
  if (!state.activeRule) return "Turn on Active Rule to publish.";
  if (!state.hasDraft) {
    return state.needsSimulation
      ? "Save the draft, enter a test order ID, then run Test rule."
      : "Save the draft to publish.";
  }
  if (state.isDirty) return "Save the draft before publishing — unsaved edits are not published.";
  if (state.needsSimulation && !state.simulation) {
    return "Enter a test order ID and run Test rule before publishing.";
  }
  if (state.simulation?.blocked) return "The test is blocked. Review the test result before publishing.";
  if ((state.simulation?.conflictCount ?? 0) > 0) return "Resolve the test conflicts before publishing.";
  return null;
}
