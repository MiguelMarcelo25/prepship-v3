# PS-490 — Billing exports: Destination column + Return/Repl indicator on Order #

**Assignee:** Lawrence
**Priority:** P2 — operator-facing billing surface, no money math changes
**Repo:** https://github.com/drprepperusa-org/prepship-v4.git · **Target branch:** `prepshipv4-stable`
**Requested by DJ:** 2026-08-01
**Closely related:** PS-488 (AC-1 return identity, AC-2 Destination) — the backend half of
this card is already built there. This card is the export surfaces only.

> Numbered PS-490: PS-489 was already taken by "International orders ship without a shipment
> record, so they bill $0 shipping" (raised 2026-08-06).

## SHIP GATE

- Ship direct to `prepshipv4-stable`; no feature branch, no PR. Pushing IS the deploy.
- Read-only investigation unrestricted.
- **Billing is a money surface.** Column additions must not change any total, fee, or
  amount. `test:ps-323-billing-sot-parity`, `test:ps-362-billing-detail-sot-export`,
  `test:ps-372-billing-read-divergence` must stay green.
- No live postage, provider mutation, marketplace notification, or shipped/cancelled
  mutation. No schema change is needed for this card.

## What DJ asked for

1. A **Destination** column (international vs domestic) in **all three** billing export
   surfaces: Export (text), Excel (xlsx), CSV.
2. The **Order #** in those same three exports to carry an indicator when the row is a
   return or a replacement — e.g. `0001 - Return`, `0002 - Repl` (Repl = REPLACE).

## Investigation, 2026-08-01 — the backend half is ALREADY DONE

This is the important finding: **do not build a new classifier, and do not derive either
fact in the export layer.** Both already have canonical backend owners.

### Destination

- Owner: `src/services/billing-destination-international.ts` →
  `classifyDestinationCountry()`, returning
  `type BillingDestination = 'Domestic' | 'International' | 'Needs Review'`.
- Source data: `orders.raw->'shipTo'->>'country'`, already selected in
  `src/services/billing.ts:2597` with a comment naming the canonical owner.
- Reading `shipTo` from `orders.raw` is **sanctioned**: `order-raw-payload-policy.ts`
  explicitly retains `shipTo` as *"operational address/package evidence not yet
  normalized into complete columns"*. There is no `country` column on `orders` (only
  `ship_to_city`, `ship_to_name`, `ship_to_postal_code`, `ship_to_state`).
- Already on the read model: `BillingDetailRowDto` carries `destinationCountry`,
  `destinationIsInternational`, and the AC-2 `destination` field
  (`src/services/billing-detail-row-sot.ts`).

Coverage check on production: 5,065 of 5,067 orders in the last 60 days carry a country
(99.96%); observed values `US` and `CA`.

### Return / Repl

- `returns.return_reference` is persisted by the **Client Portal** and already selected
  into the billing read model (`src/services/billing.ts:1811`, `:1832`), exposed on the
  DTO as `returnReference` (PS-488 AC-1).
- Observed convention on all 8 existing rows: `<number>-RETURN` — e.g. `2659-RETURN`,
  `2142-RETURN`, `1202-RETURN`.
- **No replacement row exists yet.** DJ confirmed replacements will use the same
  convention with a `-REPL` suffix. There is no `%repl%` / `%exchange%` / `%reship%`
  column anywhere in the database, and `returns.reason` is null on all 8 rows, so the
  suffix is the only available signal — which is fine, because it is the one the Client
  Portal actually writes.
- `src/services/billing-row-reference.ts` already owns
  `type BillingRowType = 'Outbound' | 'Return'` and `billingRowIdentity()` — the natural
  home for the label rule.

### What is genuinely missing

**Both fields are already rendered in the UI — and in none of the three exports.**

PS-488 AC-6 (`aa8324c3`) added **Type** and **Destination** columns to
`web/src/components/Views/BillingDetailTable.tsx`, plus the supporting fields on
`billing-detail-row-sot.ts` and `billing-parity.ts`. It did **not** touch any export
route. Verified at HEAD `4a055403` with a clean tree: grep for `destination` in
`billing-invoice-csv.ts`, `billing-invoice-xlsx-layout.ts` and `billing-invoice-text.ts`
returns **zero matches in all three**.

