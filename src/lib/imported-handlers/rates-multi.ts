// Node-style handler mounted by the Render/Hono /rates route.
//
// Reads three sources of ShipStation V2 credentials and tags each returned
// carrier with the account it came from so the Settings UI can group:
//   1. SHIPSTATION_API_KEY_V2          → "DR PREPPER"
//   2. SHIPSTATION_KFG_API_KEY_V2      → "KFG"
//   3. clients.ssApiKeyV2 in Postgres  → client.name (per-client header)
//
// Auth: requires a Supabase JWT in Authorization: Bearer <token>. Verified
// against SUPABASE_JWT_SECRET. Same gate as the Render API uses.

import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../auth/verify-supabase-jwt';
import { corsHeaders } from '../http/cors';
import { elapsedMs, nowMs } from '../http/timing';
import {
  loadShipStationCarrierAccounts,
  type ShipStationCarrierAccountLoadResult,
} from '../../services/shipstation-carrier-account-cache';
import {
  loadShipStationCarrierAccountSources,
  readShipStationCarrierAccountSnapshots,
  resolveShipStationCarrierAccountSnapshot,
  type ShipStationCarrierAccountSnapshot,
  type ShipStationCarrierAccountSource,
  type ShipStationCarrierSnapshotResolution,
} from '../../services/shipstation-carrier-account-snapshots';
import type { NodeStyleRequest, NodeStyleResponse } from '../node-handler.js';

interface SsCarrier {
  carrier_id: string;
  carrier_code: string;
  nickname?: string;
  friendly_name?: string;
  services?: unknown[];
}

interface TaggedCarrier extends SsCarrier {
  source_client_name: string;
  source_client_id: number | null;
}

type MultiCarrierTiming = {
  totalDurationMs: number;
  authDurationMs: number;
  dbDurationMs: number;
  aggregationDurationMs: number;
  slowestSource: string | null;
  slowestSourceDurationMs: number;
  cacheHits: number;
  cacheMisses: number;
  durableSnapshotHits?: number;
  durableStaleSources?: number;
  liveFallbacks?: number;
  responseCacheHit: boolean;
  responseCacheAgeMs: number | null;
};

type MultiCarrierSourceDiagnostic = {
  source: string;
  keySource: string;
  status: number | null;
  count: number;
  error: string | null;
  cacheStatus: 'hit' | 'miss';
  cacheAgeMs: number | null;
  durationMs: number;
  providerDurationMs: number;
  snapshotStatus: ShipStationCarrierSnapshotResolution['status'];
  snapshotAgeMs: number | null;
  snapshotFetchedAt: string | null;
};

type MultiCarrierPayload = {
  carriers: TaggedCarrier[];
  _diagnostics: {
    dbError: string | null;
    sources: MultiCarrierSourceDiagnostic[];
    cachedAt: string;
    timing: MultiCarrierTiming;
  };
};

function publicCarrierFetchError(result: ShipStationCarrierAccountLoadResult): string | null {
  if (!result.error) return null;
  if (result.status) return `ShipStation carrier request failed (${result.status})`;
  return 'ShipStation carrier request failed';
}

