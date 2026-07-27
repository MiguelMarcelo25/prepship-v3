import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { orders } from './orders.js';

export const automationRules = pgTable('automation_rules', {
  id: serial().primaryKey(),
  name: text().notNull(),
  description: text(),
  clientId: integer().references(() => clients.id, { onDelete: 'restrict' }),
  storeId: integer(),
  priority: integer().notNull().default(100),
  position: integer().notNull().default(0),
  trigger: text().notNull(),
  status: text().notNull().default('draft'),
  activeVersionId: integer(),
  activeFrom: timestamp({ withTimezone: true }),
  draftRevision: integer().notNull().default(1),
  systemLocked: boolean().notNull().default(false),
  provenance: text().notNull().default('operator'),
  createdBy: text().notNull(),
  updatedBy: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp({ withTimezone: true }),
}, (table) => [
  index('automation_rules_scope_status_idx').on(
    table.clientId,
    table.storeId,
    table.status,
    table.priority,
    table.position,
  ),
  index('automation_rules_activation_idx').on(table.status, table.activeFrom, table.clientId, table.storeId),
]);

export const automationRuleVersions = pgTable('automation_rule_versions', {
  id: serial().primaryKey(),
  ruleId: integer().notNull().references(() => automationRules.id, { onDelete: 'restrict' }),
  versionNumber: integer().notNull(),
  lifecycle: text().notNull().default('draft'),
  document: jsonb().$type<Record<string, unknown>>().notNull(),
  documentHash: text().notNull(),
  draftRevision: integer().notNull().default(1),
  simulationHash: text(),
  /**
   * Why this version was allowed to publish: 'simulated' (proof present and
   * matching document_hash) or 'low_risk_exempt' (no simulation was required).
   * Null on drafts. See src/services/automations/publish-gate.ts.
   */
  publishGate: text().$type<'simulated' | 'low_risk_exempt'>(),
  simulationRunId: bigint({ mode: 'number' }),
  createdBy: text().notNull(),
  publishedBy: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp({ withTimezone: true }),
}, (table) => [
  unique('automation_versions_rule_number_unq').on(table.ruleId, table.versionNumber),
  index('automation_versions_rule_lifecycle_idx').on(table.ruleId, table.lifecycle, table.versionNumber),
]);

export const automationRuleConditions = pgTable('automation_rule_conditions', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  ruleVersionId: integer().notNull().references(() => automationRuleVersions.id, { onDelete: 'cascade' }),
  parentConditionId: bigint({ mode: 'number' }),
  position: integer().notNull(),
  nodeKind: text().notNull(),
  groupOperator: text(),
  fieldKey: text(),
  operator: text(),
  typedValue: jsonb(),
  depth: integer().notNull(),
}, (table) => [
  index('automation_conditions_version_parent_idx').on(table.ruleVersionId, table.parentConditionId, table.position),
]);

export const automationRuleActions = pgTable('automation_rule_actions', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  ruleVersionId: integer().notNull().references(() => automationRuleVersions.id, { onDelete: 'cascade' }),
  position: integer().notNull(),
  actionType: text().notNull(),
  schemaVersion: integer().notNull().default(1),
  config: jsonb().$type<Record<string, unknown>>().notNull(),
  actionClass: text().notNull(),
  riskClass: text().notNull(),
  invalidatesRateProof: boolean().notNull().default(false),
}, (table) => [
  unique('automation_actions_version_position_unq').on(table.ruleVersionId, table.position),
]);

export const automationShippingControls = pgTable('automation_shipping_controls', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  controlKey: text().notNull(),
  controlType: text().notNull(),
  clientId: integer().references(() => clients.id, { onDelete: 'restrict' }),
  storeId: integer(),
  carrierId: text(),
  carrierCode: text(),
  serviceCode: text(),
  serviceName: text(),
  disabled: boolean().notNull().default(true),
  reason: text(),
  systemLocked: boolean().notNull().default(false),
  provenance: text().notNull().default('operator'),
  source: text(),
  position: bigint({ mode: 'number' }).notNull(),
  sourceUpdatedAt: text(),
  updatedBy: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('automation_shipping_controls_key_unq').on(table.controlKey),
  index('automation_shipping_controls_scope_idx').on(
    table.clientId,
    table.storeId,
    table.controlType,
    table.position,
    table.id,
  ),
]);

