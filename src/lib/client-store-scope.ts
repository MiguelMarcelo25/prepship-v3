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

  return {
    clientIds,
    storeIds,
    isGlobal: explicitGlobal,
    isRestricted: !explicitGlobal && (hasExplicitScope || requiresExplicitScope),
  };
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
