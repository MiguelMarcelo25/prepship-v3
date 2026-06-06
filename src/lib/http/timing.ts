export type TimingFields = Record<string, string | number | boolean | null | undefined>;

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
  options: {
    logPrefix?: string;
    thresholdMs?: number;
    fields?: TimingFields;
  } = {},
): Promise<T> {
  const startedAt = nowMs();
  try {
    const result = await fn();
    logTiming(name, elapsedMs(startedAt), { ...options, ok: true });
    return result;
  } catch (err) {
    logTiming(name, elapsedMs(startedAt), {
      ...options,
      ok: false,
      fields: {
        ...options.fields,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// ─── Carrier harness replay/capture hooks ───────────────────────────────────
// Used ONLY by the carrier test harness. Both are inert unless CARRIER_TEST_MODE
// is set, so production fetch behavior is unchanged. Replay returns a recorded
// Response (no real network); capture records the real Response body to a sink so
// the harness can build fixtures from genuine carrier traffic (not fabricated).
export type CarrierReplayStep = { name: string; status?: number; body: unknown };
export type CarrierCaptureRecord = { name: string; status: number; body: string };

let __replaySteps: CarrierReplayStep[] | null = null;
let __replayUsed: boolean[] = [];
let __captureSink: ((rec: CarrierCaptureRecord) => void) | null = null;

export function __setCarrierReplay(steps: CarrierReplayStep[] | null): void {
  if (!process.env.CARRIER_TEST_MODE || !steps) {
    __replaySteps = null;
    __replayUsed = [];
    return;
  }
  __replaySteps = steps;
  __replayUsed = steps.map(() => false);
}

export function __setCarrierCaptureSink(sink: ((rec: CarrierCaptureRecord) => void) | null): void {
  __captureSink = process.env.CARRIER_TEST_MODE ? sink : null;
}

function takeReplay(name: string): Response | null {
  if (!__replaySteps || !process.env.CARRIER_TEST_MODE) return null;
  for (let i = 0; i < __replaySteps.length; i += 1) {
    const step = __replaySteps[i];
    if (!step || __replayUsed[i]) continue;
    if (step.name === name) {
      __replayUsed[i] = true;
      const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {});
      return new Response(body, { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
  }
  return null;
}

export async function timedFetch(
  name: string,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fields?: TimingFields,
): Promise<Response> {
  const startedAt = nowMs();
  const replayed = takeReplay(name);
  if (replayed) {
    console.info('[external:timing]', { name, durationMs: 0, host: timingHost(input), status: replayed.status, ok: replayed.ok, replay: true, ...fields });
    return replayed;
  }
  try {
    const res = await fetch(input, init);
    if (__captureSink && process.env.CARRIER_TEST_MODE) {
      const clone = res.clone();
      const body = await clone.text().catch(() => '');
      __captureSink({ name, status: res.status, body });
    }
    console.info('[external:timing]', {
      name,
      durationMs: elapsedMs(startedAt),
      method: init?.method ?? 'GET',
      host: timingHost(input),
      status: res.status,
      ok: res.ok,
      ...fields,
    });
    return res;
  } catch (err) {
    console.info('[external:timing]', {
      name,
      durationMs: elapsedMs(startedAt),
      method: init?.method ?? 'GET',
      host: timingHost(input),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...fields,
    });
    throw err;
  }
}

export function serverTimingValue(metrics: TimingFields): string {
  return Object.entries(metrics)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([name, value]) => `${sanitizeServerTimingName(name)};dur=${Math.max(0, Math.round(value as number))}`)
    .join(', ');
}

export function appendServerTiming(existing: string | null | undefined, metrics: TimingFields): string {
  const next = serverTimingValue(metrics);
  if (!existing) return next;
  if (!next) return existing;
  return `${existing}, ${next}`;
}

function logTiming(
  name: string,
  durationMs: number,
  options: {
    logPrefix?: string;
    thresholdMs?: number;
    ok?: boolean;
    fields?: TimingFields;
  },
): void {
  const thresholdMs = options.thresholdMs ?? 0;
  if (durationMs < thresholdMs) return;
  console.info(options.logPrefix ?? '[timing]', {
    name,
    durationMs,
    ok: options.ok,
    ...options.fields,
  });
}

function timingHost(input: Parameters<typeof fetch>[0]): string | undefined {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
}

function sanitizeServerTimingName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}
