# PS-477 — Backend-owned hazmat disclosure for shipments PrepShip did not purchase

Date: 2026-07-31 · Card: https://trello.com/c/KTQgLRx4 · Head at design time: `f5a1ff77`

## Problem

Five shipped HUGRAB orders — 3243, 3244, 3245, 3246, 3249 — each carry an active
hazmat declaration written by automation and each has a shipment row. None has a
row in `shipment_hazmat_snapshots`. Shipment history and Print Queue show no
hazmat for them.

The snapshot is written only by PrepShip's own label-purchase flow
(`labels.ts:3100` for `provider_purchase`, `labels.ts:2583` for `test_label`).
These five labels were bought in ShipStation and ingested by
`shipment-sync.ts:163`, which writes `source='shipstation'` and knows nothing
about the declaration PrepShip recorded minutes earlier.

## Root cause — not the missing row

The backend already returns both facts. `getOrderHazmat` (`order-hazmat.ts:331`)
hands back the live declaration *and* `frozenPurchaseFacts`. No owner answers
"what does this shipment declare, and how well do we know it?", so each consumer
invented its own answer and they drifted:

- **Print Queue** (`print-queue.ts:1524`) joins `shipment_hazmat_snapshots →
  shipments` and omits the hazmat fields entirely when there is no snapshot.
- **Order detail panel** (`OrdersHazmatDeclaration.tsx:32`) does
  `if (shipped) return state.frozenPurchaseFacts?.declaration ?? clearDeclaration()`.

The second is worse than a blank: it renders `clearDeclaration()`, affirmatively
displaying a dangerous-goods order as **not hazmat**. That is what an operator
sees today for all five orders.

Absence of a snapshot silently means "not hazmat". A missing row reads as a
negative compliance answer.

Per ARCHITECTURE.md this is backend-critical truth living in React, so a
frontend-only fix is rejected regardless of how small it would be.

## Decisions

| Question | Decision |
|---|---|
| What does a shipped hazmat order with no seal display? | Hazmat, visibly marked unsealed |
| Scope | Read-time resolution; fixes the five existing orders with no shipped-row write, though they are not used to verify it |
| Print Queue badge | One HAZMAT badge either way; provenance in tooltip and DTO |
| Snapshot vs declaration disagreement | Snapshot wins when present |
| Rollout flags | Do **not** gate disclosure |
| Test data | Test orders only; no real order touched, including for observation |

### Why snapshot wins

The seal is proof of what was declared at purchase. A later declaration edit
cannot change what was on the label. Surfacing snapshot-vs-declaration
*divergence* is a different problem and is out of scope.

### Why flags must not gate disclosure

`getOrderHazmat` returns a null declaration when
`resolveHazmatCapabilities().featureEnabled` is false. The disclosure resolver
deliberately ignores those flags:

- Today's Print Queue badge reads snapshots directly and is already
  flag-independent. Gating would be a **regression** in visibility.
- `getOrderHazmatForShipping` sets the precedent with an explicit comment —
  hiding a persisted declaration behind a kill switch is how an undeclared label
  gets purchased.

Rollout flags gate **writing and rating** hazmat. They must not gate **seeing**
that something already shipped as dangerous goods.

### Why false positives are not a risk

PS-465 makes hazmat declarations immutable on terminal orders, so a declaration
on a shipped order necessarily predates shipping. Eleven declarations exist in
total.

## Design

New module `src/services/shipping-workflow/hazmat-disclosure.ts`, beside
`hazmat-declaration.ts` which already owns sealing — not inside
`order-hazmat.ts`, which owns writes, optimistic revisions, label locks, audit
and rate invalidation.

### Pure reducer — the whole rule, no I/O

```ts
export type HazmatProvenance = 'sealed' | 'declared_unsealed' | 'none'

export type ShipmentHazmatDisclosure = {
  isHazmat: boolean
  profile: HazmatProfile | null
  provenance: HazmatProvenance
  snapshotHash: string | null
  declarationRevision: number | null
}

export function resolveHazmatDisclosure(
  snapshot: CanonicalHazmatPurchaseFacts | null,
  declaration: { declaration: NormalizedHazmatDeclaration | null; revision: number } | null,
): ShipmentHazmatDisclosure
```

Rules in order:

1. Snapshot present → `sealed`, profile and hash from the snapshot, `isHazmat`
   from `summary_is_hazmat`.
2. No snapshot, declaration is hazmat → `declared_unsealed`, `profile: null`,
   `snapshotHash: null`.
3. Otherwise → `none`, `isHazmat: false`.

Two constraints on rule 2, both load-bearing:

**`profile` is null for `declared_unsealed`, always.**
`NormalizedHazmatDeclaration` has no profile field. A carrier profile
(`shipstation_usps`, `shipstation_ups_dry_ice`, …) is resolved at rating and
purchase time by `hazmat-capability.ts`, so a declaration alone cannot name one.
For a label PrepShip did not buy, the profile is genuinely unknown, and `null`
says so. Inventing one would fabricate exactly the provenance this design is
trying to keep honest.

**"Is this hazmat" is delegated, not re-derived.** The reducer calls
`summarizeHazmatDeclaration(declaration).isHazmat`, which already owns the rule
(`status === 'active'`). Re-implementing `status === 'active'` inside the
resolver would create a second source of truth for the exact fact this module
exists to make single — the same failure mode as the two drifted consumers.