export const automationRuns = pgTable('automation_runs', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  executionKey: text().notNull(),
  orderId: integer().references(() => orders.id, { onDelete: 'restrict' }),
  ruleId: integer().references(() => automationRules.id, { onDelete: 'restrict' }),
  trigger: text().notNull(),
  sourceEventId: text().notNull(),
  factsRevision: text().notNull(),
  rulesetDigest: text().notNull(),
  engineVersion: text().notNull(),
  mode: text().notNull(),
  status: text().notNull(),
  matchedRuleVersionIds: integer().array().notNull().default([]),
  trace: jsonb().$type<Record<string, unknown> | null>(),
  traceHash: text().notNull(),
  errorCode: text(),
  errorSummary: text(),
  createdBy: text(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp({ withTimezone: true }),
}, (table) => [
  index('automation_runs_order_trigger_idx').on(table.orderId, table.trigger, table.startedAt),
  index('automation_runs_rule_status_idx').on(table.ruleId, table.status, table.startedAt),
  unique('automation_runs_execution_unq').on(
    table.orderId,
    table.factsRevision,
    table.trigger,
    table.sourceEventId,
    table.rulesetDigest,
    table.engineVersion,
    table.mode,
  ),
  uniqueIndex('automation_runs_execution_key_idx').on(table.executionKey),
]);

export const automationActionResults = pgTable('automation_action_results', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  runId: bigint({ mode: 'number' }).notNull().references(() => automationRuns.id, { onDelete: 'restrict' }),
  ruleVersionId: integer().notNull().references(() => automationRuleVersions.id, { onDelete: 'restrict' }),
  actionIndex: integer().notNull(),
  actionType: text().notNull(),
  idempotencyKey: text().notNull(),
  status: text().notNull(),
  targetType: text(),
  targetId: text(),
  beforeSummary: jsonb().$type<Record<string, unknown> | null>(),
  afterSummary: jsonb().$type<Record<string, unknown> | null>(),
  reason: text(),
  appliedAt: timestamp({ withTimezone: true }),
  attemptCount: integer().notNull().default(0),
  leaseToken: text(),
  leaseExpiresAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('automation_action_results_idempotency_unq').on(table.idempotencyKey),
  index('automation_action_results_run_idx').on(table.runId, table.actionIndex),
  index('automation_action_results_reclaim_idx').on(table.status, table.leaseExpiresAt, table.id),
]);

export const orderAutomationState = pgTable('order_automation_state', {
  orderId: integer().primaryKey().references(() => orders.id, { onDelete: 'cascade' }),
  factsRevision: text().notNull(),
  rulesetDigest: text().notNull(),
  engineVersion: text().notNull(),
  status: text().notNull(),
  plan: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  lastRunId: bigint({ mode: 'number' }).references(() => automationRuns.id, { onDelete: 'set null' }),
  failureCode: text(),
  evaluatedAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('order_automation_state_status_idx').on(table.status, table.updatedAt)]);

export const automationOutbox = pgTable('automation_outbox', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  eventKey: text().notNull(),
  eventType: text().notNull(),
  aggregateType: text().notNull(),
  aggregateId: text().notNull(),
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  status: text().notNull().default('pending'),
  availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  attemptCount: integer().notNull().default(0),
  lockedAt: timestamp({ withTimezone: true }),
  lockedBy: text(),
  lockToken: text(),
  leaseExpiresAt: timestamp({ withTimezone: true }),
  lastError: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp({ withTimezone: true }),
}, (table) => [
  uniqueIndex('automation_outbox_event_key_unq').on(table.eventKey),
  index('automation_outbox_ready_idx').on(table.status, table.availableAt, table.id),
  index('automation_outbox_reclaim_idx').on(table.status, table.availableAt, table.leaseExpiresAt, table.id),
]);

export const automationReprocessJobs = pgTable('automation_reprocess_jobs', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  ruleId: integer().notNull().references(() => automationRules.id, { onDelete: 'restrict' }),
  ruleVersionId: integer().notNull().references(() => automationRuleVersions.id, { onDelete: 'restrict' }),
  previewRunId: bigint({ mode: 'number' }).references(() => automationRuns.id, { onDelete: 'restrict' }),
  scope: jsonb().$type<Record<string, unknown>>().notNull(),
  previewHash: text().notNull(),
  status: text().notNull().default('previewed'),
  requestedBy: text().notNull(),
  confirmedBy: text(),
  totalOrders: integer().notNull().default(0),
  processedOrders: integer().notNull().default(0),
  failedOrders: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp({ withTimezone: true }),
  completedAt: timestamp({ withTimezone: true }),
}, (table) => [index('automation_reprocess_jobs_status_idx').on(table.status, table.createdAt)]);

export type AutomationRule = typeof automationRules.$inferSelect;
export type AutomationRuleVersion = typeof automationRuleVersions.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type AutomationShippingControl = typeof automationShippingControls.$inferSelect;
