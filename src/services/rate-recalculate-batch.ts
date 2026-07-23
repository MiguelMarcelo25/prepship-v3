import { randomUUID } from 'node:crypto';
import { getJsonSetting, setJsonSetting } from './settings-json';
import { deleteSettingsByKeys, listSettingsByKeyPrefix } from './settings';
import {
  getRateBrowseWorkflow,
  startRateBrowseWorkflow,
  type StartRateBrowseWorkflowInput,
} from './rate-browse-workflow';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';

export const RATE_RECALCULATE_BATCH_PREFIX = 'rate_recalculate_batch.job.';
export const RATE_RECALCULATE_BATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_RECALCULATE_ADMISSION_GRACE_MS = 30_000;

export type RateRecalculateBatchItemStatus =
  | 'queued'
  | 'running'
  | 'updated'
  | 'cleared'
  | 'skipped'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled'
  | 'superseded';

export type RateRecalculateBatchReasonCode =
  | 'missing_shipment_inputs'
  | 'carrier_accounts_loading'
  | 'no_eligible_carrier_accounts'
  | 'provider_timeout'
  | 'provider_failure'
  | 'transport_failure'
  | 'no_rates_returned'
  | 'strict_verdict_rejected'
  | 'strict_verdict_unavailable'
  | 'rate_persistence_rejected'
  | 'skipped_immutable_order'
  | 'skipped_test_order'
  | 'cancelled'
  | 'superseded'
  | 'workflow_admission_failed'
  | 'workflow_status_unavailable';

