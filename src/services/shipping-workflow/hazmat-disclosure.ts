import {
  summarizeHazmatDeclaration,
  type CanonicalHazmatPurchaseFacts,
  type HazmatProfile,
  type NormalizedHazmatDeclaration,
} from './hazmat-declaration.js';

/**
 * How well PrepShip knows what a shipment declared.
 *
 * - `sealed`            — an immutable snapshot was written at PrepShip purchase.
 * - `declared_unsealed` — an active declaration exists but PrepShip did not buy
 *                         the label, so nothing was sealed. Sync-ingested
 *                         shipments land here (shipment-sync.ts writes
 *                         source='shipstation' and knows nothing of the
 *                         declaration recorded minutes earlier).
 * - `none`              — not dangerous goods.
 */
export type HazmatProvenance = 'sealed' | 'declared_unsealed' | 'none';

export type ShipmentHazmatDisclosure = {
  isHazmat: boolean;
  profile: HazmatProfile | null;
  provenance: HazmatProvenance;
  snapshotHash: string | null;
  declarationRevision: number | null;
};

const NOT_HAZMAT: ShipmentHazmatDisclosure = {
  isHazmat: false,
  profile: null,
  provenance: 'none',
  snapshotHash: null,
  declarationRevision: null,
};

/**
 * The single rule. No I/O so it is directly testable at the boundary.
 *
 * This module must never import the database client. Task 1's guard
 * (`test:ps-477-hazmat-disclosure`) proves the rule is I/O-free by running on a
 * bare checkout with no parseable environment; a db import here would make that
 * guard exit before its first assertion and would silently stop proving
 * anything. The loaders live in `hazmat-disclosure-loader.ts` instead.
 *
 * A snapshot wins when present: it is proof of what was declared at purchase,
 * and a later declaration edit cannot change what was on the label.
 *
 * PS-477 corrupt-snapshot rule (owned here, not by the loader and not by the
 * consumer): a snapshot ROW that exists but fails shape or integrity validation
 * is not proof of anything — the bytes cannot be trusted to describe the label.
 * For disclosure it is therefore the same input as "no snapshot": the shipment
 * falls back to its live declaration and stays dangerous goods whenever that
 * declaration is active. Never `none` on the strength of a seal nobody can
 * verify. Callers express a corrupt snapshot by passing `snapshot: null`; they
 * do not get to invent a different outcome, and they must surface the
 * corruption (see `hazmat-disclosure-loader.ts`).
 */
export function resolveHazmatDisclosure(
  snapshot: CanonicalHazmatPurchaseFacts | null,
  declaration: { declaration: NormalizedHazmatDeclaration | null; revision: number } | null,
): ShipmentHazmatDisclosure {
  if (snapshot) {
    return {
      isHazmat: summarizeHazmatDeclaration(snapshot.declaration).isHazmat,
      profile: snapshot.profile,
      provenance: 'sealed',
      snapshotHash: snapshot.snapshotHash,
      declarationRevision: snapshot.revision,
    };
  }
  if (!declaration?.declaration) return NOT_HAZMAT;
  // Delegated, never re-derived. summarizeHazmatDeclaration already owns
  // `status === 'active'`; a second copy here would recreate the drift that
  // broke Print Queue and the detail panel in different directions.
  if (!summarizeHazmatDeclaration(declaration.declaration).isHazmat) return NOT_HAZMAT;
  return {
    isHazmat: true,
    // Always null. A declaration has no profile field -- carrier profile is
    // resolved at rating/purchase by hazmat-capability.ts. For a label PrepShip
    // did not buy, the profile is genuinely unknown and null says so.
    profile: null,
    provenance: 'declared_unsealed',
    snapshotHash: null,
    declarationRevision: declaration.revision,
  };
}
