import type { CanonicalHazmatPurchaseFacts } from '../../services/shipping-workflow/hazmat-declaration.js';

export class ShipStationHazmatPayloadError extends Error {
  readonly code = 'SHIPSTATION_HAZMAT_PAYLOAD_UNSUPPORTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ShipStationHazmatPayloadError';
  }
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== null && nested !== undefined),
  );
}

function advancedOptions(facts: CanonicalHazmatPurchaseFacts): Record<string, unknown> {
  const declaration = facts.declaration;
  if (facts.profile === 'shipstation_usps') {
    // Stamps.com documents only the shipment-level dangerous_goods flag for
    // USPS. Do not infer support for dry-ice, product-DG, or unrelated regulated
    // content fields from the generic advanced-options schema.
    return { dangerous_goods: true };
  }
  if (facts.profile === 'shipstation_ups_dry_ice') {
    if (!declaration.dryIce || declaration.dryIceWeightValue == null || !declaration.dryIceWeightUnit) {
      throw new ShipStationHazmatPayloadError('The UPS dry-ice profile requires a complete dry-ice weight.');
    }
    return compact({
      dry_ice: true,
      dry_ice_weight: {
        value: declaration.dryIceWeightValue,
        unit: declaration.dryIceWeightUnit,
      },
    });
  }
  throw new ShipStationHazmatPayloadError(
    `ShipStation profile ${facts.profile} is not certified for provider dispatch.`,
  );
}

/**
 * Adds provider-exact ShipStation V2 advanced options only for sealed active facts.
 * Returning the original object for null facts preserves the legacy JSON body exactly.
 */
export function applyShipStationHazmatToShipment<T extends Record<string, unknown>>(
  shipment: T,
  facts: CanonicalHazmatPurchaseFacts | null | undefined,
): T {
  if (!facts) return shipment;
  const existing = shipment.advanced_options;
  const existingOptions = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return {
    ...shipment,
    advanced_options: {
      ...existingOptions,
      ...advancedOptions(facts),
    },
  };
}
