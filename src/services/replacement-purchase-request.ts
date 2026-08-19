/**
 * PS-502 — resolve the complete, immutable provider request for a replacement label.
 *
 * PURE. No database, no provider, no network. It takes what the caller supplies, validates it
 * completely, and returns a frozen request plus its fingerprint — or refuses. The command
 * that dispatches is elsewhere; this only decides whether there is something safe to dispatch.
 *
 * WHY IT REFUSES INSTEAD OF CHOOSING
 *
 * DJ decisions 1, 2 and 3 — destination address, carrier/service authority, and package
 * authority — are NOT frozen. Hermes's instruction is explicit: build the input-bound
 * architecture now, but "do not silently choose defaults and then let them become de facto
 * policy."
 *
 * That is not a stylistic preference. A default chosen here would ship, operators would rely
 * on it, and by the time DJ ruled the ruling would be ratifying whatever this file happened
 * to do. So every field must arrive explicitly, and a field offered as a POLICY DEFAULT is
 * refused by name until its decision is frozen. An OPERATOR OVERRIDE is accepted, because a
 * named person choosing a value with a written reason is a decision someone made — not a
 * default that quietly became policy.
 *
 * Flipping a decision to frozen is one boolean here, and nothing else changes.
 */
import {
  isReplacementProviderCredentialAuthority,
  type ReplacementProviderCredentialAuthority,
} from './replacement-provider-credential-authority';

/** How a field's value was arrived at. The distinction is the whole point of this module. */
export type PurchaseInputSource = 'operator_override' | 'policy_default';

export type ResolvedInput<T> = {
  value: T;
  source: PurchaseInputSource;
  /** Required for an override: who chose it. */
  chosenBy?: string | null;
  /** Required for an override: why. */
  reason?: string | null;
};

/**
 * Which DJ decisions are frozen. All false today.
 *
 * When DJ freezes one, flip it here and policy defaults for that field become acceptable.
 * Until then a policy default is refused with the decision named, so the refusal tells an
 * operator what is actually missing rather than that "something was invalid".
 */
export const FROZEN_DECISIONS = {
  /** Decision 1 — which address a replacement ships to. */
  address: false,
  /** Decision 2 — carrier / rate / service authority. */
  carrierService: false,
  /** Decision 3 — package authority. */
  package: false,
} as const;

export type ReplacementDestinationAddress = {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  residential?: boolean | null;
};

export type ReplacementCarrierSelection = {
  carrierCode: string;
  serviceCode: string;
  providerAccountId: number;
};

export type ReplacementPackageSelection = {
  packageId: string;
  weightOz: number;
  dimsL: number;
  dimsW: number;
  dimsH: number;
};

export type ReplacementPurchaseInputs = {
  replacementId: number;
  replacementShipmentId: number;
  replacementReference: string;
  address: ResolvedInput<ReplacementDestinationAddress>;
  carrier: ResolvedInput<ReplacementCarrierSelection>;
  package: ResolvedInput<ReplacementPackageSelection>;
};

export type ResolvedPurchaseRequest = {
  replacementId: number;
  replacementShipmentId: number;
  replacementReference: string;
  address: ReplacementDestinationAddress;
  carrier: ReplacementCarrierSelection;
  package: ReplacementPackageSelection;
  /** Server-selected V2 credential identity. Null only on pure pre-binding resolver output. */
  providerCredentialAuthority: ReplacementProviderCredentialAuthority | null;
  /** Per-field provenance, so an audit can say who chose what and why. */
  provenance: Record<'address' | 'carrier' | 'package', {
    source: PurchaseInputSource;
    chosenBy: string | null;
    reason: string | null;
  }>;
  /** Deterministic over the resolved VALUES only. Provenance is audit, not identity. */
  fingerprint: string;
};

export type PurchaseRequestErrorCode =
  | 'REPLACEMENT_PURCHASE_INPUT_MISSING'
  | 'REPLACEMENT_PURCHASE_INPUT_INVALID'
  | 'REPLACEMENT_PURCHASE_DECISION_UNFROZEN'
  | 'REPLACEMENT_PURCHASE_OVERRIDE_UNATTRIBUTED'
  | 'REPLACEMENT_PURCHASE_INTERNAL_COST_LEAK';

export class ReplacementPurchaseRequestError extends Error {
  constructor(
    readonly code: PurchaseRequestErrorCode,
    message: string,
    readonly httpStatus: 400 | 409 = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementPurchaseRequestError';
  }
}

