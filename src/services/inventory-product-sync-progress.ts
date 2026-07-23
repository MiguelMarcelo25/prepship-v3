import {
  shipStationSyncAccountId,
  type ShipStationSyncAccountIdentity,
} from './shipstation-sync-account-state';

export const PRODUCT_SYNC_NEXT_ACCOUNT_KEY = 'inventory.shipstation_products.next_account';
const PRODUCT_SYNC_PAGE_KEY_PREFIX = 'inventory.shipstation_products.next_page';

export function productSyncAccountId(account: ShipStationSyncAccountIdentity): string {
  return shipStationSyncAccountId(account);
}

export function productSyncPageKey(account: ShipStationSyncAccountIdentity): string {
  return `${PRODUCT_SYNC_PAGE_KEY_PREFIX}:${productSyncAccountId(account)}`;
}

/**
 * Start with the durable next-account marker so a large or unhealthy first
 * catalog cannot monopolize every bounded worker turn.
 */
export function rotateProductSyncAccounts<T extends ShipStationSyncAccountIdentity>(
  accounts: readonly T[],
  nextAccountId: string | null,
): T[] {
  if (accounts.length === 0 || !nextAccountId) return [...accounts];
  const startIndex = accounts.findIndex(
    (account) => productSyncAccountId(account) === nextAccountId,
  );
  if (startIndex <= 0) return [...accounts];
  return [...accounts.slice(startIndex), ...accounts.slice(0, startIndex)];
}

export function followingProductSyncAccountId<T extends ShipStationSyncAccountIdentity>(
  accounts: readonly T[],
  currentIndex: number,
): string | null {
  if (accounts.length === 0) return null;
  return productSyncAccountId(accounts[(currentIndex + 1) % accounts.length]!);
}
