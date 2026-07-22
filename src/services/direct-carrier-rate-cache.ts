// PS-271 (Layer 2) — 60s per-carrier UNION cache for direct-carrier rates.
//
// The Shipp direct-carrier quote is uncached + non-deterministic: the SAME 31oz shipment sometimes
// returns UPS+FedEx, sometimes FedEx-only (#1502, client HUGRAB). A thin (FedEx-only) pass is a valid
// 200, so today it silently drops the cheaper UPS from the combined best-rate pick. This is the
// additive BACKSTOP: a short-TTL per-carrier cache so a thin pass still surfaces the UPS that the
// account returned a tick earlier — unioned live-wins-per-carrier with the fresh-cached rows.
//
// This table is ALSO the durable home for Layer 1's negative-memory cooldown (a process-local Map is
// wrong — there are two worker processes), stored as a synthetic carrier_code='__cooldown__' row.
//
// ENV-GATED, default OFF (DIRECT_CARRIER_RATE_CACHE). The OFF path is a TRUE no-op: read returns []
// and write is a no-op, NO DB call, NO schema ensure, zero cost — so a COLD cache / flag OFF is
// byte-for-byte identical to today (monotonic-additive). DJ flips it on Render after a canary.
//
// Best-effort everywhere: reads/writes NEVER throw into the rate hot path.
// Migration 0062 owns the table and RLS posture; boot blocks incomplete schema.
import { sql as pg } from '../db/client.js';
import { env } from '../lib/env.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

/** True only when DJ has flipped the canary on Render. Default OFF. */
export function directCarrierRateCacheEnabled(): boolean {
  return env.DIRECT_CARRIER_RATE_CACHE;
}

/** Cache freshness TTL in ms (default 60s). */
export function directCarrierRateCacheTtlMs(): number {
  return Math.max(1_000, env.DIRECT_CARRIER_RATE_CACHE_TTL_SECONDS * 1_000);
}

/** Negative-memory cooldown TTL in ms (default 180s, >= the order-sync cadence). */
export function directCarrierQuoteCooldownMs(): number {
  return Math.max(1_000, env.DIRECT_CARRIER_QUOTE_COOLDOWN_SECONDS * 1_000);
}

/** Synthetic carrier_code reserved for the durable Layer 1 cooldown rows (never a real carrier). */
export const DIRECT_CARRIER_COOLDOWN_MARKER = '__cooldown__';

export type DirectCarrierCacheRow = {
  accountId: number;
  sourceTable: string;
  carrierCode: string;
  serviceCode: string;
  requestKey: string;
  amount: number;
  rateJson: unknown;
  ageMs: number;
};

export type DirectCarrierCacheWrite = {
  accountId: number;
  sourceTable: string;
  carrierCode: string;
  serviceCode: string;
  requestKey: string;
  amount: number;
  rateJson: unknown;
};

/** Migration readiness for the durable direct-carrier cache. */
export async function ensureDirectCarrierRateCacheSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

/**
 * Read fresh-cached direct-carrier rate rows for an (account, source_table, request_key) lane.
 * Returns [] when the flag is OFF (no DB touched) or on any error. Excludes the synthetic cooldown
 * marker rows. Caller dedupes/unions; this just returns rows newer than the TTL.
 */
export async function readFreshDirectCarrierRates(
  accountId: number,
  sourceTable: string,
  requestKey: string,
  maxAgeMs: number = directCarrierRateCacheTtlMs(),
): Promise<DirectCarrierCacheRow[]> {
  if (!directCarrierRateCacheEnabled()) return [];
  if (!requestKey) return [];
  try {
    await ensureDirectCarrierRateCacheSchema();
    const cutoffMs = Math.max(1_000, maxAgeMs);
    const rows = await pg<Array<{
      carrierCode: string;
      serviceCode: string;
      amount: string | number | null;
      rateJson: unknown;
      ageMs: string | number;
    }>>`
      SELECT carrier_code AS "carrierCode", service_code AS "serviceCode", amount,
             rate_json AS "rateJson",
             EXTRACT(EPOCH FROM (now() - updated_at)) * 1000 AS "ageMs"
      FROM direct_carrier_rate_cache
      WHERE account_id = ${accountId}
        AND source_table = ${sourceTable}
        AND request_key = ${requestKey}
        AND carrier_code <> ${DIRECT_CARRIER_COOLDOWN_MARKER}
        AND updated_at > now() - (${cutoffMs} / 1000.0) * interval '1 second'
    `;
    return rows.map((row) => ({
      accountId,
      sourceTable,
      carrierCode: String(row.carrierCode ?? ''),
      serviceCode: String(row.serviceCode ?? ''),
      requestKey,
      amount: Number(row.amount ?? 0),
      rateJson: row.rateJson,
      ageMs: Number(row.ageMs ?? 0),
    }));
  } catch (err) {
    console.warn(
      '[direct-carrier-rate-cache] read skipped:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Fire-and-forget UPSERT of live direct-carrier rates. NO-OP when the flag is OFF (no DB, no schema
 * ensure). Best-effort: never throws into the rate hot path — a failed write is logged at most.
 */
export async function writeDirectCarrierRates(writes: DirectCarrierCacheWrite[]): Promise<void> {
  if (!directCarrierRateCacheEnabled()) return;
  if (!writes.length) return;
  try {
    await ensureDirectCarrierRateCacheSchema();
    for (const w of writes) {
      if (!w.requestKey || !w.carrierCode || !w.serviceCode) continue;
      const json = w.rateJson === undefined ? null : JSON.stringify(w.rateJson);
      await pg`
        INSERT INTO direct_carrier_rate_cache
          (account_id, source_table, carrier_code, service_code, request_key, amount, rate_json, updated_at)
        VALUES (
          ${w.accountId}, ${w.sourceTable}, ${w.carrierCode}, ${w.serviceCode},
          ${w.requestKey}, ${w.amount}, ${json}::jsonb, now()
        )
        ON CONFLICT (account_id, source_table, carrier_code, service_code, request_key) DO UPDATE
          SET amount = EXCLUDED.amount, rate_json = EXCLUDED.rate_json, updated_at = now()
      `;
    }
  } catch (err) {
    console.warn(
      '[direct-carrier-rate-cache] write skipped:',
      err instanceof Error ? err.message : err,
    );
  }
}
