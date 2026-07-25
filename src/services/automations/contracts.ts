import { createHash } from 'node:crypto';
import {
  AUTOMATION_LIMITS,
  AUTOMATION_TRIGGERS,
  getAutomationFieldDefinition,
  validateAutomationAction,
  type AutomationAction,
  type AutomationFieldKey,
  type AutomationTrigger,
} from './catalog';

export type TriState = 'true' | 'false' | 'unknown';
export type UnknownPolicy = 'no_match' | 'block';
export type AutomationOperator =
  | 'eq'
  | 'neq'
  | 'normalized_eq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export type AutomationPredicate = {
  kind: 'predicate';
  field: AutomationFieldKey;
  operator: AutomationOperator;
  value: unknown;
};

export type AutomationGroup = {
  kind: 'group';
  op: 'all' | 'any' | 'not';
  children: AutomationCondition[];
};

export type AutomationLineCollection =
  | { kind: 'line_any'; condition: AutomationCondition }
  | { kind: 'line_all'; condition: AutomationCondition }
  | { kind: 'line_none'; condition: AutomationCondition };

export type AutomationCondition = AutomationPredicate | AutomationGroup | AutomationLineCollection;

export type AutomationFacts = {
  revision: string;
  order: {
    id: number;
    clientId: number | null;
    storeId: number | null;
    sourceProvider: string | null;
    status: string;
    orderTotal: number | null;
    itemSubtotal: number | null;
    customerShipping: number | null;
    tags: string[];
    createdAt: string;
  };
  lines: Array<{
    lineId: string;
    sku: string | null;
    name: string | null;
    quantity: number | null;
  }>;
  destination: {
    country: string | null;
    state: string | null;
    postalCode: string | null;
    residential: boolean | null;
    poBox: boolean | null;
  };
  package: {
    weightOz: number | null;
    presetId: string | null;
  };
  workflow: {
    hasSelectedRate: boolean | null;
    holdForReview: boolean | null;
    hazmatState: 'none' | 'active' | 'unknown';
  };
  completeness: {
    identity: boolean;
    lines: boolean;
    destination: boolean;
    package: boolean;
    workflow: boolean;
  };
};

export type AutomationRuleDocument = {
  schemaVersion: 1;
  name: string;
  description?: string | null;
  trigger: AutomationTrigger;
  priority: number;
  position: number;
  unknownPolicy: UnknownPolicy;
  scope: { clientIds: number[]; storeIds: number[] };
  condition: AutomationCondition;
  actions: AutomationAction[];
};

export type CompiledAutomationRule = {
  ruleId: string;
  versionId: string;
  versionNumber: number;
  documentHash: string;
  document: AutomationRuleDocument;
};

export type AutomationIntent = {
  intentId: string;
  ruleId: string;
  versionId: string;
  priority: number;
  position: number;
  actionIndex: number;
  action: AutomationAction;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function canonicalAutomationJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function automationDocumentHash(value: unknown): string {
  return createHash('sha256').update(canonicalAutomationJson(value)).digest('hex');
}

function validateTypedValue(fieldType: string, operator: AutomationOperator, value: unknown): void {
  if (operator === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      throw new Error('The in operator requires 1-100 values');
    }
    for (const member of value) validateTypedValue(fieldType, 'eq', member);
    return;
  }
  if (fieldType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Numeric automation fields require finite numeric values');
  }
  if (fieldType === 'boolean' && typeof value !== 'boolean') {
    throw new Error('Boolean automation fields require boolean values');
  }
  if ((fieldType === 'string' || fieldType === 'string_array') && (typeof value !== 'string' || !value.trim())) {
    throw new Error('Text automation fields require non-blank values');
  }
}

