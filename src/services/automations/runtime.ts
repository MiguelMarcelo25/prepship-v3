import { and, desc, eq, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  automationActionResults,
  automationRules,
  automationRuleVersions,
  automationRuns,
  orderAutomationState,
} from '../../db/schema/automations.js';
import type { ClientStoreScope } from '../../lib/client-store-scope.js';
import type { LabelPurchaseLock } from '../../lib/label-purchase-lock.js';
import type { AutomationTrigger } from './catalog.js';
import { compileAutomationRuleVersion, type AutomationRuleDocument } from './contracts.js';
import { loadAutomationFacts } from './facts.js';
import { automationHazmatHandler } from './hazmat-action.js';
import { addAutomationWorkflowTag } from './order-workflow-command.js';
import {
  automationRulesetDigest,
  AutomationEffectLeaseBusyError,
  AutomationPreflightError,
  ensureAutomationStateCurrent,
  executeAutomationEvaluation,
  type AutomationHandlerRegistry,
  type AutomationWatermark,
} from './orchestrator.js';
import { createPostgresAutomationExecutionStore } from './postgres-store.js';

const planOwnedAction = async ({ facts, intent, idempotencyKey }: Parameters<NonNullable<AutomationHandlerRegistry['package.set']>>[0]) => ({
  targetType: 'order_automation_state',
  targetId: String(facts.order.id),
  after: { actionType: intent.action.type, config: intent.action.config },
  idempotencyKey,
});

export const automationHandlerRegistry: AutomationHandlerRegistry = {
  'tag.add': async ({ facts, intent, idempotencyKey }) => {
    const tag = String(intent.action.config.tag ?? '');
    const result = await addAutomationWorkflowTag({ orderId: facts.order.id, tag });
    return {
      targetType: 'order_tag',
      targetId: tag,
      before: { tags: result.before },
      after: { tags: result.after },
      idempotencyKey,
    };
  },
  'hold.for_review': async ({ facts, intent, idempotencyKey }) => {
    const result = await addAutomationWorkflowTag({ orderId: facts.order.id, tag: 'HOLD_FOR_REVIEW' });
    return {
      targetType: 'order_workflow_hold',
      targetId: String(facts.order.id),
      before: { tags: result.before },
      after: { tags: result.after, reason: intent.action.config.reason },
      idempotencyKey,
    };
  },
  'insurance.require': planOwnedAction,
  'package.set': planOwnedAction,
  'confirmation.set': planOwnedAction,
  'carrier.exclude': planOwnedAction,
  'service.exclude': planOwnedAction,
  'carrier.prefer': planOwnedAction,
  'service.prefer': planOwnedAction,
  'hazmat.add_declaration': automationHazmatHandler,
};

export async function loadActiveAutomationRules(input: {
  clientId: number | null;
  storeId: number | null;
  trigger?: AutomationTrigger;
  orderCreatedAt: Date;
}) {
  const rows = await db.select({ rule: automationRules, version: automationRuleVersions })
    .from(automationRules)
    .innerJoin(automationRuleVersions, eq(automationRuleVersions.id, automationRules.activeVersionId))
    .where(and(
      eq(automationRules.status, 'active'),
      or(isNull(automationRules.activeFrom), lte(automationRules.activeFrom, input.orderCreatedAt)),
      ...(input.trigger ? [eq(automationRules.trigger, input.trigger)] : []),
      or(isNull(automationRules.clientId), input.clientId == null ? isNull(automationRules.clientId) : eq(automationRules.clientId, input.clientId)),
      or(isNull(automationRules.storeId), input.storeId == null ? isNull(automationRules.storeId) : eq(automationRules.storeId, input.storeId)),
      eq(automationRuleVersions.lifecycle, 'published'),
    ));
  return rows.map(({ rule, version }) => {
    const compiled = compileAutomationRuleVersion(version.document as AutomationRuleDocument, {
      ruleId: String(rule.id),
      versionId: String(version.id),
      versionNumber: version.versionNumber,
    });
    if (compiled.documentHash !== version.documentHash) throw new Error(`Automation version ${version.id} hash mismatch`);
    return compiled;
  });
}

export async function evaluateOrderAutomations(input: {
  orderId: number;
  trigger: AutomationTrigger;
  sourceEventId: string;
  scope: ClientStoreScope;
}) {
  const facts = await loadAutomationFacts(input.orderId, input.scope);
  const rules = await loadActiveAutomationRules({
    clientId: facts.order.clientId,
    storeId: facts.order.storeId,
    trigger: input.trigger,
    orderCreatedAt: new Date(facts.order.createdAt),
  });
  return executeAutomationEvaluation({
    facts,
    trigger: input.trigger,
    sourceEventId: input.sourceEventId,
    rules,
    store: createPostgresAutomationExecutionStore(),
    handlers: automationHandlerRegistry,
    scope: input.scope,
  });
}

