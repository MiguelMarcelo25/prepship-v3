/**
 * Main-pool readiness classification.
 *
 * `/health/ready` historically probed only `healthSql` — the dedicated max:3
 * pool in routes/health.ts. That pool has its own sockets, so it stayed green
 * through two total outages (2026-08-11) in which the MAIN pool
 * (db/client.ts, DB_POOL_MAX) had every connection closed underneath it by the
 * Supavisor transaction pooler: `write CONNECTION_CLOSED …pooler.supabase.com:6543`.
 * Readiness returned 200 in ~0.7s while every real request failed, so no
 * monitor could ever page.
 *
 * Probing the main pool closes that hole, but naively failing readiness on any
 * probe error trades one outage for another: unlike `healthSql`, the main pool
 * is shared with live traffic and CAN legitimately be busy, so a load spike
 * would fail readiness and hand Render a restart loop.
 *
 * The two failures are distinguishable and deserve different responses:
 *
 *   unreachable — the socket is gone (CONNECTION_CLOSED, ECONNRESET, …).
 *                 No amount of waiting fixes it. Fail readiness immediately.
 *   saturated   — the pool is alive but every connection is in use, so the
 *                 probe timed out queueing. Usually transient. Only fail once
 *                 it persists across consecutive checks.
 *
 * Unknown errors classify as `saturated`: the tolerant path still fails after
 * `saturationTolerance` consecutive checks, so an unrecognised fatal error is
 * caught a few cycles later rather than restarting the service on a blip.
 */

/** Why a main-pool probe failed. */
export type MainPoolFailure = 'unreachable' | 'saturated';

/**
 * Substrings that mean the socket itself is gone. Matched case-insensitively
 * against the error's `code` and message. postgres.js raises the CONNECTION_*
 * codes; the rest come from Node's socket layer.
 */
const UNREACHABLE_SIGNATURES = [
  'connection_closed',
  'connection_destroyed',
  'connection_connect_timeout',
  'connection_ended',
  'econnreset',
  'econnrefused',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'enotfound',
  'socket hang up',
] as const;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === 'string' ? code : ''} ${error.message}`.toLowerCase();
  }
  return String(error ?? '').toLowerCase();
}

/** Classify a failed main-pool probe. Unknown errors are treated as `saturated`. */
export function classifyMainPoolFailure(error: unknown): MainPoolFailure {
  const text = errorText(error);
  return UNREACHABLE_SIGNATURES.some((signature) => text.includes(signature))
    ? 'unreachable'
    : 'saturated';
}

export type MainPoolVerdict = {
  /** False only when readiness should fail. */
  healthy: boolean;
  failure: MainPoolFailure | null;
  /** Consecutive saturated probes, including this one. Zero when healthy. */
  consecutiveSaturated: number;
};

/**
 * Lifetime evidence, surfaced on /health/deep.
 *
 * PS-504: the 2026-08-11 incidents were diagnosed from a screenshot because
 * nothing counted pool failures. A raw postgres.js `onclose` counter is not the
 * answer — `idle_timeout` is 10s, so connections recycle constantly and clean
 * closes would swamp the signal. Counting failed PROBES has a clean zero
 * baseline: any non-zero unreachableCount is a real dropped socket.
 */
export type MainPoolHealthSnapshot = {
  unreachableCount: number;
  saturatedCount: number;
  consecutiveSaturated: number;
  lastFailure: MainPoolFailure | null;
};

export type MainPoolHealthTracker = {
  recordSuccess: () => MainPoolVerdict;
  recordFailure: (error: unknown) => MainPoolVerdict;
  snapshot: () => MainPoolHealthSnapshot;
};

/**
 * Tracks consecutive saturation so a busy moment does not restart the service.
 *
 * `unreachable` bypasses the tolerance entirely — a closed socket is the exact
 * condition that went undetected, and waiting on it only extends the outage.
 */
export function createMainPoolHealthTracker(saturationTolerance: number): MainPoolHealthTracker {
  const tolerance = Math.max(1, Math.trunc(saturationTolerance));
  let consecutiveSaturated = 0;
  // Lifetime counters are never reset by a success — a pool that dropped
  // sockets an hour ago and recovered is still evidence worth keeping.
  let unreachableCount = 0;
  let saturatedCount = 0;
  let lastFailure: MainPoolFailure | null = null;

  return {
    recordSuccess() {
      consecutiveSaturated = 0;
      return { healthy: true, failure: null, consecutiveSaturated: 0 };
    },
    recordFailure(error: unknown) {
      const failure = classifyMainPoolFailure(error);
      lastFailure = failure;
      if (failure === 'unreachable') {
        unreachableCount += 1;
        consecutiveSaturated = 0;
        return { healthy: false, failure, consecutiveSaturated: 0 };
      }
      saturatedCount += 1;
      consecutiveSaturated += 1;
      return {
        healthy: consecutiveSaturated < tolerance,
        failure,
        consecutiveSaturated,
      };
    },
    snapshot() {
      return { unreachableCount, saturatedCount, consecutiveSaturated, lastFailure };
    },
  };
}
