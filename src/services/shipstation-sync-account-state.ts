import { getJsonSetting } from './settings-json';
import {
  type AdvisoryLockTransaction,
  withAdvisoryTransactionLock,
} from '../lib/advisory-session-lock';

const ACCOUNT_STATE_KEY = 'order_sync.shipstation_accounts.snapshot';

export type ShipStationSyncAccountIdentity = {
  label: string;
  ownerClientId: number | null;
  storeIds?: number[];
};

export type ShipStationSyncAccountRunState = {
  accountId: string;
  storeIds: number[];
  status: 'running' | 'succeeded' | 'failed' | 'deferred';
  activeJobId: string | null;
  activeAttemptId?: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
};

export type ShipStationSyncRunIdentity = {
  queueJobId: string;
  attemptId: string;
};

type ShipStationSyncAccountStateSnapshot = {
  version: 1;
  updatedAt: string;
  accounts: Record<string, ShipStationSyncAccountRunState>;
};

function accountStatesFromValue(
  value: string | null | undefined,
): Record<string, ShipStationSyncAccountRunState> {
  if (!value) return {};
  try {
    const snapshot = JSON.parse(value) as Partial<ShipStationSyncAccountStateSnapshot>;
    return snapshot.accounts && typeof snapshot.accounts === 'object'
      ? snapshot.accounts
      : {};
  } catch {
    return {};
  }
}

async function readAccountStatesInTransaction(
  transaction: AdvisoryLockTransaction,
): Promise<Record<string, ShipStationSyncAccountRunState>> {
  const rows = await transaction<{ value: string | null }[]>`
    select value from settings where key = ${ACCOUNT_STATE_KEY} limit 1
  `;
  return accountStatesFromValue(rows[0]?.value);
}

async function writeAccountStatesInTransaction(
  transaction: AdvisoryLockTransaction,
  updatedAt: string,
  accounts: Record<string, ShipStationSyncAccountRunState>,
): Promise<void> {
  const value = JSON.stringify({
    version: 1,
    updatedAt,
    accounts,
  } satisfies ShipStationSyncAccountStateSnapshot);
  await transaction`
    insert into settings (key, value)
    values (${ACCOUNT_STATE_KEY}, ${value})
    on conflict (key) do update set value = excluded.value
  `;
}

export function shipStationSyncAccountId(account: ShipStationSyncAccountIdentity): string {
  if (account.label === 'main') return 'main';
  return account.ownerClientId !== null
    ? `client:${account.ownerClientId}`
    : `account:${account.label}`;
}

export function shipStationSyncWatermarkKeys(
  baseKey: string,
  account: ShipStationSyncAccountIdentity,
): { primaryKey: string; legacyKey: string | null } {
  const accountId = shipStationSyncAccountId(account);
  const primaryKey = accountId === 'main' ? baseKey : `${baseKey}:${accountId}`;
  const legacyKey = account.label === 'main' ? null : `${baseKey}:${account.label}`;
  return {
    primaryKey,
    legacyKey: legacyKey === primaryKey ? null : legacyKey,
  };
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
  update: (
    previous: ShipStationSyncAccountRunState | undefined,
  ) => ShipStationSyncAccountRunState | undefined,
): Promise<void> {
  // Per user override unlock shipped data on 2026-07-11: serialize sync
  // lifecycle metadata only; order and shipment rows remain untouched.
  await withAdvisoryTransactionLock(ACCOUNT_STATE_KEY, async (transaction) => {
    const accountId = shipStationSyncAccountId(account);
    const accounts = await readAccountStatesInTransaction(transaction);
    const next = update(accounts[accountId]);
    if (!next) return;
    accounts[accountId] = next;
    await writeAccountStatesInTransaction(
      transaction,
      new Date().toISOString(),
      accounts,
    );
  });
}

