import { createHash } from 'node:crypto';

export const HAZMAT_DECLARATION_SCHEMA_VERSION = 1 as const;

export type HazmatDeclarationStatus = 'clear' | 'active';
export type HazmatPackingGroup = 'i' | 'ii' | 'iii';

export type HazmatMaterialInput = {
  unNaNumber?: unknown;
  properShippingName?: unknown;
  technicalName?: unknown;
  hazardClass?: unknown;
  subsidiaryHazardClass?: unknown;
  packingGroup?: unknown;
  amount?: unknown;
  amountUnit?: unknown;
  quantity?: unknown;
  packagingInstruction?: unknown;
  packagingInstructionSection?: unknown;
  packagingType?: unknown;
  transportMean?: unknown;
  transportCategory?: unknown;
  regulationAuthority?: unknown;
  regulationLevel?: unknown;
  radioactive?: unknown;
  reportableQuantity?: unknown;
  additionalDescription?: unknown;
};

export type HazmatDeclarationInput = {
  status?: unknown;
  limitedQuantity?: unknown;
  containsBattery?: unknown;
  dryIce?: unknown;
  dryIceWeightValue?: unknown;
  dryIceWeightUnit?: unknown;
  emergencyContactName?: unknown;
  emergencyContactPhone?: unknown;
  uspsCategory?: unknown;
  uspsPackageLevel?: unknown;
  regulatedContentType?: unknown;
  materials?: unknown;
};

export type NormalizedHazmatMaterial = {
  sequence: number;
  unNaNumber: string | null;
  properShippingName: string | null;
  technicalName: string | null;
  hazardClass: string | null;
  subsidiaryHazardClass: string | null;
  packingGroup: HazmatPackingGroup | null;
  amount: number | null;
  amountUnit: string | null;
  quantity: number | null;
  packagingInstruction: string | null;
  packagingInstructionSection: string | null;
  packagingType: string | null;
  transportMean: string | null;
  transportCategory: string | null;
  regulationAuthority: string | null;
  regulationLevel: string | null;
  radioactive: boolean;
  reportableQuantity: boolean;
  additionalDescription: string | null;
};

export type NormalizedHazmatDeclaration = {
  schemaVersion: typeof HAZMAT_DECLARATION_SCHEMA_VERSION;
  status: HazmatDeclarationStatus;
  limitedQuantity: boolean;
  containsBattery: boolean;
  dryIce: boolean;
  dryIceWeightValue: number | null;
  dryIceWeightUnit: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  uspsCategory: string | null;
  uspsPackageLevel: boolean | null;
  regulatedContentType: string | null;
  materials: NormalizedHazmatMaterial[];
};

export type HazmatValidationIssue = {
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

export type HazmatValidationResult = {
  valid: boolean;
  issues: HazmatValidationIssue[];
};

export type HazmatProfile =
  | 'shipstation_usps'
  | 'shipstation_ups_dry_ice'
  | 'shipstation_ups_dangerous_goods'
  | 'ups_direct'
  | 'walmart'
  // Test-fixture carrier only; see hazmat-test-profile.ts for why this cannot
  // reach a real client.
  | 'prepship_test';

export type CanonicalHazmatPurchaseFacts = {
  schemaVersion: typeof HAZMAT_DECLARATION_SCHEMA_VERSION;
  revision: number;
  declarationHash: string;
  snapshotHash: string;
  profile: HazmatProfile;
  declaration: NormalizedHazmatDeclaration & { status: 'active' };
};

export type CanonicalHazmatQuoteFacts = {
  schemaVersion: typeof HAZMAT_DECLARATION_SCHEMA_VERSION;
  revision: number;
  declarationHash: string;
  declaration: NormalizedHazmatDeclaration & { status: 'active' };
};

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalJson(value: unknown): CanonicalJson {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, canonicalJson(row[key])]),
    );
  }
  return String(value);
}

export function stableHazmatJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function text(value: unknown): string | null {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function code(value: unknown): string | null {
  return text(value)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;
}

function positiveNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(4)) : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = positiveNumber(value);
  return parsed != null && Number.isInteger(parsed) ? parsed : null;
}

function bool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = code(value);
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function nullableBool(value: unknown): boolean | null {
  if (value == null || value === '') return null;
  return bool(value);
}

function unNaNumber(value: unknown): string | null {
  const normalized = text(value)?.toUpperCase().replace(/\s+/g, '') ?? null;
  return normalized;
}