/** Field -> the DJ decision that governs its default. */
const DECISION_FOR: Record<'address' | 'carrier' | 'package', { key: keyof typeof FROZEN_DECISIONS; number: number; what: string }> = {
  address: { key: 'address', number: 1, what: 'which address a replacement ships to' },
  carrier: { key: 'carrierService', number: 2, what: 'carrier / rate / service authority' },
  package: { key: 'package', number: 3, what: 'package authority' },
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Validate one supplied field: present, attributed if an override, and permitted if a default.
 *
 * The order matters. A missing field is reported as missing rather than as an unfrozen
 * decision, because "you did not send an address" and "nobody has decided which address to
 * use" send an operator to completely different places.
 */
function acceptField<T>(
  field: 'address' | 'carrier' | 'package',
  input: ResolvedInput<T> | null | undefined,
): { value: T; source: PurchaseInputSource; chosenBy: string | null; reason: string | null } {
  if (!input || input.value == null) {
    throw new ReplacementPurchaseRequestError(
      'REPLACEMENT_PURCHASE_INPUT_MISSING',
      `${field} was not supplied. A replacement label is never bought from inferred inputs.`,
      400,
      { field },
    );
  }

  if (input.source === 'policy_default') {
    const decision = DECISION_FOR[field];
    if (!FROZEN_DECISIONS[decision.key]) {
      throw new ReplacementPurchaseRequestError(
        'REPLACEMENT_PURCHASE_DECISION_UNFROZEN',
        `${field} was offered as a policy default, but DJ decision ${decision.number} ` +
          `(${decision.what}) is not frozen. Supply it as an operator override with a written ` +
          'reason, or wait for the decision — a default accepted now becomes policy by default.',
        409,
        { field, decision: decision.number },
      );
    }
    return { value: input.value, source: 'policy_default', chosenBy: null, reason: null };
  }

  if (input.source !== 'operator_override') {
    throw new ReplacementPurchaseRequestError(
      'REPLACEMENT_PURCHASE_INPUT_INVALID',
      `${field} has unknown source ${JSON.stringify(input.source)}`,
      400,
      { field },
    );
  }

  // An override is only an override if it says who and why — the same rule the database
  // enforces on admin_override, applied before a provider call rather than after.
  const chosenBy = text(input.chosenBy);
  const reason = text(input.reason);
  if (!chosenBy || !reason) {
    throw new ReplacementPurchaseRequestError(
      'REPLACEMENT_PURCHASE_OVERRIDE_UNATTRIBUTED',
      `${field} was overridden without ${!chosenBy ? 'an actor' : 'a written reason'}. ` +
        'An unattributed override is indistinguishable from an invented default.',
      400,
      { field },
    );
  }
  return { value: input.value, source: 'operator_override', chosenBy, reason };
}

function validateAddress(a: ReplacementDestinationAddress): ReplacementDestinationAddress {
  const required = ['name', 'line1', 'city', 'state', 'postalCode', 'country'] as const;
  for (const key of required) {
    if (!text(a?.[key])) {
      throw new ReplacementPurchaseRequestError(
        'REPLACEMENT_PURCHASE_INPUT_INVALID',
        `address.${key} is required`, 400, { field: 'address', missing: key },
      );
    }
  }
  return {
    name: text(a.name)!, line1: text(a.line1)!, line2: text(a.line2),
    city: text(a.city)!, state: text(a.state)!, postalCode: text(a.postalCode)!,
    country: text(a.country)!.toUpperCase(),
    residential: typeof a.residential === 'boolean' ? a.residential : null,
  };
}

function validateCarrier(c: ReplacementCarrierSelection): ReplacementCarrierSelection {
  const carrierCode = text(c?.carrierCode);
  const serviceCode = text(c?.serviceCode);
  const providerAccountId = positive(c?.providerAccountId);
  if (!carrierCode || !serviceCode || !providerAccountId) {
    throw new ReplacementPurchaseRequestError(
      'REPLACEMENT_PURCHASE_INPUT_INVALID',
      'carrier requires carrierCode, serviceCode and a positive providerAccountId', 400,
      { field: 'carrier' },
    );
  }
  return { carrierCode, serviceCode, providerAccountId };
}

function validatePackage(p: ReplacementPackageSelection): ReplacementPackageSelection {
  const packageId = text(p?.packageId);
  const weightOz = positive(p?.weightOz);
  const dimsL = positive(p?.dimsL);
  const dimsW = positive(p?.dimsW);
  const dimsH = positive(p?.dimsH);
  if (!packageId || !weightOz || !dimsL || !dimsW || !dimsH) {
    throw new ReplacementPurchaseRequestError(
      'REPLACEMENT_PURCHASE_INPUT_INVALID',
      'package requires packageId, a positive weightOz and positive dimensions. A zero or ' +
        'missing weight is not a default — it is an unpriceable parcel.',
      400,
      { field: 'package' },
    );
  }
  return { packageId, weightOz, dimsL, dimsW, dimsH };
}

/**
 * Field names that must never appear in a resolved request.
 *
 * Carrier and internal cost data stays server-side. A resolved request is fingerprinted,
 * persisted on the durable intent and handed to an adapter; letting a cost ride along means
 * it is stored and passed around in a structure whose whole purpose is to be sent outward.
 */
const FORBIDDEN_COST_KEYS = [
  'cost', 'labelCost', 'shipmentCost', 'otherCost', 'internalCost', 'rateAmount', 'amount',
  'houseCost', 'margin', 'customerRate',
];

function assertNoInternalCost(value: unknown, path = 'request'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoInternalCost(entry, `${path}[${i}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_COST_KEYS.includes(key)) {
      throw new ReplacementPurchaseRequestError(
        'REPLACEMENT_PURCHASE_INTERNAL_COST_LEAK',
        `${path}.${key} is internal cost data and must not travel in a provider request`,
        400,
        { key, path },
      );
    }
    assertNoInternalCost(nested, `${path}.${key}`);
  }
}

/**
 * Deterministic fingerprint over the resolved VALUES.
 *
 * Provenance is deliberately excluded: a retry by a different operator, or a reason reworded,
 * is the same purchase. The fingerprint answers "would this buy the same label", and the
 * durable intent stores it so a retry can prove it is reusing the frozen request rather than
 * silently buying against refreshed order, package or rate data.
 */
export function fingerprintPurchaseRequest(request: {
  replacementId: number;
  replacementShipmentId: number;
  address: ReplacementDestinationAddress;
  carrier: ReplacementCarrierSelection;
  package: ReplacementPackageSelection;
  providerCredentialAuthority?: ReplacementProviderCredentialAuthority | null;
}): string {
  const authority = request.providerCredentialAuthority;
  return JSON.stringify([
    authority ? 'rpr2' : 'rpr1',
    request.replacementId,
    request.replacementShipmentId,
    [
      request.address.name, request.address.line1, request.address.line2,
      request.address.city, request.address.state, request.address.postalCode,
      request.address.country, request.address.residential,
    ],
    [request.carrier.carrierCode, request.carrier.serviceCode, request.carrier.providerAccountId],
    [
      request.package.packageId, request.package.weightOz,
      request.package.dimsL, request.package.dimsW, request.package.dimsH,
    ],
    ...(authority
      ? [[authority.version, authority.scope, authority.keyFingerprint]]
      : []),
  ]);
}

/**
 * The one resolver. Everything the provider adapter needs, or a coded refusal.
 *
 * The adapter receives this and makes no business-policy choice of its own: by the time it
 * runs, every question of which address, which service and which package has already been
 * answered and attributed.
 */
export function resolveReplacementPurchaseRequest(
  inputs: ReplacementPurchaseInputs,
  providerCredentialAuthority: ReplacementProviderCredentialAuthority | null = null,
): ResolvedPurchaseRequest {
  const address = acceptField('address', inputs.address);
  const carrier = acceptField('carrier', inputs.carrier);
  const pkg = acceptField('package', inputs.package);

  // Checked on the SUPPLIED values, not on the result: the validators below construct a new
  // object from known keys, so a cost field would be silently stripped before it could be
  // rejected. Silently dropping it keeps the provider safe but tells the caller nothing,
  // and a caller passing cost into a provider request has a misunderstanding worth surfacing.
  assertNoInternalCost(address.value, 'address');
  assertNoInternalCost(carrier.value, 'carrier');
  assertNoInternalCost(pkg.value, 'package');

  const resolved = {
    replacementId: inputs.replacementId,
    replacementShipmentId: inputs.replacementShipmentId,
    replacementReference: inputs.replacementReference,
    address: validateAddress(address.value),
    carrier: validateCarrier(carrier.value),
    package: validatePackage(pkg.value),
  };

  assertNoInternalCost(resolved);
  if (
    providerCredentialAuthority != null
    && !isReplacementProviderCredentialAuthority(providerCredentialAuthority)
  ) {
    throw new ReplacementPurchaseRequestError(
      'REPLACEMENT_PURCHASE_INPUT_INVALID',
      'the server-selected provider credential authority is malformed',
      400,
      { field: 'providerCredentialAuthority' },
    );
  }

  const bound = {
    ...resolved,
    providerCredentialAuthority,
    provenance: {
      address: { source: address.source, chosenBy: address.chosenBy, reason: address.reason },
      carrier: { source: carrier.source, chosenBy: carrier.chosenBy, reason: carrier.reason },
      package: { source: pkg.source, chosenBy: pkg.chosenBy, reason: pkg.reason },
    },
  };
  return { ...bound, fingerprint: fingerprintPurchaseRequest(bound) };
}
