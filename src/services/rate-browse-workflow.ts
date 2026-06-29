import { randomUUID } from 'node:crypto';
import {
  getRateBrowseWorkflowSnapshot,
  persistRateBrowseWorkflowSnapshot,
} from './rate-browse-workflow-store';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';

export type StartRateBrowseWorkflowInput = {
  body: Record<string, unknown>;
  canViewFinancials: boolean;
  orderId?: number | null;
  requestKey?: string | null;
  run: () => Promise<Record<string, unknown>>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function countCarrierStatuses(result: Record<string, unknown>) {
  const carrierStatuses = Array.isArray(result.carrierStatuses)
    ? result.carrierStatuses as Array<Record<string, unknown>>
    : [];
  const completed = carrierStatuses.filter((status) => {
    const text = String(status.status ?? '').toLowerCase();
    return text && text !== 'loading' && text !== 'pending' && text !== 'queued';
  }).length;
  const failed = carrierStatuses.filter((status) => {
    const text = String(status.status ?? '').toLowerCase();
    return text === 'error' || text === 'failed' || text === 'timeout';
  }).length;
  return {
    totalCarriers: carrierStatuses.length,
    completedCarriers: completed,
    failedCarriers: failed,
    successfulCarriers: Math.max(0, completed - failed),
  };
}

function snapshotFromInput(input: StartRateBrowseWorkflowInput): RateBrowseWorkflowSnapshot {
  const startedAt = nowIso();
  return {
    jobId: randomUUID(),
    phase: 'queued',
    requestKey: input.requestKey ?? null,
    orderId: input.orderId ?? finiteNumber(input.body.orderId),
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

async function runRateBrowseWorkflowJob(
  queued: RateBrowseWorkflowSnapshot,
  run: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const running: RateBrowseWorkflowSnapshot = {
    ...queued,
    phase: 'running',
    updatedAt: nowIso(),
    message: 'Rate browse workflow running',
  };
  await persistRateBrowseWorkflowSnapshot(running);

  try {
    const result = await run();
    const counts = countCarrierStatuses(result);
    const finishedAt = nowIso();
    await persistRateBrowseWorkflowSnapshot({
      ...running,
      ...counts,
      phase: 'complete',
      ratesCount: arrayLength(result.rates),
      requestKey: typeof result.requestKey === 'string'
        ? result.requestKey
        : typeof result.cacheKey === 'string'
          ? result.cacheKey
          : running.requestKey,
      updatedAt: finishedAt,
      finishedAt,
      message: 'Rate browse workflow complete',
      result,
      diagnostics: {
        ...running.diagnostics,
        rateBrowseTiming: result.rateBrowseTiming ?? null,
      },
      error: null,
    });
  } catch (err) {
    const finishedAt = nowIso();
    await persistRateBrowseWorkflowSnapshot({
      ...running,
      phase: 'error',
      updatedAt: finishedAt,
      finishedAt,
      message: 'Rate browse workflow failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function startRateBrowseWorkflow(
  input: StartRateBrowseWorkflowInput,
): Promise<RateBrowseWorkflowSnapshot> {
  const queued = snapshotFromInput(input);
  await persistRateBrowseWorkflowSnapshot(queued);
  void runRateBrowseWorkflowJob(queued, input.run);
  return queued;
}

export async function getRateBrowseWorkflow(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  return getRateBrowseWorkflowSnapshot(jobId);
}
