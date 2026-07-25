import { AUTOMATION_ENGINE_VERSION, getAutomationFieldDefinition } from './catalog';
import type {
  AutomationCondition,
  AutomationFacts,
  AutomationIntent,
  AutomationOperator,
  AutomationPredicate,
  CompiledAutomationRule,
  TriState,
} from './contracts';

type AutomationLine = AutomationFacts['lines'][number];

export type AutomationTraceNode = {
  kind: AutomationCondition['kind'];
  result: TriState;
  summary: string;
  children?: AutomationTraceNode[];
};

export type AutomationMatchTrace = {
  ruleId: string;
  versionId: string;
  ruleName: string;
  result: TriState;
  unknownPolicy: 'no_match' | 'block';
  trace: AutomationTraceNode;
};

function and(values: TriState[]): TriState {
  if (values.includes('false')) return 'false';
  if (values.includes('unknown')) return 'unknown';
  return 'true';
}

function or(values: TriState[]): TriState {
  if (values.includes('true')) return 'true';
  if (values.includes('unknown')) return 'unknown';
  return 'false';
}

function not(value: TriState): TriState {
  if (value === 'unknown') return 'unknown';
  return value === 'true' ? 'false' : 'true';
}

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function comparableNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function compare(actual: unknown, operator: AutomationOperator, expected: unknown): TriState {
  if (actual == null) return 'unknown';
  if (operator === 'in') {
    if (!Array.isArray(expected)) return 'unknown';
    return expected.some((candidate) => compare(actual, 'eq', candidate) === 'true') ? 'true' : 'false';
  }
  if (operator === 'contains' || operator === 'not_contains') {
    const has = Array.isArray(actual)
      ? actual.some((value) => normalized(value) === normalized(expected))
      : normalized(actual).includes(normalized(expected));
    return (operator === 'contains' ? has : !has) ? 'true' : 'false';
  }
  if (operator === 'starts_with') return normalized(actual).startsWith(normalized(expected)) ? 'true' : 'false';
  if (operator === 'normalized_eq') return normalized(actual) === normalized(expected) ? 'true' : 'false';
  if (operator === 'eq' || operator === 'neq') {
    const equal = typeof actual === 'string' && typeof expected === 'string'
      ? actual === expected
      : actual === expected;
    return (operator === 'eq' ? equal : !equal) ? 'true' : 'false';
  }
  const left = comparableNumber(actual);
  const right = comparableNumber(expected);
  if (left == null || right == null) return 'unknown';
  const result = operator === 'gt'
    ? left > right
    : operator === 'gte'
      ? left >= right
      : operator === 'lt'
        ? left < right
        : left <= right;
  return result ? 'true' : 'false';
}

function factValue(facts: AutomationFacts, field: string, line: AutomationLine | null): { value: unknown; complete: boolean } {
  const values: Record<string, { value: unknown; complete: boolean }> = {
    'order.client_id': { value: facts.order.clientId, complete: facts.completeness.identity },
    'order.store_id': { value: facts.order.storeId, complete: facts.completeness.identity },
    'order.source_provider': { value: facts.order.sourceProvider, complete: facts.completeness.identity },
    'order.status': { value: facts.order.status, complete: facts.completeness.workflow },
    'order.order_total': { value: facts.order.orderTotal, complete: facts.order.orderTotal != null },
    'order.item_subtotal': { value: facts.order.itemSubtotal, complete: facts.order.itemSubtotal != null },
    'order.customer_shipping': { value: facts.order.customerShipping, complete: facts.order.customerShipping != null },
    'order.tags': { value: facts.order.tags, complete: facts.completeness.workflow },
    'destination.country': { value: facts.destination.country, complete: facts.completeness.destination },
    'destination.state': { value: facts.destination.state, complete: facts.completeness.destination },
    'destination.postal_code': { value: facts.destination.postalCode, complete: facts.completeness.destination },
    'destination.residential': { value: facts.destination.residential, complete: facts.completeness.destination },
    'destination.po_box': { value: facts.destination.poBox, complete: facts.completeness.destination },
    'package.weight_oz': { value: facts.package.weightOz, complete: facts.completeness.package },
    'package.preset_id': { value: facts.package.presetId, complete: facts.completeness.package },
    'workflow.has_selected_rate': { value: facts.workflow.hasSelectedRate, complete: facts.completeness.workflow },
    'workflow.hold_for_review': { value: facts.workflow.holdForReview, complete: facts.completeness.workflow },
    'workflow.hazmat_state': { value: facts.workflow.hazmatState, complete: facts.completeness.workflow },
    'line.sku': { value: line?.sku, complete: facts.completeness.lines && line != null },
    'line.name': { value: line?.name, complete: facts.completeness.lines && line != null },
    'line.quantity': { value: line?.quantity, complete: facts.completeness.lines && line != null },
  };
  return values[field] ?? { value: null, complete: false };
}

