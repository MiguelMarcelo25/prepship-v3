/**
 * Pure ordering helpers for the Automations rules list.
 *
 * ShipStation runs rules top-to-bottom in an explicit operator-controlled
 * sequence. PrepShip's backend orders by (priority ASC, position ASC, id ASC)
 * -- see src/services/automations/repository.ts. These helpers translate a
 * "move this rule up/down" gesture into the priority values that reproduce the
 * intended order.
 *
 * These functions decide nothing authoritative: they only compute the numbers
 * the caller then persists through the backend draft endpoint, which remains
 * the source of truth for rule content, validation, and evaluation order.
 */

export type OrderableRule = {
  id: number;
  priority: number;
  position: number;
};

/** Gap between adjacent rules, so a later single swap touches only two rows. */
const PRIORITY_STEP = 10;

/**
 * Canonical display order. Mirrors the backend ORDER BY exactly so the list
 * the operator sees is the order the engine will actually evaluate in.
 */
export function sortRulesForDisplay<T extends OrderableRule>(
  rules: readonly T[],
): T[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority || a.position - b.position || a.id - b.id,
  );
}

export type PriorityChange = { ruleId: number; priority: number; position: number };

/**
 * Compute the priority changes needed to move one rule one slot up or down.
 *
 * Returns an empty array when the move is a no-op (already at the boundary,
 * or the rule is not present). Renumbering is uniform, which also repairs
 * pre-existing ties -- e.g. two rules both sitting at priority 100 with no
 * defined order between them.
 */
export function planRuleMove<T extends OrderableRule>(
  rules: readonly T[],
  ruleId: number,
  direction: "up" | "down",
): PriorityChange[] {
  const ordered = sortRulesForDisplay(rules);
  const from = ordered.findIndex((rule) => rule.id === ruleId);
  if (from === -1) return [];

  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return [];

  const moved = [...ordered];
  const [item] = moved.splice(from, 1);
  if (!item) return [];
  moved.splice(to, 0, item);

  const changes: PriorityChange[] = [];
  moved.forEach((rule, index) => {
    const priority = (index + 1) * PRIORITY_STEP;
    if (rule.priority !== priority || rule.position !== 0) {
      changes.push({ ruleId: rule.id, priority, position: 0 });
    }
  });
  return changes;
}

/**
 * True when two or more rules share an identical sort key, meaning their
 * relative evaluation order is decided only by insertion id. Worth surfacing
 * to the operator, because it is not a choice they made.
 */
export function hasAmbiguousOrder(rules: readonly OrderableRule[]): boolean {
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.priority}:${rule.position}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
