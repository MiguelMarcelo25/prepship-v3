import { randomUUID } from 'node:crypto';
import {
  getRateBrowseWorkflowSnapshot,
  persistRateBrowseWorkflowSnapshot,
  reserveRateBrowseWorkflowSnapshot,
} from './rate-browse-workflow-store';
import { buildRateBrowseResultSnapshot } from './rate-browse-workflow-snapshots';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';
import { buildRateBrowseWorkflowRequestKey } from './rate-browse-workflow-key';

export type StartRateBrowseWorkflowInput = {
  body: Record<string, unknown>;
  canViewFinancials: boolean;
  orderId?: number | null;
  requestKey?: string | null;
  priority?: 'manual' | 'preflight' | 'backfill';
  getInitialResult?: () => Promise<Record<string, unknown> | null>;
  run: () => Promise<Record<string, unknown>>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function snapshotFromInput(input: StartRateBrowseWorkflowInput): RateBrowseWorkflowSnapshot {
  const startedAt = nowIso();
  return {
    jobId: randomUUID(),
    phase: 'queued',
    requestKey: input.requestKey ?? buildRateBrowseWorkflowRequestKey(input.body),
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
  input: StartRateBrowseWorkflowInput,
): Promise<void> {
  const priority = input.priority ?? 'manual';
  const running: RateBrowseWorkflowSnapshot = {
    ...queued,
    phase: 'running',
    updatedAt: nowIso(),
    message: 'Rate browse workflow running',
  };
  await persistRateBrowseWorkflowSnapshot(running, { priority });

  try {
    if (input.getInitialResult) {
      try {
        const partialResult = await input.getInitialResult();
        if (partialResult && Array.isArray(partialResult.rates) && partialResult.rates.length > 0) {
          await persistRateBrowseWorkflowSnapshot(buildRateBrowseResultSnapshot({
            base: running,
            result: partialResult,
            phase: 'partial',
            message: 'Cached rates available while live carriers continue',
            finishedAt: null,
            diagnostics: { partialSource: 'cache-first' },
          }), { priority });
        }
      } catch (err) {
        await persistRateBrowseWorkflowSnapshot({
          ...running,
          updatedAt: nowIso(),
          message: 'Rate browse workflow running; cached partial unavailable',
          diagnostics: {
            ...running.diagnostics,
            partialError: err instanceof Error ? err.message : String(err),
          },
        }, { priority });
      }
    }

    const result = await input.run();
    const finishedAt = nowIso();
    await persistRateBrowseWorkflowSnapshot(buildRateBrowseResultSnapshot({
      base: running,
      result,
      phase: 'complete',
      message: 'Rate browse workflow complete',
      finishedAt,
      diagnostics: { rateBrowseTiming: result.rateBrowseTiming ?? null },
    }), { priority });
  } catch (err) {
    const finishedAt = nowIso();
    await persistRateBrowseWorkflowSnapshot({
      ...running,
      phase: 'error',
      updatedAt: finishedAt,
      finishedAt,
      message: 'Rate browse workflow failed',
      error: err instanceof Error ? err.message : String(err),
    }, { priority });
  }
}

export async function startRateBrowseWorkflow(
  input: StartRateBrowseWorkflowInput,
): Promise<RateBrowseWorkflowSnapshot> {
  const queued = snapshotFromInput(input);
  const reservation = await reserveRateBrowseWorkflowSnapshot(queued, {
    priority: input.priority ?? 'manual',
  });
  if (reservation.created) {
    void runRateBrowseWorkflowJob(reservation.snapshot, input);
  }
  return reservation.snapshot;
}

export async function getRateBrowseWorkflow(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  return getRateBrowseWorkflowSnapshot(jobId);
}