export async function evaluateOrderAutomationFactEvent(input: {
  orderId: number;
  trigger: AutomationTrigger;
  sourceEventId: string;
  scope: ClientStoreScope;
}) {
  const facts = await loadAutomationFacts(input.orderId, input.scope);
  const rules = await loadActiveAutomationRules({
    clientId: facts.order.clientId,
    storeId: facts.order.storeId,
    orderCreatedAt: new Date(facts.order.createdAt),
  });
  return executeAutomationEvaluation({
    facts,
    trigger: input.trigger,
    sourceEventId: input.sourceEventId,
    rules,
    store: createPostgresAutomationExecutionStore(),
    handlers: automationHandlerRegistry,
    evaluateAllTriggers: true,
    scope: input.scope,
  });
}

export async function reconcileOrderAutomationsForShipping(input: {
  orderId: number;
  stage: 'before_rate' | 'before_label_purchase';
  scope: ClientStoreScope;
  labelPurchaseLock?: LabelPurchaseLock;
}) {
  const facts = await loadAutomationFacts(input.orderId, input.scope);
  const rules = await loadActiveAutomationRules({
    clientId: facts.order.clientId,
    storeId: facts.order.storeId,
    orderCreatedAt: new Date(facts.order.createdAt),
  });
  const rulesetDigest = automationRulesetDigest(rules);
  const current = await loadOrderAutomationWatermark(input.orderId);
  let state: AutomationWatermark;
  try {
    state = await ensureAutomationStateCurrent({
      orderId: input.orderId,
      factsRevision: facts.revision,
      rulesetDigest,
      state: current,
    });
  } catch (error) {
    if (!(error instanceof AutomationPreflightError) || error.code !== 'AUTOMATION_EVALUATION_REQUIRED') throw error;
    let result;
    try {
      result = await executeAutomationEvaluation({
        facts,
        trigger: input.stage,
        sourceEventId: `${input.stage}:${facts.revision}:${rulesetDigest}`,
        rules,
        store: createPostgresAutomationExecutionStore(),
        handlers: automationHandlerRegistry,
        evaluateAllTriggers: true,
        scope: input.scope,
        labelPurchaseLock: input.labelPurchaseLock,
      });
    } catch (evaluationError) {
      if (evaluationError instanceof AutomationEffectLeaseBusyError) {
        throw new AutomationPreflightError(
          'AUTOMATION_EVALUATION_REQUIRED',
          'Automation evaluation is already in progress; retry before rating or label purchase',
        );
      }
      throw evaluationError;
    }
    state = {
      orderId: input.orderId,
      factsRevision: facts.revision,
      rulesetDigest,
      engineVersion: 'ps-466-v1',
      status: result.mode === 'audit_only' ? 'audit_only' : result.status === 'completed' ? 'current' : result.status,
      plan: result.reduction.plan,
      lastRunId: result.runId,
      failureCode: result.status === 'completed' ? null : `AUTOMATION_${result.status.toUpperCase()}`,
    };
    state = await ensureAutomationStateCurrent({
      orderId: input.orderId,
      factsRevision: facts.revision,
      rulesetDigest,
      state,
    });
  }
  if (state.plan.hold.required) {
    throw new AutomationPreflightError('AUTOMATION_HOLD_REQUIRED', 'Automation placed this order on review hold; resolve it before rating or label purchase');
  }
  return state;
}

// PS-472: the handler's own message for the newest failed effect on this order.
// order_automation_state stores only a generic failureCode, so the actionable
// detail ("Hazmat declaration writes are disabled.") lives one table over. This
// is read-only display detail -- it never feeds authority or the reduced plan.
async function loadLatestAutomationFailure(
  orderId: number,
): Promise<{ actionType: string | null; reason: string | null }> {
  const [row] = await db
    .select({
      actionType: automationActionResults.actionType,
      reason: automationActionResults.reason,
    })
    .from(automationActionResults)
    .innerJoin(automationRuns, eq(automationRuns.id, automationActionResults.runId))
    .where(and(
      eq(automationRuns.orderId, orderId),
      eq(automationActionResults.status, 'failed'),
    ))
    .orderBy(desc(automationActionResults.id))
    .limit(1);
  return { actionType: row?.actionType ?? null, reason: row?.reason ?? null };
}

export async function loadOrderAutomationWatermark(orderId: number): Promise<AutomationWatermark | null> {
  const [state] = await db.select().from(orderAutomationState)
    .where(eq(orderAutomationState.orderId, orderId))
    .limit(1);
  if (!state) return null;
  const status = state.status as AutomationWatermark['status'];
  // Only pay for the lookup when there is a failure to explain -- this loader
  // sits on the rating path and must stay cheap for healthy orders.
  const failure = status === 'failed'
    ? await loadLatestAutomationFailure(orderId)
    : { actionType: null, reason: null };
  return {
    orderId: state.orderId,
    factsRevision: state.factsRevision,
    rulesetDigest: state.rulesetDigest,
    engineVersion: state.engineVersion,
    status,
    plan: state.plan as AutomationWatermark['plan'],
    lastRunId: state.lastRunId,
    failureCode: state.failureCode,
    failureActionType: failure.actionType,
    failureReason: failure.reason,
  };
}

export async function assertPersistedAutomationStateCurrent(input: {
  orderId: number;
  factsRevision: string;
  rulesetDigest: string;
}) {
  return ensureAutomationStateCurrent({
    ...input,
    state: await loadOrderAutomationWatermark(input.orderId),
  });
}
