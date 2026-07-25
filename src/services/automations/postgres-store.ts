import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  automationActionResults,
  automationRuns,
  orderAutomationState,
} from '../../db/schema/automations.js';
import { automationDocumentHash } from './contracts.js';
import type {
  AutomationEffectRecord,
  AutomationExecutionResult,
  AutomationExecutionStore,
  AutomationWatermark,
} from './orchestrator.js';

const EFFECT_LEASE_MS = 5 * 60 * 1_000;

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

export function createPostgresAutomationExecutionStore(): AutomationExecutionStore {
  return {
    async findCompleted(executionKey) {
      const [row] = await db.select({ status: automationRuns.status, trace: automationRuns.trace })
        .from(automationRuns)
        .where(eq(automationRuns.executionKey, executionKey))
        .limit(1);
      if (!row || row.status === 'running' || row.status === 'failed') return null;
      return resultFromTrace(row.trace);
    },
    async begin(input) {
      const [created] = await db.insert(automationRuns).values({
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
      }).onConflictDoNothing({ target: automationRuns.executionKey }).returning({ id: automationRuns.id });
      if (created) return created.id;
      const [existing] = await db.select({ id: automationRuns.id, status: automationRuns.status })
        .from(automationRuns)
        .where(eq(automationRuns.executionKey, input.executionKey))
        .limit(1);
      if (!existing) throw new Error('Automation execution admission failed');
      if (existing.status === 'failed') {
        await db.update(automationRuns).set({
          status: 'running',
          errorCode: null,
          errorSummary: null,
          completedAt: null,
        }).where(and(
          eq(automationRuns.id, existing.id),
          eq(automationRuns.status, 'failed'),
        ));
      }
      return existing.id;
    },
    async claimEffect(effect) {
      return db.transaction(async (tx) => {
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
      const [recorded] = await db.update(automationActionResults).set({
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
      const trace = { result } as unknown as Record<string, unknown>;
      await db.update(automationRuns).set({
        status: result.status,
        matchedRuleVersionIds: result.evaluation.matches
          .filter((match) => match.result === 'true')
          .map((match) => numericId(match.versionId, 'Matched version ID')),
        trace,
        traceHash: automationDocumentHash(trace),
        errorCode: result.status === 'completed' ? null : `AUTOMATION_${result.status.toUpperCase()}`,
        errorSummary: result.status === 'completed' ? null : `Automation ${result.status}`,
        completedAt: new Date(),
      }).where(eq(automationRuns.id, numericId(result.runId, 'Run ID')));
    },
    async setState(state: AutomationWatermark) {
      await db.insert(orderAutomationState).values({
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
