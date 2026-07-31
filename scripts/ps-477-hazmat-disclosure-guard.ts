// PS-477: a shipment PrepShip did not buy must still disclose its hazmat.
//
// Five shipped HUGRAB orders (3243-3246, 3249) carry an active declaration and a
// shipment row but no shipment_hazmat_snapshots row: the labels were bought in
// ShipStation and ingested by shipment-sync.ts:163, while the snapshot is only
// ever written by PrepShip's own purchase flow (labels.ts:3100).
//
// Absence of a snapshot silently meant "not hazmat". print-queue.ts omitted the
// fields entirely; OrdersHazmatDeclaration.tsx returned clearDeclaration(),
// which affirmatively displayed a dangerous-goods order as clear.
//
// This guard calls the reducer rather than matching source text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveHazmatDisclosure,
} from '../src/services/shipping-workflow/hazmat-disclosure.js';
import {
  summarizeHazmatDeclaration,
  HAZMAT_DECLARATION_SCHEMA_VERSION,
  type CanonicalHazmatPurchaseFacts,
  type NormalizedHazmatDeclaration,
} from '../src/services/shipping-workflow/hazmat-declaration.js';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

// 0. The reducer must stay I/O-free -- the one property this whole guard rests
//    on. Running it with an unparseable DATABASE_URL proves it on a bare
//    checkout (the db client parses process.env at import and exits the
//    process), but CI runs with a real environment, where a db import would
//    load silently and every assertion below would keep passing while proving
//    nothing about purity. So pin it statically too: the loaders live in the
//    sibling hazmat-disclosure-loader.ts, and that is where the db client is
//    allowed to appear.
{
  assert.doesNotMatch(
    source('src/services/shipping-workflow/hazmat-disclosure.ts'),
    /\bfrom\s+'[^']*db\/client\.js'/,
    'hazmat-disclosure.ts must not import the database client -- loaders belong in hazmat-disclosure-loader.ts',
  );
  assert.match(
    source('src/services/shipping-workflow/hazmat-disclosure-loader.ts'),
    /\bfrom\s+'[^']*db\/client\.js'/,
    'the loader module is where the database client belongs; this check must not pass by the file having vanished',
  );
}

// 0b. `disclosure` must never be gated by a rollout flag. Flags gate WRITING and
//     RATING hazmat; they must never gate SEEING that something already shipped
//     as dangerous goods. Every sibling field in order-hazmat.ts's publicState
//     (revision, semanticHash, decisionSource, frozenPurchaseFacts) carries a
//     `capabilities.featureEnabled ? ... : ...` ternary, so the obvious edit for
//     someone tidying that block is to make `disclosure` match -- which restores
//     the PS-477 bug for every client the flag is off for. Nothing else stops
//     that. Structural check only; it supplements the reducer calls below, it
//     does not replace them.
{
  const orderHazmat = source('src/services/order-hazmat.ts');
  const disclosureAssignments = orderHazmat
    .split('\n')
    .filter((line) => /^\s*disclosure:/.test(line));
  assert.ok(
    disclosureAssignments.length > 0,
    'order-hazmat.ts must still carry a disclosure field; this check must not pass by the field having vanished',
  );
  // PS-479 narrowed this from "the word featureEnabled may not appear on a
  // disclosure line" to the property that was actually worth protecting.
  //
  // Splitting fact from content is legitimate and now happens: the FACT
  // (isHazmat / provenance / profile) stays ungated, while the CONTENT
  // (`declaration` — materials, UN numbers, emergency contacts) follows the
  // same gating as its siblings. The blanket ban would have rejected that, and
  // the tempting "fix" is to delete the check. So it pins the real invariant
  // instead: whatever the flag does, it may only ever override `declaration`,
  // and the rest of the resolved fact must pass through by spread.
  for (const line of disclosureAssignments) {
    if (!/featureEnabled/.test(line)) continue;
    const window = orderHazmat.slice(orderHazmat.indexOf(line), orderHazmat.indexOf(line) + 400);
    assert.match(
      window,
      /\.\.\.input\.disclosure/,
      'a flag-conditional disclosure must still spread the resolved fact through -- rebuilding it field by field is how isHazmat quietly gets dropped',
    );
    const overriddenKeys = [...window.matchAll(/\.\.\.input\.disclosure,\s*([a-zA-Z]+):/g)].map((match) => match[1]);
    for (const key of overriddenKeys) {
      assert.equal(
        key,
        'declaration',
        `only declaration CONTENT may be flag-gated; "${key}" is part of the disclosure fact and must stay visible when the kill switch is off`,
      );
    }
  }
}

