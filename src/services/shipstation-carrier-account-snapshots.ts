import { createHash } from 'node:crypto';
import type { Carrier } from '../lib/shipstation/types.js';
import type { ShipStationCarrierAccountLoadResult } from './shipstation-carrier-account-cache.js';

const SNAPSHOT_SCOPE = 'shipstation-carrier-account-snapshot';
export const SHIPSTATION_CARRIER_SNAPSHOT_FRESH_MS = 10 * 60 * 1000;
const SHIPSTATION_CARRIER_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ShipStationCarrierAccountSource = {
  sourceKey: string;
  source: string;
  sourceId: number | null;
  keySource: string;
  apiKeyV2: string;
  credentialFingerprint: string;
};

export type ShipStationCarrierAccountSnapshot = {
  version: 1;
  sourceKey: string;
  credentialFingerprint: string;
  carriers: Carrier[];
  fetchedAt: string;
};

export type ShipStationCarrierSnapshotResolution = {
  status: 'fresh' | 'stale' | 'missing' | 'credential_mismatch';
  snapshot: ShipStationCarrierAccountSnapshot | null;
  ageMs: number | null;
};

type ClientCredentialRow = {
  id: number;
  name: string;
  ssApiKeyV2: string | null;
};

type SourceInput = {
  primaryApiKeyV2?: string | null;
  kfgApiKeyV2?: string | null;
  clients?: readonly ClientCredentialRow[];
};

export type ShipStationCarrierSnapshotRefreshSummary = {
  sources: number;
  fresh: number;
  attempted: number;
  refreshed: number;
  errors: number;
  credentialDbError: string | null;
};

type RefreshDependencies = {
  loadSources: () => Promise<{
    sources: ShipStationCarrierAccountSource[];
    dbError: string | null;
  }>;
  readSnapshots: (
    sources: readonly ShipStationCarrierAccountSource[],
  ) => Promise<Map<string, ShipStationCarrierAccountSnapshot>>;
  fetchCarrierAccounts: (
    source: ShipStationCarrierAccountSource,
  ) => Promise<ShipStationCarrierAccountLoadResult>;
  writeSnapshot: (
    source: ShipStationCarrierAccountSource,
    carriers: Carrier[],
    fetchedAt: Date,
  ) => Promise<void>;
  now: () => number;
};

export function shipStationCredentialFingerprint(apiKeyV2: string): string {
  return createHash('sha256').update(apiKeyV2).digest('hex');
}

export function buildShipStationCarrierAccountSources(
  input: SourceInput,
): ShipStationCarrierAccountSource[] {
  const sources: ShipStationCarrierAccountSource[] = [];
  const seenKeys = new Set<string>();
  const add = (source: Omit<ShipStationCarrierAccountSource, 'credentialFingerprint'>) => {
    const apiKeyV2 = source.apiKeyV2.trim();
    if (!apiKeyV2 || seenKeys.has(apiKeyV2)) return;
    seenKeys.add(apiKeyV2);
    sources.push({
      ...source,
      apiKeyV2,
      credentialFingerprint: shipStationCredentialFingerprint(apiKeyV2),
    });
  };

  add({
    sourceKey: 'env:primary',
    source: 'DR PREPPER',
    sourceId: null,
    keySource: 'env.SHIPSTATION_API_KEY_V2',
    apiKeyV2: input.primaryApiKeyV2 ?? '',
  });
  add({
    sourceKey: 'env:kfg',
    source: 'KFG',
    sourceId: null,
    keySource: 'env.SHIPSTATION_KFG_API_KEY_V2',
    apiKeyV2: input.kfgApiKeyV2 ?? '',
  });
  for (const client of input.clients ?? []) {
    add({
      sourceKey: `client:${client.id}`,
      source: client.name,
      sourceId: client.id,
      keySource: `clients.ss_api_key_v2 (id=${client.id})`,
      apiKeyV2: client.ssApiKeyV2 ?? '',
    });
  }
  return sources;
}

export async function loadShipStationCarrierAccountSources(): Promise<{
  sources: ShipStationCarrierAccountSource[];
  dbError: string | null;
}> {
  let clientRows: ClientCredentialRow[] = [];
  let dbError: string | null = null;
  try {
    const [{ db }, { clients }, { and, eq, isNotNull }] = await Promise.all([
      import('../db/client.js'),
      import('../db/schema/clients.js'),
      import('drizzle-orm'),
    ]);
    clientRows = await db
      .select({
        id: clients.id,
        name: clients.name,
        ssApiKeyV2: clients.ssApiKeyV2,
      })
      .from(clients)
      .where(and(isNotNull(clients.ssApiKeyV2), eq(clients.active, true)));
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  return {
    sources: buildShipStationCarrierAccountSources({
      primaryApiKeyV2: process.env.SHIPSTATION_API_KEY_V2,
      kfgApiKeyV2: process.env.SHIPSTATION_KFG_API_KEY_V2,
      clients: clientRows,
    }),
    dbError,
  };
}

export function shipStationCarrierSnapshotCacheKey(sourceKey: string): string {
  return `${SNAPSHOT_SCOPE}:${sourceKey}`;
}

function parseSnapshot(value: unknown): ShipStationCarrierAccountSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<ShipStationCarrierAccountSnapshot>;
  if (
    row.version !== 1 ||
    typeof row.sourceKey !== 'string' ||
    typeof row.credentialFingerprint !== 'string' ||
    typeof row.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.fetchedAt)) ||
    !Array.isArray(row.carriers)
  ) {
    return null;
  }
  return row as ShipStationCarrierAccountSnapshot;
}

