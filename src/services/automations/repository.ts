import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders } from '../../db/schema/orders.js';
import { orderScopePredicate } from '../../lib/order-scope.js';
import {
  automationActionResults,
  automationRuleActions,
  automationRuleConditions,
  automationOutbox,
  automationReprocessJobs,
  automationRules,
  automationRuleVersions,
  automationRuns,
} from '../../db/schema/automations.js';
import type { ClientStoreScope } from '../../lib/client-store-scope.js';
import { assertResourceInScope } from '../../lib/scope-predicates.js';
import { getAutomationActionDefinition } from './catalog.js';
import {
  compileAutomationRuleVersion,
  automationDocumentHash,
  type AutomationCondition,
  type AutomationRuleDocument,
  type CompiledAutomationRule,
} from './contracts.js';
import { reduceAutomationIntents } from './conflicts.js';
import { evaluateAutomationBundle } from './evaluator.js';
import { isTerminalAutomationStatus, loadAutomationFacts } from './facts.js';

export class AutomationConflictError extends Error {
  readonly code = 'AUTOMATION_REVISION_CONFLICT';
  constructor(message = 'Automation draft changed; reload before saving') {
    super(message);
    this.name = 'AutomationConflictError';
  }
}

function scopePredicate(scope: ClientStoreScope) {
  if (!scope.isRestricted) return undefined;
  const predicates = [];
  if (scope.clientIds.length > 0) predicates.push(inArray(automationRules.clientId, scope.clientIds));
  if (scope.storeIds.length > 0) predicates.push(inArray(automationRules.storeId, scope.storeIds));
  return predicates.length > 0 ? or(...predicates) : sql<boolean>`false`;
}

function assertDocumentScope(scope: ClientStoreScope, document: AutomationRuleDocument): void {
  if (!scope.isRestricted) return;
  const clientVisible = document.scope.clientIds.every((id) => scope.clientIds.includes(id));
  const storeVisible = document.scope.storeIds.every((id) => scope.storeIds.includes(id));
  if (!clientVisible || !storeVisible || (document.scope.clientIds.length === 0 && document.scope.storeIds.length === 0)) {
    throw new Error('Automation not found');
  }
}

function persistedScope(document: AutomationRuleDocument): { clientId: number | null; storeId: number | null } {
  if (document.scope.clientIds.length > 1 || document.scope.storeIds.length > 1) {
    throw new Error('MVP rules support one client and one store scope; create separate rules for additional scopes');
  }
  return {
    clientId: document.scope.clientIds[0] ?? null,
    storeId: document.scope.storeIds[0] ?? null,
  };
}

function documentOf(value: unknown): AutomationRuleDocument {
  if (!value || typeof value !== 'object') throw new Error('Automation version document is invalid');
  return value as AutomationRuleDocument;
}

async function loadRuleForScope(ruleId: number, scope: ClientStoreScope) {
  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, ruleId)).limit(1);
  if (!rule) throw new Error('Automation not found');
  assertResourceInScope(scope, rule, 'Automation not found');
  return rule;
}

export async function listAutomationRules(scope: ClientStoreScope) {
  const predicate = scopePredicate(scope);
  const query = db
    .select({
      rule: automationRules,
      activeVersion: automationRuleVersions,
    })
    .from(automationRules)
    .leftJoin(automationRuleVersions, eq(automationRuleVersions.id, automationRules.activeVersionId))
    .orderBy(asc(automationRules.priority), asc(automationRules.position), asc(automationRules.id));
  const rows = predicate ? await query.where(predicate) : await query;
  return rows.map(({ rule, activeVersion }) => ({
    ...rule,
    activeVersion: activeVersion ? {
      id: activeVersion.id,
      versionNumber: activeVersion.versionNumber,
      documentHash: activeVersion.documentHash,
      publishedAt: activeVersion.publishedAt,
    } : null,
  }));
}

export async function getAutomationRule(ruleId: number, scope: ClientStoreScope) {
  const rule = await loadRuleForScope(ruleId, scope);
  const versions = await db
    .select()
    .from(automationRuleVersions)
    .where(eq(automationRuleVersions.ruleId, ruleId))
    .orderBy(desc(automationRuleVersions.versionNumber));
  return { rule, versions };
}

