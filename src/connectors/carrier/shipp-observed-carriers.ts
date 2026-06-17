// PS-271 (Layer 1) — the "observed-set" brain for the Shipp connector's thin-response retry.
//
// Shipp's /quote API has NO carrier-selection field, so we cannot ask for "UPS + FedEx". The fix is
// behavioral: EXPECT the carriers this account RECENTLY returned, and re-ask once when one is missing
// from a non-empty 200 (a "thin" response). For Shipp account 10000025 the recently-observed set
// resolves to {ups, fedex}. USPS is NEVER in a Shipp expected-set (Shipp account 10000025 never
// serves USPS — USPS comes from ShipStation 433542), so forcing it would phantom-retry fleet-wide;
// the observed-set is derived from carriers ACTUALLY returned, so USPS can never appear.
//
// EVERYTHING here is opt-in per account and default-OFF. With the flag absent the connector runs
// today's exact single POST — none of this code executes.
//
// Pure decision (missingObservedCarriers / shippObservedRetryEnabled) is DB-free so the offline guard
// exercises it without a database. The durable observed-set read + negative-memory cooldown live in
// direct_carrier_rate_cache (Layer 2's table) — durable across BOTH worker processes (a process-local
// Map would be wrong). The per-provider token bucket bounds /quote (which today bypasses the global
// limiter); it mirrors acquireShipStationRateBudget but for the Shipp provider.
import {
  DIRECT_CARRIER_COOLDOWN_MARKER,
  directCarrierQuoteCooldownMs,
  directCarrierRateCacheEnabled,
  ensureDirectCarrierRateCacheSchema,
  readFreshDirectCarrierRates,
} from '../../services/direct-carrier-rate-cache.js';
import { sql as pg } from '../../db/client.js';

/**
 * The per-account opt-in flag, read from carrier_accounts.credentials jsonb. Absent/false => the
 * whole observed-set retry is OFF and the connector does today's single POST. Accepts boolean true
 * or the strings 'true' / '1' / 'yes' so the credentials editor can store either.
 */
export function shippObservedRetryEnabled(credentials: Record<string, unknown> | null | undefined): boolean {
  if (!credentials || typeof credentials !== 'object') return false;
  const raw = (credentials as Record<string, unknown>).shippObservedSetRetry;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return /^(true|1|yes)$/i.test(raw.trim());
  return false;
}

