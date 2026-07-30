# PS-477 Hazmat Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a shipped order that carries an active hazmat declaration but no purchase snapshot display as dangerous goods — visibly marked unsealed — instead of displaying as not hazmat.

**Architecture:** One new backend module owns the resolved fact. A pure reducer maps `(snapshot, declaration)` to `sealed | declared_unsealed | none`. Two thin loaders (batch for Print Queue, single for order detail) feed it. Both existing consumers stop deriving their own answer and render the backend's `provenance` verbatim.

**Tech Stack:** TypeScript strict, Drizzle ORM, Postgres, PGlite (`@electric-sql/pglite`) for isolated integration tests, React + Tailwind, Playwright for mocked browser proof, `tsx` for guard scripts.

**Spec:** `docs/superpowers/specs/2026-07-31-ps-477-hazmat-disclosure-design.md`

## Global Constraints

- TypeScript strict mode. `npm run typecheck` must pass — it runs both `tsconfig.json` and `web/tsconfig.json`.
- Tailwind utility classes and theme tokens. No hardcoded hex in component styles.
- **Test orders only.** No test may read or write a real customer order, including for observation. No production database write of any kind.
- No `orders` or `shipments` write. The entire `shipments` table is inside the AGENTS.md/CLAUDE.md lockdown.
- No provider call, no postage, no label purchase, no marketplace notification in any test.
- Backend owns the compliance fact. The frontend renders `provenance` and must not re-derive whether something is hazmat.
- Ship direct to `prepshipv4-stable`. Pushing `src/**` triggers the CI-gated Render deploy.
- Every guard must call the function under test, not pattern-match source text.

## Spec Amendments Discovered While Reading Code

Two facts in the codebase contradict the spec as approved. Both are incorporated below.

**A1 — The Print Queue badge is gated on `hazmat_profile`, which will be null.**
`OrdersPrintQueueDrawer.tsx:344` and `:418` both render the badge under
`{entry.hazmat_profile ? (...)}`. The spec sets `profile: null` for
`declared_unsealed`. Left alone, the backend would return correct data and the
badge still would not appear. The render gate moves to `hazmat_is_hazmat`.

**A2 — The order-detail panel returns `null` entirely when the capability flag is off.**
`OrdersHazmatDeclaration.tsx:104` is
`if (loading || !state?.capabilities.featureEnabled) return null`, and
`getOrderHazmat`'s `publicState` also nulls `declaration` and
`frozenPurchaseFacts` on the same flag. The spec says flags must never hide that
something shipped as dangerous goods. Resolution: `disclosure` is added as a
**new field that is never flag-gated**, and the panel renders a minimal
disclosure block before the `featureEnabled` early return. Existing fields keep
their current gating — this plan does not widen `declaration` or
`frozenPurchaseFacts` exposure.

**A3 — Not a bug: the Orders-list chip already works.**
`HazmatChip.tsx:24` keys on `status === 'active'` from the live declaration, so
the Orders table already shows hazmat for the five orders. Only Print Queue and
the detail panel are broken. Do not change `HazmatChip`.

## File Structure

| File | Responsibility |
|---|---|
| `src/services/shipping-workflow/hazmat-disclosure.ts` (create) | Pure reducer + two loaders. The canonical owner of "what does this shipment declare and how well do we know it". |
| `scripts/ps-477-hazmat-disclosure-guard.ts` (create) | Calls the reducer directly. Pins the rules and the two delegation constraints. |
| `scripts/ps-477-hazmat-disclosure-integration.ts` (create) | PGlite. Builds the unsealed shape and asserts both loaders. |
| `src/services/print-queue.ts` (modify ~1516-1569) | Replace inline join with the batch loader; emit `hazmat_provenance` + `hazmat_is_hazmat`. |
| `src/services/order-hazmat.ts` (modify) | `getOrderHazmat` returns a non-flag-gated `disclosure`. |
| `web/src/lib/v2-apiClient.ts` (modify) | DTO types for `disclosure` and the queue's new fields. |
| `web/src/components/Views/OrdersPrintQueueDrawer.tsx` (modify :344, :418) | Gate badge on `hazmat_is_hazmat`; tooltip states sealed vs unsealed. |
| `web/src/components/Views/OrdersHazmatDeclaration.tsx` (modify :29-34, :104) | Drop `?? clearDeclaration()`; render disclosure before the flag return. |
| `web/e2e/orders-ps465-hazmat.spec.js` (modify) | Two mocked cases: unsealed queue entry, unsealed shipped detail. |
| `package.json` (modify) | `test:ps-477-hazmat-disclosure` script. |
| `scripts/sot-guard-pack.mjs` (modify) | Register the guard. 70 → 71. |

