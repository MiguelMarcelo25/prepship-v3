import { env } from '../lib/env';
import { getSetting, setSetting } from './settings';

const WORKER_STATUS_KEY = 'worker.status.snapshot';

type WorkerMode = 'api-scheduler' | 'worker-scheduler' | 'placeholder' | 'disabled';
type WorkerJobStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export type WorkerJobSnapshot = {
  name: string;
  status: WorkerJobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
};

export type WorkerStatusSnapshot = {
  version: 1;
  service: 'api' | 'worker';
  mode: WorkerMode;
  schedulerEnabled: boolean;
  placeholder: boolean;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  currentJob: string | null;
  jobs: Record<string, WorkerJobSnapshot>;
};

const processStartedAt = new Date().toISOString();
let snapshot: WorkerStatusSnapshot = createSnapshot('disabled');

function createSnapshot(mode: WorkerMode): WorkerStatusSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    service: mode === 'api-scheduler' ? 'api' : 'worker',
    mode,
    schedulerEnabled: mode === 'api-scheduler' || mode === 'worker-scheduler',
    placeholder: mode === 'placeholder',
    pid: process.pid,
    startedAt: processStartedAt,
    heartbeatAt: now,
    currentJob: null,
    jobs: {},
  };
}

function summarizeResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const source = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'synced',
    'pages',
    'inserted',
    'updated',
    'matchedOrders',
    'ordersMarkedShipped',
    'processed',
    'succeeded',
    'failed',
    'skipped',
    'total',
    'refreshed',
    'days',
    'dailyRows',
    'skuRows',
    'inventoryRows',
    'billingRows',
    'lastSyncedAt',
  ]) {
    if (source[key] !== undefined) summary[key] = source[key];
  }
  return Object.keys(summary).length ? summary : null;
}

async function persistSnapshot(): Promise<void> {
  try {
    await setSetting(WORKER_STATUS_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn(
      '[worker-status] failed to persist status:',
      err instanceof Error ? err.message : err
    );
  }
}

export async function setWorkerMode(mode: WorkerMode): Promise<void> {
  snapshot = createSnapshot(mode);
  await persistSnapshot();
}

export async function recordWorkerHeartbeat(): Promise<void> {
  snapshot.heartbeatAt = new Date().toISOString();
  await persistSnapshot();
}

export async function recordWorkerJobStart(name: string): Promise<void> {
  const now = new Date().toISOString();
  snapshot.currentJob = name;
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    name,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    summary: null,
    error: null,
  };
  await persistSnapshot();
}

export async function recordWorkerJobSuccess(
  name: string,
  startedAtMs: number,
  result: unknown
): Promise<void> {
  const now = new Date().toISOString();
  snapshot.currentJob = snapshot.currentJob === name ? null : snapshot.currentJob;
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    name,
    status: 'succeeded',
    startedAt: snapshot.jobs[name]?.startedAt ?? new Date(startedAtMs).toISOString(),
    finishedAt: now,
    durationMs: Date.now() - startedAtMs,
    summary: summarizeResult(result),
    error: null,
  };
  await persistSnapshot();
}

export async function recordWorkerJobFailure(
  name: string,
  startedAtMs: number,
  err: unknown
): Promise<void> {
  const now = new Date().toISOString();
  snapshot.currentJob = snapshot.currentJob === name ? null : snapshot.currentJob;
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    name,
    status: 'failed',
    startedAt: snapshot.jobs[name]?.startedAt ?? new Date(startedAtMs).toISOString(),
    finishedAt: now,
    durationMs: Date.now() - startedAtMs,
    summary: null,
    error: err instanceof Error ? err.message : String(err),
  };
  await persistSnapshot();
}

export async function recordWorkerJobSkipped(
  name: string,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  snapshot.heartbeatAt = now;
  snapshot.jobs[name] = {
    name,
    status: 'skipped',
    startedAt: null,
    finishedAt: now,
    durationMs: null,
    summary: { reason },
    error: null,
  };
  await persistSnapshot();
}

export async function getPersistedWorkerStatus(): Promise<{
  status: WorkerStatusSnapshot | null;
  stale: boolean;
  heartbeatAgeSeconds: number | null;
}> {
  const raw = await getSetting(WORKER_STATUS_KEY);
  if (!raw) {
    return { status: null, stale: true, heartbeatAgeSeconds: null };
  }
  try {
    const status = JSON.parse(raw) as WorkerStatusSnapshot;
    const heartbeatMs = Date.parse(status.heartbeatAt);
    const heartbeatAgeSeconds = Number.isFinite(heartbeatMs)
      ? Math.max(0, Math.round((Date.now() - heartbeatMs) / 1000))
      : null;
    return {
      status,
      stale: heartbeatAgeSeconds === null || heartbeatAgeSeconds > 120,
      heartbeatAgeSeconds,
    };
  } catch {
    return { status: null, stale: true, heartbeatAgeSeconds: null };
  }
}

export function getApiRuntimeStatus() {
  return {
    schedulerEnabled: env.RUN_SYNC_SCHEDULER,
    workerPlaceholder: env.WORKER_PLACEHOLDER,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: processStartedAt,
  };
}
