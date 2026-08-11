import { randomUUID } from 'node:crypto';
import { announceAutomationExecutionPause, isAutomationExecutionPaused } from './execution-pause.js';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  automationOutbox,
  automationReprocessJobs,
  automationRules,
  automationRuleVersions,
} from '../../db/schema/automations.js';
import { GLOBAL_SCOPE } from '../../lib/client-store-scope.js';
import { compileAutomationRuleVersion, type AutomationRuleDocument } from './contracts.js';
import { loadAutomationFacts } from './facts.js';
import { AutomationEffectLeaseBusyError, AutomationRunLeaseBusyError, executeAutomationEvaluation } from './orchestrator.js';
import { createPostgresAutomationExecutionStore, reapExpiredAutomationRuns } from './postgres-store.js';
import { automationHandlerRegistry, evaluateOrderAutomationFactEvent } from './runtime.js';
import { AUTOMATION_TRIGGERS, type AutomationTrigger } from './catalog.js';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const POLL_MS = 5_000;
const OUTBOX_LEASE_MS = 5 * 60 * 1_000;

type ClaimedOutbox = typeof automationOutbox.$inferSelect & { attemptCount: number; lockToken: string };

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function claimOutbox(): Promise<ClaimedOutbox | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.select().from(automationOutbox)
      .where(and(
        inArray(automationOutbox.eventType, ['automation_reprocess_confirmed', 'order_facts_changed']),
        or(
          and(
            inArray(automationOutbox.status, ['pending', 'failed']),
            lte(automationOutbox.availableAt, now),
          ),
          and(
            eq(automationOutbox.status, 'processing'),
            or(isNull(automationOutbox.leaseExpiresAt), lte(automationOutbox.leaseExpiresAt, now)),
          ),
        ),
      ))
      .orderBy(automationOutbox.id)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    if (row.attemptCount >= MAX_ATTEMPTS) {
      await tx.update(automationOutbox).set({
        status: 'dead',
        lockedAt: null,
        lockedBy: null,
        lockToken: null,
        leaseExpiresAt: null,
        lastError: 'Automation outbox lease expired after the maximum claim attempts',
      }).where(eq(automationOutbox.id, row.id));
      const exhaustedJobId = positiveId(row.payload.jobId);
      if (exhaustedJobId) {
        await tx.update(automationReprocessJobs).set({
          status: 'failed',
          failedOrders: 1,
          completedAt: now,
        }).where(eq(automationReprocessJobs.id, exhaustedJobId));
      }
      return null;
    }
    const attemptCount = row.attemptCount + 1;
    const lockToken = randomUUID();
    const [claimed] = await tx.update(automationOutbox).set({
      status: 'processing',
      attemptCount,
      lockedAt: now,
      lockedBy: `automation-worker:${process.pid}`,
      lockToken,
      leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS),
      lastError: null,
    }).where(eq(automationOutbox.id, row.id)).returning();
    return claimed ? { ...claimed, attemptCount, lockToken } : null;
  });
}

async function markFailure(row: ClaimedOutbox, error: unknown): Promise<void> {
  const dead = row.attemptCount >= MAX_ATTEMPTS;
  const summary = error instanceof Error ? error.message.slice(0, 500) : 'Automation reprocess failed';
  const delaySeconds = Math.min(60, 2 ** Math.max(0, row.attemptCount - 1));
  const backoffAt = Date.now() + delaySeconds * 1_000;
  const leaseRetryAt = (error instanceof AutomationEffectLeaseBusyError || error instanceof AutomationRunLeaseBusyError) && error.retryAt
    ? error.retryAt.getTime() + 1_000
    : 0;
  const jobId = positiveId(row.payload.jobId);
  await db.transaction(async (tx) => {
    const [released] = await tx.update(automationOutbox).set({
      status: dead ? 'dead' : 'failed',
      availableAt: new Date(Math.max(backoffAt, leaseRetryAt)),
      lockedAt: null,
      lockedBy: null,
      lockToken: null,
      leaseExpiresAt: null,
      lastError: summary,
    }).where(and(
      eq(automationOutbox.id, row.id),
      eq(automationOutbox.lockToken, row.lockToken),
    )).returning({ id: automationOutbox.id });
    if (!released) return;
    if (dead && jobId) {
      await tx.update(automationReprocessJobs).set({
        status: 'failed',
        failedOrders: 1,
        completedAt: new Date(),
      }).where(eq(automationReprocessJobs.id, jobId));
    }
  });
}