function normalizeMaterial(value: unknown, sequence: number): NormalizedHazmatMaterial {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as HazmatMaterialInput
    : {};
  const packingGroup = code(row.packingGroup);
  return {
    sequence,
    unNaNumber: unNaNumber(row.unNaNumber),
    properShippingName: text(row.properShippingName),
    technicalName: text(row.technicalName),
    hazardClass: text(row.hazardClass),
    subsidiaryHazardClass: text(row.subsidiaryHazardClass),
    packingGroup: packingGroup === 'i' || packingGroup === 'ii' || packingGroup === 'iii'
      ? packingGroup
      : null,
    amount: positiveNumber(row.amount),
    amountUnit: code(row.amountUnit),
    quantity: positiveInteger(row.quantity),
    packagingInstruction: text(row.packagingInstruction),
    packagingInstructionSection: code(row.packagingInstructionSection),
    packagingType: code(row.packagingType),
    transportMean: code(row.transportMean),
    transportCategory: code(row.transportCategory),
    regulationAuthority: code(row.regulationAuthority),
    regulationLevel: code(row.regulationLevel),
    radioactive: bool(row.radioactive),
    reportableQuantity: bool(row.reportableQuantity),
    additionalDescription: text(row.additionalDescription),
  };
}

export function normalizeHazmatDeclaration(input: HazmatDeclarationInput): NormalizedHazmatDeclaration {
  const status: HazmatDeclarationStatus = code(input.status) === 'active' ? 'active' : 'clear';
  if (status === 'clear') {
    return {
      schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
      status,
      limitedQuantity: false,
      containsBattery: false,
      dryIce: false,
      dryIceWeightValue: null,
      dryIceWeightUnit: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      uspsCategory: null,
      uspsPackageLevel: null,
      regulatedContentType: null,
      materials: [],
    };
  }

  const dryIce = bool(input.dryIce);
  const materials = Array.isArray(input.materials)
    ? input.materials.map((material, index) => normalizeMaterial(material, index + 1))
    : [];
  return {
    schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
    status,
    limitedQuantity: bool(input.limitedQuantity),
    containsBattery: bool(input.containsBattery),
    dryIce,
    dryIceWeightValue: dryIce ? positiveNumber(input.dryIceWeightValue) : null,
    dryIceWeightUnit: dryIce ? code(input.dryIceWeightUnit) : null,
    emergencyContactName: text(input.emergencyContactName),
    emergencyContactPhone: text(input.emergencyContactPhone),
    uspsCategory: code(input.uspsCategory),
    uspsPackageLevel: nullableBool(input.uspsPackageLevel),
    regulatedContentType: code(input.regulatedContentType),
    materials,
  };
}

function error(path: string, codeValue: string, message: string): HazmatValidationIssue {
  return { path, code: codeValue, message, severity: 'error' };
}

export function validateHazmatDeclaration(
  declaration: NormalizedHazmatDeclaration,
): HazmatValidationResult {
  const issues: HazmatValidationIssue[] = [];
  if (declaration.status === 'clear') return { valid: true, issues };

  const hasActiveFact = declaration.materials.length > 0
    || declaration.limitedQuantity
    || declaration.containsBattery
    || declaration.dryIce
    || (declaration.emergencyContactName != null && declaration.emergencyContactPhone != null)
    || declaration.uspsCategory != null
    || declaration.regulatedContentType != null;
  if (!hasActiveFact) {
    issues.push(error('declaration', 'HAZMAT_ACTIVE_FACT_REQUIRED', 'An active declaration requires at least one material or hazardous shipping fact.'));
  }
  if (declaration.dryIce && declaration.dryIceWeightValue == null) {
    issues.push(error('dryIceWeightValue', 'HAZMAT_DRY_ICE_WEIGHT_REQUIRED', 'Dry ice weight is required.'));
  }
  if (declaration.dryIce && declaration.dryIceWeightUnit == null) {
    issues.push(error('dryIceWeightUnit', 'HAZMAT_DRY_ICE_UNIT_REQUIRED', 'Dry ice weight unit is required.'));
  }
  if (
    declaration.emergencyContactPhone != null
    && !/^[+()\-\d\s.]{7,30}$/.test(declaration.emergencyContactPhone)
  ) {
    issues.push(error('emergencyContactPhone', 'HAZMAT_CONTACT_PHONE_INVALID', 'Emergency contact phone is invalid.'));
  }
  if (declaration.emergencyContactName != null && declaration.emergencyContactPhone == null) {
    issues.push(error('emergencyContactPhone', 'HAZMAT_CONTACT_PHONE_REQUIRED', 'Dangerous-goods contact phone is required with a contact name.'));
  }
  if (declaration.emergencyContactPhone != null && declaration.emergencyContactName == null) {
    issues.push(error('emergencyContactName', 'HAZMAT_CONTACT_NAME_REQUIRED', 'Dangerous-goods contact name is required with a contact phone.'));
  }

  declaration.materials.forEach((material, index) => {
    const path = `materials.${index}`;
    if (!material.unNaNumber || !/^(UN|NA)\d{4}$/.test(material.unNaNumber)) {
      issues.push(error(`${path}.unNaNumber`, 'HAZMAT_UN_NA_NUMBER_INVALID', 'Use a UN or NA number followed by four digits.'));
    }
    if (!material.properShippingName) {
      issues.push(error(`${path}.properShippingName`, 'HAZMAT_SHIPPING_NAME_REQUIRED', 'Proper shipping name is required.'));
    }
    if (!material.hazardClass) {
      issues.push(error(`${path}.hazardClass`, 'HAZMAT_CLASS_REQUIRED', 'Hazard class is required.'));
    }
    if (material.amount == null) {
      issues.push(error(`${path}.amount`, 'HAZMAT_AMOUNT_REQUIRED', 'Dangerous-goods amount is required.'));
    }
    if (!material.amountUnit) {
      issues.push(error(`${path}.amountUnit`, 'HAZMAT_AMOUNT_UNIT_REQUIRED', 'Dangerous-goods amount unit is required.'));
    }
    if (material.quantity == null) {
      issues.push(error(`${path}.quantity`, 'HAZMAT_QUANTITY_REQUIRED', 'Material quantity is required.'));
    }
    if (!material.transportMean) {
      issues.push(error(`${path}.transportMean`, 'HAZMAT_TRANSPORT_MEAN_REQUIRED', 'Transport mean is required.'));
    }
    if (!material.regulationLevel) {
      issues.push(error(`${path}.regulationLevel`, 'HAZMAT_REGULATION_LEVEL_REQUIRED', 'Regulation level is required.'));
    }
  });

  return { valid: issues.every((issue) => issue.severity !== 'error'), issues };
}

