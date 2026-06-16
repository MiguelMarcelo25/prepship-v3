/**
 * Markup types and interfaces
 * Handles per-carrier % and flat markups for PrepShip profit layer
 */

export type MarkupType = 'pct' | 'flat';

export interface Markup {
  type: MarkupType;
  value: number;
}

export type MarkupsMap = Record<number | string, Markup>;

/**
 * API response from /api/settings/rbMarkups
 * Key can be shippingProviderId (number) or carrierCode (string)
 */
export type RbMarkupsResponse = MarkupsMap;