function activeDeclaration(): NormalizedHazmatDeclaration & { status: 'active' } {
  return {
    schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
    status: 'active',
    limitedQuantity: false,
    containsBattery: false,
    dryIce: false,
    dryIceWeightValue: null,
    dryIceWeightUnit: null,
    emergencyContactName: 'Eddie Kim',
    emergencyContactPhone: '310-720-1871',
    uspsCategory: null,
    uspsPackageLevel: null,
    regulatedContentType: null,
    materials: [],
  } as NormalizedHazmatDeclaration & { status: 'active' };
}

function clearDeclaration(): NormalizedHazmatDeclaration {
  return { ...activeDeclaration(), status: 'clear' } as NormalizedHazmatDeclaration;
}

function snapshot(): CanonicalHazmatPurchaseFacts {
  return {
    schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
    revision: 3,
    declarationHash: `hz_${'a'.repeat(64)}`,
    snapshotHash: `hz_${'b'.repeat(64)}`,
    profile: 'shipstation_usps',
    declaration: { ...activeDeclaration(), status: 'active' },
  };
}

// 1. Snapshot present wins and is sealed.
{
  const result = resolveHazmatDisclosure(snapshot(), { declaration: activeDeclaration(), revision: 9 });
  assert.equal(result.provenance, 'sealed');
  assert.equal(result.isHazmat, true);
  assert.equal(result.profile, 'shipstation_usps');
  assert.equal(result.snapshotHash, `hz_${'b'.repeat(64)}`);
  assert.equal(result.declarationRevision, 3, 'sealed revision comes from the snapshot, not the live declaration');
}

// 2. THE PS-477 CASE: no snapshot, active declaration.
{
  const result = resolveHazmatDisclosure(null, { declaration: activeDeclaration(), revision: 3 });
  assert.equal(result.provenance, 'declared_unsealed');
  assert.equal(result.isHazmat, true, 'a shipment PrepShip did not buy is still dangerous goods');
  assert.equal(result.snapshotHash, null);
  assert.equal(result.declarationRevision, 3);
}

// 3. profile is ALWAYS null when unsealed. A declaration cannot name a carrier
//    profile -- that is resolved at rating/purchase by hazmat-capability.ts.
//    Inventing one would fabricate the provenance this module exists to keep honest.
{
  const result = resolveHazmatDisclosure(null, { declaration: activeDeclaration(), revision: 3 });
  assert.equal(result.profile, null, 'unsealed disclosure must not invent a carrier profile');
}

// 4. Cleared declaration is not hazmat.
{
  const result = resolveHazmatDisclosure(null, { declaration: clearDeclaration(), revision: 2 });
  assert.equal(result.provenance, 'none');
  assert.equal(result.isHazmat, false);
}

// 5. Nothing at all.
{
  const result = resolveHazmatDisclosure(null, null);
  assert.equal(result.provenance, 'none');
  assert.equal(result.isHazmat, false);
  assert.equal(result.profile, null);
  assert.equal(result.snapshotHash, null);
}

