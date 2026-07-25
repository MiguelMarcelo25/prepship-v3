import {
  hazmatSemanticHash,
  normalizeAndValidateHazmatDeclaration,
  type HazmatDeclarationInput,
  type NormalizedHazmatDeclaration,
} from './hazmat-declaration.js';

export type ApprovedAutomationHazmatProfileVersion = Readonly<{
  id: string;
  label: string;
  declaration: NormalizedHazmatDeclaration & { status: 'active' };
  semanticHash: string;
}>;

export function compileApprovedAutomationHazmatProfileVersion(input: {
  id: string;
  label: string;
  declaration: HazmatDeclarationInput;
}): ApprovedAutomationHazmatProfileVersion {
  const id = input.id.trim();
  const label = input.label.trim();
  if (!id || id.length > 128) throw new Error('Approved hazmat profile version ID must contain 1-128 characters');
  if (!label || label.length > 128) throw new Error('Approved hazmat profile label must contain 1-128 characters');

  const normalized = normalizeAndValidateHazmatDeclaration(input.declaration);
  if (!normalized.validation.valid) {
    throw new Error(`Approved hazmat profile is invalid: ${normalized.validation.issues.map((issue) => issue.message).join('; ')}`);
  }
  if (normalized.declaration.status !== 'active') {
    throw new Error('Approved automation hazmat profiles must contain an active declaration');
  }

  return Object.freeze({
    id,
    label,
    declaration: Object.freeze({
      ...normalized.declaration,
      materials: Object.freeze(normalized.declaration.materials.map((material) => Object.freeze({ ...material }))),
    }) as NormalizedHazmatDeclaration & { status: 'active' },
    semanticHash: hazmatSemanticHash(normalized.declaration),
  });
}

// PS-465 owns these immutable, compliance-approved declaration facts. No
// production profile is registered until the Leeds Line facts are supplied and
// approved; PS-466 therefore remains fail-closed instead of guessing them.
export const APPROVED_AUTOMATION_HAZMAT_PROFILE_VERSIONS: readonly ApprovedAutomationHazmatProfileVersion[] = Object.freeze([]);

export function getApprovedAutomationHazmatProfileVersion(
  profileVersionId: string,
): ApprovedAutomationHazmatProfileVersion | null {
  const normalized = profileVersionId.trim();
  return APPROVED_AUTOMATION_HAZMAT_PROFILE_VERSIONS.find((profile) => profile.id === normalized) ?? null;
}

export function hasApprovedAutomationHazmatProfileVersions(): boolean {
  return APPROVED_AUTOMATION_HAZMAT_PROFILE_VERSIONS.length > 0;
}