export async function readShipStationCarrierAccountSnapshots(
  sources: readonly ShipStationCarrierAccountSource[],
): Promise<Map<string, ShipStationCarrierAccountSnapshot>> {
  const result = new Map<string, ShipStationCarrierAccountSnapshot>();
  if (sources.length === 0) return result;

  const [{ db }, { analyticsCache }, { inArray }] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema/analytics-cache.js'),
    import('drizzle-orm'),
  ]);
  const cacheKeys = sources.map((source) => shipStationCarrierSnapshotCacheKey(source.sourceKey));
  const rows = await db
    .select({
      cacheKey: analyticsCache.cacheKey,
      payload: analyticsCache.payload,
      expiresAt: analyticsCache.expiresAt,
    })
    .from(analyticsCache)
    .where(inArray(analyticsCache.cacheKey, cacheKeys));
  const sourceByCacheKey = new Map(
    sources.map((source) => [shipStationCarrierSnapshotCacheKey(source.sourceKey), source]),
  );
  for (const row of rows) {
    const source = sourceByCacheKey.get(row.cacheKey);
    const snapshot = parseSnapshot(row.payload);
    if (
      source &&
      snapshot?.sourceKey === source.sourceKey &&
      row.expiresAt.getTime() > Date.now()
    ) {
      result.set(source.sourceKey, snapshot);
    }
  }
  return result;
}

export function resolveShipStationCarrierAccountSnapshot(
  source: ShipStationCarrierAccountSource,
  snapshots: ReadonlyMap<string, ShipStationCarrierAccountSnapshot>,
  now = Date.now(),
): ShipStationCarrierSnapshotResolution {
  const snapshot = snapshots.get(source.sourceKey) ?? null;
  if (!snapshot) return { status: 'missing', snapshot: null, ageMs: null };
  if (snapshot.credentialFingerprint !== source.credentialFingerprint) {
    return { status: 'credential_mismatch', snapshot: null, ageMs: null };
  }
  const ageMs = Math.max(0, now - Date.parse(snapshot.fetchedAt));
  return {
    status: ageMs < SHIPSTATION_CARRIER_SNAPSHOT_FRESH_MS ? 'fresh' : 'stale',
    snapshot,
    ageMs,
  };
}

export async function writeShipStationCarrierAccountSnapshot(
  source: ShipStationCarrierAccountSource,
  carriers: Carrier[],
  fetchedAt = new Date(),
): Promise<void> {
  const [{ db }, { analyticsCache }] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema/analytics-cache.js'),
  ]);
  const payload: ShipStationCarrierAccountSnapshot = {
    version: 1,
    sourceKey: source.sourceKey,
    credentialFingerprint: source.credentialFingerprint,
    carriers,
    fetchedAt: fetchedAt.toISOString(),
  };
  const expiresAt = new Date(fetchedAt.getTime() + SHIPSTATION_CARRIER_SNAPSHOT_RETENTION_MS);
  await db
    .insert(analyticsCache)
    .values({
      cacheKey: shipStationCarrierSnapshotCacheKey(source.sourceKey),
      payload,
      expiresAt,
      updatedAt: fetchedAt,
    })
    .onConflictDoUpdate({
      target: analyticsCache.cacheKey,
      set: { payload, expiresAt, updatedAt: fetchedAt },
    });
}

export async function refreshDueShipStationCarrierAccountSnapshots(
  overrides: Partial<RefreshDependencies> = {},
): Promise<ShipStationCarrierSnapshotRefreshSummary> {
  const now = overrides.now ?? Date.now;
  const loadSources = overrides.loadSources ?? loadShipStationCarrierAccountSources;
  const readSnapshots = overrides.readSnapshots ?? readShipStationCarrierAccountSnapshots;
  const fetchCarrierAccounts = overrides.fetchCarrierAccounts ?? (async (source) => {
    const { loadShipStationCarrierAccounts } = await import('./shipstation-carrier-account-cache.js');
    return loadShipStationCarrierAccounts(source.apiKeyV2);
  });
  const writeSnapshot = overrides.writeSnapshot ?? writeShipStationCarrierAccountSnapshot;

  const sourceResult = await loadSources();
  const snapshots = await readSnapshots(sourceResult.sources);
  const due = sourceResult.sources.filter((source) => (
    resolveShipStationCarrierAccountSnapshot(source, snapshots, now()).status !== 'fresh'
  ));
  let refreshed = 0;
  let errors = 0;
  await Promise.all(due.map(async (source) => {
    const result = await fetchCarrierAccounts(source);
    if (result.error) {
      errors += 1;
      return;
    }
    await writeSnapshot(source, result.carriers, new Date(now()));
    refreshed += 1;
  }));

  return {
    sources: sourceResult.sources.length,
    fresh: sourceResult.sources.length - due.length,
    attempted: due.length,
    refreshed,
    errors,
    credentialDbError: sourceResult.dbError,
  };
}
