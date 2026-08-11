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

/**
 * PS-466: legacy runs predate fenced leases and carry `lease_expires_at IS NULL`.
 *
 * Sweeping them is HISTORICAL DATA MUTATION, so it is off unless an operator names an
 * explicit cutoff. Without this, deploying the worker would silently terminalize the 98
 * stranded production runs — a data repair nobody authorised, performed as a side effect of
 * a code deploy.
 *
 * A bounded timestamp rather than a boolean: a boolean authorises an unbounded cohort,
 * whereas a cutoff authorises exactly the rows an operator can point at. Absent, blank or
 * unparseable all mean OFF — an unreadable cutoff must never be treated as "sweep
 * everything", and it deliberately never defaults to `now()`.
 */
export const AUTOMATION_LEGACY_RECOVERY_ENV = 'AUTOMATION_LEGACY_RUN_RECOVERY_BEFORE';

/**
 * Explicit ISO-8601 with a MANDATORY timezone. `2026-08-01T00:00:00` is rejected: without an
 * offset it is interpreted in the machine's local zone, so the same configuration text would
 * authorise a different cohort on a developer laptop than in production.
 */
const ISO_WITH_TZ = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const disabled = (why: string) => ({
  cutoff: null,
  diagnostic: `legacy run recovery DISABLED: ${why}`,
});

