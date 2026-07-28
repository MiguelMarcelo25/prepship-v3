import { env } from '../../lib/env.js';
import type { HazmatProfile } from './hazmat-declaration.js';

export type HazmatFeatureFlags = {
  readEnabled: boolean;
  writeEnabled: boolean;
  rateEnabled: boolean;
  purchaseEnabled: boolean;
  uspsEnabled: boolean;
  upsShipstationEnabled: boolean;
  upsDirectEnabled: boolean;
  walmartEnabled: boolean;
  canaryClientIds: number[];
};

export type HazmatCapabilityField = {
  key: string;
  label: string;
  type: 'boolean' | 'text' | 'number' | 'select' | 'materials';
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
};

export type HazmatProfileCapability = {
  profile: HazmatProfile;
  label: string;
  visible: boolean;
  ratingSupported: boolean;
  purchaseSupported: boolean;
  unavailableReason: string | null;
  fields: HazmatCapabilityField[];
  warnings: string[];
};

export type HazmatCapabilities = {
  featureEnabled: boolean;
  writeEnabled: boolean;
  clientAllowed: boolean;
  profiles: Record<HazmatProfile, HazmatProfileCapability>;
};

function parseClientIds(value: string): number[] {
  return Array.from(new Set(
    value
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
}

export function currentHazmatFeatureFlags(): HazmatFeatureFlags {
  return {
    readEnabled: env.HAZMAT_READ_ENABLED,
    writeEnabled: env.HAZMAT_WRITE_ENABLED,
    rateEnabled: env.HAZMAT_RATE_ENABLED,
    purchaseEnabled: env.HAZMAT_PURCHASE_ENABLED,
    uspsEnabled: env.HAZMAT_USPS_ENABLED,
    upsShipstationEnabled: env.HAZMAT_UPS_SHIPSTATION_ENABLED,
    upsDirectEnabled: env.HAZMAT_UPS_DIRECT_ENABLED,
    walmartEnabled: env.HAZMAT_WALMART_ENABLED,
    canaryClientIds: parseClientIds(env.HAZMAT_CANARY_CLIENT_IDS),
  };
}

const COMMON_FIELDS: HazmatCapabilityField[] = [
  { key: 'limitedQuantity', label: 'Limited quantity', type: 'boolean', required: false },
  { key: 'containsBattery', label: 'Contains battery', type: 'boolean', required: false },
  { key: 'dryIce', label: 'Dry ice', type: 'boolean', required: false },
  { key: 'dryIceWeightValue', label: 'Dry ice weight', type: 'number', required: false },
  {
    key: 'dryIceWeightUnit',
    label: 'Dry ice weight unit',
    type: 'select',
    required: false,
    options: [
      { value: 'pound', label: 'Pounds' },
      { value: 'kilogram', label: 'Kilograms' },
    ],
  },
  { key: 'emergencyContactName', label: 'Dangerous-goods contact name', type: 'text', required: false },
  { key: 'emergencyContactPhone', label: 'Dangerous-goods contact phone', type: 'text', required: false },
  { key: 'materials', label: 'Declared materials', type: 'materials', required: false },
];

const USPS_FIELDS: HazmatCapabilityField[] = [
  ...COMMON_FIELDS,
  { key: 'uspsCategory', label: 'USPS dangerous-goods category', type: 'text', required: false },
  { key: 'uspsPackageLevel', label: 'USPS package-level declaration', type: 'boolean', required: false },
  {
    key: 'regulatedContentType',
    label: 'Other regulated content evidence',
    type: 'text',
    required: false,
    helpText: 'Stored as operator evidence; it is not mapped to the USPS dangerous-goods flag.',
  },
];

import {
  HAZMAT_TEST_PROFILE_WARNINGS,
  hazmatTestProfileUnavailableReason,
} from './hazmat-test-profile.js';

function profile(input: Omit<HazmatProfileCapability, 'visible'> & { visible?: boolean }): HazmatProfileCapability {
  return { visible: input.visible ?? true, ...input };
}

export function resolveHazmatCapabilities(input: {
  clientId: number | null;
  /**
   * clients.is_test (the PS-186 authority). Defaults to false so the test
   * profile fails closed for every caller that has not resolved it.
   */
  isTestClient?: boolean;
  /**
   * A live automation declares dangerous goods for this client. Widens display
   * only -- never rating, purchase, or write authority.
   */
  hasHazmatAutomation?: boolean;
  flags?: HazmatFeatureFlags;
}): HazmatCapabilities {
  const flags = input.flags ?? currentHazmatFeatureFlags();
  const isTestClient = input.isTestClient === true;
  const clientAllowed = flags.canaryClientIds.length === 0
    || (input.clientId != null && flags.canaryClientIds.includes(input.clientId));
  // Visibility follows the automations; authority does not. If a rule declares
  // hazmat for this client the block is shown so the operator can see what the
  // rule did, but every capability below still requires clientAllowed, so a
  // rule edit can never turn on rating or purchase for a real client.
  const featureEnabled = flags.readEnabled && (clientAllowed || input.hasHazmatAutomation === true);
  // Authority is the narrow one. It never consults hasHazmatAutomation, so
  // widening visibility cannot widen what may be rated, purchased, or written.
  const authorityEnabled = flags.readEnabled && clientAllowed;
  const enabledFor = (providerEnabled: boolean) => authorityEnabled && flags.rateEnabled && providerEnabled;
  const purchasableFor = (providerEnabled: boolean) =>
    enabledFor(providerEnabled) && flags.purchaseEnabled;
  const hiddenReason = featureEnabled ? null : 'Hazmat is not enabled for this client.';

  return {
    featureEnabled,
    // Writing a declaration is authority, not display.
    writeEnabled: authorityEnabled && flags.writeEnabled,
    clientAllowed,
    profiles: {
      shipstation_usps: profile({
        profile: 'shipstation_usps',
        label: 'Stamps.com USPS',
        visible: featureEnabled,
        ratingSupported: enabledFor(flags.uspsEnabled),
        purchaseSupported: purchasableFor(flags.uspsEnabled),
        unavailableReason: hiddenReason
          ?? (!flags.uspsEnabled ? 'USPS hazmat is disabled pending provider certification.'
            : !flags.rateEnabled ? 'Hazmat rating is disabled.'
              : !flags.purchaseEnabled ? 'Hazmat purchase is disabled.' : null),
        fields: USPS_FIELDS,
        warnings: [
          'Only a connected Stamps.com carrier code is eligible; USPS from ShipStation remains blocked.',
          'Carrier acceptance, packaging, marking, and documentation remain the operator’s responsibility.',
        ],
      }),
      shipstation_ups_dry_ice: profile({
        profile: 'shipstation_ups_dry_ice',
        label: 'ShipStation UPS · Dry ice',
        visible: featureEnabled,
        ratingSupported: enabledFor(flags.upsShipstationEnabled),
        purchaseSupported: purchasableFor(flags.upsShipstationEnabled),
        unavailableReason: hiddenReason
          ?? (!flags.upsShipstationEnabled ? 'UPS dry-ice capability is not certified for this account.'
            : !flags.rateEnabled ? 'Hazmat rating is disabled.'
              : !flags.purchaseEnabled ? 'Hazmat purchase is disabled.' : null),
        fields: COMMON_FIELDS.filter((field) => field.key.startsWith('dryIce') || field.key.startsWith('emergency')),
        warnings: ['Dry ice is a separate UPS profile and does not authorize generic dangerous goods.'],
      }),
      shipstation_ups_dangerous_goods: profile({
        profile: 'shipstation_ups_dangerous_goods',
        label: 'ShipStation UPS · Dangerous goods',
        visible: featureEnabled,
        ratingSupported: false,
        purchaseSupported: false,
        unavailableReason: hiddenReason ?? 'Generic UPS dangerous goods are not certified for the connected ShipStation account.',
        fields: COMMON_FIELDS,
        warnings: ['Never infer generic dangerous-goods support from the dry-ice option.'],
      }),
      ups_direct: profile({
        profile: 'ups_direct',
        label: 'Direct UPS',
        visible: featureEnabled,
        // The rollout flag cannot create certification. Keep this unavailable until
        // the UPS-native ChemicalRecord mapper and provider contract tests land.
        ratingSupported: false,
        purchaseSupported: false,
        unavailableReason: hiddenReason
          ?? 'Direct UPS HazMat/ChemicalRecord mapping is not certified.',
        fields: COMMON_FIELDS,
        warnings: ['Direct UPS uses UPS-native HazMat fields, never ShipStation shapes.'],
      }),
      walmart: profile({
        profile: 'walmart',
        label: 'Walmart Shipping',
        visible: featureEnabled,
        // Walmart's current connector emits explicit false values. A flag alone
        // must never turn that incompatible payload into an authorized hazmat call.
        ratingSupported: false,
        purchaseSupported: false,
        unavailableReason: hiddenReason
          ?? 'Walmart hazmat payload support is not certified.',
        fields: COMMON_FIELDS,
        warnings: ['Active hazmat must never be omitted or sent as false.'],
      }),
      // Only reachable for clients.is_test, and only via the prepship_test
      // fixture carrier. Grants nothing to any real carrier.
      prepship_test: profile({
        profile: 'prepship_test',
        label: 'PrepShip Test (fixture)',
        visible: featureEnabled && isTestClient,
        ratingSupported: authorityEnabled && isTestClient && flags.rateEnabled,
        purchaseSupported:
          authorityEnabled && isTestClient && flags.rateEnabled && flags.purchaseEnabled,
        unavailableReason: hazmatTestProfileUnavailableReason({
          featureEnabled,
          isTestClient,
          rateEnabled: flags.rateEnabled,
          purchaseEnabled: flags.purchaseEnabled,
        }),
        fields: COMMON_FIELDS,
        warnings: [...HAZMAT_TEST_PROFILE_WARNINGS],
      }),
    },
  };
}

export function hazmatProfileCapability(
  capabilities: HazmatCapabilities,
  profileName: HazmatProfile,
): HazmatProfileCapability {
  return capabilities.profiles[profileName];
}
