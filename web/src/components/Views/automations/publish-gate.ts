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