---

### Task 1: Pure reducer + guard

**Files:**
- Create: `src/services/shipping-workflow/hazmat-disclosure.ts`
- Create: `scripts/ps-477-hazmat-disclosure-guard.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `CanonicalHazmatPurchaseFacts`, `NormalizedHazmatDeclaration`, `HazmatProfile`, `summarizeHazmatDeclaration` — all from `src/services/shipping-workflow/hazmat-declaration.js`.
- Produces: `resolveHazmatDisclosure(snapshot, declaration)`, types `HazmatProvenance` and `ShipmentHazmatDisclosure`. Tasks 2, 3 and 5 depend on these exact names.

- [ ] **Step 1: Read the types this depends on**

Read `src/services/shipping-workflow/hazmat-declaration.ts` lines 68-120 (`NormalizedHazmatDeclaration`, `HazmatProfile`, `CanonicalHazmatPurchaseFacts`) and lines 395-413 (`summarizeHazmatDeclaration`). Confirm `CanonicalHazmatPurchaseFacts.profile` is `HazmatProfile` (not nullable) and that `NormalizedHazmatDeclaration` has **no** profile field.

- [ ] **Step 2: Write the failing guard**

Create `scripts/ps-477-hazmat-disclosure-guard.ts`:

```ts
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
import {
  resolveHazmatDisclosure,
} from '../src/services/shipping-workflow/hazmat-disclosure.js';
import {
  summarizeHazmatDeclaration,
  type CanonicalHazmatPurchaseFacts,
  type NormalizedHazmatDeclaration,
} from '../src/services/shipping-workflow/hazmat-declaration.js';