`isTerminal` is deliberately not a parameter. Nothing is sealed before purchase,
so an awaiting order with an active declaration is genuinely "declared, not
sealed". Edit affordances are a separate concern the panel already handles.

### Two thin loaders

- `loadHazmatDisclosureForOrders(orderIds: number[]): Promise<Map<number, ShipmentHazmatDisclosure>>`
  — batch, for Print Queue. One query for snapshots (existing `snapshots →
  shipments` join, latest shipment first), one for declarations, reduce per order.
- `loadHazmatDisclosureForOrder(orderId: number)` — single, for order detail.

### Call-site changes

- `print-queue.ts:1524` drops its inline join and calls the batch loader.
- `getOrderHazmat` gains a `disclosure` field. `loadFrozenPurchaseFacts` and
  `frozenPurchaseFacts` stay as-is so the sealed-facts block at
  `OrdersHazmatDeclaration.tsx:399` keeps working unchanged.
- `OrdersHazmatDeclaration.tsx:32` stops doing `?? clearDeclaration()` and
  renders the backend's `disclosure`.

### DTO

Print Queue keeps its existing flat `hazmat_profile`, `hazmat_snapshot_hash`,
`hazmat_declaration_revision` fields and gains `hazmat_provenance`. They are
emitted whenever `isHazmat` is true, instead of only when a snapshot exists. For
the five orders the new shape is `hazmat_snapshot_hash: null` with
`hazmat_provenance: 'declared_unsealed'`.

## Data flow

**Print Queue.** `listPrintQueue` collects `visibleOrderIds` as now, calls the
batch loader, spreads hazmat fields when `isHazmat` is true. Two queries in the
loader instead of one inline join. Same failure semantics as today — if the
lookup throws, the request fails, as it already would. No partial-degradation
mode: a queue that silently drops hazmat on a query error is the bug being fixed.

**Order detail.** `getOrderHazmat` already loads both inputs; it passes them to
the reducer and returns `disclosure`. No extra query.

## Edge cases

- **Multiple shipments per order** — both loaders take the latest shipment
  (`orderBy(desc(shipments.id))`), matching `loadFrozenPurchaseFacts` and the
  current Print Queue join. Multi-package orders (PS-289) could diverge per
  shipment; keeping existing per-order-latest behavior is a known simplification,
  not changed under this ticket.
- **Snapshot with `summary_is_hazmat: false`** — `sealed`, `isHazmat: false`. The
  seal is authoritative including when it says "not dangerous goods".
- **Declaration status `clear`** — `none`. Orders 3240, 3241 and 3242 are in this
  state and correctly show nothing.

## Testing

Test orders only. No real order is touched, including for observation.

**A test order cannot reproduce this bug.** Buying a label through PrepShip is
what seals a snapshot, including a mock label. `TESTING-MS2TCYUF-000` went
through the test-client path, PS-186 forced a mock label, and it produced the one
snapshot in the database (`prepship_test` / `test_label`). The normal test-order
flow exercises the **sealed** case, which already works. The broken shape only
arises when the label was bought elsewhere and swept in by sync.

1. **Pure reducer — unit, no database, no order.** Case table: snapshot present →
   `sealed`; absent + active → `declared_unsealed`; absent + `clear` → `none`;
   snapshot with `summary_is_hazmat: false` → `sealed`, `isHazmat: false`; both
   null → `none`. Plus two pins for the constraints above: `declared_unsealed`
   must carry `profile: null`, and the reducer must agree with
   `summarizeHazmatDeclaration` on every declaration input rather than testing
   `status` itself. This is the boundary test at the canonical owner.
2. **Loader integration — PGlite.** Follows
   `scripts/ps-465-hazmat-migration-integration.ts`, which spins
   `@electric-sql/pglite` and applies `0078`. Builds the PS-477 shape directly:
   an order, a shipment with `source='shipstation'`, an active declaration, no
   snapshot. Asserts the batch loader returns `declared_unsealed` for it and
   `sealed` for a sibling that has one. Synthetic rows, throwaway database.
3. **Operator proof — mocked Playwright.** Extends the fully-intercepted
   `test:ps-465-hazmat:browser` suite. Stub the Print Queue DTO with
   `hazmat_provenance: 'declared_unsealed'`, assert the badge renders and the
   tooltip says unsealed. Stub a shipped order detail with an active declaration
   and no `frozenPurchaseFacts`, assert it no longer renders as clear.

**Guard.** New `test:ps-477-hazmat-disclosure` added to
`scripts/sot-guard-pack.mjs` — currently 70 entries, so 70 → 71. It calls the
reducer rather than pattern-matching source, matching PS-472/473/474. Mutation
checks: making the reducer return `none` for an active declaration must trip the
fallback tests; restoring `?? clearDeclaration()` must trip the browser test.

## Accepted limitation

No screenshot of the real app showing a real unsealed order, because that would
require either touching a real order or writing a `shipments` row for a test
fixture — and the entire `shipments` table is inside the lockdown. The rule is
unit-proven and the wiring is guard-pinned. This is the same limitation PS-472
accepted and documented.

## Out of scope

- Backfilling snapshots onto the five existing shipments.
- Surfacing snapshot-vs-declaration divergence.
- Per-shipment disclosure for multi-package orders.
- Direct UPS and Walmart hazmat mapping (PS-465 out-of-scope list).
