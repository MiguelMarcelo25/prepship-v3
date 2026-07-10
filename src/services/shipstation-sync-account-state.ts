import { getJsonSetting, setJsonSetting } from './settings-json';

const ACCOUNT_STATE_KEY = 'order_sync.shipstation_accounts.snapshot';

export type ShipStationSyncAccountIdentity = {
  label: string;
  ownerClientId: number | null;
  storeIds?: number[];
};

export type ShipStationSyncAccountRunState = {
  accountId: string;
  storeIds: number[];
  status: 'running' | 'succeeded' | 'failed';
  activeJobId: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
};

type ShipStationSyncAccountStateSnapshot = {
  version: 1;
  updatedAt: string;
  accounts: Record<string, ShipStationSyncAccountRunState>;
};

export function shipStationSyncAccountId(account: ShipStationSyncAccountIdentity): string {
  if (account.label === 'main') return 'main';
  return account.ownerClientId !== null
    ? `client:${account.ownerClientId}`
    : `account:${account.label}`;
}

export function shipStationSyncAccountDisplayName(
  account: ShipStationSyncAccountIdentity,
): string {
  if (account.label === 'main') return 'Main ShipStation';
  return account.ownerClientId !== null
    ? `Client #${account.ownerClientId}`
    : 'ShipStation account';
}

export function summarizeShipStationAccountWatermarks(
  watermarks: ReadonlyArray<number | null>,
): { completeThroughMs: number | null; latestMs: number | null } {
  const completed = watermarks.filter((value): value is number => Boolean(value));
  return {
    completeThroughMs:
      watermarks.length > 0 && completed.length === watermarks.length
        ? Math.min(...completed)
        : null,
    latestMs: completed.length > 0 ? Math.max(...completed) : null,
  };
}

export function sanitizeShipStationSyncError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/(authorization|api[_-]?key|api[_-]?secret|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[provider endpoint]')
    .slice(0, 300);
}

export async function readShipStationSyncAccountStates(): Promise<
  Record<string, ShipStationSyncAccountRunState>
> {
  const snapshot = await getJsonSetting<Partial<ShipStationSyncAccountStateSnapshot>>(
    ACCOUNT_STATE_KEY,
  );
  return snapshot?.accounts && typeof snapshot.accounts === 'object'
    ? snapshot.accounts
    : {};
}

async function updateAccountState(
  account: ShipStationSyncAccountIdentity,
  update: (previous: ShipStationSyncAccountRunState | undefined) => ShipStationSyncAccountRunState,
): Promise<void> {
  const accountId = shipStationSyncAccountId(account);
  const accounts = await readShipStationSyncAccountStates();
  accounts[accountId] = update(accounts[accountId]);
  await setJsonSetting(ACCOUNT_STATE_KEY, {
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts,
  } satisfies ShipStationSyncAccountStateSnapshot);
}

export async function markShipStationSyncAccountStarted(
  account: ShipStationSyncAccountIdentity,
  jobId: string,
  startedAtMs: number,
): Promise<void> {
  const accountId = shipStationSyncAccountId(account);
  const startedAt = new Date(startedAtMs).toISOString();
  await updateAccountState(account, (previous) => ({
    accountId,
    storeIds: [...(account.storeIds ?? [])],
    status: 'running',
    activeJobId: jobId,
    lastStartedAt: startedAt,
    lastCompletedAt: previous?.lastCompletedAt ?? null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailureAt: previous?.lastFailureAt ?? null,
    lastError: previous?.lastError ?? null,
  }));
}

export async function markShipStationSyncAccountSucceeded(
  account: ShipStationSyncAccountIdentity,
  completedAtMs: number,
): Promise<void> {
  const accountId = shipStationSyncAccountId(account);
  const completedAt = new Date(completedAtMs).toISOString();
  await updateAccountState(account, (previous) => ({
    accountId,
    storeIds: [...(account.storeIds ?? previous?.storeIds ?? [])],
    status: 'succeeded',
    activeJobId: null,
    lastStartedAt: previous?.lastStartedAt ?? completedAt,
    lastCompletedAt: completedAt,
    lastSuccessAt: completedAt,
    lastFailureAt: previous?.lastFailureAt ?? null,
    lastError: null,
  }));
}

export async function markShipStationSyncAccountFailed(
  account: ShipStationSyncAccountIdentity,
  completedAtMs: number,
  error: unknown,
): Promise<void> {
  const accountId = shipStationSyncAccountId(account);
  const completedAt = new Date(completedAtMs).toISOString();
  await updateAccountState(account, (previous) => ({
    accountId,
    storeIds: [...(account.storeIds ?? previous?.storeIds ?? [])],
    status: 'failed',
    activeJobId: null,
    lastStartedAt: previous?.lastStartedAt ?? completedAt,
    lastCompletedAt: completedAt,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailureAt: completedAt,
    lastError: sanitizeShipStationSyncError(error),
  }));
}
