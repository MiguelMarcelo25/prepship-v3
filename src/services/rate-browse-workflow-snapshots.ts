import type {
  RateBrowseWorkflowPhase,
  RateBrowseWorkflowSnapshot,
} from './rate-browse-workflow-types';

function nowIso(): string {
  return new Date().toISOString();
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function resultRequestKey(result: Record<string, unknown>, fallback: string | null): string | null {
  return typeof result.requestKey === 'string'
    ? result.requestKey
    : typeof result.cacheKey === 'string'
      ? result.cacheKey
      : fallback;
}

export function countRateBrowseCarrierStatuses(result: Record<string, unknown>) {
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

export function buildRateBrowseResultSnapshot(input: {
  base: RateBrowseWorkflowSnapshot;
  result: Record<string, unknown>;
  phase: Extract<RateBrowseWorkflowPhase, 'partial' | 'complete'>;
  message: string;
  finishedAt: string | null;
  diagnostics?: Record<string, unknown>;
}): RateBrowseWorkflowSnapshot {
  return {
    ...input.base,
    ...countRateBrowseCarrierStatuses(input.result),
    phase: input.phase,
    ratesCount: arrayLength(input.result.rates),
    requestKey: resultRequestKey(input.result, input.base.requestKey),
    updatedAt: nowIso(),
    finishedAt: input.finishedAt,
    message: input.message,
    result: input.result,
    diagnostics: {
      ...input.base.diagnostics,
      ...(input.diagnostics ?? {}),
    },
    error: null,
  };
}