export async function processAutomationOutboxOnce(): Promise<'idle' | 'progress' | 'completed' | 'failed'> {
  const claimed = await claimOutbox();
  if (!claimed) return 'idle';
  try {
    if (claimed.eventType === 'order_facts_changed') {
      const orderId = positiveId(claimed.payload.orderId);
      const trigger = String(claimed.payload.trigger ?? '') as AutomationTrigger;
      if (!orderId || !(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger)) {
        throw new Error('Automation fact event payload is invalid');
      }
      const result = await evaluateOrderAutomationFactEvent({
        orderId,
        trigger,
        sourceEventId: String(claimed.payload.sourceEventId ?? claimed.eventKey),
        scope: GLOBAL_SCOPE,
      });
      if (result.status === 'failed') throw new Error(`Automation fact event ${result.status}`);
      const [completed] = await db.update(automationOutbox).set({
        status: 'completed',
        lockedAt: null,
        lockedBy: null,
        lockToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      }).where(and(
        eq(automationOutbox.id, claimed.id),
        eq(automationOutbox.lockToken, claimed.lockToken),
      )).returning({ id: automationOutbox.id });
      if (!completed) throw new Error('Automation outbox lease lost before fact-event completion');
      return 'completed';
    }
    const jobId = positiveId(claimed.payload.jobId);
    if (!jobId) throw new Error('Automation outbox payload is missing jobId');
    const [row] = await db.select({
      job: automationReprocessJobs,
      rule: automationRules,
      version: automationRuleVersions,
    }).from(automationReprocessJobs)
      .innerJoin(automationRules, eq(automationRules.id, automationReprocessJobs.ruleId))
      .innerJoin(automationRuleVersions, eq(automationRuleVersions.id, automationReprocessJobs.ruleVersionId))
      .where(eq(automationReprocessJobs.id, jobId))
      .limit(1);
    if (!row) throw new Error('Automation reprocess job not found');
    if (row.rule.activeVersionId !== row.version.id || row.rule.status !== 'active' || row.version.lifecycle !== 'published') {
      throw new Error('Automation reprocess version is no longer active');
    }
    const orderIds = Array.isArray(row.job.scope.orderIds)
      ? row.job.scope.orderIds.map(positiveId).filter((value): value is number => value != null)
      : [];
    const nextIds = orderIds.slice(row.job.processedOrders, row.job.processedOrders + BATCH_SIZE);
    const compiled = compileAutomationRuleVersion(row.version.document as AutomationRuleDocument, {
      ruleId: String(row.rule.id),
      versionId: String(row.version.id),
      versionNumber: row.version.versionNumber,
    });
    if (compiled.documentHash !== row.version.documentHash) throw new Error('Automation reprocess version hash mismatch');

    for (const orderId of nextIds) {
      const facts = await loadAutomationFacts(orderId, GLOBAL_SCOPE);
      const result = await executeAutomationEvaluation({
        facts,
        trigger: 'manual_reprocess',
        sourceEventId: `reprocess:${row.job.id}:${row.version.id}:${orderId}`,
        rules: [compiled],
        store: createPostgresAutomationExecutionStore(),
        handlers: automationHandlerRegistry,
        evaluateAllTriggers: true,
        scope: GLOBAL_SCOPE,
      });
      if (result.status !== 'completed') {
        throw new Error(`Automation reprocess order ${orderId} ${result.status}`);
      }
    }

    const processedOrders = row.job.processedOrders + nextIds.length;
    const completed = processedOrders >= orderIds.length;
    await db.transaction(async (tx) => {
      const [released] = await tx.update(automationOutbox).set({
        status: completed ? 'completed' : 'pending',
        availableAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lockToken: null,
        leaseExpiresAt: null,
        completedAt: completed ? new Date() : null,
      }).where(and(
        eq(automationOutbox.id, claimed.id),
        eq(automationOutbox.lockToken, claimed.lockToken),
      )).returning({ id: automationOutbox.id });
      if (!released) throw new Error('Automation outbox lease lost before reprocess checkpoint');
      await tx.update(automationReprocessJobs).set({
        status: completed ? 'completed' : 'running',
        processedOrders,
        completedAt: completed ? new Date() : null,
      }).where(eq(automationReprocessJobs.id, row.job.id));
    });
    return completed ? 'completed' : 'progress';
  } catch (error) {
    await markFailure(claimed, error);
    return 'failed';
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // PS-466 cutover: do not CLAIM work while paused. Checking only inside evaluation would
    // let every pass increment attempts and eventually dead-letter genuine events.
    if (isAutomationExecutionPaused()) {
      announceAutomationExecutionPause(true);
      return;
    }
    await reapExpiredAutomationRuns();
    for (let index = 0; index < 5; index += 1) {
      if (await processAutomationOutboxOnce() === 'idle') break;
    }
  } finally {
    running = false;
  }
}

export function startAutomationOutboxWorker(): void {
  if (timer) return;
  void pump();
  timer = setInterval(() => void pump(), POLL_MS);
}

export function stopAutomationOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
