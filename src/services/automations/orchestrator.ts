import { AUTOMATION_ENGINE_VERSION, type AutomationActionType } from './catalog.js';
import type { ClientStoreScope } from '../../lib/client-store-scope.js';
import type { LabelPurchaseLock } from '../../lib/label-purchase-lock.js';
import { automationDocumentHash, type AutomationFacts, type AutomationIntent, type CompiledAutomationRule } from './contracts.js';
import { reduceAutomationIntents, type ReducedAutomationPlan } from './conflicts.js';
import { evaluateAutomationBundle } from './evaluator.js';
import { isTerminalAutomationStatus } from './facts.js';

export type AutomationStateStatus = 'pending' | 'current' | 'blocked' | 'conflict' | 'failed' | 'audit_only';

export type AutomationWatermark = {
  orderId: number;
  factsRevision: string;
  rulesetDigest: string;
  engineVersion: string;
  status: AutomationStateStatus;
  plan: ReducedAutomationPlan;
  lastRunId: string | number | null;
  failureCode: string | null;
};

export type AutomationEffectRecord = {
  runId: string | number;
  ruleId: string;
  versionId: string;
  actionIndex: number;
  actionType: AutomationActionType;
  idempotencyKey: string;
  status: 'planned' | 'applied' | 'skipped' | 'conflict' | 'failed' | 'audit_only';
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
};

export type AutomationExecutionResult = {
  runId: string | number;
  executionKey: string;
  rulesetDigest: string;
  mode: 'apply' | 'audit_only';
  status: 'completed' | 'blocked' | 'conflict' | 'failed';
  evaluation: ReturnType<typeof evaluateAutomationBundle>;
  reduction: ReturnType<typeof reduceAutomationIntents>;
};

export type AutomationEffectClaim =
  | { status: 'claimed'; claimToken: string }
  | { status: 'complete' }
  | { status: 'busy'; retryAt: Date | null };

export interface AutomationExecutionStore {
  findCompleted(executionKey: string): Promise<AutomationExecutionResult | null>;
  begin(input: {
    executionKey: string;
    orderId: number;
    trigger: string;
    sourceEventId: string;
    factsRevision: string;
    rulesetDigest: string;
    mode: 'apply' | 'audit_only';
  }): Promise<string | number>;
  claimEffect(effect: AutomationEffectRecord): Promise<AutomationEffectClaim>;
  recordEffect(effect: AutomationEffectRecord, claimToken: string): Promise<void>;
  finish(result: AutomationExecutionResult): Promise<void>;
  setState(state: AutomationWatermark): Promise<void>;
}

export type AutomationHandlerResult = {
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  idempotencyKey?: string;
};

export type AutomationHandler = (input: {
  facts: AutomationFacts;
  intent: AutomationIntent;
  plan: ReducedAutomationPlan;
  trigger: string;
  idempotencyKey: string;
  scope: ClientStoreScope;
  labelPurchaseLock?: LabelPurchaseLock;
}) => Promise<AutomationHandlerResult>;

export type AutomationHandlerRegistry = Partial<Record<AutomationActionType, AutomationHandler>>;

export class AutomationEffectLeaseBusyError extends Error {
  readonly code = 'AUTOMATION_EFFECT_BUSY';
  readonly status = 409;

  constructor(public readonly retryAt: Date | null) {
    super('Automation action evaluation is already in progress; retry after the active lease expires');
    this.name = 'AutomationEffectLeaseBusyError';
  }
}

export function automationRulesetDigest(rules: CompiledAutomationRule[]): string {
  return automationDocumentHash({
    engineVersion: AUTOMATION_ENGINE_VERSION,
    versions: rules
      .map((rule) => ({ ruleId: rule.ruleId, versionId: rule.versionId, documentHash: rule.documentHash }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId) || left.versionId.localeCompare(right.versionId)),
  });
}

/**
 * PS-469: sourceEventId is deliberately NOT part of this key.
 *
 * It used to be, and that made the whole key useless. The event id is minted by
 * the DB trigger in migration 0079 as
 *   concat('automation-facts:', table, ':', orderId, ':', txid_current(), ':', trigger)
 * -- it contains txid_current(). So every transaction that touched the order
 * produced a new event id, a new execution key, a findCompleted miss, and a full
 * re-evaluation. factsRevision sat inside the key doing nothing, because
 * sourceEventId varied independently of it.
 *
 * Measured cost before this change: 322,962 runs across 294 orders in four days,
 * 791 MB of automation_runs. One order logged six runs in three minutes with a
 * byte-identical factsRevision each time. Sync re-upserts rows that have not
 * changed (the same no-op-UPDATE class as the known 1.2M shipment updates), and
 * the trigger fires on UPDATE OF <column> whether or not the value differs.
 *
 * The key is now (orderId, factsRevision, trigger, rulesetDigest, engineVersion),
 * which is what the PS-466 spec describes -- it reads "trigger/sourceEventId",
 * and the implementation took that as both rather than either.
 *
 * Safe because the store already distinguishes outcomes: findCompleted returns
 * null for 'running' and 'failed', and begin() resets a failed row to running.
 * A repeat event on unchanged facts now returns the completed run instead of
 * recomputing it; a retry after failure still proceeds. sourceEventId is still
 * persisted on the run for provenance -- it is just not part of identity.
 */
