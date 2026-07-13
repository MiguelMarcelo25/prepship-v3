/**
 * force-override-rate-limit.ts — PS-231.
 *
 * Per-admin sliding-window rate limit on the shipped/cancelled `?force=1` lockdown
 * override (assertOrderEditable, src/routes/orders.ts). A compromised admin token
 * must not be able to rewrite unlimited historical/financial records in a burst —
 * each override is already audited (PS-234); this caps the rate.
 *
 * The window math is a PURE function (evaluateForceOverrideWindow) so the guard can
 * test it offline with an injected clock; the in-memory store is the only impure
 * part (per-instance, which matches the single-instance Render backend; the audit
 * trail remains the durable cross-instance record). Limit is env-configurable via
 * FORCE_OVERRIDE_MAX_PER_HOUR (default 20), mirroring the kill-switch style of
 * isInventoryAutoDeductEnabled().
 */
const DEFAULT_MAX_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;

export function configuredForceOverrideMax(): number {
  const raw = Number(process.env.FORCE_OVERRIDE_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_PER_HOUR;
}

export type ForceOverrideRateResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

/**
 * Pure window evaluation. Given an actor's prior override timestamps, decide whether
 * one more is allowed now. Returns the pruned in-window timestamps so the caller can
 * persist them. Does NOT record the new attempt (the caller appends `now` on allow).
 */
export function evaluateForceOverrideWindow(
  priorTimestamps: number[],
  now: number,
  max: number,
  windowMs: number,
): ForceOverrideRateResult & { kept: number[] } {
  const kept = priorTimestamps.filter((t) => now - t < windowMs);
  if (kept.length >= max) {
    const oldest = Math.min(...kept);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, windowMs - (now - oldest)),
      kept,
    };
  }
  return { allowed: true, remaining: Math.max(0, max - kept.length - 1), retryAfterMs: 0, kept };
}

const store = new Map<string, number[]>();

/**
 * Check-and-record one force-override attempt for an admin. On allow, the attempt is
 * recorded; on deny, the store is left pruned (the denied attempt is not counted).
 */
export function checkForceOverrideRateLimit(actor: string | undefined | null): ForceOverrideRateResult {
  const key = (actor ?? 'unknown').toLowerCase();
  const now = Date.now();
  const max = configuredForceOverrideMax();
  const result = evaluateForceOverrideWindow(store.get(key) ?? [], now, max, WINDOW_MS);
  store.set(key, result.allowed ? [...result.kept, now] : result.kept);
  return { allowed: result.allowed, remaining: result.remaining, retryAfterMs: result.retryAfterMs };
}

/**
 * Audit PL-6 (2026-07-13): DURABLE variant. The in-memory store resets on every
 * restart and is per-instance — the PS-231 cap ("a compromised admin token must
 * not rewrite unlimited locked records in a burst") silently vanished on redeploy.
 * Every ALLOWED override already writes an append-only audit_log row
 * (eventType='lockdown_override', action='force_override' — DB-trigger protected),
 * so the durable window is derived from those rows: zero new state, correct
 * across instances and restarts. Falls back to the in-memory window if the audit
 * query fails (an override attempt should not hard-fail on a transient DB read
 * error; the in-memory floor still applies and the attempt itself is audited).
 */
export async function checkForceOverrideRateLimitDurable(
  actor: string | undefined | null,
): Promise<ForceOverrideRateResult> {
  const key = (actor ?? 'unknown').toLowerCase();
  const max = configuredForceOverrideMax();
  try {
    const { sql } = await import('../db/client');
    const [row] = await sql<Array<{ n: number; oldest: string | null }>>`
      SELECT count(*)::int AS n, min(ts)::text AS oldest
      FROM audit_log
      WHERE event_type = 'lockdown_override'
        AND action = 'force_override'
        AND lower(coalesce(actor_email, 'unknown')) = ${key}
        AND ts > now() - interval '1 hour'
    `;
    const n = Number(row?.n ?? 0);
    if (n >= max) {
      const oldestMs = row?.oldest ? Date.parse(row.oldest) : Date.now();
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, WINDOW_MS - (Date.now() - oldestMs)),
      };
    }
    // Keep the in-memory window recording too: it is the only intra-request
    // backstop (the audit row for THIS attempt is written by the caller after
    // this check), and it preserves the fallback path's accuracy.
    checkForceOverrideRateLimit(actor);
    return { allowed: true, remaining: Math.max(0, max - n - 1), retryAfterMs: 0 };
  } catch {
    return checkForceOverrideRateLimit(actor);
  }
}

/** Test-only: reset the in-memory store. */
export function __resetForceOverrideRateLimit(): void {
  store.clear();
}
