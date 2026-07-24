import { SYNC_CADENCE_MS } from '../lib/sync-cadence';
import type { OrderSyncAccountDiagnostic } from './order-sync';
import type { ShopifyOrderSyncStatus } from './shopify-order-sync';
import type { SyncJobAttemptSnapshot } from './sync-job-queue';

export type SyncProviderState =
  | 'disabled'
  | 'idle'
  | 'fresh'
  | 'stale'
  | 'error'
  | 'queued'
  | 'retrying'
  | 'running'
  | 'deferred';

export type SyncProviderStatusDto = {
  key: 'shipstation_orders' | 'shopify_orders' | 'shipstation_shipments';
  label: string;
  enabled: boolean;
  state: SyncProviderState;
  fresh: boolean;
  lastSuccessfulAt: string | null;
  ageSeconds: number | null;
  cadenceMinutes: number;
  accountCount: number | null;
  blockedBy: string | null;
  blockedByLabel: string | null;
  reason: string | null;
};

export type SyncProviderSummaryDto = {
  state: 'idle' | 'fresh' | 'deferred' | 'attention' | 'queued' | 'retrying' | 'running';
  focusProviderKey: SyncProviderStatusDto['key'] | null;
  attentionProviderCount: number;
  deferredProviderCount: number;
};

type ProviderStatusInput = {
  nowMs: number;
  orders: {
    lastSyncedAt: string | null;
    health: 'healthy' | 'stale' | 'error' | 'running';
    allAccountsFresh: boolean;
    accounts: OrderSyncAccountDiagnostic[];
  };
  shipments: { lastSyncedAt: string | null };
  shopify: ShopifyOrderSyncStatus;
  attempts: SyncJobAttemptSnapshot[];
};

const JOB_NAME_BY_PROVIDER: Record<SyncProviderStatusDto['key'], string> = {
  shipstation_orders: 'prepship.sync.orders',
  shopify_orders: 'prepship.sync.shopify-orders',
  shipstation_shipments: 'prepship.sync.shipments',
};

