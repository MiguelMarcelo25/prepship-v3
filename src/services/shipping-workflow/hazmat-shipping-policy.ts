import type { HazmatCapabilities } from './hazmat-capability.js';
import { isHazmatTestFixtureCarrier } from './hazmat-test-profile.js';
import {
  quoteHazmatDeclaration,
  sealHazmatQuoteFacts,
  type CanonicalHazmatPurchaseFacts,
  type CanonicalHazmatQuoteFacts,
  type HazmatProfile,
  type NormalizedHazmatDeclaration,
} from './hazmat-declaration.js';

export class HazmatShippingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HazmatShippingError';
  }
}

export type HazmatShippingState = {
  declaration: NormalizedHazmatDeclaration | null;
  revision: number;
  semanticHash: string | null;
  capabilities: HazmatCapabilities;
  validation: { valid: boolean; issues: Array<{ code: string; path: string; message: string }> };
};

export function hazmatQuoteFactsForShipping(
  state: HazmatShippingState,
): CanonicalHazmatQuoteFacts | null {
  if (!state.declaration || state.declaration.status !== 'active') return null;
  if (!state.capabilities.featureEnabled) {
    throw new HazmatShippingError(
      'This order has an active hazmat declaration, but hazmat is disabled for the client.',
      'HAZMAT_CLIENT_DISABLED',
    );
  }
  if (!state.validation.valid) {
    throw new HazmatShippingError(
      'The hazmat declaration is incomplete. Correct it before requesting rates.',
      'HAZMAT_DECLARATION_INVALID',
      { issues: state.validation.issues },
    );
  }
  const facts = quoteHazmatDeclaration({ declaration: state.declaration, revision: state.revision });
  if (state.semanticHash !== facts.declarationHash) {
    throw new HazmatShippingError(
      'The hazmat declaration hash is stale. Save the declaration again before rating.',
      'HAZMAT_DECLARATION_HASH_MISMATCH',
    );
  }
  return facts;
}

function carrierKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isPureDryIce(declaration: CanonicalHazmatQuoteFacts['declaration']): boolean {
  return declaration.dryIce
    && declaration.materials.length === 0
    && !declaration.containsBattery
    && !declaration.limitedQuantity;
}

function assertProfileDeclarationCompatible(
  facts: CanonicalHazmatQuoteFacts,
  profile: HazmatProfile,
): void {
  if (profile === 'shipstation_ups_dry_ice' && !isPureDryIce(facts.declaration)) {
    throw new HazmatShippingError(
      'The UPS dry-ice profile cannot carry generic dangerous-goods facts.',
      'HAZMAT_PROFILE_DECLARATION_INVALID',
      { profile },
    );
  }
}

export function resolveHazmatProfile(input: {
  providerFamily: 'shipstation' | 'direct';
  provider?: string | null;
  carrierCode?: string | null;
  facts: CanonicalHazmatQuoteFacts;
}): HazmatProfile | null {
  const provider = carrierKey(input.provider);
  const carrier = carrierKey(input.carrierCode);
  // Checked before the family split: fixture rates carry no provider family and
  // are only ever generated for clients.is_test. The capability lookup that
  // follows re-checks that, so a forged code alone resolves to unsupported.
  if (isHazmatTestFixtureCarrier(carrier)) return 'prepship_test';
  if (input.providerFamily === 'shipstation') {
    if (carrier === 'stamps_com') {
      return 'shipstation_usps';
    }
    if (carrier.includes('ups')) {
      return isPureDryIce(input.facts.declaration)
        ? 'shipstation_ups_dry_ice'
        : 'shipstation_ups_dangerous_goods';
    }
    return null;
  }
  if (provider === 'walmart' || provider === 'walmart_shipping') return 'walmart';
  if (provider === 'ups') return 'ups_direct';
  return null;
}

function assertCapability(input: {
  facts: CanonicalHazmatQuoteFacts;
  profile: HazmatProfile | null;
  capabilities: HazmatCapabilities;
  purpose: 'rating' | 'purchase';
}): HazmatProfile {
  if (!input.profile) {
    throw new HazmatShippingError(
      `The selected carrier does not have a certified hazmat ${input.purpose} profile.`,
      'HAZMAT_PROFILE_UNSUPPORTED',
    );
  }
  assertProfileDeclarationCompatible(input.facts, input.profile);
  const capability = input.capabilities.profiles[input.profile];
  const supported = input.purpose === 'rating'
    ? capability.ratingSupported
    : capability.purchaseSupported;
  if (!supported) {
    throw new HazmatShippingError(
      capability.unavailableReason ?? `Hazmat ${input.purpose} is disabled for this carrier.`,
      input.purpose === 'rating' ? 'HAZMAT_RATE_UNAVAILABLE' : 'HAZMAT_PURCHASE_UNAVAILABLE',
      { profile: input.profile },
    );
  }
  return input.profile;
}

export function assertHazmatRatingSupported(input: {
  facts: CanonicalHazmatQuoteFacts;
  profile: HazmatProfile | null;
  capabilities: HazmatCapabilities;
}): HazmatProfile {
  return assertCapability({ ...input, purpose: 'rating' });
}

export function authorizeHazmatPurchase(input: {
  facts: CanonicalHazmatQuoteFacts;
  profile: HazmatProfile | null;
  capabilities: HazmatCapabilities;
}): CanonicalHazmatPurchaseFacts {
  const profile = assertCapability({ ...input, purpose: 'purchase' });
  return sealHazmatQuoteFacts(input.facts, profile);
}