function activeDeclaration(): NormalizedHazmatDeclaration & { status: 'active' } {
  return {
    schemaVersion: 1,
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

function snapshot(isHazmat: boolean): CanonicalHazmatPurchaseFacts {
  return {
    schemaVersion: 1,
    revision: 3,
    declarationHash: `hz_${'a'.repeat(64)}`,
    snapshotHash: `hz_${'b'.repeat(64)}`,
    profile: 'shipstation_usps',
    declaration: { ...activeDeclaration(), status: 'active' },
  } as CanonicalHazmatPurchaseFacts & { summaryIsHazmat?: boolean };
}

// 1. Snapshot present wins and is sealed.
{
  const result = resolveHazmatDisclosure(snapshot(true), { declaration: activeDeclaration(), revision: 9 });
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

// 6. Delegation pin: the reducer must agree with summarizeHazmatDeclaration on
//    every declaration input rather than testing status itself. A second
//    derivation of "is this hazmat" is the exact failure this module removes.
for (const declaration of [activeDeclaration(), clearDeclaration()]) {
  const result = resolveHazmatDisclosure(null, { declaration, revision: 1 });
  assert.equal(
    result.isHazmat,
    summarizeHazmatDeclaration(declaration).isHazmat,
    'reducer must delegate the hazmat determination to summarizeHazmatDeclaration',
  );
}

console.log('PS-477 hazmat disclosure guard passed');
```

- [ ] **Step 3: Add the script and run it to verify it fails**

In `package.json`, beside the other PS-465 hazmat scripts, add:

```json
"test:ps-477-hazmat-disclosure": "tsx scripts/ps-477-hazmat-disclosure-guard.ts",
```

Run: `npm run test:ps-477-hazmat-disclosure`
Expected: FAIL — `Cannot find module '.../hazmat-disclosure.js'`.

- [ ] **Step 4: Write the minimal implementation**

Create `src/services/shipping-workflow/hazmat-disclosure.ts`:

```ts
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
 * A snapshot wins when present: it is proof of what was declared at purchase,
 * and a later declaration edit cannot change what was on the label.
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
```

- [ ] **Step 5: Run the guard to verify it passes**

Run: `npm run test:ps-477-hazmat-disclosure`
Expected: PASS — `PS-477 hazmat disclosure guard passed`

- [ ] **Step 6: Mutation-check the guard**

Temporarily change `provenance: 'declared_unsealed'` to `provenance: 'none'` and set `isHazmat: false` in the unsealed branch. Run the guard.
Expected: FAIL on assertion 2. Revert.

Temporarily change `profile: null` in the unsealed branch to `profile: 'shipstation_usps'`. Run the guard.
Expected: FAIL on assertion 3. Revert.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean, no output beyond the two tsc invocations.

```bash
git add src/services/shipping-workflow/hazmat-disclosure.ts scripts/ps-477-hazmat-disclosure-guard.ts package.json
git commit -m "feat(ps-477): own the hazmat disclosure fact in one place"
```

---

### Task 2: Loaders + PGlite integration

**Files:**
- Modify: `src/services/shipping-workflow/hazmat-disclosure.ts`
- Create: `scripts/ps-477-hazmat-disclosure-integration.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `resolveHazmatDisclosure` from Task 1.
- Produces: `loadHazmatDisclosureForOrders(orderIds: number[]): Promise<Map<number, ShipmentHazmatDisclosure>>` and `loadHazmatDisclosureForOrder(orderId: number): Promise<ShipmentHazmatDisclosure>`. Tasks 3 and 5 depend on these names.

- [ ] **Step 1: Read the existing query shapes**

Read `src/services/order-hazmat.ts:181-215` (`loadFrozenPurchaseFacts` — the snapshot→shipment join, latest shipment first, and how it validates `summaryProfile` against the profile list) and `src/services/print-queue.ts:1524-1542` (the inline join being replaced). Read how `loadDeclaration` reads `order_hazmat_declarations` in `order-hazmat.ts`.

- [ ] **Step 2: Write the failing integration test**

Create `scripts/ps-477-hazmat-disclosure-integration.ts`. Follow the PGlite pattern in `scripts/ps-465-hazmat-migration-integration.ts` — create the minimal parent tables, apply `drizzle/0078_order_hazmat_declarations.sql`, insert rows, then assert.

```ts
// PS-477: the unsealed shape cannot be produced by buying a label.
//
// Buying through PrepShip -- even a mock label for a test client -- is what
// SEALS a snapshot. TESTING-MS2TCYUF-000 proves it: it went through the
// test-client path, PS-186 forced a mock label, and it produced the only
// snapshot in production (prepship_test / test_label). So the broken shape is
// built here directly instead: a shipment with source='shipstation' and no
// snapshot, exactly what shipment-sync.ts:163 writes.
//
// PGlite, in-process, throwaway. No real order is read or written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const client = new PGlite();

try {
  await client.exec(`
    CREATE TABLE public.orders (id serial PRIMARY KEY);
    CREATE TABLE public.order_overrides (
      order_id integer PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
      best_rate_json jsonb
    );
    CREATE TABLE public.shipments (
      id serial PRIMARY KEY,
      order_id integer NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
      source text
    );
    CREATE TABLE public.external_operations (id serial PRIMARY KEY);
  `);
  await client.exec(readFileSync('drizzle/0078_order_hazmat_declarations.sql', 'utf8'));

  await client.exec(`
    INSERT INTO public.orders (id) VALUES (1), (2), (3);
    -- Order 1: the PS-477 shape. Sync-ingested shipment, active declaration,
    -- deliberately NO snapshot.
    INSERT INTO public.shipments (id, order_id, source) VALUES (10, 1, 'shipstation');
    -- Order 2: sealed. PrepShip bought this one.
    INSERT INTO public.shipments (id, order_id, source) VALUES (20, 2, 'prepship_v2');
    -- Order 3: shipment, no declaration at all.
    INSERT INTO public.shipments (id, order_id, source) VALUES (30, 3, 'shipstation');
  `);

  const declarationCols = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='order_hazmat_declarations'
  `);
  assert.ok(
    declarationCols.rows.some((row) => row.column_name === 'status'),
    'order_hazmat_declarations must expose status',
  );

  // Assert the join shape the batch loader relies on: an order with a shipment
  // and an active declaration but no snapshot must be findable.
  const unsealed = await client.query<{ order_id: number }>(`
    SELECT s.order_id
    FROM public.shipments s
    LEFT JOIN public.shipment_hazmat_snapshots hs ON hs.shipment_id = s.id
    WHERE hs.shipment_id IS NULL AND s.order_id = 1
  `);
  assert.equal(unsealed.rows.length, 1, 'order 1 must have a shipment with no snapshot');

  console.log('PS-477 hazmat disclosure PGlite integration passed');
} finally {
  await client.close();
}
```

- [ ] **Step 3: Add the script and run it to verify it fails**

In `package.json` add:

```json
"test:ps-477-hazmat-disclosure-integration": "tsx scripts/ps-477-hazmat-disclosure-integration.ts",
```

Run: `npm run test:ps-477-hazmat-disclosure-integration`
Expected: FAIL initially if the schema assumptions are wrong. If it passes immediately, the assertions are too weak — tighten them until they describe the shape the loaders need.

- [ ] **Step 4: Implement the loaders**

Append to `src/services/shipping-workflow/hazmat-disclosure.ts`. Mirror the query in `order-hazmat.ts:184-196` for snapshots and `loadDeclaration` for declarations. Batch both, then reduce per order:

First extract two mappers so the assembly rules exist once. Move the row→declaration
body of `loadDeclaration` (`order-hazmat.ts:158-172`) and the snapshot-JSON
validation (`order-hazmat.ts:197-215`) into `hazmat-disclosure.ts` as exported
`declarationFromRows(header, materials)` and
`purchaseFactsFromSnapshotRow(row): CanonicalHazmatPurchaseFacts | null`. Then
make `loadDeclaration` and `loadFrozenPurchaseFacts` call them instead of
inlining. Their behaviour must not change — this is a move, not a rewrite.

```ts
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { shipments } from '../../db/schema/shipments.js';
import {
  orderHazmatDeclarations,
  orderHazmatMaterials,
  shipmentHazmatSnapshots,
} from '../../db/schema/hazmat.js';

// Loaders are deliberately thin: fetch both inputs, hand them to the reducer.
// They must not contain any rule -- if a rule appears here, it belongs in
// resolveHazmatDisclosure.
export async function loadHazmatDisclosureForOrders(
  orderIds: number[],
): Promise<Map<number, ShipmentHazmatDisclosure>> {
  const result = new Map<number, ShipmentHazmatDisclosure>();
  if (orderIds.length === 0) return result;

  // Latest snapshot per order. Same join as order-hazmat.ts:184-196, batched:
  // ordered by shipment id desc, so the first row seen per order is the latest.
  const snapshotRows = await db
    .select({
      orderId: shipments.orderId,
      snapshotJson: shipmentHazmatSnapshots.snapshotJson,
      snapshotHash: shipmentHazmatSnapshots.snapshotHash,
      revision: shipmentHazmatSnapshots.orderDeclarationRevision,
      profile: shipmentHazmatSnapshots.summaryProfile,
      isHazmat: shipmentHazmatSnapshots.summaryIsHazmat,
    })
    .from(shipmentHazmatSnapshots)
    .innerJoin(shipments, eq(shipments.id, shipmentHazmatSnapshots.shipmentId))
    .where(inArray(shipments.orderId, orderIds))
    .orderBy(desc(shipments.id));

  const snapshotByOrder = new Map<number, CanonicalHazmatPurchaseFacts>();
  for (const row of snapshotRows) {
    if (row.orderId == null || snapshotByOrder.has(row.orderId)) continue;
    const facts = purchaseFactsFromSnapshotRow(row);
    if (facts) snapshotByOrder.set(row.orderId, facts);
  }

  // Declarations plus their materials. Materials do not affect isHazmat today,
  // but the reducer delegates to summarizeHazmatDeclaration, which takes a whole
  // NormalizedHazmatDeclaration -- so we assemble a real one rather than a
  // partial with materials: [] that would quietly go wrong if that function ever
  // starts reading them.
  const headers = await db
    .select()
    .from(orderHazmatDeclarations)
    .where(inArray(orderHazmatDeclarations.orderId, orderIds));

  const materialRows = headers.length === 0
    ? []
    : await db
        .select()
        .from(orderHazmatMaterials)
        .where(inArray(orderHazmatMaterials.orderId, headers.map((header) => header.orderId)))
        .orderBy(orderHazmatMaterials.sequence);

  const materialsByOrder = new Map<number, typeof materialRows>();
  for (const row of materialRows) {
    const list = materialsByOrder.get(row.orderId) ?? [];
    list.push(row);
    materialsByOrder.set(row.orderId, list);
  }

  const declarationByOrder = new Map<
    number,
    { declaration: NormalizedHazmatDeclaration; revision: number }
  >();
  for (const header of headers) {
    declarationByOrder.set(header.orderId, {
      declaration: declarationFromRows(header, materialsByOrder.get(header.orderId) ?? []),
      revision: header.revision,
    });
  }

  for (const orderId of orderIds) {
    result.set(
      orderId,
      resolveHazmatDisclosure(
        snapshotByOrder.get(orderId) ?? null,
        declarationByOrder.get(orderId) ?? null,
      ),
    );
  }
  return result;
}

export async function loadHazmatDisclosureForOrder(
  orderId: number,
): Promise<ShipmentHazmatDisclosure> {
  const batch = await loadHazmatDisclosureForOrders([orderId]);
  return batch.get(orderId) ?? resolveHazmatDisclosure(null, null);
}
```

Three queries regardless of order count — snapshots, declaration headers,
materials. Do not loop `loadDeclaration` per order; Print Queue passes every
visible order id and that would be N×2 round trips.

- [ ] **Step 5: Run both PS-477 tests**

Run: `npm run test:ps-477-hazmat-disclosure && npm run test:ps-477-hazmat-disclosure-integration`
Expected: both PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/services/shipping-workflow/hazmat-disclosure.ts src/services/order-hazmat.ts scripts/ps-477-hazmat-disclosure-integration.ts package.json
git commit -m "feat(ps-477): batch and single loaders for hazmat disclosure"
```

---

### Task 3: Print Queue backend

**Files:**
- Modify: `src/services/print-queue.ts:1516-1569`

**Interfaces:**
- Consumes: `loadHazmatDisclosureForOrders` from Task 2.
- Produces: queue DTO entries gain `hazmat_is_hazmat: boolean` and `hazmat_provenance: HazmatProvenance`. Task 4 depends on both names.

- [ ] **Step 1: Read the current block**

Read `src/services/print-queue.ts:1500-1575` in full, including the function signature and its imports of `shipmentHazmatSnapshots` and `shipments`.

- [ ] **Step 2: Replace the inline join**

Delete the `hazmatRows` query and `hazmatByOrderId` map at `:1524-1542`. Replace with:

```ts
  // PS-477: the queue must not treat a missing snapshot as "not hazmat". A label
  // bought in ShipStation and ingested by sync has no snapshot, and five shipped
  // HUGRAB orders proved the queue then showed nothing at all. The backend owns
  // this fact now; the queue renders what it reports.
  const disclosureByOrderId = await loadHazmatDisclosureForOrders(visibleOrderIds);
```

Replace the conditional spread at `:1563-1569` with:

```ts
      ...(disclosureByOrderId.get(Number(e.orderId))?.isHazmat
        ? {
            hazmat_is_hazmat: true,
            hazmat_provenance: disclosureByOrderId.get(Number(e.orderId))!.provenance,
            hazmat_profile: disclosureByOrderId.get(Number(e.orderId))!.profile,
            hazmat_snapshot_hash: disclosureByOrderId.get(Number(e.orderId))!.snapshotHash,
            hazmat_declaration_revision: disclosureByOrderId.get(Number(e.orderId))!.declarationRevision,
          }
        : {}),
```

Remove the now-unused `shipmentHazmatSnapshots` import if nothing else in the file uses it.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `shipmentHazmatSnapshots` is now unused, tsc or lint will flag it — remove the import.

- [ ] **Step 4: Run the print queue guards**

Run: `npm run test:ps-346-print-queue-durable-full-results`
Expected: PASS. If it asserts the old conditional-spread shape, update the assertion to the new field set and note why in the diff.

- [ ] **Step 5: Commit**

```bash
git add src/services/print-queue.ts
git commit -m "fix(ps-477): print queue asks the disclosure owner, not the snapshot table"
```

---

### Task 4: Print Queue badge

**Files:**
- Modify: `web/src/components/Views/OrdersPrintQueueDrawer.tsx:344, :418`
- Modify: `web/src/lib/v2-apiClient.ts`

**Interfaces:**
- Consumes: `hazmat_is_hazmat`, `hazmat_provenance`, `hazmat_profile`, `hazmat_snapshot_hash`, `hazmat_declaration_revision` from Task 3.

- [ ] **Step 1: Read both badge sites and the DTO type**

Read `web/src/components/Views/OrdersPrintQueueDrawer.tsx:335-355` and `:410-430`. Both currently gate on `entry.hazmat_profile`. Find the queue entry type in `web/src/lib/v2-apiClient.ts` and add the two new fields.

- [ ] **Step 2: Add the DTO fields**

In `web/src/lib/v2-apiClient.ts`, on the print queue entry type:

```ts
  hazmat_is_hazmat?: boolean
  hazmat_provenance?: 'sealed' | 'declared_unsealed' | 'none'
```

- [ ] **Step 3: Move the render gate off profile**

This is amendment A1. `profile` is null for unsealed, so gating on it would hide exactly the case this ticket exists to fix. At **both** sites change `{entry.hazmat_profile ? (` to `{entry.hazmat_is_hazmat ? (` and make the tooltip state provenance. At `:347`:

```tsx
                            title={entry.hazmat_provenance === 'sealed'
                              ? `Immutable hazmat snapshot revision ${entry.hazmat_declaration_revision ?? 'unknown'} · ${entry.hazmat_profile}`
                              : 'Dangerous goods declared. This label was not purchased through PrepShip, so no snapshot was sealed at purchase.'}
```

At `:421` apply the same conditional, keeping that site's shorter sealed text.

- [ ] **Step 4: Build the frontend**

Run: `npm run build:web`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Views/OrdersPrintQueueDrawer.tsx web/src/lib/v2-apiClient.ts
git commit -m "fix(ps-477): queue badge keys on hazmat, not on a profile that is null when unsealed"
```

---

### Task 5: Order detail backend

**Files:**
- Modify: `src/services/order-hazmat.ts` (`OrderHazmatState`, `publicState`, `getOrderHazmat`)

**Interfaces:**
- Consumes: `loadHazmatDisclosureForOrder` from Task 2.
- Produces: `OrderHazmatState.disclosure: ShipmentHazmatDisclosure`. Task 6 depends on it.

- [ ] **Step 1: Read the state builder**

Read `src/services/order-hazmat.ts:60-80` (`OrderHazmatState`) and `:270-336` (`publicState`, `getOrderHazmat`). Note that `publicState` nulls `declaration` and `frozenPurchaseFacts` when `capabilities.featureEnabled` is false.

- [ ] **Step 2: Add a non-flag-gated disclosure field**

Add `disclosure: ShipmentHazmatDisclosure` to `OrderHazmatState`. In `publicState`, set it from the passed-in disclosure **without** the `featureEnabled` ternary that guards the neighbouring fields:

```ts
    // PS-477 / amendment A2: rollout flags gate WRITING and RATING hazmat. They
    // must never gate SEEING that something already shipped as dangerous goods.
    // getOrderHazmatForShipping sets the same precedent -- hiding a persisted
    // declaration behind a kill switch is how an undeclared label gets bought.
    disclosure: input.disclosure,
```

In `getOrderHazmat`, compute it before the `featureEnabled` early return so the flags-off branch carries a real disclosure rather than an empty one. Both return paths must set it.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean once every `publicState` call site supplies `disclosure`.

- [ ] **Step 4: Run the PS-465 suite for regressions**

Run: `npm run test:ps-465-hazmat`
Expected: 3/3 PASS — declaration/capability guard, migration guard, PGlite integration.

- [ ] **Step 5: Commit**

```bash
git add src/services/order-hazmat.ts
git commit -m "feat(ps-477): order hazmat state carries a disclosure flags cannot hide"
```

---

### Task 6: Order detail panel

**Files:**
- Modify: `web/src/components/Views/OrdersHazmatDeclaration.tsx:29-34, :104`
- Modify: `web/src/lib/v2-apiClient.ts` (`OrderHazmatDto`)

- [ ] **Step 1: Read the component top to bottom**

Read all of `web/src/components/Views/OrdersHazmatDeclaration.tsx`. The change touches the display fallback and the early return; everything below line 115 is the editor and stays as-is.

- [ ] **Step 2: Add `disclosure` to the DTO type**

In `web/src/lib/v2-apiClient.ts` on `OrderHazmatDto`:

```ts
  disclosure: {
    isHazmat: boolean
    profile: string | null
    provenance: 'sealed' | 'declared_unsealed' | 'none'
    snapshotHash: string | null
    declarationRevision: number | null
  }
```

- [ ] **Step 3: Render disclosure before the capability gate**

Replace `:104` so a shipped dangerous-goods order is never silently blank (amendment A2):

```tsx
  if (loading) return null
  // PS-477: disclosure is not flag-gated. A shipped order that carries an active
  // declaration must say so even when hazmat writes are disabled for this
  // client, because absence used to read as "not dangerous goods".
  if (!state?.capabilities.featureEnabled) {
    if (!state?.disclosure.isHazmat) return null
    return (
      <div className="mt-2 rounded ring-1 ring-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-900">
        <span className="font-bold uppercase tracking-wide">Hazmat</span>
        {state.disclosure.provenance === 'declared_unsealed'
          ? ' · declared, not sealed at purchase'
          : ' · sealed at purchase'}
      </div>
    )
  }
```

- [ ] **Step 4: Stop rendering an unsealed order as clear**

Replace `displayedDeclaration` at `:29-34`:

```tsx
function displayedDeclaration(state: OrderHazmatDto, shipped: boolean): HazmatDeclarationDraft {
  // Per user override unlock shipped data on 2026-07-25: terminal views render
  // only the immutable purchase snapshot and never expose declaration writes.
  // PS-477: when there is no snapshot -- the label was bought outside PrepShip
  // and ingested by sync -- fall back to the declaration rather than
  // clearDeclaration(), which affirmatively displayed dangerous goods as clear.
  if (shipped) return state.frozenPurchaseFacts?.declaration ?? state.declaration ?? clearDeclaration()
  return state.declaration ?? clearDeclaration()
}
```

`editable` stays `!shipped && ...`, so this remains read-only for shipped orders.

- [ ] **Step 5: Show provenance beside the frozen block**

At `:399`, where `{shipped && state.frozenPurchaseFacts ? (` renders sealed facts, add an else-branch for `shipped && !state.frozenPurchaseFacts && state.disclosure.isHazmat` reading "Declared, not sealed at purchase — this label was not bought through PrepShip."

- [ ] **Step 6: Build and commit**

Run: `npm run build:web`

```bash
git add web/src/components/Views/OrdersHazmatDeclaration.tsx web/src/lib/v2-apiClient.ts
git commit -m "fix(ps-477): a shipped hazmat order no longer renders as clear"
```

---

### Task 7: Mocked browser proof

**Files:**
- Modify: `web/e2e/orders-ps465-hazmat.spec.js`

- [ ] **Step 1: Read the existing spec**

Read `web/e2e/orders-ps465-hazmat.spec.js` in full — specifically how it intercepts routes and stubs `/orders/:id/hazmat`. Reuse its fixtures; do not create a parallel suite.

- [ ] **Step 2: Add the unsealed detail case**

Stub `/orders/:id/hazmat` with `frozenPurchaseFacts: null`, an active `declaration`, and `disclosure: { isHazmat: true, profile: null, provenance: 'declared_unsealed', snapshotHash: null, declarationRevision: 3 }`, with the order shipped. Assert the panel does **not** render as clear and that "not sealed" appears.

- [ ] **Step 3: Add the unsealed queue case**

Stub the print queue response with one entry carrying `hazmat_is_hazmat: true`, `hazmat_provenance: 'declared_unsealed'`, `hazmat_profile: null`. Assert the badge renders and its `title` mentions not being purchased through PrepShip.

- [ ] **Step 4: Run the browser suite**

Run: `npm run test:ps-465-hazmat:browser`
Expected: all PASS, every request intercepted, no provider host contacted.

- [ ] **Step 5: Mutation-check**

Restore `?? clearDeclaration()` in `OrdersHazmatDeclaration.tsx`. Re-run the suite.
Expected: the unsealed detail case FAILS. Revert.

- [ ] **Step 6: Commit**

```bash
git add web/e2e/orders-ps465-hazmat.spec.js
git commit -m "test(ps-477): mocked proof that an unsealed hazmat order shows as hazmat"
```

---

### Task 8: Guard pack wiring and final verification

**Files:**
- Modify: `scripts/sot-guard-pack.mjs`

- [ ] **Step 1: Register both guards**

Read `scripts/sot-guard-pack.mjs` — `REQUIRED_GUARDS` currently holds 70 entries. Add after `'test:ps-476-rule-status-convergence'`:

```js
  // PS-477: a shipment PrepShip did not purchase still discloses its hazmat.
  // Absence of a snapshot must never read as "not dangerous goods" -- the queue
  // omitted the fields entirely and the detail panel rendered clearDeclaration(),
  // so five shipped HUGRAB orders displayed as clear.
  'test:ps-477-hazmat-disclosure',
  'test:ps-477-hazmat-disclosure-integration',
```

- [ ] **Step 2: Confirm the count**

Run: `grep -cE "^\s*'test:" scripts/sot-guard-pack.mjs`
Expected: `72` (70 + 2).

- [ ] **Step 3: Run the whole pack**

Run: `npm run test:sot-guard-pack`
Expected: every guard passes, including both new entries. If an unrelated guard was already red, record which and confirm it is red on `origin/prepshipv4-stable` too — the criterion is zero NEW reds vs base.

- [ ] **Step 4: Full verification**

Run each and record exact output:

```bash
npm run typecheck
npm run build:web
npm run test:ps-465-hazmat
npm run test:sot-guard-pack
```

- [ ] **Step 5: Commit and push**

```bash
git add scripts/sot-guard-pack.mjs
git commit -m "test(ps-477): put the disclosure guards behind the deploy gate"
git push origin prepshipv4-stable
```

Pushing `src/**` triggers the CI-gated Render deploy. Watch it:

```bash
gh run list --workflow=render-auto-deploy.yml --limit 1
```

- [ ] **Step 6: Report, without touching a real order**

Report to the PS-477 card: head SHA, changed files, the named canonical owner (`hazmat-disclosure.ts`) and the callers that delegate to it, exact guard totals, and the accepted limitation — no screenshot of a real unsealed order exists, because testing is test-orders-only and the `shipments` table is inside the lockdown.

Do **not** query or screenshot orders 3243-3246 or 3249 to confirm the fix.