async function persistVersionChildren(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  versionId: number,
  document: AutomationRuleDocument,
): Promise<void> {
  const insertCondition = async (
    node: AutomationCondition,
    parentConditionId: number | null,
    position: number,
    depth: number,
  ): Promise<void> => {
    const [inserted] = await tx.insert(automationRuleConditions).values({
      ruleVersionId: versionId,
      parentConditionId,
      position,
      nodeKind: node.kind,
      groupOperator: node.kind === 'group' ? node.op : null,
      fieldKey: node.kind === 'predicate' ? node.field : null,
      operator: node.kind === 'predicate' ? node.operator : null,
      typedValue: node.kind === 'predicate' ? node.value : null,
      depth,
    }).returning({ id: automationRuleConditions.id });
    const conditionId = inserted?.id;
    if (conditionId == null) throw new Error('Failed to persist automation condition');
    if (node.kind === 'group') {
      for (const [childPosition, child] of node.children.entries()) {
        await insertCondition(child, conditionId, childPosition, depth + 1);
      }
    } else if (node.kind !== 'predicate') {
      await insertCondition(node.condition, conditionId, 0, depth);
    }
  };
  await insertCondition(document.condition, null, 0, 1);
  for (const [position, action] of document.actions.entries()) {
    const definition = getAutomationActionDefinition(action.type);
    if (!definition) throw new Error(`Unsupported automation action: ${action.type}`);
    await tx.insert(automationRuleActions).values({
      ruleVersionId: versionId,
      position,
      actionType: action.type,
      schemaVersion: action.schemaVersion,
      config: action.config,
      actionClass: definition.actionClass,
      riskClass: definition.risk,
      invalidatesRateProof: definition.invalidatesRateProof,
    });
  }
}

export async function createAutomationDraft(input: {
  document: AutomationRuleDocument;
  actor: string;
  scope: ClientStoreScope;
}) {
  assertDocumentScope(input.scope, input.document);
  const compiled = compileAutomationRuleVersion(input.document, {
    ruleId: 'pending',
    versionId: 'pending-v1',
    versionNumber: 1,
  });
  const ruleScope = persistedScope(compiled.document);
  return db.transaction(async (tx) => {
    const [rule] = await tx.insert(automationRules).values({
      name: compiled.document.name,
      description: compiled.document.description ?? null,
      clientId: ruleScope.clientId,
      storeId: ruleScope.storeId,
      priority: compiled.document.priority,
      position: compiled.document.position,
      trigger: compiled.document.trigger,
      status: 'draft',
      draftRevision: 1,
      createdBy: input.actor,
      updatedBy: input.actor,
    }).returning();
    if (!rule) throw new Error('Failed to create automation rule');
    const [version] = await tx.insert(automationRuleVersions).values({
      ruleId: rule.id,
      versionNumber: 1,
      lifecycle: 'draft',
      document: compiled.document as unknown as Record<string, unknown>,
      documentHash: compiled.documentHash,
      draftRevision: 1,
      createdBy: input.actor,
    }).returning();
    if (!version) throw new Error('Failed to create automation version');
    await persistVersionChildren(tx, version.id, compiled.document);
    return { rule, version };
  });
}