/** Normalize a Shipp carrier label/code to the canonical lowercase carrier_code used everywhere. */
export function normalizeObservedCarrier(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * The pure decision: which EXPECTED carriers are MISSING from the carriers a non-empty 200 actually
 * returned. USPS can never be in `expected` (it's derived from observed carriers, and Shipp never
 * returns USPS), so this never asks Shipp to re-quote for a carrier it doesn't serve. Returns [] when
 * nothing is expected (cold/first observation) — never trigger a retry without prior evidence.
 */
export function missingObservedCarriers(expected: string[], returned: string[]): string[] {
  const have = new Set(returned.map(normalizeObservedCarrier).filter(Boolean));
  const want = new Set(expected.map(normalizeObservedCarrier).filter(Boolean));
  return [...want].filter((carrier) => !have.has(carrier));
}

type ShippAccountRef = {
  accountId: number | null | undefined;
  sourceTable: string | null | undefined;
  requestKey: string | null | undefined;
  laneFingerprint: string | null | undefined;
};

/**
 * The recently-observed carrier set for an account lane, read DURABLY from direct_carrier_rate_cache.
 * Returns [] when the Layer 2 cache is OFF or the account/key is missing — which the connector treats
 * as "no expectation" (no retry). Best-effort: never throws.
 */
export async function readObservedCarriers(ref: ShippAccountRef): Promise<string[]> {
  if (!directCarrierRateCacheEnabled()) return [];
  if (ref.accountId == null || !ref.sourceTable || !ref.requestKey) return [];
  const rows = await readFreshDirectCarrierRates(Number(ref.accountId), String(ref.sourceTable), String(ref.requestKey));
  const carriers = new Set<string>();
  for (const row of rows) {
    const code = normalizeObservedCarrier(row.carrierCode);
    if (code && code !== DIRECT_CARRIER_COOLDOWN_MARKER) carriers.add(code);
  }
  return [...carriers];
}

function cooldownServiceCode(carrier: string, laneFingerprint: string): string {
  return `${carrier}:${laneFingerprint}`.slice(0, 200);
}

/**
 * True when a re-quote for (account, lane, carrier) is in negative-memory cooldown — i.e. we recently
 * re-asked and the carrier was STILL missing, so we must not hammer Shipp again this window. Durable
 * (survives both worker processes). Returns false when the cache is OFF or on any error (fail-open to
 * today's behavior). Best-effort: never throws.
 */
export async function isQuoteInCooldown(ref: ShippAccountRef, carrier: string): Promise<boolean> {
  if (!directCarrierRateCacheEnabled()) return false;
  if (ref.accountId == null || !ref.sourceTable || !ref.laneFingerprint) return false;
  try {
    await ensureDirectCarrierRateCacheSchema();
    const ttlMs = directCarrierQuoteCooldownMs();
    const svc = cooldownServiceCode(normalizeObservedCarrier(carrier), String(ref.laneFingerprint));
    const rows = await pg<Array<{ fresh: boolean }>>`
      SELECT (updated_at > now() - (${ttlMs} / 1000.0) * interval '1 second') AS fresh
      FROM direct_carrier_rate_cache
      WHERE account_id = ${Number(ref.accountId)}
        AND source_table = ${String(ref.sourceTable)}
        AND carrier_code = ${DIRECT_CARRIER_COOLDOWN_MARKER}
        AND service_code = ${svc}
        AND request_key = ${String(ref.laneFingerprint)}
      LIMIT 1
    `;
    return rows[0]?.fresh === true;
  } catch (err) {
    console.warn('[shipp-observed-carriers] cooldown read skipped:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Record that a re-quote for (account, lane, carrier) STILL came back missing — start/refresh the
 * negative-memory cooldown so the next quote this window won't re-ask. NO-OP when the cache is OFF.
 * Best-effort: never throws.
 */
export async function recordQuoteCooldown(ref: ShippAccountRef, carrier: string): Promise<void> {
  if (!directCarrierRateCacheEnabled()) return;
  if (ref.accountId == null || !ref.sourceTable || !ref.laneFingerprint) return;
  try {
    await ensureDirectCarrierRateCacheSchema();
    const svc = cooldownServiceCode(normalizeObservedCarrier(carrier), String(ref.laneFingerprint));
    await pg`
      INSERT INTO direct_carrier_rate_cache
        (account_id, source_table, carrier_code, service_code, request_key, amount, rate_json, updated_at)
      VALUES (
        ${Number(ref.accountId)}, ${String(ref.sourceTable)}, ${DIRECT_CARRIER_COOLDOWN_MARKER},
        ${svc}, ${String(ref.laneFingerprint)}, 0, NULL, now()
      )
      ON CONFLICT (account_id, source_table, carrier_code, service_code, request_key) DO UPDATE
        SET updated_at = now()
    `;
  } catch (err) {
    console.warn('[shipp-observed-carriers] cooldown write skipped:', err instanceof Error ? err.message : err);
  }
}

// ─── Per-provider token bucket for Shipp /quote ──────────────────────────────
// Shipp /quote bypasses the global ShipStation limiter today. The observed-set retry can issue a 2nd
// POST per quote, so route /quote through a per-provider token bucket that mirrors
// acquireShipStationRateBudget. Bounds /quote retries only — login is untouched. Process-local (each
// worker self-limits its own outbound /quote burst); the durable cooldown above is the cross-process
// throttle on re-asks.
const SHIPP_QUOTE_LIMIT_PER_MINUTE = Math.max(
  1,
  Number.parseInt(process.env.SHIPP_QUOTE_LIMIT_PER_MINUTE ?? '60', 10) || 60,
);
const SHIPP_QUOTE_WINDOW_MS = 60_000;
const shippQuoteTimestamps: number[] = [];

function nextShippQuoteDelayMs(now = Date.now()): number {
  while (shippQuoteTimestamps.length > 0 && now - shippQuoteTimestamps[0]! >= SHIPP_QUOTE_WINDOW_MS) {
    shippQuoteTimestamps.shift();
  }
  if (shippQuoteTimestamps.length < SHIPP_QUOTE_LIMIT_PER_MINUTE) return 0;
  return Math.max(0, SHIPP_QUOTE_WINDOW_MS - (now - shippQuoteTimestamps[0]!));
}

/** Acquire one Shipp /quote token, sleeping until the per-minute budget allows it. */
export async function acquireShippQuoteBudget(): Promise<void> {
  for (;;) {
    const delayMs = nextShippQuoteDelayMs();
    if (delayMs <= 0) {
      shippQuoteTimestamps.push(Date.now());
      return;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
  }
}
