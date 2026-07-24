export type ApiRouteHealth = 'learning' | 'healthy' | 'slow' | 'error';

type ApiTimingSample = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  responseBytes: number | null;
  observedAt: string;
};

type ApiTimingBucket = {
  method: string;
  path: string;
  recentSamples: ApiTimingSample[];
};

type ApiTimingObservation = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  responseBytes?: number | null;
  observedAtMs?: number;
};

export const API_TIMING_WINDOW_MS = 15 * 60_000;
export const API_TIMING_MIN_CONFIDENT_SAMPLES = 20;

const MAX_BUCKETS = 150;
const MAX_RECENT_SAMPLES = 500;
const STARTED_AT_MS = Date.now();
const STARTED_AT = new Date(STARTED_AT_MS).toISOString();
const buckets = new Map<string, ApiTimingBucket>();

const ROUTE_P95_BUDGET_MS = new Map<string, number>([
  ['GET /orders', 1_000],
  ['GET /orders/:id/full', 1_000],
  ['GET /rates/carriers-for-store', 1_500],
  ['GET /sync/status', 1_000],
]);

function bucketKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path || '/'}`;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

export function normalizeApiMetricPath(value: string): string {
  const rawPath = String(value || '/').split(/[?#]/, 1)[0] || '/';
  const normalized = rawPath
    .replace(/:([A-Za-z0-9_]+)\{[^}]+\}/g, ':$1')
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
      '/:id',
    )
    .replace(/\/\d+(?=\/|$)/g, '/:id');
  return normalized || '/';
}

export function apiRouteLatencyBudgetMs(method: string, path: string): number {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizeApiMetricPath(path);
  return ROUTE_P95_BUDGET_MS.get(bucketKey(normalizedMethod, normalizedPath))
    ?? (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' ? 1_000 : 1_500);
}

export function classifyApiRouteHealth(input: {
  sampleCount: number;
  errorCount: number;
  p95Ms: number;
  budgetMs: number;
}): ApiRouteHealth {
  if (input.errorCount > 0) return 'error';
  if (input.sampleCount < API_TIMING_MIN_CONFIDENT_SAMPLES) return 'learning';
  if (input.p95Ms > input.budgetMs) return 'slow';
  return 'healthy';
}

function pruneExpiredBucket(bucket: ApiTimingBucket, nowMs: number): void {
  const cutoffMs = nowMs - API_TIMING_WINDOW_MS;
  bucket.recentSamples = bucket.recentSamples.filter((sample) => {
    const observedAtMs = Date.parse(sample.observedAt);
    return Number.isFinite(observedAtMs) && observedAtMs >= cutoffMs && observedAtMs <= nowMs;
  });
}

function pruneExpiredBuckets(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    pruneExpiredBucket(bucket, nowMs);
    if (bucket.recentSamples.length === 0) buckets.delete(key);
  }
}

export function observeApiTiming(observation: ApiTimingObservation): void {
  const observedAtMs = Number.isFinite(observation.observedAtMs)
    ? Number(observation.observedAtMs)
    : Date.now();
  const method = observation.method.toUpperCase();
  let path = normalizeApiMetricPath(observation.path);
  let key = bucketKey(method, path);
  const existing = buckets.get(key);
  if (existing) {
    pruneExpiredBucket(existing, observedAtMs);
    if (existing.recentSamples.length === 0) buckets.delete(key);
  }
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    pruneExpiredBuckets(observedAtMs);
  }
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    path = '/__other__';
    key = bucketKey(method, path);
  }

  const observedAt = new Date(observedAtMs).toISOString();
  const sample: ApiTimingSample = {
    method,
    path,
    status: observation.status,
    durationMs: Math.max(0, Math.round(observation.durationMs)),
    responseBytes:
      typeof observation.responseBytes === 'number'
        ? observation.responseBytes
        : null,
    observedAt,
  };
  const bucket = buckets.get(key) ?? {
    method,
    path,
    recentSamples: [],
  };
  bucket.recentSamples.push(sample);
  if (bucket.recentSamples.length > MAX_RECENT_SAMPLES) {
    bucket.recentSamples.splice(0, bucket.recentSamples.length - MAX_RECENT_SAMPLES);
  }
  buckets.set(key, bucket);
}

export function getApiTimingSnapshot(options: { nowMs?: number } = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  pruneExpiredBuckets(nowMs);

  const routes = Array.from(buckets.values())
    .map((bucket) => {
      const samples = bucket.recentSamples;
      const durations = samples.map((sample) => sample.durationMs);
      const latest = samples[samples.length - 1]!;
      const count = samples.length;
      const errorCount = samples.filter((sample) => sample.status >= 500).length;
      const p95Ms = percentile(durations, 95);
      const budgetMs = apiRouteLatencyBudgetMs(bucket.method, bucket.path);
      const confidence = count >= API_TIMING_MIN_CONFIDENT_SAMPLES ? 'ready' as const : 'learning' as const;
      return {
        method: bucket.method,
        path: bucket.path,
        count,
        errorCount,
        errorRate: count > 0 ? Number(((errorCount / count) * 100).toFixed(1)) : 0,
        avgMs: Math.round(durations.reduce((sum, duration) => sum + duration, 0) / Math.max(1, count)),
        p50Ms: percentile(durations, 50),
        p95Ms,
        p99Ms: percentile(durations, 99),
        maxMs: Math.max(0, ...durations),
        lastDurationMs: latest.durationMs,
        lastStatus: latest.status,
        lastObservedAt: latest.observedAt,
        budgetMs,
        confidence,
        health: classifyApiRouteHealth({ sampleCount: count, errorCount, p95Ms, budgetMs }),
        recentSamples: [...samples],
      };
    })
    .sort((a, b) => {
      const priority: Record<ApiRouteHealth, number> = { error: 0, slow: 1, learning: 2, healthy: 3 };
      return priority[a.health] - priority[b.health]
        || b.p95Ms - a.p95Ms
        || b.count - a.count;
    });

  const errorRouteCount = routes.filter((route) => route.health === 'error').length;
  const slowRouteCount = routes.filter((route) => route.health === 'slow').length;
  const learningRouteCount = routes.filter((route) => route.health === 'learning').length;
  const healthyRouteCount = routes.filter((route) => route.health === 'healthy').length;
  const slowestCurrent = routes.reduce<(typeof routes)[number] | null>(
    (slowest, route) => (
      !slowest || route.lastDurationMs > slowest.lastDurationMs ? route : slowest
    ),
    null,
  );
  const state = errorRouteCount > 0
    ? 'error' as const
    : slowRouteCount > 0
      ? 'slow' as const
      : routes.length === 0
        ? 'idle' as const
        : learningRouteCount > 0
          ? 'learning' as const
          : 'healthy' as const;

  return {
    startedAt: STARTED_AT,
    generatedAt: new Date(nowMs).toISOString(),
    routeCount: routes.length,
    window: {
      durationMs: API_TIMING_WINDOW_MS,
      label: 'Last 15 minutes',
      startedAt: new Date(Math.max(STARTED_AT_MS, nowMs - API_TIMING_WINDOW_MS)).toISOString(),
      sampleCapacityPerRoute: MAX_RECENT_SAMPLES,
      minimumSamplesForPercentiles: API_TIMING_MIN_CONFIDENT_SAMPLES,
    },
    summary: {
      state,
      windowSampleCount: routes.reduce((sum, route) => sum + route.count, 0),
      healthyRouteCount,
      slowRouteCount,
      errorRouteCount,
      learningRouteCount,
      slowestCurrent: slowestCurrent ? {
        method: slowestCurrent.method,
        path: slowestCurrent.path,
        durationMs: slowestCurrent.lastDurationMs,
        health: slowestCurrent.health,
      } : null,
    },
    routes,
  };
}

export function resetApiTimingMetricsForTest(): void {
  buckets.clear();
}