function executionKey(input: {
  orderId: number;
  factsRevision: string;
  trigger: string;
  rulesetDigest: string;
}): string {
  return automationDocumentHash({ ...input, engineVersion: AUTOMATION_ENGINE_VERSION });
}

function effectKey(input: { executionKey: string; intent: AutomationIntent }): string {
  return automationDocumentHash({
    executionKey: input.executionKey,
    versionId: input.intent.versionId,
    actionIndex: input.intent.actionIndex,
    actionType: input.intent.action.type,
  });
}

export async function executeAutomationEvaluation(input: {
  facts: AutomationFacts;
  trigger: string;
  sourceEventId: string;
  rules: CompiledAutomationRule[];
  store: AutomationExecutionStore;
  handlers: AutomationHandlerRegistry;
  evaluateAllTriggers?: boolean;
  scope: ClientStoreScope;
  labelPurchaseLock?: LabelPurchaseLock;
}): Promise<AutomationExecutionResult> {
  const rulesetDigest = automationRulesetDigest(input.rules);
  const key = executionKey({
    orderId: input.facts.order.id,
    factsRevision: input.facts.revision,
    trigger: input.trigger,
    rulesetDigest,
  });
  const completed = await input.store.findCompleted(key);
  if (completed) return completed;

  const terminal = isTerminalAutomationStatus(input.facts.order.status);
  const mode = terminal ? 'audit_only' as const : 'apply' as const;
  const runId = await input.store.begin({
    executionKey: key,
    orderId: input.facts.order.id,
    trigger: input.trigger,
    sourceEventId: input.sourceEventId,
    factsRevision: input.facts.revision,
    rulesetDigest,
    mode,
  });
  const evaluation = evaluateAutomationBundle({
    facts: input.facts,
    trigger: input.trigger,
    rules: input.rules,
    evaluateAllTriggers: input.evaluateAllTriggers,
  });
  const reduction = reduceAutomationIntents(evaluation.intents);

  let status: AutomationExecutionResult['status'] = 'completed';
  let failureCode: string | null = null;
  if (evaluation.blocked) {
    status = 'blocked';
    failureCode = 'AUTOMATION_FACTS_UNKNOWN';
  } else if (reduction.conflicts.length > 0) {
    status = 'conflict';
    failureCode = 'AUTOMATION_CONFLICT';
  }

  if (status === 'completed') {
    for (const intent of evaluation.intents) {
      const idempotencyKey = effectKey({ executionKey: key, intent });
      const claim = await input.store.claimEffect({
        runId,
        ruleId: intent.ruleId,
        versionId: intent.versionId,
        actionIndex: intent.actionIndex,
        actionType: intent.action.type,
        idempotencyKey,
        status: 'planned',
      });
      if (claim.status === 'complete') continue;
      if (claim.status === 'busy') throw new AutomationEffectLeaseBusyError(claim.retryAt);
      if (terminal) {
        await input.store.recordEffect({
          runId,
          ruleId: intent.ruleId,
          versionId: intent.versionId,
          actionIndex: intent.actionIndex,
          actionType: intent.action.type,
          idempotencyKey,
          status: 'audit_only',
          reason: 'Terminal orders are immutable; action recorded as would-differ only',
        }, claim.claimToken);
        continue;
      }
      const handler = input.handlers[intent.action.type];
      if (!handler) {
        status = 'failed';
        failureCode = 'AUTOMATION_HANDLER_UNAVAILABLE';
        await input.store.recordEffect({
          runId,
          ruleId: intent.ruleId,
          versionId: intent.versionId,
          actionIndex: intent.actionIndex,
          actionType: intent.action.type,
          idempotencyKey,
          status: 'failed',
          reason: `No canonical handler is registered for ${intent.action.type}`,
        }, claim.claimToken);
        break;
      }
      try {
        const handled = await handler({
          facts: input.facts,
          intent,
          plan: reduction.plan,
          trigger: input.trigger,
          idempotencyKey,
          scope: input.scope,
          labelPurchaseLock: input.labelPurchaseLock,
        });
        await input.store.recordEffect({
          runId,
          ruleId: intent.ruleId,
          versionId: intent.versionId,
          actionIndex: intent.actionIndex,
          actionType: intent.action.type,
          idempotencyKey,
          status: 'applied',
          targetType: handled.targetType,
          targetId: handled.targetId,
          before: handled.before,
          after: handled.after,
        }, claim.claimToken);
      } catch (error) {
        status = 'failed';
        failureCode = 'AUTOMATION_ACTION_FAILED';
        await input.store.recordEffect({
          runId,
          ruleId: intent.ruleId,
          versionId: intent.versionId,
          actionIndex: intent.actionIndex,
          actionType: intent.action.type,
          idempotencyKey,
          status: 'failed',
          reason: error instanceof Error ? error.message : 'Canonical action handler failed',
        }, claim.claimToken);
        break;
      }
    }
  }

  const result: AutomationExecutionResult = {
    runId,
    executionKey: key,
    rulesetDigest,
    mode,
    status,
    evaluation,
    reduction,
  };
  await input.store.finish(result);
  await input.store.setState({
    orderId: input.facts.order.id,
    factsRevision: input.facts.revision,
    rulesetDigest,
    engineVersion: AUTOMATION_ENGINE_VERSION,
    status: terminal ? 'audit_only' : status === 'completed' ? 'current' : status,
    plan: reduction.plan,
    lastRunId: runId,
    failureCode,
  });
  return result;
}

