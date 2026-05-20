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
  count: number;
  errorCount: number;
  totalMs: number;
  maxMs: number;
  lastDurationMs: number;
  lastStatus: number;
  lastObservedAt: string;
  recentDurations: number[];
  recentSamples: ApiTimingSample[];
};

type ApiTimingObservation = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  responseBytes?: number | null;
};

const MAX_BUCKETS = 150;
const MAX_RECENT_DURATIONS = 200;
const MAX_RECENT_SAMPLES = 20;
const STARTED_AT = new Date().toISOString();
const buckets = new Map<string, ApiTimingBucket>();

function bucketKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path || '/'}`;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx] ?? 0;
}

export function observeApiTiming(observation: ApiTimingObservation): void {
  const method = observation.method.toUpperCase();
  const path = observation.path || '/';
  let key = bucketKey(method, path);
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    key = bucketKey(method, '__other__');
  }

  const observedAt = new Date().toISOString();
  const durationMs = Math.max(0, Math.round(observation.durationMs));
  const sample: ApiTimingSample = {
    method,
    path,
    status: observation.status,
    durationMs,
    responseBytes:
      typeof observation.responseBytes === 'number'
        ? observation.responseBytes
        : null,
    observedAt,
  };

  const existing = buckets.get(key);
  const bucket =
    existing ??
    {
      method,
      path,
      count: 0,
      errorCount: 0,
      totalMs: 0,
      maxMs: 0,
      lastDurationMs: 0,
      lastStatus: 0,
      lastObservedAt: observedAt,
      recentDurations: [],
      recentSamples: [],
    };

  bucket.count += 1;
  if (observation.status >= 500) bucket.errorCount += 1;
  bucket.totalMs += durationMs;
  bucket.maxMs = Math.max(bucket.maxMs, durationMs);
  bucket.lastDurationMs = durationMs;
  bucket.lastStatus = observation.status;
  bucket.lastObservedAt = observedAt;
  bucket.recentDurations.push(durationMs);
  if (bucket.recentDurations.length > MAX_RECENT_DURATIONS) {
    bucket.recentDurations.splice(
      0,
      bucket.recentDurations.length - MAX_RECENT_DURATIONS
    );
  }
  bucket.recentSamples.push(sample);
  if (bucket.recentSamples.length > MAX_RECENT_SAMPLES) {
    bucket.recentSamples.splice(
      0,
      bucket.recentSamples.length - MAX_RECENT_SAMPLES
    );
  }

  buckets.set(key, bucket);
}

export function getApiTimingSnapshot() {
  const routes = Array.from(buckets.values())
    .map((bucket) => ({
      method: bucket.method,
      path: bucket.path,
      count: bucket.count,
      errorCount: bucket.errorCount,
      avgMs: Math.round(bucket.totalMs / Math.max(1, bucket.count)),
      p50Ms: percentile(bucket.recentDurations, 50),
      p95Ms: percentile(bucket.recentDurations, 95),
      p99Ms: percentile(bucket.recentDurations, 99),
      maxMs: bucket.maxMs,
      lastDurationMs: bucket.lastDurationMs,
      lastStatus: bucket.lastStatus,
      lastObservedAt: bucket.lastObservedAt,
      recentSamples: bucket.recentSamples,
    }))
    .sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);

  return {
    startedAt: STARTED_AT,
    generatedAt: new Date().toISOString(),
    routeCount: routes.length,
    window: {
      recentDurationsPerRoute: MAX_RECENT_DURATIONS,
      recentSamplesPerRoute: MAX_RECENT_SAMPLES,
    },
    routes,
  };
}
