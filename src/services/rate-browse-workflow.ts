import { randomUUID } from 'node:crypto';
import {
  getRateBrowseWorkflowSnapshot,
  reserveRateBrowseWorkflowSnapshot,
} from './rate-browse-workflow-store';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';
import { buildRateBrowseWorkflowRequestKey } from './rate-browse-workflow-key';
import { enqueueRateBrowseWorkerJob } from './rate-browse-worker';

export type StartRateBrowseWorkflowInput = {
  body: Record<string, unknown>;
  canViewFinancials: boolean;
  orderId?: number | null;
  requestKey?: string | null;
  priority?: 'manual' | 'preflight' | 'backfill';
  includeCachedPartial?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function snapshotFromInput(input: StartRateBrowseWorkflowInput): RateBrowseWorkflowSnapshot {
  const startedAt = nowIso();
  return {
    jobId: randomUUID(),
    generation: 0,
    phase: 'queued',
    requestKey: input.requestKey ?? buildRateBrowseWorkflowRequestKey(input.body),
    orderId: input.orderId ?? finiteNumber(input.body.orderId),
    clientId: finiteNumber(input.body.clientId),
    storeId: finiteNumber(input.body.storeId),
    totalCarriers: 0,
    completedCarriers: 0,
    successfulCarriers: 0,
    failedCarriers: 0,
    ratesCount: 0,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    message: 'Rate browse workflow queued',
    result: null,
    diagnostics: {
      source: 'rate-browse-workflow',
      canViewFinancials: input.canViewFinancials,
    },
    error: null,
  };
}

export async function startRateBrowseWorkflow(
  input: StartRateBrowseWorkflowInput,
): Promise<RateBrowseWorkflowSnapshot> {
  const queued = snapshotFromInput(input);
  const reservation = await reserveRateBrowseWorkflowSnapshot(queued, {
    priority: input.priority ?? 'manual',
    workerInput: {
      body: input.body,
      canViewFinancials: input.canViewFinancials,
      includeCachedPartial: input.includeCachedPartial === true,
      priority: input.priority ?? 'manual',
    },
  });
  if (reservation.created) {
    const queuedJob = await enqueueRateBrowseWorkerJob(reservation.snapshot.jobId);
    if (!queuedJob.queued) {
      console.warn(
        `[rate-browse-workflow] durable job ${reservation.snapshot.jobId} awaits worker recovery: ` +
        `${queuedJob.error ?? 'pg-boss enqueue was deduplicated'}`,
      );
    }
  }
  return reservation.snapshot;
}

export async function getRateBrowseWorkflow(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  return getRateBrowseWorkflowSnapshot(jobId);
}
