import { z } from 'zod';

export const AUTOMATION_ENGINE_VERSION = 'ps-466-v1';
export const AUTOMATION_LIMITS = {
  maxDepth: 3,
  maxNodes: 50,
  maxActions: 12,
  maxTextLength: 240,
} as const;

export const AUTOMATION_TRIGGERS = [
  'order_imported',
  'order_facts_updated',
  'order_items_changed',
  'address_changed',
  'before_rate',
  'before_label_purchase',
  'manual_reprocess',
] as const;

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTION_TYPES = [
  'tag.add',
  'hold.for_review',
  'insurance.require',
  'package.set',
  'confirmation.set',
  'carrier.exclude',
  'service.exclude',
  'carrier.prefer',
  'service.prefer',
  'hazmat.add_declaration',
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];
export type AutomationActionClass = 'accumulative' | 'restrictive' | 'minimum' | 'scalar' | 'eligibility';

export type AutomationAction = {
  type: AutomationActionType;
  schemaVersion: 1;
  config: Record<string, unknown>;
};

type ActionDefinition = {
  type: AutomationActionType;
  label: string;
  actionClass: AutomationActionClass;
  risk: 'low' | 'medium' | 'high';
  permission: 'automations:write' | 'automations:publish';
  allowedTriggers: readonly AutomationTrigger[];
  invalidatesRateProof: boolean;
  available: boolean;
  unavailableReason?: string;
  schema: z.ZodType<Record<string, unknown>>;
};

const allTriggers = [...AUTOMATION_TRIGGERS];
const shippingMutationTriggers: readonly AutomationTrigger[] = [
  'order_imported',
  'order_facts_updated',
  'order_items_changed',
  'address_changed',
  'manual_reprocess',
];

const shortText = z.string().trim().min(1).max(AUTOMATION_LIMITS.maxTextLength);
const nullableProfile = z.string().trim().min(1).max(128).nullable().optional();
const dangerousGoodsPhone = z.string().trim().min(7).max(30)
  .regex(/^[+()\-\d\s.]+$/, 'Dangerous-goods contact phone is invalid');

const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  {
    type: 'tag.add',
    label: 'Add tag',
    actionClass: 'accumulative',
    risk: 'low',
    permission: 'automations:write',
    allowedTriggers: allTriggers,
    invalidatesRateProof: false,
    available: true,
    schema: z.object({ tag: z.string().trim().min(1).max(64) }).strict(),
  },
  {
    type: 'hold.for_review',
    label: 'Hold for review',
    actionClass: 'restrictive',
    risk: 'medium',
    permission: 'automations:write',
    allowedTriggers: allTriggers,
    invalidatesRateProof: true,
    available: true,
    schema: z.object({ reason: shortText }).strict(),
  },
  {
    type: 'insurance.require',
    label: 'Require insurance',
    actionClass: 'minimum',
    risk: 'high',
    permission: 'automations:publish',
    allowedTriggers: shippingMutationTriggers,
    invalidatesRateProof: true,
    available: true,
    schema: z.object({
      minimumValue: z.number().finite().nonnegative().max(100_000),
      provider: z.enum(['parcelguard', 'carrier']),
      profileId: nullableProfile,
    }).strict(),
  },
  {
    type: 'package.set',
    label: 'Set package preset',
    actionClass: 'scalar',
    risk: 'high',
    permission: 'automations:publish',
    allowedTriggers: shippingMutationTriggers,
    invalidatesRateProof: true,
    available: false,
    unavailableReason: 'Package preset automation is unavailable until the canonical package resolver consumes automation plans',
    schema: z.object({ packagePresetId: z.string().trim().min(1).max(128) }).strict(),
  },
  {
    type: 'confirmation.set',
    label: 'Set confirmation',
    actionClass: 'scalar',
    risk: 'high',
    permission: 'automations:publish',
    allowedTriggers: shippingMutationTriggers,
    invalidatesRateProof: true,
    available: true,
    schema: z.object({ confirmation: z.enum(['none', 'delivery', 'signature', 'adult_signature']) }).strict(),
  },
  ...(['carrier.exclude', 'service.exclude'] as const).map((type): ActionDefinition => ({
    type,
    label: type === 'carrier.exclude' ? 'Exclude carrier' : 'Exclude service',
    actionClass: 'eligibility',
    risk: 'high',
    permission: 'automations:publish',
    allowedTriggers: shippingMutationTriggers,
    invalidatesRateProof: true,
    available: true,
    schema: z.object({ ids: z.array(z.string().trim().min(1).max(128)).min(1).max(50) }).strict(),
  })),
  ...(['carrier.prefer', 'service.prefer'] as const).map((type): ActionDefinition => ({
    type,
    label: type === 'carrier.prefer' ? 'Prefer carrier' : 'Prefer service',
    actionClass: 'scalar',
    risk: 'high',
    permission: 'automations:publish',
    allowedTriggers: shippingMutationTriggers,
    invalidatesRateProof: true,
    available: false,
    unavailableReason: 'Preference automation is unavailable until backend Best Rate ranking consumes the preference plan',
    schema: z.object({ id: z.string().trim().min(1).max(128) }).strict(),
  })),
  {
    type: 'hazmat.add_declaration',
    label: 'Set shipment as dangerous goods',
    actionClass: 'restrictive',
    risk: 'high',
    permission: 'automations:publish',
    allowedTriggers: ['order_imported', 'order_items_changed', 'manual_reprocess'],
    invalidatesRateProof: true,
    available: true,
    schema: z.object({
      contactName: z.string().trim().min(1).max(120),
      contactPhone: dangerousGoodsPhone,
    }).strict(),
  },
];