export type RateRecalculateBatchItem = {
  orderId: number;
  workflowJobId: string | null;
  status: RateRecalculateBatchItemStatus;
  reasonCode: RateRecalculateBatchReasonCode | null;
  message: string;
  retryable: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RateRecalculateBatchCounters = {
  total: number;
  completed: number;
  remaining: number;
  running: number;
  updated: number;
  cleared: number;
  skipped: number;
  retryableFailed: number;
  terminalFailed: number;
};

export type RateRecalculateBatchSnapshot = {
  batchId: string;
  status: 'queued' | 'running' | 'complete';
  items: RateRecalculateBatchItem[];
  counters: RateRecalculateBatchCounters;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RateRecalculateBatchStartItem = {
  orderId: number;
  body?: Record<string, unknown>;
  initialOutcome?: Pick<
    RateRecalculateBatchItem,
    'status' | 'reasonCode' | 'message' | 'retryable'
  >;
};

type RateRecalculateBatchDependencies = {
  startWorkflow: typeof startRateBrowseWorkflow;
  getWorkflow: typeof getRateBrowseWorkflow;
  readBatch: (batchId: string) => Promise<RateRecalculateBatchSnapshot | null>;
  persistBatch: (snapshot: RateRecalculateBatchSnapshot) => Promise<void>;
  pruneBatches: (now: Date) => Promise<void>;
  now: () => Date;
  createId: () => string;
};

const productionDependencies: RateRecalculateBatchDependencies = {
  startWorkflow: startRateBrowseWorkflow,
  getWorkflow: getRateBrowseWorkflow,
  readBatch: (batchId) => getJsonSetting(rateRecalculateBatchKey(batchId)),
  persistBatch: (snapshot) => setJsonSetting(rateRecalculateBatchKey(snapshot.batchId), snapshot),
  pruneBatches: prunePersistedRateRecalculateBatches,
  now: () => new Date(),
  createId: randomUUID,
};

async function prunePersistedRateRecalculateBatches(now: Date): Promise<void> {
  const rows = await listSettingsByKeyPrefix(RATE_RECALCULATE_BATCH_PREFIX);
  await deleteSettingsByKeys(rateRecalculateBatchKeysToPrune(rows, now));
}

export function rateRecalculateBatchKeysToPrune(
  rows: ReadonlyArray<{ key: string; value: string | null }>,
  now: Date,
): string[] {
  const cutoff = now.getTime() - RATE_RECALCULATE_BATCH_RETENTION_MS;
  return rows.flatMap((row) => {
    if (!row.key.startsWith(RATE_RECALCULATE_BATCH_PREFIX)) return [];
    if (typeof row.value !== 'string') return [row.key];
    try {
      const parsed = JSON.parse(row.value) as Partial<RateRecalculateBatchSnapshot>;
      const updatedAt = new Date(String(parsed.updatedAt ?? '')).getTime();
      return !Number.isFinite(updatedAt) || updatedAt < cutoff ? [row.key] : [];
    } catch {
      return [row.key];
    }
  });
}

function dependencies(
  injected: Partial<RateRecalculateBatchDependencies> | undefined,
): RateRecalculateBatchDependencies {
  if (injected && Object.keys(injected).length > 0 && process.env.NODE_ENV !== 'test') {
    throw new Error('Rate recalculate batch dependencies may only be injected in tests');
  }
  return { ...productionDependencies, ...(injected ?? {}) };
}

export function rateRecalculateBatchKey(batchId: string): string {
  const normalized = String(batchId ?? '').trim();
  if (!normalized) throw new Error('rate recalculate batchId is required');
  return `${RATE_RECALCULATE_BATCH_PREFIX}${normalized}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  const normalized = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return normalized ? normalized.slice(0, 240) : null;
}

function isTerminal(status: RateRecalculateBatchItemStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

export function buildRateRecalculateBatchCounters(
  items: RateRecalculateBatchItem[],
): RateRecalculateBatchCounters {
  const completed = items.filter((item) => isTerminal(item.status)).length;
  return {
    total: items.length,
    completed,
    remaining: Math.max(0, items.length - completed),
    running: items.filter((item) => item.status === 'running').length,
    updated: items.filter((item) => item.status === 'updated').length,
    cleared: items.filter((item) => item.status === 'cleared').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    retryableFailed: items.filter((item) => item.status === 'failed_retryable').length,
    terminalFailed: items.filter((item) =>
      item.status === 'failed_terminal' || item.status === 'cancelled' || item.status === 'superseded'
    ).length,
  };
}

function withDerivedBatchState(
  snapshot: Omit<RateRecalculateBatchSnapshot, 'status' | 'counters' | 'finishedAt'>,
): RateRecalculateBatchSnapshot {
  const counters = buildRateRecalculateBatchCounters(snapshot.items);
  const status = counters.remaining === 0
    ? 'complete'
    : counters.running > 0
      ? 'running'
      : 'queued';
  return {
    ...snapshot,
    status,
    counters,
    finishedAt: status === 'complete' ? snapshot.updatedAt : null,
  };
}

function failureReasonFromText(value: string): {
  reasonCode: RateRecalculateBatchReasonCode;
  retryable: boolean;
} {
  const normalized = value.toLowerCase();
  if (/supersed/.test(normalized)) return { reasonCode: 'superseded', retryable: false };
  if (/cancel/.test(normalized)) return { reasonCode: 'cancelled', retryable: false };
  if (/timeout|timed out|deadline|abort/.test(normalized)) return { reasonCode: 'provider_timeout', retryable: true };
  if (/carrier account.*loading/.test(normalized)) return { reasonCode: 'carrier_accounts_loading', retryable: true };
  if (/no (eligible )?carrier|carrier account.*unavailable/.test(normalized)) {
    return { reasonCode: 'no_eligible_carrier_accounts', retryable: true };
  }
  if (/weight|dimension|postal|zip|shipment input/.test(normalized)) {
    return { reasonCode: 'missing_shipment_inputs', retryable: true };
  }
  if (/persist|fingerprint|rate proof|selection ref|authorization/.test(normalized)) {
    return { reasonCode: 'rate_persistence_rejected', retryable: true };
  }
  if (/transport|network|fetch|connection|econn/.test(normalized)) {
    return { reasonCode: 'transport_failure', retryable: true };
  }
  return { reasonCode: 'provider_failure', retryable: true };
}

export function projectRateBrowseWorkflowItem(
  previous: RateRecalculateBatchItem,
  workflow: RateBrowseWorkflowSnapshot | null,
  now = new Date(),
): RateRecalculateBatchItem {
  const updatedAt = now.toISOString();
  if (!workflow) {
    return {
      ...previous,
      status: 'failed_retryable',
      reasonCode: 'workflow_status_unavailable',
      message: 'Durable rate workflow status is temporarily unavailable.',
      retryable: true,
      updatedAt,
      finishedAt: updatedAt,
    };
  }

  if (workflow.phase === 'queued') {
    return {
      ...previous,
      workflowJobId: workflow.jobId,
      status: 'queued',
      reasonCode: null,
      message: workflow.message || 'Rate recalculation queued.',
      retryable: false,
      updatedAt: workflow.updatedAt,
      finishedAt: null,
    };
  }
  if (workflow.phase === 'cached' || workflow.phase === 'running' || workflow.phase === 'partial') {
    return {
      ...previous,
      workflowJobId: workflow.jobId,
      status: 'running',
      reasonCode: null,
      message: workflow.message || 'Rate recalculation running.',
      retryable: false,
      updatedAt: workflow.updatedAt,
      finishedAt: null,
    };
  }

  const result = record(workflow.result);
  const strict = record(result.strictRecalculation);
  const action = text(strict.action)?.toLowerCase();
  const strictMessage = text(strict.message);
  const workflowMessage = text(workflow.error) ?? text(workflow.message) ?? 'Rate recalculation failed.';

  if (workflow.phase === 'complete' && action === 'apply') {
    return {
      ...previous,
      workflowJobId: workflow.jobId,
      status: 'updated',
      reasonCode: null,
      message: strictMessage ?? 'Best rate recalculated and applied.',
      retryable: false,
      updatedAt: workflow.updatedAt,
      finishedAt: workflow.finishedAt ?? workflow.updatedAt,
    };
  }
  if (workflow.phase === 'complete' && action === 'clear') {
    return {
      ...previous,
      workflowJobId: workflow.jobId,
      status: 'cleared',
      reasonCode: 'no_rates_returned',
      message: strictMessage ?? 'No eligible live rates were returned.',
      retryable: true,
      updatedAt: workflow.updatedAt,
      finishedAt: workflow.finishedAt ?? workflow.updatedAt,
    };
  }
  if (workflow.phase === 'complete' && action === 'blocked') {
    const classified = failureReasonFromText(strictMessage ?? workflowMessage);
    return {
      ...previous,
      workflowJobId: workflow.jobId,
      status: classified.reasonCode === 'cancelled'
        ? 'cancelled'
        : classified.reasonCode === 'superseded'
          ? 'superseded'
          : classified.retryable
            ? 'failed_retryable'
            : 'failed_terminal',
      reasonCode: classified.reasonCode === 'provider_failure'
        ? 'strict_verdict_rejected'
        : classified.reasonCode,
      message: strictMessage ?? workflowMessage,
      retryable: classified.retryable,
      updatedAt: workflow.updatedAt,
      finishedAt: workflow.finishedAt ?? workflow.updatedAt,
    };
  }
  if (workflow.phase === 'complete') {
    return {
      ...previous,
      workflowJobId: workflow.jobId,
      status: 'failed_retryable',
      reasonCode: 'strict_verdict_unavailable',
      message: 'Rate workflow completed without an authoritative strict-recalculation verdict.',
      retryable: true,
      updatedAt: workflow.updatedAt,
      finishedAt: workflow.finishedAt ?? workflow.updatedAt,
    };
  }

  const classified = failureReasonFromText(workflowMessage);
  return {
    ...previous,
    workflowJobId: workflow.jobId,
    status: classified.reasonCode === 'cancelled'
      ? 'cancelled'
      : classified.reasonCode === 'superseded'
        ? 'superseded'
        : classified.retryable
          ? 'failed_retryable'
          : 'failed_terminal',
    reasonCode: classified.reasonCode,
    message: workflowMessage,
    retryable: classified.retryable,
    updatedAt: workflow.updatedAt,
    finishedAt: workflow.finishedAt ?? workflow.updatedAt,
  };
}

function initialItem(
  item: RateRecalculateBatchStartItem,
  at: string,
): RateRecalculateBatchItem {
  if (item.initialOutcome) {
    return {
      orderId: item.orderId,
      workflowJobId: null,
      ...item.initialOutcome,
      startedAt: at,
      updatedAt: at,
      finishedAt: at,
    };
  }
  return {
    orderId: item.orderId,
    workflowJobId: null,
    status: 'queued',
    reasonCode: null,
    message: 'Rate recalculation queued for durable admission.',
    retryable: false,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
  };
}

async function persist(
  snapshot: RateRecalculateBatchSnapshot,
  deps: RateRecalculateBatchDependencies,
): Promise<RateRecalculateBatchSnapshot> {
  await deps.persistBatch(snapshot);
  return snapshot;
}

export async function startRateRecalculateBatch(
  input: {
    items: RateRecalculateBatchStartItem[];
    canViewFinancials: boolean;
  },
  injected?: Partial<RateRecalculateBatchDependencies>,
): Promise<RateRecalculateBatchSnapshot> {
  const deps = dependencies(injected);
  try {
    await deps.pruneBatches(deps.now());
  } catch {
    // Retention cleanup is best-effort and must not block operator rate work.
  }
  const at = deps.now().toISOString();
  let batch = withDerivedBatchState({
    batchId: deps.createId(),
    items: input.items.map((item) => initialItem(item, at)),
    startedAt: at,
    updatedAt: at,
  });
  await persist(batch, deps);

  for (const inputItem of input.items) {
    if (!inputItem.body || inputItem.initialOutcome) continue;
    const index = batch.items.findIndex((item) => item.orderId === inputItem.orderId);
    if (index < 0) continue;
    const currentItem = batch.items[index];
    if (!currentItem) continue;
    try {
      const workflowInput: StartRateBrowseWorkflowInput = {
        body: inputItem.body,
        canViewFinancials: input.canViewFinancials,
        orderId: inputItem.orderId,
        requestKey: null,
        priority: 'manual',
        includeCachedPartial: true,
      };
      const workflow = await deps.startWorkflow(workflowInput);
      batch.items[index] = projectRateBrowseWorkflowItem(currentItem, workflow, deps.now());
    } catch (error) {
      const updatedAt = deps.now().toISOString();
      batch.items[index] = {
        ...currentItem,
        status: 'failed_retryable',
        reasonCode: 'workflow_admission_failed',
        message: text(error instanceof Error ? error.message : error) ?? 'Rate workflow admission failed.',
        retryable: true,
        updatedAt,
        finishedAt: updatedAt,
      };
    }
    batch = withDerivedBatchState({
      ...batch,
      items: [...batch.items],
      updatedAt: deps.now().toISOString(),
    });
    await persist(batch, deps);
  }
  return batch;
}

async function refreshRateRecalculateBatch(
  batchId: string,
  deps: RateRecalculateBatchDependencies,
): Promise<RateRecalculateBatchSnapshot | null> {
  const current = await deps.readBatch(batchId);
  if (!current) return null;
  const items = await Promise.all(current.items.map(async (item) => {
    if (isTerminal(item.status)) return item;
    if (!item.workflowJobId) {
      const admissionAgeMs = deps.now().getTime() - new Date(item.startedAt).getTime();
      if (Number.isFinite(admissionAgeMs) && admissionAgeMs < RATE_RECALCULATE_ADMISSION_GRACE_MS) {
        return item;
      }
      return projectRateBrowseWorkflowItem(item, null, deps.now());
    }
    try {
      return projectRateBrowseWorkflowItem(
        item,
        await deps.getWorkflow(item.workflowJobId),
        deps.now(),
      );
    } catch {
      return projectRateBrowseWorkflowItem(item, null, deps.now());
    }
  }));
  // Polling is a read projection over the canonical durable per-order jobs. Do
  // not write projected state here: a stale GET must never overwrite a newer
  // retry admission from another tab/process.
  return withDerivedBatchState({
    ...current,
    items,
    updatedAt: deps.now().toISOString(),
  });
}

export async function getRateRecalculateBatch(
  batchId: string,
  injected?: Partial<RateRecalculateBatchDependencies>,
): Promise<RateRecalculateBatchSnapshot | null> {
  return refreshRateRecalculateBatch(batchId, dependencies(injected));
}

export async function retryRateRecalculateBatch(
  batchId: string,
  input: {
    items: Array<{ orderId: number; body: Record<string, unknown> }>;
    canViewFinancials: boolean;
  },
  injected?: Partial<RateRecalculateBatchDependencies>,
): Promise<RateRecalculateBatchSnapshot | null> {
  const deps = dependencies(injected);
  let batch = await refreshRateRecalculateBatch(batchId, deps);
  if (!batch) return null;
  const bodies = new Map(input.items.map((item) => [item.orderId, item.body]));
  for (const item of batch.items) {
    const body = bodies.get(item.orderId);
    if (!body || !item.retryable || (item.status !== 'failed_retryable' && item.status !== 'cleared')) continue;
    const index = batch.items.findIndex((candidate) => candidate.orderId === item.orderId);
    if (index < 0) continue;
    try {
      const workflow = await deps.startWorkflow({
        body,
        canViewFinancials: input.canViewFinancials,
        orderId: item.orderId,
        requestKey: null,
        priority: 'manual',
        includeCachedPartial: true,
      });
      batch.items[index] = projectRateBrowseWorkflowItem({
        ...item,
        workflowJobId: workflow.jobId,
        status: 'queued',
        reasonCode: null,
        message: 'Rate recalculation retry queued.',
        retryable: false,
        updatedAt: deps.now().toISOString(),
        finishedAt: null,
      }, workflow, deps.now());
    } catch (error) {
      const updatedAt = deps.now().toISOString();
      batch.items[index] = {
        ...item,
        status: 'failed_retryable',
        reasonCode: 'workflow_admission_failed',
        message: text(error instanceof Error ? error.message : error) ?? 'Rate workflow retry admission failed.',
        retryable: true,
        updatedAt,
        finishedAt: updatedAt,
      };
    }
  }
  batch = withDerivedBatchState({
    ...batch,
    items: [...batch.items],
    updatedAt: deps.now().toISOString(),
  });
  return persist(batch, deps);
}
