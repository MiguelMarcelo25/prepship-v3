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
export type HazmatProvenance = 'sealed' | 'sealed_unreadable' | 'declared_unsealed' | 'none';

/**
 * PS-478: the columns of a snapshot row that survive a corrupt `snapshot_json`.
 *
 * Both carry DB CHECK constraints of their own, so they remain trustworthy when
 * the sealed JSON does not. Passing this is how a caller says "a seal exists
 * here, but I could not verify its contents" — distinct from passing nothing,
 * which says "no seal was ever written".
 */
export type UnreadableSeal = {
  summaryIsHazmat: boolean;
  summaryProfile: HazmatProfile | null;
};

export type ShipmentHazmatDisclosure = {
  isHazmat: boolean;
  profile: HazmatProfile | null;
  provenance: HazmatProvenance;
  snapshotHash: string | null;
  declarationRevision: number | null;
  /**
   * PS-479: the declaration a terminal view should DISPLAY, already chosen.
   *
   * The panel used to pick this itself —
   * `frozenPurchaseFacts?.declaration ?? state.declaration ?? clearDeclaration()`
   * — which restated this module's snapshot-wins precedence in React. The two
   * agreed, but they were fed by different functions with different corruption
   * semantics, so they could drift. Two copies of a precedence rule drifting is
   * the exact failure PS-477 exists to close, and it had been reintroduced one
   * layer up.
   *
   * Null means "nothing to display", not "not hazmat" — read `isHazmat` for
   * that. A `sealed_unreadable` order can be hazmat with a null declaration
   * when the seal is unreadable and no live declaration survives.
   *
   * This is declaration CONTENT (materials, UN numbers, emergency contacts),
   * not the disclosure FACT. The fact is never gated by rollout flags; the
   * content follows the same gating as `OrderHazmatState.declaration`, so
   * `publicState` nulls it when the hazmat feature is off for the client.
   */
  declaration: NormalizedHazmatDeclaration | null;
};

const NOT_HAZMAT: ShipmentHazmatDisclosure = {
  isHazmat: false,
  profile: null,
  provenance: 'none',
  snapshotHash: null,
  declarationRevision: null,
  declaration: null,
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
 * PS-478 corrupt-snapshot rule (owned here, not by the loader and not by the
 * consumer): a snapshot ROW that exists but whose sealed JSON fails shape or
 * integrity validation is its own state, `sealed_unreadable` — NOT the same
 * input as "no snapshot".
 *
 * PS-477 originally collapsed the two. That is right whenever a live
 * declaration survives, because the order stays dangerous goods either way. It
 * is wrong once the declaration is retracted (the PS-475 path): the answer
 * became `none` / isHazmat false, so a shipment that went out sealed as
 * dangerous goods read back as not dangerous goods.
 *
 * The distinction is grounded, not merely defensive. `summary_is_hazmat` and
 * `summary_profile` are separate columns carrying their own DB CHECK
 * constraints, so they stay trustworthy even when `snapshot_json` is garbage. A
 * corrupt seal is therefore not an absence of information; it is "the sealed
 * detail is unreadable, but the summary still says what this was."
 *
 * Callers pass those surviving columns as `unreadableSeal`. They must still
 * surface the corruption (see `hazmat-disclosure-loader.ts`); they do not get
 * to invent a different outcome.
 */
export function resolveHazmatDisclosure(
  snapshot: CanonicalHazmatPurchaseFacts | null,
  declaration: { declaration: NormalizedHazmatDeclaration | null; revision: number } | null,
  unreadableSeal: UnreadableSeal | null = null,
): ShipmentHazmatDisclosure {
  if (snapshot) {
    return {
      isHazmat: summarizeHazmatDeclaration(snapshot.declaration).isHazmat,
      profile: snapshot.profile,
      provenance: 'sealed',
      snapshotHash: snapshot.snapshotHash,
      declarationRevision: snapshot.revision,
      // The sealed declaration, not the live one. A terminal view must show
      // what actually went out on the label; a later edit cannot rewrite it.
      declaration: snapshot.declaration,
    };
  }
  if (unreadableSeal) {
    const declaredHazmat = declaration?.declaration
      ? summarizeHazmatDeclaration(declaration.declaration).isHazmat
      : false;
    return {
      // Safety union, deliberately. Neither source may veto the other
      // downward: a corrupt seal cannot downgrade a live active declaration,
      // and a retracted declaration cannot un-ship what already went out under
      // a seal. Only agreement on "not hazmat" produces false here.
      isHazmat: unreadableSeal.summaryIsHazmat || declaredHazmat,
      profile: unreadableSeal.summaryProfile,
      provenance: 'sealed_unreadable',
      // Null on purpose. The hash describes bytes that failed validation, so
      // presenting it would offer proof of something we could not read.
      snapshotHash: null,
      declarationRevision: declaration?.revision ?? null,
      // The sealed content is unreadable by definition, so the live
      // declaration is the only thing left worth showing. Null when none
      // survives -- which is still `isHazmat: true` off the summary column, so
      // a consumer must read the fact, not the presence of this field.
      declaration: declaration?.declaration ?? null,
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
    // Nothing was sealed, so the live declaration IS what this shipment
    // declares. Non-null here by construction: the guard above returned early
    // unless this declaration exists and is active.
    declaration: declaration.declaration,
  };
}