export function normalizeAndValidateHazmatDeclaration(input: HazmatDeclarationInput): {
  declaration: NormalizedHazmatDeclaration;
  validation: HazmatValidationResult;
} {
  const declaration = normalizeHazmatDeclaration(input);
  return { declaration, validation: validateHazmatDeclaration(declaration) };
}

export function hazmatSemanticHash(declaration: NormalizedHazmatDeclaration): string {
  return `hz_${createHash('sha256').update(stableHazmatJson(declaration)).digest('hex')}`;
}

export function sealHazmatDeclaration(input: {
  declaration: NormalizedHazmatDeclaration;
  revision: number;
  profile: HazmatProfile;
}): CanonicalHazmatPurchaseFacts {
  if (input.declaration.status !== 'active') {
    throw new Error('Only an active hazmat declaration can be sealed for rating or purchase.');
  }
  if (!Number.isInteger(input.revision) || input.revision <= 0) {
    throw new Error('Hazmat declaration revision must be a positive integer.');
  }
  const declarationHash = hazmatSemanticHash(input.declaration);
  const sealed = {
    schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
    revision: input.revision,
    declarationHash,
    profile: input.profile,
    declaration: input.declaration as NormalizedHazmatDeclaration & { status: 'active' },
  };
  const snapshotHash = `hz_${createHash('sha256').update(stableHazmatJson(sealed)).digest('hex')}`;
  return { ...sealed, snapshotHash };
}

export function quoteHazmatDeclaration(input: {
  declaration: NormalizedHazmatDeclaration;
  revision: number;
}): CanonicalHazmatQuoteFacts {
  if (input.declaration.status !== 'active') {
    throw new Error('Only an active hazmat declaration can be bound to a quote.');
  }
  if (!Number.isInteger(input.revision) || input.revision <= 0) {
    throw new Error('Hazmat declaration revision must be a positive integer.');
  }
  return {
    schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
    revision: input.revision,
    declarationHash: hazmatSemanticHash(input.declaration),
    declaration: input.declaration as NormalizedHazmatDeclaration & { status: 'active' },
  };
}

export function sealHazmatQuoteFacts(
  facts: CanonicalHazmatQuoteFacts,
  profile: HazmatProfile,
): CanonicalHazmatPurchaseFacts {
  if (facts.declarationHash !== hazmatSemanticHash(facts.declaration)) {
    throw new Error('Hazmat quote facts do not match their declaration hash.');
  }
  return sealHazmatDeclaration({
    declaration: facts.declaration,
    revision: facts.revision,
    profile,
  });
}

export function summarizeHazmatDeclaration(declaration: NormalizedHazmatDeclaration): {
  isHazmat: boolean;
  materialCount: number;
  unNaNumbers: string[];
  limitedQuantity: boolean;
  containsBattery: boolean;
  dryIce: boolean;
} {
  return {
    isHazmat: declaration.status === 'active',
    materialCount: declaration.materials.length,
    unNaNumbers: declaration.materials
      .map((material) => material.unNaNumber)
      .filter((value): value is string => value != null),
    limitedQuantity: declaration.limitedQuantity,
    containsBattery: declaration.containsBattery,
    dryIce: declaration.dryIce,
  };
}
