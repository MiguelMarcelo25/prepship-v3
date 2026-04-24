export const EXCLUDED_STORE_IDS = [376720, 272465, 309763, 376827] as const;

export const EXCLUDED_STORE_IDS_SQL = EXCLUDED_STORE_IDS.join(',');

export function isExcludedStoreId(storeId: number | null | undefined): boolean {
  return storeId != null && EXCLUDED_STORE_IDS.includes(storeId as (typeof EXCLUDED_STORE_IDS)[number]);
}