export function resolveLegacyRecoveryCutoff(raw: string | undefined, now: Date = new Date()): {
  cutoff: Date | null;
  diagnostic: string;
} {
  const value = (raw ?? '').trim();
  if (!value) {
    return { cutoff: null, diagnostic: 'legacy run recovery DISABLED (no cutoff configured)' };
  }

  const match = ISO_WITH_TZ.exec(value);
  if (!match) {
    return disabled(
      `${AUTOMATION_LEGACY_RECOVERY_ENV} must be an ISO-8601 timestamp with an explicit timezone (Z or +HH:MM)`,
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return disabled(`${AUTOMATION_LEGACY_RECOVERY_ENV} is not a parseable timestamp`);
  }

  // Reject impossible calendar dates. `new Date('2026-02-30T00:00:00Z')` silently rolls over
  // to 2 March, which would authorise two days more history than the operator wrote down.
  const [, y, mo, d, h, mi, s] = match;
  const utc = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  if (
    utc.getUTCFullYear() !== Number(y)
    || utc.getUTCMonth() + 1 !== Number(mo)
    || utc.getUTCDate() !== Number(d)
  ) {
    return disabled(`${AUTOMATION_LEGACY_RECOVERY_ENV} is not a real calendar date`);
  }

  // A future cutoff authorises the ENTIRE legacy cohort, which is precisely the unbounded
  // sweep this control exists to prevent. An operator must name a boundary they can point at.
  if (parsed.getTime() > now.getTime()) {
    return disabled(
      `${AUTOMATION_LEGACY_RECOVERY_ENV} is in the future (${parsed.toISOString()}); a cutoff must bound an identified historical cohort`,
    );
  }

  return {
    cutoff: parsed,
    diagnostic: `legacy run recovery ENABLED for runs started at or before ${parsed.toISOString()}`,
  };
}

let announcedLegacyCutoff: string | null = null;

export async function reapExpiredAutomationRuns(input: {
  now?: Date;
  batchSize?: number;
  database?: typeof db;
  legacyCutoffRaw?: string;
} = {}): Promise<number> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const maxRuntimeCutoff = new Date(now.getTime() - AUTOMATION_RUN_LEASE_MS);
  // The reaper's effective `now` is passed in, so a future cutoff is judged against the same
  // clock the sweep uses rather than wall-clock.
  const legacy = resolveLegacyRecoveryCutoff(
    input.legacyCutoffRaw ?? process.env[AUTOMATION_LEGACY_RECOVERY_ENV],
    now,
  );
  // Announce once, not once per batch: a sweep decision this consequential should be visible
  // in the logs, but repeating it every pass trains people to skip it.
  if (announcedLegacyCutoff !== legacy.diagnostic) {
    announcedLegacyCutoff = legacy.diagnostic;
    console.log(`[automation-recovery] ${legacy.diagnostic}`);
  }
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
          // A fenced lease that has expired is always recoverable — that is the whole point
          // of the lease, and it is unrelated to the historical cohort.
          lte(automationRuns.leaseExpiresAt, now),
          // A legacy null-lease row is recoverable ONLY under an explicit operator cutoff,
          // and even then only once it is older than a normal maximum runtime, so a run that
          // is legitimately in flight during the deploy is never swept.
          legacy.cutoff
            ? and(
                isNull(automationRuns.leaseExpiresAt),
                lte(automationRuns.startedAt, legacy.cutoff),
                lte(automationRuns.startedAt, maxRuntimeCutoff),
              )
            : sql`false`,
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
          // PS-466: the default-off legacy policy governs EVERY recovery entry point, not
          // just the sweeper.
          //
          // A legacy row has `lease_expires_at IS NULL`, so the inferred expiry below is
          // always in the past for anything older than a run's maximum lifetime. Without this
          // guard a repeat event on the same execution key would reclaim one of the 98
          // historical runs through demand-driven admission: assign it a lease, bump
          // attempt_count and recovery_count, stamp last_recovery_code, and re-execute it.
          //
          // The reaper would have left those rows alone. Admission would not have. That
          // breaks the deployment promise that legacy disposition stays disabled, and it
          // breaks it silently, on ordinary traffic rather than on an operator action.
          if (existing.leaseExpiresAt == null) {
            const legacyAdmission = resolveLegacyRecoveryCutoff(
              process.env[AUTOMATION_LEGACY_RECOVERY_ENV],
              now,
            );
            if (!legacyAdmission.cutoff || existing.startedAt > legacyAdmission.cutoff) {
              throw new AutomationRunLeaseBusyError(null);
            }
          }
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

        // PS-466: the caller must still own the PARENT RUN before any effect is admitted.
        //
        // This fence matters more than the one on finish(). finish() protects run HISTORY;
        // this protects the HANDLER BOUNDARY, which is where tags, hazmat declarations, rate
        // invalidations and any future provider call actually happen.
        //
        // Without it: worker A claims a run, stalls past its lease, recovery terminalizes the
        // run, worker B re-leases it — and stale worker A can still claim an effect and
        // invoke its handler, because nothing here ever looked at automation_runs. Its later
        // finish() would be correctly refused, but by then the side effect has occurred.
        //
        // Locked FOR UPDATE inside the same transaction as the effect claim, so ownership
        // cannot move between the check and the insert.
        const parentRunId = numericId(effect.runId, 'Run ID');
        const runToken = runClaims.get(parentRunId);
        const [parentRun] = await tx.select({
          status: automationRuns.status,
          leaseToken: automationRuns.leaseToken,
          leaseExpiresAt: automationRuns.leaseExpiresAt,
        }).from(automationRuns)
          .where(eq(automationRuns.id, parentRunId))
          .limit(1)
          .for('update');
        const ownsParentRun = Boolean(
          parentRun
          && runToken
          && parentRun.status === 'running'
          && parentRun.leaseToken === runToken
          && parentRun.leaseExpiresAt
          && parentRun.leaseExpiresAt > now,
        );
        if (!ownsParentRun) {
          throw new Error('Automation run lease lost before effect admission');
        }

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
    /**
     * PS-466: fence an UNFENCED convergence step.
     *
     * Hazmat retraction deliberately never calls `claimEffect()` — it has no persisted rule
     * version, so it is an explicit convergence step rather than a synthetic action-result
     * intent. That means the parent-run fence guarding every other handler does not cover it,
     * and a stale worker could mutate the canonical hazmat declaration on a run it no longer
     * owns. Its later `finish()` would be refused, but the retraction already happened.
     *
     * `expectedRevision` stops two retractions both succeeding; it does NOT prove the winner
     * still owns the run. A stale worker can win that race using stale rules and facts.
     *
     * A read-only ownership assertion is insufficient: the lease could expire between the
     * assertion and the retraction. RENEWING the lease is what creates a bounded ownership
     * window that covers the convergence command.
     */
    async renewRunLease(runId: number) {
      const now = new Date();
      const claimToken = runClaims.get(runId);
      if (!claimToken) {
        throw new Error('Automation run lease lost before convergence');
      }
      const [renewed] = await database.update(automationRuns).set({
        leaseExpiresAt: new Date(now.getTime() + AUTOMATION_RUN_LEASE_MS),
      }).where(and(
        eq(automationRuns.id, runId),
        eq(automationRuns.status, 'running'),
        eq(automationRuns.leaseToken, claimToken),
        gt(automationRuns.leaseExpiresAt, now),
      )).returning({ id: automationRuns.id });
      if (!renewed) {
        throw new Error('Automation run lease lost before convergence');
      }
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
