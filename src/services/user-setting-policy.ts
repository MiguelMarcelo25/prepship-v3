// Internal workflow snapshots share the table but must never cross the user-settings API boundary.
export const ALLOWED_SETTINGS = [
  'rbMarkups',
  'rbSettings',
  'colVisibility',
  'colPrefs',
  'colWidths',
  'dateRange',
  'pageSize',
  'defaultView',
  'orders.columnPrefs',
  'marketplace_fee_rules',
  'block_shipstation_for_direct_store',
] as const;

export type AllowedSettingKey = (typeof ALLOWED_SETTINGS)[number];

export const MARKUP_SETTING_PREFIX = 'markup.';
export const MARKUP_SETTING_LIKE_PATTERN = 'markup._%';

const allowedSet = new Set<string>(ALLOWED_SETTINGS);

export function isAllowedSettingKey(key: string): boolean {
  if (allowedSet.has(key)) return true;
  return key.startsWith(MARKUP_SETTING_PREFIX) && key.length > MARKUP_SETTING_PREFIX.length;
}