export class AutomationPreflightError extends Error {
  readonly status = 409;

  constructor(public readonly code: 'AUTOMATION_EVALUATION_REQUIRED' | 'AUTOMATION_FACTS_UNKNOWN' | 'AUTOMATION_CONFLICT' | 'AUTOMATION_EVALUATION_FAILED' | 'AUTOMATION_TERMINAL_AUDIT_ONLY' | 'AUTOMATION_HOLD_REQUIRED' | 'AUTOMATION_PROVIDER_PLAN_UNSUPPORTED', message: string) {
    super(message);
    this.name = 'AutomationPreflightError';
  }
}

export async function ensureAutomationStateCurrent(input: {
  orderId: number;
  factsRevision: string;
  rulesetDigest: string;
  state: AutomationWatermark | null | undefined;
  reevaluate?: () => Promise<AutomationWatermark>;
}): Promise<AutomationWatermark> {
  let state = input.state;
  const stale = !state
    || state.orderId !== input.orderId
    || state.factsRevision !== input.factsRevision
    || state.rulesetDigest !== input.rulesetDigest
    || state.engineVersion !== AUTOMATION_ENGINE_VERSION;
  if (stale && input.reevaluate) state = await input.reevaluate();
  if (!state
    || state.orderId !== input.orderId
    || state.factsRevision !== input.factsRevision
    || state.rulesetDigest !== input.rulesetDigest
    || state.engineVersion !== AUTOMATION_ENGINE_VERSION) {
    throw new AutomationPreflightError('AUTOMATION_EVALUATION_REQUIRED', 'Automation evaluation is stale or missing; evaluate before rating or label purchase');
  }
  if (state.status === 'blocked') throw new AutomationPreflightError('AUTOMATION_FACTS_UNKNOWN', 'Automation facts are incomplete; rating and purchase are blocked');
  if (state.status === 'conflict') throw new AutomationPreflightError('AUTOMATION_CONFLICT', 'Automation actions conflict; operator review is required');
  if (state.status === 'failed') throw new AutomationPreflightError('AUTOMATION_EVALUATION_FAILED', 'Automation evaluation failed; retry or review before continuing');
  if (state.status === 'audit_only') throw new AutomationPreflightError('AUTOMATION_TERMINAL_AUDIT_ONLY', 'Terminal orders are audit-only and cannot enter shipping actions');
  if (state.status !== 'current') throw new AutomationPreflightError('AUTOMATION_EVALUATION_REQUIRED', 'Automation evaluation is pending');
  return state;
}

export function createInMemoryAutomationExecutionStore(): AutomationExecutionStore & {
  effects: AutomationEffectRecord[];
  states: Map<number, AutomationWatermark>;
} {
  const completed = new Map<string, AutomationExecutionResult>();
  const effects: AutomationEffectRecord[] = [];
  const states = new Map<number, AutomationWatermark>();
  let nextRunId = 1;
  let nextClaimId = 1;
  const runKeys = new Map<string | number, string>();
  const claimTokens = new Map<string, string>();
  return {
    effects,
    states,
    async findCompleted(key) { return completed.get(key) ?? null; },
    async begin(input) {
      const runId = nextRunId++;
      runKeys.set(runId, input.executionKey);
      return runId;
    },
    async claimEffect(effect) {
      const index = effects.findIndex((existing) => existing.idempotencyKey === effect.idempotencyKey);
      if (index >= 0 && effects[index]?.status === 'planned') return { status: 'busy', retryAt: null };
      if (index >= 0 && effects[index]?.status !== 'failed') return { status: 'complete' };
      const claimToken = `memory-claim-${nextClaimId++}`;
      if (index >= 0) effects[index] = effect;
      else effects.push(effect);
      claimTokens.set(effect.idempotencyKey, claimToken);
      return { status: 'claimed', claimToken };
    },
    async recordEffect(effect, claimToken) {
      if (claimTokens.get(effect.idempotencyKey) !== claimToken) {
        throw new Error('Automation effect lease lost before completion');
      }
      const index = effects.findIndex((existing) => existing.idempotencyKey === effect.idempotencyKey);
      if (index >= 0) effects[index] = effect;
      else effects.push(effect);
      claimTokens.delete(effect.idempotencyKey);
    },
    async finish(result) {
      const key = runKeys.get(result.runId);
      if (!key) return;
      if (result.status === 'failed') completed.delete(key);
      else completed.set(key, result);
    },
    async setState(state) { states.set(state.orderId, state); },
  };
}
