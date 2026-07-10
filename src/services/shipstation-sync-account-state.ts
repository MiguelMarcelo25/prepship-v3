import { getJsonSetting, setJsonSetting } from './settings-json';
import { withAdvisorySessionLock } from '../lib/advisory-session-lock';

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
  update: (
    previous: ShipStationSyncAccountRunState | undefined,
  ) => ShipStationSyncAccountRunState | undefined,
): Promise<void> {
  await withAdvisorySessionLock(ACCOUNT_STATE_KEY, async () => {
    const accountId = shipStationSyncAccountId(account);
    const accounts = await readShipStationSyncAccountStates();
    const next = update(accounts[accountId]);
    if (!next) return;
    accounts[accountId] = next;
    await setJsonSetting(ACCOUNT_STATE_KEY, {
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts,
    } satisfies ShipStationSyncAccountStateSnapshot);
  });
}

export function finishShipStationSyncAccountRun(
  previous: ShipStationSyncAccountRunState | undefined,
  identity: ShipStationSyncRunIdentity,
  input: {
    status: 'succeeded' | 'failed';
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
  return {
    ...previous,
    status: input.status,
    activeJobId: null,
    activeAttemptId: null,
    lastCompletedAt: input.completedAt,
    lastSuccessAt: failed ? previous.lastSuccessAt : input.completedAt,
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

export async function markShipStationSyncRunFailed(
  identity: ShipStationSyncRunIdentity,
  completedAtMs: number,
  error: unknown,
): Promise<number> {
  return withAdvisorySessionLock(ACCOUNT_STATE_KEY, async () => {
    const accounts = await readShipStationSyncAccountStates();
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
      await setJsonSetting(ACCOUNT_STATE_KEY, {
        version: 1,
        updatedAt: completedAt,
        accounts,
      } satisfies ShipStationSyncAccountStateSnapshot);
    }
    return changed;
  });
}