export function finishShipStationSyncAccountRun(
  previous: ShipStationSyncAccountRunState | undefined,
  identity: ShipStationSyncRunIdentity,
  input: {
    status: 'succeeded' | 'failed' | 'deferred';
    completedAt: string;
    error?: unknown;
  },
): ShipStationSyncAccountRunState | undefined {
  if (
    !previous ||
    previous.status !== 'running' ||
    previous.activeJobId !== identity.queueJobId ||
    previous.activeAttemptId !== identity.attemptId
  ) {
    return undefined;
  }

  const failed = input.status === 'failed';
  const succeeded = input.status === 'succeeded';
  return {
    ...previous,
    status: input.status,
    activeJobId: null,
    activeAttemptId: null,
    lastCompletedAt: input.completedAt,
    lastSuccessAt: succeeded ? input.completedAt : previous.lastSuccessAt,
    lastFailureAt: failed ? input.completedAt : previous.lastFailureAt,
    lastError: failed ? sanitizeShipStationSyncError(input.error ?? 'sync failed') : null,
  };
}

export async function markShipStationSyncAccountStarted(
  account: ShipStationSyncAccountIdentity,
  identity: ShipStationSyncRunIdentity,
  startedAtMs: number,
): Promise<void> {
  const accountId = shipStationSyncAccountId(account);
  const startedAt = new Date(startedAtMs).toISOString();
  await updateAccountState(account, (previous) => ({
    accountId,
    storeIds: [...(account.storeIds ?? [])],
    status: 'running',
    activeJobId: identity.queueJobId,
    activeAttemptId: identity.attemptId,
    lastStartedAt: startedAt,
    lastCompletedAt: previous?.lastCompletedAt ?? null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailureAt: previous?.lastFailureAt ?? null,
    lastError: previous?.lastError ?? null,
  }));
}

export async function markShipStationSyncAccountSucceeded(
  account: ShipStationSyncAccountIdentity,
  identity: ShipStationSyncRunIdentity,
  completedAtMs: number,
): Promise<void> {
  const completedAt = new Date(completedAtMs).toISOString();
  await updateAccountState(account, (previous) =>
    finishShipStationSyncAccountRun(previous, identity, {
      status: 'succeeded',
      completedAt,
    }),
  );
}

export async function markShipStationSyncAccountFailed(
  account: ShipStationSyncAccountIdentity,
  identity: ShipStationSyncRunIdentity,
  completedAtMs: number,
  error: unknown,
): Promise<void> {
  const completedAt = new Date(completedAtMs).toISOString();
  await updateAccountState(account, (previous) =>
    finishShipStationSyncAccountRun(previous, identity, {
      status: 'failed',
      completedAt,
      error,
    }),
  );
}

export async function markShipStationSyncAccountDeferred(
  account: ShipStationSyncAccountIdentity,
  identity: ShipStationSyncRunIdentity,
  completedAtMs: number,
): Promise<void> {
  const completedAt = new Date(completedAtMs).toISOString();
  await updateAccountState(account, (previous) =>
    finishShipStationSyncAccountRun(previous, identity, {
      status: 'deferred',
      completedAt,
    }),
  );
}

export async function markShipStationSyncRunFailed(
  identity: ShipStationSyncRunIdentity,
  completedAtMs: number,
  error: unknown,
): Promise<number> {
  return withAdvisoryTransactionLock(ACCOUNT_STATE_KEY, async (transaction) => {
    const accounts = await readAccountStatesInTransaction(transaction);
    const completedAt = new Date(completedAtMs).toISOString();
    let changed = 0;

    for (const [accountId, previous] of Object.entries(accounts)) {
      const next = finishShipStationSyncAccountRun(previous, identity, {
        status: 'failed',
        completedAt,
        error,
      });
      if (!next) continue;
      accounts[accountId] = next;
      changed += 1;
    }

    if (changed > 0) {
      // Per user override unlock shipped data on 2026-07-10: serialize account-run
      // metadata closeout only; order/shipment rows remain untouched.
      await writeAccountStatesInTransaction(transaction, completedAt, accounts);
    }
    return changed;
  });
}