So the operator can see Destination on screen and cannot get it out of an export — which
is precisely the gap DJ reported. **This card is the export surfaces only**, and the UI
table is the reference implementation to mirror: same vocabulary, same source fields, no
new derivation.

## Decisions locked in with DJ (2026-08-01)

| Question | Decision |
|---|---|
| Destination vocabulary | **Keep the existing three values**: `Domestic` / `International` / `Needs Review`. NOT a two-value INTL/DOM. |
| Order # format | **`0001 - Return` / `0002 - Repl`** — space-dash-space, consistent across both. |
| Repl detection | `return_reference` suffix `-REPL`. |

**Why three values and not INTL/DOM, even though DJ first asked for two.** The owner's
own comment records DJ's rule from 2026-08-05: a missing country is *not* International
and *not* Domestic either — 293 orders in 120 days carry no country at all, and billing
them as Domestic makes a gap indistinguishable from a verified US address. `Needs Review`
exists precisely so that cannot happen. DJ reconfirmed keeping all three on 2026-08-01.

## Work, file by file

1. **`src/services/billing-row-reference.ts`** — add the pure label rule mapping a
   `returnReference` suffix to a display token (`-RETURN` → `Return`, `-REPL` → `Repl`).
   One owner, consumed by all three exports; do NOT re-implement per surface (PS-316).
   An unrecognised or absent suffix must leave the Order # **clean**, never mislabelled.
2. **`src/routes/billing-invoice-csv.ts`** — add `Destination` to `INVOICE_CSV_HEADERS`,
   carry the field on `InvoiceCsvDetailRow` (note this type is snake_case while the DTO
   is camelCase — there is a mapping layer), and render the Order # suffix in
   `renderInvoiceCsvRow`. Mind `csvField()`'s formula-injection guard.
3. **`src/routes/billing-invoice-xlsx-layout.ts`** — same column and same Order # suffix,
   in the Line Items sheet; keep column widths/formatting consistent with neighbours.
4. **`src/routes/billing-invoice-text.ts`** — same, in the text Export.
5. **Guard** — new `test:ps-490-billing-export-destination-return`, wired into
   `test:sot-guard-pack`. Pin: all three surfaces emit the column; all three use the
   SHARED label rule rather than re-deriving; `Needs Review` is never rendered as
   Domestic; an unknown suffix leaves Order # untouched; and no total/amount changes.

## Done when

- All three exports show a Destination column with `Domestic` / `International` /
  `Needs Review`, read from the backend DTO and never re-derived in the export layer.
- All three exports render `<order#> - Return` / `<order#> - Repl` when the row has the
  matching `return_reference` suffix, and a clean order number otherwise.
- A single shared owner produces the label; a guard proves all three consume it.
- Billing parity guards green — **no total, fee, or amount changes**.
- Zero new reds vs base; CI-gated deploy green on the exact head SHA.

## Evidence to return

- Exact head SHA, changed files.
- The canonical owners named, and the call sites that delegate to them.
- A sample row from each of the three exports showing both new behaviours.
- Proof no billing amount changed (parity guards + a before/after export diff for a
  sample period).

## Notes for whoever picks this up

- There is **no `-REPL` data in production yet**, so that branch cannot be verified from
  live rows. Cover it with a fixture, and expect the first real one to come from the
  Client Portal side.
- Verify the invoice query path actually carries `destination` and `returnReference`
  through to `data.details` (`billingInvoiceData` → `renderInvoiceCsv(data.details)` in
  `src/routes/billing.ts:2533-2535`). The fields are selected in `billing.ts`, but confirm
  they survive into the invoice DTO rather than only the billing-detail read model — that
  is the one unverified link in this plan.

- **Mirror the UI table, do not invent.** `BillingDetailTable.tsx` already renders Type
  and Destination from the DTO. The exports should read the same fields and use the same
  words, so screen and export cannot disagree — a billing surface that says two different
  things about one order is worse than one that says nothing.

Filed on Trello 2026-08-01 as PS-490: https://trello.com/c/9osbmAlm (Lawrence To-Do List).
Head at filing: `a148f6b4`.

> **Concurrency note.** This branch is being worked by more than one agent session. While
> tonight's PS-431/467/469/477/484/485 work was in flight, a concurrent session pushed 68
> commits of PS-487/PS-488 billing work on top of it. Everything is intact and linear —
> but re-read the export files at current HEAD before implementing, because this card's
> findings were taken at `4a055403` and that area is actively moving.
