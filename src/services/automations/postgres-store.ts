import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  automationActionResults,
  automationRuns,
  orderAutomationState,
} from '../../db/schema/automations.js';
import { automationDocumentHash } from './contracts.js';
import {
  AutomationRunLeaseBusyError,
  type AutomationEffectRecord,
  type AutomationExecutionResult,
  type AutomationExecutionStore,
  type AutomationWatermark,
} from './orchestrator.js';

const EFFECT_LEASE_MS = 5 * 60 * 1_000;
export const AUTOMATION_RUN_LEASE_MS = 5 * 60 * 1_000;
export const AUTOMATION_RUN_MAX_ATTEMPTS = 5;
export const AUTOMATION_RECOVERY_BATCH_SIZE = 25;

function numericId(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a persisted numeric ID`);
  return parsed;
}

function resultFromTrace(value: unknown): AutomationExecutionResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = (value as { result?: unknown }).result;
  return result && typeof result === 'object' ? result as AutomationExecutionResult : null;
}

export async function reapExpiredAutomationRuns(input: {
  now?: Date;
  batchSize?: number;
  database?: typeof db;
} = {}): Promise<number> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const legacyCutoff = new Date(now.getTime() - AUTOMATION_RUN_LEASE_MS);
  const batchSize = Math.max(1, Math.min(input.batchSize ?? AUTOMATION_RECOVERY_BATCH_SIZE, 100));

  return database.transaction(async (tx) => {
    const candidates = await tx.select({
      id: automationRuns.id,
      orderId: automationRuns.orderId,
      executionKey: automationRuns.executionKey,
      attemptCount: automationRuns.attemptCount,
      recoveryCount: automationRuns.recoveryCount,
    }).from(automationRuns)
      .where(and(
        eq(automationRuns.status, 'running'),
        or(
          lte(automationRuns.leaseExpiresAt, now),
          and(isNull(automationRuns.leaseExpiresAt), lte(automationRuns.startedAt, legacyCutoff)),
        ),
      ))
      .orderBy(automationRuns.id)
      .limit(batchSize)
      .for('update', { skipLocked: true });

    let recovered = 0;
    for (const run of candidates) {
      const [liveEffect] = await tx.select({ id: automationActionResults.id })
        .from(automationActionResults)
        .where(and(
          eq(automationActionResults.runId, run.id),
          eq(automationActionResults.status, 'planned'),
          gt(automationActionResults.leaseExpiresAt, now),
        ))
        .limit(1);
      if (liveEffect) continue;

      await tx.update(automationActionResults).set({
        status: 'failed',
        reason: 'Recovery expired an unfinished action lease without invoking its handler',
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(and(
        eq(automationActionResults.runId, run.id),
        eq(automationActionResults.status, 'planned'),
        or(
          isNull(automationActionResults.leaseExpiresAt),
          lte(automationActionResults.leaseExpiresAt, now),
        ),
      ));

      const recoveryTrace = {
        recovery: {
          code: 'AUTOMATION_RUN_LEASE_EXPIRED',
          recoveredAt: now.toISOString(),
          priorAttemptCount: run.attemptCount,
          recoveryCount: run.recoveryCount + 1,
          handlerInvocations: 0,
        },
      };
      const [terminalized] = await tx.update(automationRuns).set({
        status: 'failed',
        trace: recoveryTrace,
        traceHash: automationDocumentHash(recoveryTrace),
        errorCode: 'AUTOMATION_RUN_LEASE_EXPIRED',
        errorSummary: 'Automation run lease expired; unfinished effects were terminalized without execution',
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        recoveryCount: sql`${automationRuns.recoveryCount} + 1`,
        lastRecoveryCode: 'AUTOMATION_RUN_LEASE_EXPIRED',
        lastRecoveredAt: now,
      }).where(and(
        eq(automationRuns.id, run.id),
        eq(automationRuns.status, 'running'),
      )).returning({ id: automationRuns.id });
      if (terminalized) recovered += 1;
    }
    return recovered;
  });
}

export function createPostgresAutomationExecutionStore(database: typeof db = db): AutomationExecutionStore {
  const runClaims = new Map<number, string>();
  return {
    async findCompleted(executionKey) {
      const [row] = await database.select({ status: automationRuns.status, trace: automationRuns.trace })
        .from(automationRuns)
        .where(eq(automationRuns.executionKey, executionKey))
        .limit(1);
      if (!row || row.status === 'running' || row.status === 'failed') return null;
      return resultFromTrace(row.trace);
    },
    async countRunsSince(orderId, since) {
      const [row] = await database
        .select({ n: count() })
        .from(automationRuns)
        .where(and(eq(automationRuns.orderId, orderId), gte(automationRuns.startedAt, since)));
      return Number(row?.n ?? 0);
    },
    async begin(input) {
      const now = new Date();
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + AUTOMATION_RUN_LEASE_MS);
      const admitted = await database.transaction(async (tx) => {
        const [created] = await tx.insert(automationRuns).values({
          executionKey: input.executionKey,
          orderId: input.orderId,
          ruleId: null,
          trigger: input.trigger,
          sourceEventId: input.sourceEventId,
          factsRevision: input.factsRevision,
          rulesetDigest: input.rulesetDigest,
          engineVersion: 'ps-466-v1',
          mode: input.mode,
          status: 'running',
          matchedRuleVersionIds: [],
          traceHash: automationDocumentHash({ pending: input.executionKey }),
          attemptCount: 1,
          leaseToken: claimToken,
          leaseExpiresAt,
        }).onConflictDoNothing({ target: automationRuns.executionKey }).returning({ id: automationRuns.id });
        if (created) return created.id;

        const [existing] = await tx.select({
          id: automationRuns.id,
          status: automationRuns.status,
          startedAt: automationRuns.startedAt,
          attemptCount: automationRuns.attemptCount,
          leaseExpiresAt: automationRuns.leaseExpiresAt,
        }).from(automationRuns)
          .where(eq(automationRuns.executionKey, input.executionKey))
          .limit(1)
          .for('update');
        if (!existing) throw new Error('Automation execution admission failed');
        if (!['running', 'failed'].includes(existing.status)) {
          throw new AutomationRunLeaseBusyError(null);
        }
        if (existing.status === 'running') {
          const effectiveExpiry = existing.leaseExpiresAt
            ?? new Date(existing.startedAt.getTime() + AUTOMATION_RUN_LEASE_MS);
          if (effectiveExpiry > now) throw new AutomationRunLeaseBusyError(effectiveExpiry);
        }
        if (existing.attemptCount >= AUTOMATION_RUN_MAX_ATTEMPTS) {
          throw new Error(`Automation run exhausted ${AUTOMATION_RUN_MAX_ATTEMPTS} attempts`);
        }

        const reclaimingExpiredRun = existing.status === 'running';
        const [reclaimed] = await tx.update(automationRuns).set({
          status: 'running',
          errorCode: null,
          errorSummary: null,
          completedAt: null,
          attemptCount: existing.attemptCount + 1,
          leaseToken: claimToken,
          leaseExpiresAt,
          ...(reclaimingExpiredRun ? {
            recoveryCount: sql`${automationRuns.recoveryCount} + 1`,
            lastRecoveryCode: 'AUTOMATION_RUN_LEASE_RECLAIMED',
            lastRecoveredAt: now,
          } : {}),
        }).where(and(
          eq(automationRuns.id, existing.id),
          eq(automationRuns.status, existing.status),
        )).returning({ id: automationRuns.id });
        if (!reclaimed) throw new AutomationRunLeaseBusyError(leaseExpiresAt);
        return reclaimed.id;
      });
      runClaims.set(admitted, claimToken);
      return admitted;
    },
    async claimEffect(effect) {
      return database.transaction(async (tx) => {
        const now = new Date();
        const claimToken = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + EFFECT_LEASE_MS);
        const [existing] = await tx.select({
          id: automationActionResults.id,
          status: automationActionResults.status,
          attemptCount: automationActionResults.attemptCount,
          leaseExpiresAt: automationActionResults.leaseExpiresAt,
        }).from(automationActionResults)
          .where(eq(automationActionResults.idempotencyKey, effect.idempotencyKey))
          .limit(1)
          .for('update');

        if (!existing) {
          const [created] = await tx.insert(automationActionResults).values({
            runId: numericId(effect.runId, 'Run ID'),
            ruleVersionId: numericId(effect.versionId, 'Rule version ID'),
            actionIndex: effect.actionIndex,
            actionType: effect.actionType,
            idempotencyKey: effect.idempotencyKey,
            status: 'planned',
            attemptCount: 1,
            leaseToken: claimToken,
            leaseExpiresAt,
            updatedAt: now,
          }).onConflictDoNothing({ target: automationActionResults.idempotencyKey })
            .returning({ id: automationActionResults.id });
          if (created) return { status: 'claimed' as const, claimToken };
          const [raced] = await tx.select({
            status: automationActionResults.status,
            leaseExpiresAt: automationActionResults.leaseExpiresAt,
          }).from(automationActionResults)
            .where(eq(automationActionResults.idempotencyKey, effect.idempotencyKey))
            .limit(1);
          return raced?.status === 'planned'
            ? { status: 'busy' as const, retryAt: raced.leaseExpiresAt }
            : { status: 'complete' as const };
        }

        const reclaimable = existing.status === 'failed'
          || (existing.status === 'planned' && (!existing.leaseExpiresAt || existing.leaseExpiresAt <= now));
        if (!reclaimable) {
          return existing.status === 'planned'
            ? { status: 'busy' as const, retryAt: existing.leaseExpiresAt }
            : { status: 'complete' as const };
        }
        const [reclaimed] = await tx.update(automationActionResults).set({
          runId: numericId(effect.runId, 'Run ID'),
          ruleVersionId: numericId(effect.versionId, 'Rule version ID'),
          actionIndex: effect.actionIndex,
          actionType: effect.actionType,
          status: 'planned',
          attemptCount: existing.attemptCount + 1,
          leaseToken: claimToken,
          leaseExpiresAt,
          reason: null,
          updatedAt: now,
        }).where(eq(automationActionResults.id, existing.id)).returning({ id: automationActionResults.id });
        return reclaimed
          ? { status: 'claimed' as const, claimToken }
          : { status: 'busy' as const, retryAt: leaseExpiresAt };
      });
    },
    async recordEffect(effect: AutomationEffectRecord, claimToken: string) {
      const [recorded] = await database.update(automationActionResults).set({
        status: effect.status,
        targetType: effect.targetType ?? null,
        targetId: effect.targetId ?? null,
        beforeSummary: effect.before ?? null,
        afterSummary: effect.after ?? null,
        reason: effect.reason ?? null,
        appliedAt: effect.status === 'applied' ? new Date() : null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(automationActionResults.idempotencyKey, effect.idempotencyKey),
        eq(automationActionResults.leaseToken, claimToken),
      )).returning({ id: automationActionResults.id });
      if (!recorded) throw new Error('Automation effect lease lost before completion');
    },
    async finish(result) {
      const runId = numericId(result.runId, 'Run ID');
      const claimToken = runClaims.get(runId);
      if (!claimToken) throw new Error('Automation run lease is missing before completion');
      const trace = { result } as unknown as Record<string, unknown>;
      const [finished] = await database.update(automationRuns).set({
        status: result.status,
        matchedRuleVersionIds: result.evaluation.matches
          .filter((match) => match.result === 'true')
          .map((match) => numericId(match.versionId, 'Matched version ID')),
        trace,
        traceHash: automationDocumentHash(trace),
        errorCode: result.status === 'completed' ? null : `AUTOMATION_${result.status.toUpperCase()}`,
        errorSummary: result.status === 'completed' ? null : `Automation ${result.status}`,
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      }).where(and(
        eq(automationRuns.id, runId),
        eq(automationRuns.status, 'running'),
        eq(automationRuns.leaseToken, claimToken),
      )).returning({ id: automationRuns.id });
      runClaims.delete(runId);
      if (!finished) throw new Error('Automation run lease lost before completion');
    },
    async setState(state: AutomationWatermark) {
      await database.insert(orderAutomationState).values({
        orderId: state.orderId,
        factsRevision: state.factsRevision,
        rulesetDigest: state.rulesetDigest,
        engineVersion: state.engineVersion,
        status: state.status,
        plan: state.plan as unknown as Record<string, unknown>,
        lastRunId: state.lastRunId == null ? null : numericId(state.lastRunId, 'Last run ID'),
        failureCode: state.failureCode,
        evaluatedAt: new Date(),
      }).onConflictDoUpdate({
        target: orderAutomationState.orderId,
        set: {
          factsRevision: state.factsRevision,
          rulesetDigest: state.rulesetDigest,
          engineVersion: state.engineVersion,
          status: state.status,
          plan: state.plan as unknown as Record<string, unknown>,
          lastRunId: state.lastRunId == null ? null : numericId(state.lastRunId, 'Last run ID'),
          failureCode: state.failureCode,
          evaluatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    },
  };
}
