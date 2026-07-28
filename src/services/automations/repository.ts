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
import { documentRequiresSimulation } from './publish-gate.js';
import { ruleExecutionHistoryExists } from './execution-history.js';
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

/**
 * Raised when a delete is refused because the rule already took effect.
 * Carries the specific reason so the UI can tell the operator which kind of
 * history is protecting the rule, and point them at Archive instead.
 */
export class AutomationDeleteBlockedError extends Error {
  readonly code = 'AUTOMATION_DELETE_BLOCKED';
  constructor(
    message: string,
    readonly reason: 'execution_history',
  ) {
    super(message);
    this.name = 'AutomationDeleteBlockedError';
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
      // Same expression deleteAutomationRule refuses on, so the row's delete
      // affordance and the backend guard cannot disagree.
      hasExecutionHistory: ruleExecutionHistoryExists(sql`${automationRules.id}`),
    })
    .from(automationRules)
    .leftJoin(automationRuleVersions, eq(automationRuleVersions.id, automationRules.activeVersionId))
    .orderBy(asc(automationRules.priority), asc(automationRules.position), asc(automationRules.id));
  const rows = predicate ? await query.where(predicate) : await query;
  return rows.map(({ rule, activeVersion, hasExecutionHistory }) => ({
    ...rule,
    hasExecutionHistory,
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
  /** Required only when the draft holds a gated action; see publish-gate.ts. */
  simulationHash?: string | null;
  actor: string;
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  if (current.rule.systemLocked) throw new Error('System-locked automations cannot be published by operators');
  const draft = current.versions.find((version) => version.lifecycle === 'draft');
  if (!draft) throw new Error('Automation draft not found');
  if (draft.draftRevision !== input.expectedRevision) throw new AutomationConflictError();
  // The gate is decided from the draft's own actions, never from what the
  // caller claims. A tag-only rule publishes in one step like ShipStation's;
  // anything that spends money, blocks a shipment, or invalidates rate proof
  // still has to be simulated on the exact document being published.
  const gated = documentRequiresSimulation(documentOf(draft.document).actions ?? []);
  if (gated && !input.simulationHash) {
    throw new Error('Publish requires simulation of the exact draft hash');
  }
  if (input.simulationHash && input.simulationHash !== draft.documentHash) {
    throw new Error('Publish requires simulation of the exact draft hash');
  }
  return db.transaction(async (tx) => {
    const [version] = await tx.update(automationRuleVersions).set({
      lifecycle: 'published',
      simulationHash: input.simulationHash ?? null,
      // Records why publishing was allowed. Never claim 'simulated' without a
      // hash -- the storage invariant treats that as proof a test ran.
      publishGate: input.simulationHash ? 'simulated' : 'low_risk_exempt',
      publishedBy: input.actor,
      publishedAt: new Date(),
    }).where(and(
      eq(automationRuleVersions.id, draft.id),
      eq(automationRuleVersions.lifecycle, 'draft'),
      eq(automationRuleVersions.draftRevision, input.expectedRevision),
      // Pin to the draft's own hash rather than the caller's. An ungated
      // publish carries no simulation hash, but the document must still be
      // unchanged since it was read, so the concurrency guarantee is intact.
      eq(automationRuleVersions.documentHash, draft.documentHash),
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

/**
 * Discards a rule's open draft, leaving its published history intact.
 *
 * Editing a published rule clones it into a draft, so abandoning that edit used
 * to leave a stray draft behind with no way to remove it -- DELETE /:id targets
 * the whole rule and refuses once anything is published. The only remedy was a
 * direct database delete, which is not something an operator can or should do.
 *
 * Only ever touches a draft: the guard rejects a published version, so this
 * cannot become a route to rewriting history. Rules with no open draft are a
 * no-op rather than an error, so a double click is harmless.
 */
export async function deleteAutomationDraft(input: {
  ruleId: number;
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  if (current.rule.systemLocked) {
    throw new Error('System-locked automations cannot be edited by operators');
  }
  const draft = current.versions.find((version) => version.lifecycle === 'draft');
  if (!draft) return { deleted: false as const, ruleId: input.ruleId };

  return db.transaction(async (tx) => {
    await tx.delete(automationRuleConditions).where(eq(automationRuleConditions.ruleVersionId, draft.id));
    await tx.delete(automationRuleActions).where(eq(automationRuleActions.ruleVersionId, draft.id));
    // Belt and braces: the lifecycle predicate means a version that became
    // published between the read and this write is left alone.
    const [removed] = await tx
      .delete(automationRuleVersions)
      .where(and(
        eq(automationRuleVersions.id, draft.id),
        eq(automationRuleVersions.lifecycle, 'draft'),
      ))
      .returning({ id: automationRuleVersions.id });
    if (!removed) throw new AutomationConflictError('Draft changed while being discarded');

    // A rule whose only version was that draft was never published, so nothing
    // downstream can reference it. Leaving the bare row behind would strand it:
    // it still lists, but openAutomationDraft has no version to clone and
    // throws 'Automation has no version to copy'. Discarding the first draft of
    // a brand-new rule means "I do not want this rule", so remove the row too.
    // Run and reprocess history is still checked -- if anything ever recorded
    // against this rule, the row stays and the operator archives it instead.
    const remaining = current.versions.filter((version) => version.id !== draft.id);
    if (remaining.length > 0) {
      return { deleted: true as const, ruleId: input.ruleId, versionId: draft.id, ruleRemoved: false as const };
    }

    const [runCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(eq(automationRuns.ruleId, input.ruleId));
    const [jobCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(automationReprocessJobs)
      .where(eq(automationReprocessJobs.ruleId, input.ruleId));
    if ((runCount?.count ?? 0) > 0 || (jobCount?.count ?? 0) > 0) {
      return { deleted: true as const, ruleId: input.ruleId, versionId: draft.id, ruleRemoved: false as const };
    }

    await tx.delete(automationRules).where(eq(automationRules.id, input.ruleId));
    return { deleted: true as const, ruleId: input.ruleId, versionId: draft.id, ruleRemoved: true as const };
  });
}

/**
 * Permanently removes an automation rule.
 *
 * Only rules that never took effect can be deleted. The schema deliberately
 * declares versions, runs, action effects, and reprocess jobs as
 * onDelete: 'restrict', so anything with execution history is protected at the
 * database level -- deleting it would destroy the audit trail PS-466 requires
 * be preserved. Those rules are archived instead, which hides them without
 * rewriting what already happened.
 */
export async function deleteAutomationRule(input: {
  ruleId: number;
  scope: ClientStoreScope;
}) {
  const rule = await loadRuleForScope(input.ruleId, input.scope);
  if (rule.systemLocked) throw new Error('System-locked automations cannot be deleted');

  const versions = await db
    .select({ id: automationRuleVersions.id, lifecycle: automationRuleVersions.lifecycle })
    .from(automationRuleVersions)
    .where(eq(automationRuleVersions.ruleId, input.ruleId));

  // Publication alone no longer blocks deletion. A rule published during
  // testing that never matched an order produced no audit trail, and treating
  // "was published once" as "has history" stranded those rules in the list
  // forever. What blocks deletion is evidence the rule actually took effect --
  // one shared expression with the rules list, so the button and the guard
  // cannot disagree.
  const [history] = await db
    .select({ used: ruleExecutionHistoryExists(input.ruleId) })
    .from(automationRules)
    .where(eq(automationRules.id, input.ruleId));
  if (history?.used) {
    throw new AutomationDeleteBlockedError(
      'This rule has already run on orders, so it cannot be deleted. Archive it instead — that hides it from the list while keeping the record of what it did.',
      'execution_history',
    );
  }

  const versionIds = versions.map((version) => version.id);
  return db.transaction(async (tx) => {
    // automation_rules.active_version_id is ON DELETE RESTRICT. It was always
    // null before, because only never-published rules could get this far and
    // only publishing sets it. An active or paused rule now reaches here with
    // it set, so it has to be released before its versions can go.
    await tx
      .update(automationRules)
      .set({ activeVersionId: null })
      .where(eq(automationRules.id, input.ruleId));
    if (versionIds.length > 0) {
      // Conditions and actions cascade from versions, but delete them
      // explicitly so the intent is visible and order is deterministic.
      await tx.delete(automationRuleConditions).where(inArray(automationRuleConditions.ruleVersionId, versionIds));
      await tx.delete(automationRuleActions).where(inArray(automationRuleActions.ruleVersionId, versionIds));
      await tx.delete(automationRuleVersions).where(eq(automationRuleVersions.ruleId, input.ruleId));
    }
    // automation_outbox is keyed by aggregate (order events), not by rule, so
    // there is nothing rule-scoped to remove there.
    await tx.delete(automationRules).where(eq(automationRules.id, input.ruleId));
    return { deleted: true as const, ruleId: input.ruleId };
  });
}

/**
 * Reopens a published rule for editing by cloning its live version into a new
 * draft.
 *
 * Publishing flips the draft version to 'published' and leaves none behind, and
 * updateAutomationDraft requires an open draft. Without this, a rule became
 * permanently frozen the moment it was published: it could not be edited,
 * reordered, or reactivated, only paused or archived.
 *
 * Published versions stay immutable. This never rewrites one -- it copies the
 * document into a brand new draft version, so history is untouched and the
 * live version keeps serving orders until the new draft is simulated and
 * published in its own right.
 *
 * Idempotent: if a draft is already open it is returned as-is, so a double
 * click cannot create two competing drafts.
 */
export async function openAutomationDraft(input: {
  ruleId: number;
  actor: string;
  scope: ClientStoreScope;
}) {
  const current = await getAutomationRule(input.ruleId, input.scope);
  if (current.rule.systemLocked) {
    throw new Error('System-locked automations cannot be edited by operators');
  }

  const existingDraft = current.versions.find((version) => version.lifecycle === 'draft');
  if (existingDraft) {
    return { rule: current.rule, version: existingDraft, created: false as const };
  }

  // Prefer the version currently serving orders; fall back to the highest
  // version number so an archived or paused rule can still be reopened.
  const sourceVersion = current.versions.find((version) => version.id === current.rule.activeVersionId)
    ?? [...current.versions].sort((left, right) => right.versionNumber - left.versionNumber)[0];
  if (!sourceVersion) throw new Error('Automation has no version to copy');

  const nextVersionNumber = current.versions.reduce(
    (highest, version) => Math.max(highest, version.versionNumber),
    0,
  ) + 1;
  const compiled = compileAutomationRuleVersion(documentOf(sourceVersion.document), {
    ruleId: String(input.ruleId),
    versionId: 'pending',
    versionNumber: nextVersionNumber,
  });

  return db.transaction(async (tx) => {
    const [version] = await tx.insert(automationRuleVersions).values({
      ruleId: input.ruleId,
      versionNumber: nextVersionNumber,
      lifecycle: 'draft',
      document: compiled.document as unknown as Record<string, unknown>,
      documentHash: compiled.documentHash,
      draftRevision: 1,
      createdBy: input.actor,
    }).returning();
    if (!version) throw new Error('Failed to open automation draft');
    await persistVersionChildren(tx, version.id, compiled.document);
    const [rule] = await tx.update(automationRules).set({
      draftRevision: 1,
      updatedBy: input.actor,
      updatedAt: new Date(),
    }).where(eq(automationRules.id, input.ruleId)).returning();
    return { rule: rule ?? current.rule, version, created: true as const };
  });
}

export async function setAutomationRuleStatus(input: {
  ruleId: number;
  status: 'active' | 'paused' | 'archived';
  actor: string;
  scope: ClientStoreScope;
}) {
  const rule = await loadRuleForScope(input.ruleId, input.scope);
  if (rule.systemLocked) throw new Error('System-locked automations cannot be changed');
  if (input.status === 'active') {
    // Resuming is the exact inverse of pausing: the published version was never
    // withdrawn, so the rule simply starts being consulted again. It is not a
    // republish and mints no new version, which is why it needs no simulation.
    if (rule.status === 'archived') {
      throw new Error('Archived automations cannot be reactivated; copy the rule instead');
    }
    if (rule.activeVersionId == null) {
      throw new Error('This automation has never been published; publish the draft to activate it');
    }
  }
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