const actionByType = new Map(ACTION_DEFINITIONS.map((definition) => [definition.type, definition]));

export function getAutomationActionDefinition(type: string): ActionDefinition | null {
  return actionByType.get(type as AutomationActionType) ?? null;
}

export function validateAutomationAction(action: AutomationAction, trigger: AutomationTrigger): AutomationAction {
  const definition = getAutomationActionDefinition(action.type);
  if (!definition) throw new Error(`Unsupported automation action: ${String(action.type)}`);
  if (action.schemaVersion !== 1) throw new Error(`Unsupported ${action.type} schema version`);
  if (!definition.available) throw new Error(definition.unavailableReason ?? `${action.type} is unavailable`);
  if (!definition.allowedTriggers.includes(trigger)) {
    throw new Error(`${action.type} is not allowed for trigger ${trigger}`);
  }
  const parsed = definition.schema.safeParse(action.config);
  if (!parsed.success) {
    throw new Error(`Invalid ${action.type} config: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return { ...action, config: parsed.data };
}

export const AUTOMATION_FIELD_DEFINITIONS = [
  { key: 'order.client_id', label: 'Client', type: 'number', operators: ['eq', 'neq', 'in'] },
  { key: 'order.store_id', label: 'Store', type: 'number', operators: ['eq', 'neq', 'in'] },
  { key: 'order.source_provider', label: 'Source provider', type: 'string', operators: ['normalized_eq', 'contains', 'starts_with'] },
  { key: 'order.status', label: 'Order status', type: 'string', operators: ['eq', 'neq', 'in'] },
  { key: 'order.order_total', label: 'Order total', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { key: 'order.item_subtotal', label: 'Item subtotal', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { key: 'order.customer_shipping', label: 'Shipping charged to customer', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { key: 'order.tags', label: 'Tags', type: 'string_array', operators: ['contains', 'not_contains'] },
  { key: 'destination.country', label: 'Destination country', type: 'string', operators: ['normalized_eq', 'in'] },
  { key: 'destination.state', label: 'Destination state', type: 'string', operators: ['normalized_eq', 'in'] },
  { key: 'destination.postal_code', label: 'Destination postal code', type: 'string', operators: ['normalized_eq', 'starts_with'] },
  { key: 'destination.residential', label: 'Residential', type: 'boolean', operators: ['eq'] },
  { key: 'destination.po_box', label: 'PO box', type: 'boolean', operators: ['eq'] },
  { key: 'package.weight_oz', label: 'Weight (oz)', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { key: 'package.preset_id', label: 'Package preset', type: 'string', operators: ['normalized_eq', 'in'] },
  { key: 'workflow.has_selected_rate', label: 'Has selected rate', type: 'boolean', operators: ['eq'] },
  { key: 'workflow.hold_for_review', label: 'Held for review', type: 'boolean', operators: ['eq'] },
  { key: 'workflow.hazmat_state', label: 'Hazmat state', type: 'string', operators: ['eq', 'neq', 'in'] },
  { key: 'line.sku', label: 'Line SKU', type: 'string', operators: ['normalized_eq', 'contains', 'starts_with'] },
  { key: 'line.name', label: 'Line product name', type: 'string', operators: ['normalized_eq', 'contains', 'starts_with'] },
  { key: 'line.quantity', label: 'Line quantity', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
] as const;

export type AutomationFieldKey = (typeof AUTOMATION_FIELD_DEFINITIONS)[number]['key'];
const fieldByKey = new Map(AUTOMATION_FIELD_DEFINITIONS.map((field) => [field.key, field]));

export function getAutomationFieldDefinition(key: string) {
  return fieldByKey.get(key as AutomationFieldKey) ?? null;
}

export function getAutomationCatalog() {
  return {
    engineVersion: AUTOMATION_ENGINE_VERSION,
    limits: AUTOMATION_LIMITS,
    triggers: AUTOMATION_TRIGGERS.map((value) => ({ value, label: value.replaceAll('_', ' ') })),
    fields: AUTOMATION_FIELD_DEFINITIONS,
    actions: ACTION_DEFINITIONS.map(({ schema: _schema, ...definition }) => definition),
    prohibitedCapabilities: [
      'label purchase',
      'label void/refund',
      'ship/cancel status mutation',
      'marketplace notification',
      'inventory mutation',
      'billing mutation',
      'arbitrary JavaScript/SQL/JSONPath/regex/webhook/provider payload',
    ],
  };
}
