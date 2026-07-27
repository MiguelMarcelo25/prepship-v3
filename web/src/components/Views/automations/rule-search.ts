/**
 * Search predicate for the Automations rules list.
 *
 * Display-only filtering. The backend remains the authority for which rules
 * exist and match orders; this only narrows what the operator sees.
 */

export type SearchableRule = {
  name: string;
  description: string | null;
  trigger: string;
  status: string;
  clientId: number | null;
  storeId: number | null;
};

/** Human-facing scope text, matching what the table renders. */
function scopeText(rule: SearchableRule): string {
  const client = rule.clientId ? `client ${rule.clientId}` : "global";
  const store = rule.storeId ? ` store ${rule.storeId}` : "";
  return `${client}${store}`;
}

/**
 * Case-insensitive match across every field the row actually displays.
 *
 * Note: rule actions are deliberately NOT searched here. The list endpoint
 * does not return action documents, so claiming to search them would be a
 * lie the data cannot back. The input placeholder is worded to match.
 */
export function matchesRuleQuery(rule: SearchableRule, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    rule.name,
    rule.description ?? "",
    rule.trigger,
    rule.trigger.replaceAll("_", " "),
    rule.status,
    scopeText(rule),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function filterRules<T extends SearchableRule>(
  rules: readonly T[],
  query: string,
): T[] {
  return rules.filter((rule) => matchesRuleQuery(rule, query));
}
