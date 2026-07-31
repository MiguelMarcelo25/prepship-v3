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
  for (const line of disclosureAssignments) {
    assert.doesNotMatch(
      line,
      /featureEnabled/,
      `disclosure must never be gated by a rollout flag -- offending line: ${line.trim()}`,
    );
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

console.log('PS-477 hazmat disclosure guard passed');