function validateCondition(
  node: AutomationCondition,
  state: { count: number },
  depth: number,
  insideLineCollection: boolean,
): void {
  state.count += 1;
  if (state.count > AUTOMATION_LIMITS.maxNodes) throw new Error(`Automation condition exceeds ${AUTOMATION_LIMITS.maxNodes} nodes`);
  if (depth > AUTOMATION_LIMITS.maxDepth) throw new Error(`Automation condition exceeds depth ${AUTOMATION_LIMITS.maxDepth}`);

  if (node.kind === 'predicate') {
    const field = getAutomationFieldDefinition(node.field);
    if (!field) throw new Error(`Unsupported automation field: ${String(node.field)}`);
    if (!(field.operators as readonly string[]).includes(node.operator)) {
      throw new Error(`Operator ${node.operator} is invalid for ${node.field}`);
    }
    if (node.field.startsWith('line.') !== insideLineCollection) {
      throw new Error(node.field.startsWith('line.')
        ? `${node.field} requires explicit line_any, line_all, or line_none semantics`
        : `${node.field} cannot be evaluated inside a line collection`);
    }
    validateTypedValue(field.type, node.operator, node.value);
    return;
  }

  if (node.kind === 'line_any' || node.kind === 'line_all' || node.kind === 'line_none') {
    if (insideLineCollection) throw new Error('Nested line collections are not supported');
    // Collection semantics are a scope boundary, not another expression-group
    // nesting level. This keeps "top-level group -> line_any -> one line group"
    // within the advertised three expression levels.
    validateCondition(node.condition, state, depth, true);
    return;
  }

  if (!['all', 'any', 'not'].includes(node.op)) throw new Error(`Unsupported condition group: ${String(node.op)}`);
  if (!Array.isArray(node.children) || node.children.length === 0) throw new Error('Condition groups cannot be empty');
  if (node.op === 'not' && node.children.length !== 1) throw new Error('NOT groups require exactly one child');
  for (const child of node.children) validateCondition(child, state, depth + 1, insideLineCollection);
}

function normalizeIdList(values: number[], label: string): number[] {
  if (!Array.isArray(values)) throw new Error(`${label} scope must be an array`);
  const normalized = [...new Set(values)];
  if (normalized.some((value) => !Number.isInteger(value) || value <= 0)) throw new Error(`${label} scope contains an invalid ID`);
  return normalized.sort((left, right) => left - right);
}

export function compileAutomationRuleVersion(
  document: AutomationRuleDocument,
  identity: { ruleId: string; versionId: string; versionNumber: number },
): CompiledAutomationRule {
  if (document.schemaVersion !== 1) throw new Error('Unsupported automation rule schema version');
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(document.trigger)) throw new Error(`Unsupported automation trigger: ${String(document.trigger)}`);
  if (!document.name?.trim() || document.name.trim().length > 160) throw new Error('Automation name must be 1-160 characters');
  if (!Number.isInteger(document.priority) || document.priority < 0 || document.priority > 100_000) throw new Error('Automation priority must be an integer from 0-100000');
  if (!Number.isInteger(document.position) || document.position < 0) throw new Error('Automation position must be a non-negative integer');
  if (!['no_match', 'block'].includes(document.unknownPolicy)) throw new Error('Unsupported unknown policy');
  if (!Array.isArray(document.actions) || document.actions.length === 0 || document.actions.length > AUTOMATION_LIMITS.maxActions) {
    throw new Error(`Automation versions require 1-${AUTOMATION_LIMITS.maxActions} actions`);
  }
  if (!identity.ruleId || !identity.versionId || !Number.isInteger(identity.versionNumber) || identity.versionNumber <= 0) {
    throw new Error('Compiled automation versions require stable rule and version identities');
  }

  validateCondition(document.condition, { count: 0 }, 1, false);
  const normalizedDocument: AutomationRuleDocument = {
    ...document,
    name: document.name.trim(),
    description: document.description?.trim() || null,
    scope: {
      clientIds: normalizeIdList(document.scope.clientIds, 'Client'),
      storeIds: normalizeIdList(document.scope.storeIds, 'Store'),
    },
    actions: document.actions.map((action) => validateAutomationAction(action, document.trigger)),
  };
  return {
    ...identity,
    document: normalizedDocument,
    documentHash: automationDocumentHash(normalizedDocument),
  };
}
