import { isAdminEmail } from './admin-emails';

type ScopeAuth = {
  email?: string | null;
  role?: string;
  permissions?: string[];
  clientIds?: number[];
  storeIds?: number[];
};

export type ClientStoreScope = {
  clientIds: number[];
  storeIds: number[];
  isGlobal: boolean;
  isRestricted: boolean;
};

// PS-233 (Per user override unlock shipped data on 2026-06-13): an explicit
// unrestricted scope for TRUSTED internal/system callers (durable workers,
// schedulers, batch fan-out) that have already cleared request-level
// authorization. Passing this to a scope-enforcing service means "no per-resource
// restriction" — it is greppable so an accidental unscoped service call stands out.
export const GLOBAL_SCOPE: ClientStoreScope = {
  clientIds: [],
  storeIds: [],
  isGlobal: true,
  isRestricted: false,
};

type ClientLike = {
  id: number;
  storeIds?: number[] | null;
};

function normalizeIds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

export function getClientStoreScope(auth: ScopeAuth): ClientStoreScope {
  const clientIds = normalizeIds(auth.clientIds);
  const storeIds = normalizeIds(auth.storeIds);
  const explicitGlobal =
    isAdminEmail(auth.email) ||
    auth.role === 'admin' ||
    Boolean(auth.permissions?.includes('scope:global'));
  const hasExplicitScope = clientIds.length > 0 || storeIds.length > 0;
  const requiresExplicitScope =
    auth.role === 'client_user' || auth.role === 'read_only_support';

  if (explicitGlobal) {
    return {
      clientIds: [],
      storeIds: [],
      isGlobal: true,
      isRestricted: false,
    };
  }

  return {
    clientIds,
    storeIds,
    isGlobal: false,
    isRestricted: hasExplicitScope || requiresExplicitScope,
  };
}

export function getInternalOpsClientStoreScope(auth: ScopeAuth): ClientStoreScope {
  const isInternalOps =
    isAdminEmail(auth.email) ||
    auth.role === 'admin' ||
    auth.role === 'operator' ||
    auth.role === 'warehouse' ||
    Boolean(auth.permissions?.includes('scope:global')) ||
    Boolean(auth.permissions?.includes('print_queue:write'));

  if (isInternalOps) {
    return {
      clientIds: [],
      storeIds: [],
      isGlobal: true,
      isRestricted: false,
    };
  }

  return getClientStoreScope(auth);
}

export function isClientVisibleToScope(
  client: ClientLike,
  scope: ClientStoreScope
): boolean {
  if (!scope.isRestricted) return true;
  if (scope.clientIds.includes(client.id)) return true;

  const clientStoreIds = Array.isArray(client.storeIds) ? client.storeIds : [];
  return clientStoreIds.some((storeId) => scope.storeIds.includes(Number(storeId)));
}

export function filterClientsForScope<T extends ClientLike>(
  clients: T[],
  scope: ClientStoreScope
): T[] {
  return clients.filter((client) => isClientVisibleToScope(client, scope));
}