function evaluatePredicate(facts: AutomationFacts, predicate: AutomationPredicate, line: AutomationLine | null): AutomationTraceNode {
  const field = getAutomationFieldDefinition(predicate.field);
  const actual = factValue(facts, predicate.field, line);
  const result = actual.complete ? compare(actual.value, predicate.operator, predicate.value) : 'unknown';
  return {
    kind: 'predicate',
    result,
    summary: `${field?.label ?? predicate.field} ${predicate.operator} ${JSON.stringify(predicate.value)}`,
  };
}

function evaluateCondition(facts: AutomationFacts, node: AutomationCondition, line: AutomationLine | null = null): AutomationTraceNode {
  if (node.kind === 'predicate') return evaluatePredicate(facts, node, line);
  if (node.kind === 'line_any' || node.kind === 'line_all' || node.kind === 'line_none') {
    if (!facts.completeness.lines) {
      return { kind: node.kind, result: 'unknown', summary: `${node.kind}: canonical lines incomplete` };
    }
    const children = facts.lines.map((candidate) => evaluateCondition(facts, node.condition, candidate));
    let result: TriState;
    if (node.kind === 'line_any') result = children.length === 0 ? 'false' : or(children.map((child) => child.result));
    else if (node.kind === 'line_all') result = children.length === 0 ? 'false' : and(children.map((child) => child.result));
    else result = children.length === 0 ? 'true' : not(or(children.map((child) => child.result)));
    return { kind: node.kind, result, summary: `${node.kind} across ${facts.lines.length} canonical lines`, children };
  }
  const children = node.children.map((child) => evaluateCondition(facts, child, line));
  const result = node.op === 'all'
    ? and(children.map((child) => child.result))
    : node.op === 'any'
      ? or(children.map((child) => child.result))
      : not(children[0]?.result ?? 'unknown');
  return { kind: 'group', result, summary: node.op.toUpperCase(), children };
}

function compareRules(left: CompiledAutomationRule, right: CompiledAutomationRule): number {
  return left.document.priority - right.document.priority
    || left.document.position - right.document.position
    || left.ruleId.localeCompare(right.ruleId)
    || left.versionId.localeCompare(right.versionId);
}

function scopeMatches(facts: AutomationFacts, rule: CompiledAutomationRule): boolean {
  const { clientIds, storeIds } = rule.document.scope;
  if (clientIds.length > 0 && (facts.order.clientId == null || !clientIds.includes(facts.order.clientId))) return false;
  if (storeIds.length > 0 && (facts.order.storeId == null || !storeIds.includes(facts.order.storeId))) return false;
  return true;
}

export function evaluateAutomationBundle(input: {
  facts: AutomationFacts;
  trigger: string;
  rules: CompiledAutomationRule[];
  evaluateAllTriggers?: boolean;
}) {
  const matches: AutomationMatchTrace[] = [];
  const intents: AutomationIntent[] = [];
  for (const rule of [...input.rules].sort(compareRules)) {
    if ((!input.evaluateAllTriggers && rule.document.trigger !== input.trigger) || !scopeMatches(input.facts, rule)) continue;
    const trace = evaluateCondition(input.facts, rule.document.condition);
    matches.push({
      ruleId: rule.ruleId,
      versionId: rule.versionId,
      ruleName: rule.document.name,
      result: trace.result,
      unknownPolicy: rule.document.unknownPolicy,
      trace,
    });
    if (trace.result !== 'true') continue;
    rule.document.actions.forEach((action, actionIndex) => {
      intents.push({
        intentId: `${rule.versionId}:${actionIndex}`,
        ruleId: rule.ruleId,
        versionId: rule.versionId,
        priority: rule.document.priority,
        position: rule.document.position,
        actionIndex,
        action,
      });
    });
  }
  return {
    engineVersion: AUTOMATION_ENGINE_VERSION,
    factsRevision: input.facts.revision,
    matches,
    intents,
    blocked: matches.some((match) => match.result === 'unknown' && match.unknownPolicy === 'block'),
  };
}