// Whole-response TTL cache. The payload is identical for every AUTHORIZED
// caller — it is built only from the env keys + the clients table, nothing
// user-scoped — so one module-level entry is safe. Auth is still verified on
// every request; the cache only skips the ShipStation fan-out + DB read.
// The per-credential cache below remains the provider-facing source, so an L1
// expiry refreshes the active DB credential inventory without another live
// ShipStation request for unchanged credentials.
const RATES_MULTI_CACHE_TTL_MS = (() => {
  const raw = Number.parseInt(process.env.RATES_MULTI_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();
let cachedResponse: { at: number; payload: MultiCarrierPayload } | null = null;

export default async function handler(
  req: NodeStyleRequest,
  res: NodeStyleResponse,
): Promise<void> {
  const totalStartedAt = nowMs();
  const origin = (req.headers?.origin as string | undefined) ?? null;
  const ch = corsHeaders(origin, { methods: 'GET, OPTIONS' });
  for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth: verify Supabase JWT
  const token = extractBearerToken(
    req.headers?.authorization || req.headers?.Authorization
  );
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization' });
    return;
  }
  const authStartedAt = nowMs();
  const verified = await verifySupabaseJwt(token);
  const authDurationMs = elapsedMs(authStartedAt);
  if (!verified.ok) {
    console.warn('[imported-rates-multi] Invalid token:', verified.reason);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const responseCacheAgeMs = cachedResponse
    ? Math.max(0, Date.now() - cachedResponse.at)
    : null;
  if (
    RATES_MULTI_CACHE_TTL_MS > 0 &&
    cachedResponse &&
    responseCacheAgeMs != null &&
    responseCacheAgeMs < RATES_MULTI_CACHE_TTL_MS
  ) {
    const totalDurationMs = elapsedMs(totalStartedAt);
    const cachedPayload = cachedResponse.payload;
    const timing = {
      ...(cachedPayload?._diagnostics?.timing ?? {}),
      totalDurationMs,
      authDurationMs,
      dbDurationMs: 0,
      aggregationDurationMs: 0,
      slowestSource: null,
      slowestSourceDurationMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      responseCacheHit: true,
      responseCacheAgeMs,
    };
    res.setHeader(
      'Server-Timing',
      `multi_auth;dur=${authDurationMs}, multi_cache;dur=${totalDurationMs}`,
    );
    res.status(200).json({
      ...cachedPayload,
      _diagnostics: {
        ...cachedPayload._diagnostics,
        timing,
      },
    });
    return;
  }

  interface Task extends ShipStationCarrierAccountSource {
    snapshotStatus: ShipStationCarrierSnapshotResolution['status'];
    snapshotAgeMs: number | null;
    snapshotFetchedAt: string | null;
    p: Promise<ShipStationCarrierAccountLoadResult>;
  }
  const diagnostics: MultiCarrierSourceDiagnostic[] = [];
  let dbError: string | null = null;
  const dbStartedAt = nowMs();
  const sourceResult = await loadShipStationCarrierAccountSources();
  dbError = sourceResult.dbError;
  let snapshots = new Map<string, ShipStationCarrierAccountSnapshot>();
  try {
    snapshots = await readShipStationCarrierAccountSnapshots(sourceResult.sources);
  } catch (err) {
    dbError ??= err instanceof Error ? err.message : String(err);
    console.error('[multi-carriers] durable snapshot read failed:', dbError);
  }
  const dbDurationMs = elapsedMs(dbStartedAt);

  const tasks: Task[] = sourceResult.sources.map((source) => {
    const resolved = resolveShipStationCarrierAccountSnapshot(source, snapshots);
    const snapshotResult: ShipStationCarrierAccountLoadResult | null = resolved.snapshot
      ? {
          carriers: resolved.snapshot.carriers,
          error: null,
          status: 200,
          cacheStatus: 'hit',
          cacheAgeMs: resolved.ageMs,
          durationMs: 0,
          providerDurationMs: 0,
        }
      : null;
    return {
      ...source,
      snapshotStatus: resolved.status,
      snapshotAgeMs: resolved.ageMs,
      snapshotFetchedAt: resolved.snapshot?.fetchedAt ?? null,
      p: snapshotResult
        ? Promise.resolve(snapshotResult)
        : loadShipStationCarrierAccounts(source.apiKeyV2),
    };
  });

  const results = await Promise.all(tasks.map((t) => t.p));
  const aggregationStartedAt = nowMs();
  const aggregated: TaggedCarrier[] = [];
  const seenByAccount = new Set<string>();
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    const r = results[i];
    if (!t || !r) continue;
    diagnostics.push({
      source: t.source,
      keySource: t.keySource,
      status: r.status,
      count: r.carriers.length,
      error: publicCarrierFetchError(r),
      cacheStatus: r.cacheStatus,
      cacheAgeMs: r.cacheAgeMs,
      durationMs: r.durationMs,
      providerDurationMs: r.providerDurationMs,
      snapshotStatus: t.snapshotStatus,
      snapshotAgeMs: t.snapshotAgeMs,
      snapshotFetchedAt: t.snapshotFetchedAt,
    });
    for (const c of r.carriers) {
      const key = `${t.source}:${c.carrier_id}`;
      if (seenByAccount.has(key)) continue;
      seenByAccount.add(key);
      aggregated.push({ ...c, source_client_name: t.source, source_client_id: t.sourceId });
    }
  }

  const aggregationDurationMs = elapsedMs(aggregationStartedAt);
  const slowestSource = diagnostics.reduce<(typeof diagnostics)[number] | null>(
    (slowest, current) => (
      !slowest || current.durationMs > slowest.durationMs ? current : slowest
    ),
    null,
  );
  const totalDurationMs = elapsedMs(totalStartedAt);
  const timing: MultiCarrierTiming = {
    totalDurationMs,
    authDurationMs,
    dbDurationMs,
    aggregationDurationMs,
    slowestSource: slowestSource?.source ?? null,
    slowestSourceDurationMs: slowestSource?.durationMs ?? 0,
    cacheHits: diagnostics.filter((row) => row.cacheStatus === 'hit').length,
    cacheMisses: diagnostics.filter((row) => row.cacheStatus === 'miss').length,
    durableSnapshotHits: diagnostics.filter((row) => (
      row.snapshotStatus === 'fresh' || row.snapshotStatus === 'stale'
    )).length,
    durableStaleSources: diagnostics.filter((row) => row.snapshotStatus === 'stale').length,
    liveFallbacks: diagnostics.filter((row) => (
      row.snapshotStatus === 'missing' || row.snapshotStatus === 'credential_mismatch'
    )).length,
    responseCacheHit: false,
    responseCacheAgeMs: null,
  };
  res.setHeader(
    'Server-Timing',
    `multi_auth;dur=${authDurationMs}, multi_db;dur=${dbDurationMs}, multi_accounts;dur=${timing.slowestSourceDurationMs}`,
  );

  const configuredSlowThresholdMs = Number.parseInt(process.env.API_TIMING_LOG_MS ?? '750', 10);
  const slowThresholdMs = Number.isFinite(configuredSlowThresholdMs) && configuredSlowThresholdMs > 0
    ? configuredSlowThresholdMs
    : 750;
  if (totalDurationMs >= slowThresholdMs) {
    console.info('[rates/multi:timing]', {
      ...timing,
      sources: diagnostics.map((row) => ({
        source: row.source,
        status: row.status,
        count: row.count,
        cacheStatus: row.cacheStatus,
        durationMs: row.durationMs,
        providerDurationMs: row.providerDurationMs,
      })),
    });
  }

  const payload: MultiCarrierPayload = {
    carriers: aggregated,
    _diagnostics: {
      dbError: dbError ? 'Client carrier credential lookup failed' : null,
      sources: diagnostics,
      // Stamped at fan-out time; a repeat call served from cache returns the
      // SAME cachedAt, which is how a cache hit is observable end-to-end.
      cachedAt: new Date().toISOString(),
      timing,
    },
  };
  // Don't pin an outage: only cache when at least one source returned carriers.
  if (RATES_MULTI_CACHE_TTL_MS > 0 && aggregated.length > 0) {
    cachedResponse = { at: Date.now(), payload };
  }
  res.status(200).json(payload);
}