export async function updateAutomationDraft(input: {
  ruleId: number;
  expectedRevision: number;
  document: AutomationRuleDocument;
  actor: string;
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  assertDocumentScope(input.scope, input.document);
  const draft = current.versions.find((version) => version.lifecycle === 'draft');
  if (!draft) throw new Error('Automation draft not found');
  if (draft.draftRevision !== input.expectedRevision) throw new AutomationConflictError();
  const compiled = compileAutomationRuleVersion(input.document, {
    ruleId: String(input.ruleId),
    versionId: String(draft.id),
    versionNumber: draft.versionNumber,
  });
  const ruleScope = persistedScope(compiled.document);
  return db.transaction(async (tx) => {
    const [updatedVersion] = await tx
      .update(automationRuleVersions)
      .set({
        document: compiled.document as unknown as Record<string, unknown>,
        documentHash: compiled.documentHash,
        draftRevision: input.expectedRevision + 1,
        simulationHash: null,
      })
      .where(and(
        eq(automationRuleVersions.id, draft.id),
        eq(automationRuleVersions.lifecycle, 'draft'),
        eq(automationRuleVersions.draftRevision, input.expectedRevision),
      ))
      .returning();
    if (!updatedVersion) throw new AutomationConflictError();
    await tx.delete(automationRuleConditions).where(eq(automationRuleConditions.ruleVersionId, draft.id));
    await tx.delete(automationRuleActions).where(eq(automationRuleActions.ruleVersionId, draft.id));
    await persistVersionChildren(tx, draft.id, compiled.document);
    const [rule] = await tx.update(automationRules).set({
      name: compiled.document.name,
      description: compiled.document.description ?? null,
      clientId: ruleScope.clientId,
      storeId: ruleScope.storeId,
      priority: compiled.document.priority,
      position: compiled.document.position,
      trigger: compiled.document.trigger,
      draftRevision: input.expectedRevision + 1,
      updatedBy: input.actor,
      updatedAt: new Date(),
    }).where(eq(automationRules.id, input.ruleId)).returning();
    return { rule, version: updatedVersion };
  });
}

function compiledFromVersion(ruleId: number, version: typeof automationRuleVersions.$inferSelect): CompiledAutomationRule {
  const compiled = compileAutomationRuleVersion(documentOf(version.document), {
    ruleId: String(ruleId),
    versionId: String(version.id),
    versionNumber: version.versionNumber,
  });
  if (compiled.documentHash !== version.documentHash) throw new Error('Automation version document hash mismatch');
  return compiled;
}

export async function simulateAutomationDraft(input: {
  ruleId: number;
  orderId: number;
  expectedRevision: number;
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  const draft = current.versions.find((version) => version.lifecycle === 'draft');
  if (!draft) throw new Error('Automation draft not found');
  if (draft.draftRevision !== input.expectedRevision) throw new AutomationConflictError();
  const facts = await loadAutomationFacts(input.orderId, input.scope);
  const compiled = compiledFromVersion(input.ruleId, draft);
  const evaluated = evaluateAutomationBundle({ facts, trigger: compiled.document.trigger, rules: [compiled] });
  const reduced = reduceAutomationIntents(evaluated.intents);
  return {
    mode: 'simulate' as const,
    zeroWrites: true,
    zeroProviderCalls: true,
    draftHash: compiled.documentHash,
    terminalAuditOnly: isTerminalAutomationStatus(facts.order.status),
    facts,
    evaluation: evaluated,
    reduction: reduced,
  };
}

export async function publishAutomationDraft(input: {
  ruleId: number;
  expectedRevision: number;
  simulationHash: string;
  actor: string;
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  if (current.rule.systemLocked) throw new Error('System-locked automations cannot be published by operators');
  const draft = current.versions.find((version) => version.lifecycle === 'draft');
  if (!draft) throw new Error('Automation draft not found');
  if (draft.draftRevision !== input.expectedRevision) throw new AutomationConflictError();
  if (input.simulationHash !== draft.documentHash) throw new Error('Publish requires simulation of the exact draft hash');
  return db.transaction(async (tx) => {
    const [version] = await tx.update(automationRuleVersions).set({
      lifecycle: 'published',
      simulationHash: input.simulationHash,
      publishedBy: input.actor,
      publishedAt: new Date(),
    }).where(and(
      eq(automationRuleVersions.id, draft.id),
      eq(automationRuleVersions.lifecycle, 'draft'),
      eq(automationRuleVersions.draftRevision, input.expectedRevision),
      eq(automationRuleVersions.documentHash, input.simulationHash),
    )).returning();
    if (!version) throw new AutomationConflictError();
    const [rule] = await tx.update(automationRules).set({
      activeVersionId: draft.id,
      activeFrom: new Date(),
      status: 'active',
      updatedBy: input.actor,
      updatedAt: new Date(),
    }).where(eq(automationRules.id, input.ruleId)).returning();
    return { rule, version, activation: 'future_orders_only' as const };
  });
}

export async function setAutomationRuleStatus(input: {
  ruleId: number;
  status: 'paused' | 'archived';
  actor: string;
  scope: ClientStoreScope;
}) {
  const rule = await loadRuleForScope(input.ruleId, input.scope);
  if (rule.systemLocked) throw new Error('System-locked automations cannot be changed');
  const [updated] = await db.update(automationRules).set({
    status: input.status,
    archivedAt: input.status === 'archived' ? new Date() : null,
    updatedBy: input.actor,
    updatedAt: new Date(),
  }).where(eq(automationRules.id, input.ruleId)).returning();
  return updated;
}

export async function listAutomationRuns(input: {
  ruleId?: number;
  orderId?: number;
  limit: number;
  scope: ClientStoreScope;
}) {
  if (input.ruleId != null) await loadRuleForScope(input.ruleId, input.scope);
  const predicates = [];
  if (input.ruleId != null) predicates.push(eq(automationRuns.ruleId, input.ruleId));
  if (input.orderId != null) predicates.push(eq(automationRuns.orderId, input.orderId));
  const scopedOrder = orderScopePredicate(input.scope);
  if (scopedOrder) predicates.push(scopedOrder);
  const rows = await db.select({ run: automationRuns }).from(automationRuns)
    .innerJoin(orders, eq(orders.id, automationRuns.orderId))
    .where(predicates.length > 0 ? and(...predicates) : undefined)
    .orderBy(desc(automationRuns.startedAt))
    .limit(input.limit);
  return rows.map(({ run }) => run);
}

export async function getAutomationRun(runId: number, scope: ClientStoreScope) {
  const predicates = [eq(automationRuns.id, runId)];
  const scopedOrder = orderScopePredicate(scope);
  if (scopedOrder) predicates.push(scopedOrder);
  const [row] = await db.select({ run: automationRuns }).from(automationRuns)
    .innerJoin(orders, eq(orders.id, automationRuns.orderId))
    .where(and(...predicates))
    .limit(1);
  if (!row) throw new Error('Automation run not found');
  const run = row.run;
  if (run.ruleId != null) await loadRuleForScope(run.ruleId, scope);
  const effects = await db.select().from(automationActionResults)
    .where(eq(automationActionResults.runId, runId))
    .orderBy(asc(automationActionResults.actionIndex));
  return { run, effects };
}

export async function previewAutomationReprocess(input: {
  ruleId: number;
  orderIds: number[];
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  if (!current.rule.activeVersionId || current.rule.status !== 'active') {
    throw new Error('Only an active published automation can be reprocessed');
  }
  const activeVersion = current.versions.find((version) => version.id === current.rule.activeVersionId && version.lifecycle === 'published');
  if (!activeVersion) throw new Error('Active automation version not found');
  const uniqueOrderIds = [...new Set(input.orderIds)];
  if (uniqueOrderIds.length === 0 || uniqueOrderIds.length > 100) throw new Error('Reprocess preview requires 1-100 order IDs');
  const candidates = [];
  const terminalAuditOnly: number[] = [];
  for (const orderId of uniqueOrderIds) {
    const facts = await loadAutomationFacts(orderId, input.scope);
    if (isTerminalAutomationStatus(facts.order.status)) {
      terminalAuditOnly.push(orderId);
      continue;
    }
    if (facts.order.status !== 'awaiting_shipment') continue;
    candidates.push({ orderId, factsRevision: facts.revision });
  }
  const previewHash = automationDocumentHash({
    ruleId: input.ruleId,
    ruleVersionId: activeVersion.id,
    documentHash: activeVersion.documentHash,
    candidates,
  });
  return {
    ruleId: input.ruleId,
    ruleVersionId: activeVersion.id,
    candidates,
    terminalAuditOnly,
    previewHash,
    zeroWrites: true,
    zeroProviderCalls: true,
  };
}

export async function confirmAutomationReprocess(input: {
  ruleId: number;
  orderIds: number[];
  previewHash: string;
  actor: string;
  scope: ClientStoreScope;
}) {
  const preview = await previewAutomationReprocess(input);
  if (preview.previewHash !== input.previewHash) throw new AutomationConflictError('Reprocess candidates changed; run preview again');
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(automationReprocessJobs).values({
      ruleId: input.ruleId,
      ruleVersionId: preview.ruleVersionId,
      scope: { orderIds: preview.candidates.map((candidate) => candidate.orderId) },
      previewHash: preview.previewHash,
      status: 'confirmed',
      requestedBy: input.actor,
      confirmedBy: input.actor,
      totalOrders: preview.candidates.length,
      confirmedAt: new Date(),
    }).returning();
    if (!job) throw new Error('Failed to create automation reprocess job');
    await tx.insert(automationOutbox).values({
      eventKey: `automation-reprocess:${job.id}:${preview.previewHash}`,
      eventType: 'automation_reprocess_confirmed',
      aggregateType: 'automation_reprocess_job',
      aggregateId: String(job.id),
      payload: {
        jobId: job.id,
        ruleId: input.ruleId,
        ruleVersionId: preview.ruleVersionId,
        orderIds: preview.candidates.map((candidate) => candidate.orderId),
      },
    });
    return { job, preview, queued: true };
  });
}