const JOB_LABELS: Record<string, string> = {
  'prepship.sync.orders': 'ShipStation orders',
  'prepship.sync.shopify-orders': 'Shopify orders',
  'prepship.sync.shipments': 'ShipStation shipments',
  'prepship.sync.fulfillment-outbox': 'marketplace confirmations',
};

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageSeconds(value: string | null, nowMs: number): number | null {
  const parsed = timestampMs(value);
  return parsed === null ? null : Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function attemptState(
  baseState: SyncProviderState,
  attempt: SyncJobAttemptSnapshot | undefined,
): Pick<SyncProviderStatusDto, 'state' | 'blockedBy' | 'blockedByLabel' | 'reason'> {
  if (!attempt) {
    return { state: baseState, blockedBy: null, blockedByLabel: null, reason: null };
  }
  if (attempt.state === 'active') {
    return { state: 'running', blockedBy: null, blockedByLabel: null, reason: null };
  }
  if (attempt.state === 'retry') {
    return { state: 'retrying', blockedBy: null, blockedByLabel: null, reason: attempt.reason };
  }
  if (attempt.state === 'created') {
    return { state: 'queued', blockedBy: null, blockedByLabel: null, reason: null };
  }
  if (attempt.state === 'failed' || attempt.state === 'expired' || attempt.state === 'cancelled') {
    return { state: 'error', blockedBy: null, blockedByLabel: null, reason: 'Latest sync attempt failed' };
  }
  if (attempt.skipped && attempt.blockedBy) {
    return {
      state: 'deferred',
      blockedBy: attempt.blockedBy,
      blockedByLabel: JOB_LABELS[attempt.blockedBy] ?? attempt.blockedBy,
      reason: attempt.reason ?? 'Waiting for the shared sync lane',
    };
  }
  return { state: baseState, blockedBy: null, blockedByLabel: null, reason: null };
}

function providerStatus(
  input: Omit<SyncProviderStatusDto, 'state' | 'blockedBy' | 'blockedByLabel' | 'reason'> & {
    baseState: SyncProviderState;
  },
  attempts: Map<string, SyncJobAttemptSnapshot>,
): SyncProviderStatusDto {
  const operational = input.enabled
    ? attemptState(input.baseState, attempts.get(JOB_NAME_BY_PROVIDER[input.key]))
    : { state: 'disabled' as const, blockedBy: null, blockedByLabel: null, reason: null };
  const { baseState: _baseState, ...base } = input;
  return { ...base, ...operational };
}

export function buildSyncProviderStatusReadModel(input: ProviderStatusInput): {
  summary: SyncProviderSummaryDto;
  providers: SyncProviderStatusDto[];
} {
  const attempts = new Map(input.attempts.map((attempt) => [attempt.name, attempt]));
  const freshMs = SYNC_CADENCE_MS.orders * 5;
  const shipmentAge = ageSeconds(input.shipments.lastSyncedAt, input.nowMs);
  const shipmentFresh = shipmentAge !== null && shipmentAge * 1000 <= freshMs;

  const providers = [
    providerStatus({
      key: 'shipstation_orders',
      label: 'ShipStation orders',
      enabled: input.orders.accounts.length > 0,
      baseState:
        input.orders.accounts.length === 0
          ? 'idle'
          : input.orders.health === 'error'
            ? 'error'
            : input.orders.health === 'running'
              ? 'running'
              : input.orders.allAccountsFresh
                ? 'fresh'
                : 'stale',
      fresh: input.orders.allAccountsFresh,
      lastSuccessfulAt: input.orders.lastSyncedAt,
      ageSeconds: ageSeconds(input.orders.lastSyncedAt, input.nowMs),
      cadenceMinutes: SYNC_CADENCE_MS.orders / 60_000,
      accountCount: input.orders.accounts.length,
    }, attempts),
    providerStatus({
      key: 'shopify_orders',
      label: 'Shopify orders',
      enabled: input.shopify.enabled,
      baseState:
        input.shopify.health === 'healthy'
          ? 'fresh'
          : input.shopify.health === 'error'
            ? 'error'
            : input.shopify.health === 'stale'
              ? 'stale'
              : 'idle',
      fresh: input.shopify.health === 'healthy',
      lastSuccessfulAt: input.shopify.lastSyncedAt,
      ageSeconds: ageSeconds(input.shopify.lastSyncedAt, input.nowMs),
      cadenceMinutes: SYNC_CADENCE_MS.orders / 60_000,
      accountCount: input.shopify.accountCount,
    }, attempts),
    providerStatus({
      key: 'shipstation_shipments',
      label: 'ShipStation shipments',
      enabled: input.orders.accounts.length > 0,
      baseState: shipmentFresh ? 'fresh' : 'stale',
      fresh: shipmentFresh,
      lastSuccessfulAt: input.shipments.lastSyncedAt,
      ageSeconds: shipmentAge,
      cadenceMinutes: SYNC_CADENCE_MS.shipments / 60_000,
      accountCount: input.orders.accounts.length,
    }, attempts),
  ];

  const enabled = providers.filter((provider) => provider.enabled);
  const first = (state: SyncProviderState) => enabled.find((provider) => provider.state === state);
  const attention = enabled.filter(
    (provider) => provider.state === 'error' || provider.state === 'stale' || (!provider.fresh && provider.state === 'deferred'),
  );
  const deferred = enabled.filter((provider) => provider.state === 'deferred');
  const running = first('running');
  const retrying = first('retrying');
  const queued = first('queued');
  const focus = running ?? retrying ?? queued ?? attention[0] ?? deferred[0] ?? null;
  const state: SyncProviderSummaryDto['state'] = running
    ? 'running'
    : retrying
      ? 'retrying'
      : queued
        ? 'queued'
        : attention.length > 0
          ? 'attention'
          : deferred.length > 0
            ? 'deferred'
            : enabled.length > 0 && enabled.every((provider) => provider.fresh)
              ? 'fresh'
              : 'idle';

  return {
    summary: {
      state,
      focusProviderKey: focus?.key ?? null,
      attentionProviderCount: attention.length,
      deferredProviderCount: deferred.length,
    },
    providers,
  };
}