// 6. Result-agreement check, not (yet) a delegation pin: this only asserts
//    that the reducer's isHazmat matches
//    summarizeHazmatDeclaration(declaration).isHazmat for every declaration
//    input. It cannot today tell real delegation apart from an identical
//    local re-derivation, because summarizeHazmatDeclaration is currently
//    defined as exactly `declaration.status === 'active'` -- both sides
//    compute the same value for every input this loop exercises, so a
//    regression that replaced the delegation with that same local check
//    would pass here undetected. This becomes a genuine delegation pin the
//    moment summarizeHazmatDeclaration grows logic beyond a pure status
//    check.
for (const declaration of [activeDeclaration(), clearDeclaration()]) {
  const result = resolveHazmatDisclosure(null, { declaration, revision: 1 });
  assert.equal(
    result.isHazmat,
    summarizeHazmatDeclaration(declaration).isHazmat,
    'reducer must delegate the hazmat determination to summarizeHazmatDeclaration',
  );
}

// ---------------------------------------------------------------------------
// PS-478: a seal that exists but cannot be read is its own state.
//
// PS-477 deliberately treated a corrupt snapshot as identical to "no snapshot",
// which is right whenever a live declaration survives -- the order stays
// dangerous goods. It is wrong when the declaration was retracted (the PS-475
// path): the order then read `none` / isHazmat false, so a shipment that went
// out sealed as dangerous goods read back as not dangerous goods.
//
// The distinction is real, not defensive: summary_is_hazmat and summary_profile
// are separate columns carrying their own DB CHECK constraints, so they remain
// trustworthy even when snapshot_json is garbage. A corrupt seal is therefore
// not "no information" -- it is "the sealed detail is unreadable, but the
// summary still says what this was".

// 7. THE PS-478 CASE: unreadable seal, no live declaration at all. This is the
//    exact combination that used to answer "not dangerous goods".
{
  const result = resolveHazmatDisclosure(null, null, { summaryIsHazmat: true, summaryProfile: 'shipstation_usps' });
  assert.equal(result.provenance, 'sealed_unreadable');
  assert.equal(result.isHazmat, true, 'an unreadable seal must never answer "not dangerous goods"');
  assert.equal(result.profile, 'shipstation_usps', 'summary_profile is DB-constrained and survives a corrupt snapshot_json');
  assert.equal(result.snapshotHash, null, 'the hash cannot be trusted when the sealed bytes failed validation');
}

// 8. Unreadable seal WITH a retracted (cleared) declaration -- same answer. The
//    retraction cannot un-ship what already went out under a seal.
{
  const result = resolveHazmatDisclosure(null, { declaration: clearDeclaration(), revision: 4 }, { summaryIsHazmat: true, summaryProfile: null });
  assert.equal(result.provenance, 'sealed_unreadable');
  assert.equal(result.isHazmat, true);
}

// 9. Safety union: an unreadable seal whose summary says NOT hazmat, beside a
//    live declaration that says it is, still reports hazmat. Neither source
//    gets to veto the other downward.
{
  const result = resolveHazmatDisclosure(null, { declaration: activeDeclaration(), revision: 5 }, { summaryIsHazmat: false, summaryProfile: null });
  assert.equal(result.provenance, 'sealed_unreadable');
  assert.equal(result.isHazmat, true, 'a corrupt seal must not downgrade a live active declaration');
}

// 10. An unreadable seal whose summary says not-hazmat, with no declaration, is
//     honestly not hazmat -- the summary column is DB-constrained, so this is a
//     real answer rather than an absence. Provenance still records that the
//     sealed detail was unreadable.
{
  const result = resolveHazmatDisclosure(null, null, { summaryIsHazmat: false, summaryProfile: null });
  assert.equal(result.provenance, 'sealed_unreadable');
  assert.equal(result.isHazmat, false);
}

// 11. A readable seal still wins outright. The unreadable input is only
//     consulted when there are no verified facts.
{
  const result = resolveHazmatDisclosure(snapshot(), null, { summaryIsHazmat: false, summaryProfile: null });
  assert.equal(result.provenance, 'sealed');
  assert.equal(result.snapshotHash, `hz_${'b'.repeat(64)}`);
}

