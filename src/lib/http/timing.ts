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

export async function timedFetch(
  name: string,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fields?: TimingFields,
): Promise<Response> {
  const startedAt = nowMs();
  try {
    const res = await fetch(input, init);
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
