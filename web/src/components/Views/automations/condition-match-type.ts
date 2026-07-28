/**
 * Whether a rule's conditions are ANDed or ORed.
 *
 * The engine has always supported group op 'all' | 'any' | 'not' and arbitrary
 * nesting; the builder only ever emitted `{op: 'all'}`, so an OR rule could not
 * be expressed at all -- "HU-10 or HU-20" meant maintaining two duplicate rules
 * that drift apart. This is the top-level ALL/ANY selector ShipStation has.
 *
 * Nesting is still not exposed. A single top-level choice covers the common
 * case; mixed AND/OR trees need a real nested editor and are deliberately not
 * faked with a flat list.
 */

export type ConditionMatchType = 'all' | 'any';

export function isConditionMatchType(value: unknown): value is ConditionMatchType {
  return value === 'all' || value === 'any';
}

/**
 * Reads the match type back off a stored document.
 *
 * Defaults to 'all' for anything unrecognised, which is what every rule
 * written before this existed used -- so an old document keeps its meaning
 * instead of silently becoming an OR.
 */
export function parseConditionMatchType(document: unknown): ConditionMatchType {
  if (typeof document !== 'object' || document === null) return 'all';
  const node = document as { kind?: unknown; op?: unknown };
  if (node.kind !== 'group') return 'all';
  return isConditionMatchType(node.op) ? node.op : 'all';
}