// 11b. PS-479 STRUCTURAL PIN. This one cannot be a behavioural test, and that
//      is worth stating plainly rather than pretending otherwise.
//
//      The old React line and the new one return the SAME value for every
//      consistent input -- that was the point of the card: "they agree today".
//      PS-479's value is deleting the duplicate rule, not changing an answer,
//      so a mutation restoring the old precedence passes the whole browser
//      suite. It was run and it did pass; the honest conclusion is that no
//      behavioural test can pin this, so the pin is structural.
//
//      What must stay true: the panel's terminal display picks nothing. It
//      renders what the backend resolved. Reintroducing a
//      `frozenPurchaseFacts?.declaration ?? ...` chain there restores the
//      duplicate precedence PS-477 exists to close.
{
  const panel = source('web/src/components/Views/OrdersHazmatDeclaration.tsx');
  const displayed = panel.slice(
    panel.indexOf('function displayedDeclaration'),
    panel.indexOf('function importedHazmatEvidence'),
  );
  assert.ok(
    displayed.length > 0,
    'displayedDeclaration must still exist; this check must not pass by the function being renamed away',
  );
  assert.match(
    displayed,
    /state\.disclosure\.declaration/,
    'the terminal branch must render the backend-resolved declaration',
  );
  const executable = displayed
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(
    executable,
    /frozenPurchaseFacts/,
    'displayedDeclaration must not consult frozenPurchaseFacts -- choosing between it and the live declaration IS the precedence rule the backend now owns',
  );
}

// ---------------------------------------------------------------------------
// PS-479: the backend resolves WHICH declaration a terminal view shows, so the
// panel stops restating this module's precedence in React.
//
// The old frontend line was:
//   frozenPurchaseFacts?.declaration ?? state.declaration ?? clearDeclaration()
// which is rules 1 and 2 of this reducer, written a second time, fed by two
// different functions with two different corruption behaviours.

// 12. Sealed shows the SEALED declaration, never the live one. This is the case
//     that would drift first: an edit after purchase must not change what a
//     terminal view says went out on the label.
{
  const live = { ...activeDeclaration(), regulatedContentType: 'edited_after_purchase' } as NormalizedHazmatDeclaration;
  const result = resolveHazmatDisclosure(snapshot(), { declaration: live, revision: 9 });
  assert.equal(result.provenance, 'sealed');
  assert.equal(
    result.declaration?.regulatedContentType,
    snapshot().declaration.regulatedContentType,
    'a sealed order must display the sealed declaration, not a later edit',
  );
}

// 13. Unsealed shows the live declaration -- there is nothing else.
{
  const result = resolveHazmatDisclosure(null, { declaration: activeDeclaration(), revision: 3 });
  assert.equal(result.provenance, 'declared_unsealed');
  assert.deepEqual(result.declaration, activeDeclaration());
}

// 14. An unreadable seal shows the live declaration when one survives, because
//     the sealed content is by definition unreadable.
{
  const result = resolveHazmatDisclosure(null, { declaration: activeDeclaration(), revision: 3 }, { summaryIsHazmat: true, summaryProfile: null });
  assert.equal(result.provenance, 'sealed_unreadable');
  assert.deepEqual(result.declaration, activeDeclaration());
}

// 15. null declaration does NOT mean "not hazmat". An unreadable seal with no
//     surviving declaration has nothing to display and is still dangerous
//     goods -- a consumer reading the field instead of the fact would get this
//     backwards, which is the whole bug class PS-477 opened on.
{
  const result = resolveHazmatDisclosure(null, null, { summaryIsHazmat: true, summaryProfile: null });
  assert.equal(result.declaration, null);
  assert.equal(result.isHazmat, true, 'nothing to display is not the same as nothing declared');
}

// 16. Not hazmat has nothing to display.
{
  assert.equal(resolveHazmatDisclosure(null, null).declaration, null);
  assert.equal(resolveHazmatDisclosure(null, { declaration: clearDeclaration(), revision: 2 }).declaration, null);
}

console.log('PS-477 hazmat disclosure guard passed');
