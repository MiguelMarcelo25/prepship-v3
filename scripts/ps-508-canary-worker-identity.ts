/**
 * PS-508 — the worker-identity decision for the canary packet, extracted as a pure, testable
 * owner (Hermes round-6, K3): given the persisted worker.status.snapshot* rows, decide whether
 * the WORKER deployment identity is proven current for an attested SHA.
 *
 * Fail-closed rules:
 *  - only the canonical scheduler snapshot key counts as authoritative
 *    (worker.status.snapshot:worker-scheduler); placeholder/legacy/aux rows never decide;
 *  - the snapshot must parse, be service === 'worker', and carry a full 40-hex commitSha;
 *  - the heartbeat must be present, parseable, and RECENT — a months-old snapshot with the
 *    right SHA proves historical identity, not a live worker;
 *  - competing authoritative snapshots (more than one canonical row) are ambiguity, refused;
 *  - the SHA must equal the attested deployment SHA exactly.
 */
const HEX40 = /^[0-9a-f]{40}$/;
const CANONICAL_KEY = 'worker.status.snapshot:worker-scheduler';
export const WORKER_HEARTBEAT_MAX_AGE_MS = 15 * 60_000;

export type WorkerIdentityDecision =
  | { ok: true; sha: string; heartbeatAgeMs: number }
  | { ok: false; reason: string };

export function decideWorkerIdentity(
  rows: Array<{ key: string; value: unknown }>,
  expectedSha: string,
  now: number,
): WorkerIdentityDecision {
  const canonical = rows.filter((r) => r.key === CANONICAL_KEY);
  if (canonical.length === 0) {
    return { ok: false, reason: 'no canonical worker snapshot (' + CANONICAL_KEY + ') found — the worker identity cannot be independently verified' };
  }
  if (canonical.length > 1) {
    return { ok: false, reason: canonical.length + ' competing canonical worker snapshots — ambiguous identity, refusing' };
  }
  let parsed: unknown;
  try {
    parsed = typeof canonical[0]!.value === 'string' ? JSON.parse(canonical[0]!.value as string) : canonical[0]!.value;
  } catch {
    return { ok: false, reason: 'the canonical worker snapshot is not parseable JSON' };
  }
  const snap = parsed as { service?: unknown; runtime?: { commitSha?: unknown }; heartbeatAt?: unknown } | null;
  if (!snap || snap.service !== 'worker') {
    return { ok: false, reason: 'the canonical snapshot is not a worker-service snapshot (service=' + String(snap?.service) + ')' };
  }
  const sha = snap.runtime?.commitSha;
  if (typeof sha !== 'string' || !HEX40.test(sha)) {
    return { ok: false, reason: 'the worker snapshot carries no full 40-hex commitSha (got ' + String(sha) + ')' };
  }
  // Round-7: liveness requires an actual heartbeatAt — NOT a startedAt fallback. startedAt is
  // set once at boot and never advances, so a worker that booted and then stopped would keep a
  // recent startedAt while doing nothing; only a moving heartbeat proves a live worker.
  const heartbeatRaw = snap.heartbeatAt;
  const heartbeat = typeof heartbeatRaw === 'string' ? Date.parse(heartbeatRaw) : NaN;
  if (Number.isNaN(heartbeat)) {
    return { ok: false, reason: 'the worker snapshot has no parseable heartbeatAt — liveness cannot be established (startedAt is not accepted as a liveness signal)' };
  }
  const age = now - heartbeat;
  // A heartbeat in the future is a clock error or a fabricated timestamp, not liveness. Allow
  // only 5 minutes of skew, matching the readback-timestamp rule.
  if (age < -5 * 60_000) {
    return { ok: false, reason: 'the worker heartbeat is in the FUTURE (' + Math.round(-age / 60_000)
      + ' minutes ahead) — a clock error or fabricated timestamp, not liveness' };
  }
  if (age > WORKER_HEARTBEAT_MAX_AGE_MS) {
    return { ok: false, reason: 'the worker heartbeat is ' + Math.round(age / 60_000) + ' minutes old (max '
      + WORKER_HEARTBEAT_MAX_AGE_MS / 60_000 + ') — the snapshot proves historical identity, not a live worker' };
  }
  if (sha !== expectedSha) {
    return { ok: false, reason: 'the live worker runs ' + sha + ', not the attested deployment SHA ' + expectedSha + ' — the worker is stale' };
  }
  return { ok: true, sha, heartbeatAgeMs: age };
}
