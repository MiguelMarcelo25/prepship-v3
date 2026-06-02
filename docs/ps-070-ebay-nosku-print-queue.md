# PS-070 — eBay no-SKU orders showing "UNKNOWN SKU" in Print Queue batch headers

**Status:** Fixed. Blank-SKU eBay lines now resolve to a stable, human-pickable
identity (product title) in both the Print Queue panel and the generated batch
PDF, and group by that identity instead of collapsing into a generic
`UNKNOWN SKU` bucket. A shared pure module keeps the frontend grouping and the
backend PDF in lock-step; a guard + an in-memory PDF certification lock the
behaviour.

**Reported:** eBay orders whose marketplace line has no SKU degraded into
`UNKNOWN SKU` on the warehouse pick/pack batch header — an unsafe instruction.

---

## Summary — root cause

One pattern, repeated on three surfaces: **`if (!sku) continue`** dropped every
blank-SKU line —

- `buildQueueAddPayload` (frontend) — no-SKU items were excluded from
  `multi_sku_data` and the combo key, so a no-SKU order queued with an empty
  `primary_sku` and a bare `ORDER:<id>` group, and multi-SKU combos silently
  lost their eBay line.
- `getPrintQueueSkuLines` (frontend) — reconstruction dropped the same lines.
- `collapseQueueSkuLines` (backend) — same drop, then the PDF fell back to the
  literal string `entry.primarySku ?? 'UNKNOWN SKU'` and drew `sku: UNKNOWN SKU`
  on the batch header.

Because the blank-SKU lines were thrown away, there was no identity left to pick
by, so the code printed a fake-pickable `UNKNOWN SKU`.

## Fallback hierarchy implemented

A single resolver (`resolveQueueLineIdentity`) maps any order/queue line to a
safe identity + stable group token:

| Priority | Source | Group token | Pick display |
|---|---|---|---|
| 1 | canonical SKU | `SKU:<normsku>` | `sku: <sku>` |
| 2 | eBay item/variation/line id **+** title | `EBAY_ID:<id>\|TITLE:<title>` | title + `no SKU — eBay item` |
| 3 | product **title** only | `NOSKU:<normalizedTitle>` | title + `no SKU — eBay item` |
| 4 | eBay item id only | `EBAY_ID:<id>` | `eBay item (<id>)` + no-SKU note |
| 5 | nothing usable | `UNRESOLVED` | `UNRESOLVED EBAY ITEM — review order details` |

Different blank-SKU titles get different `NOSKU:` tokens (never collapse);
identical title + qty share a token (batch together); combos sort tokens so line
order doesn't matter. Canonical `order_items` only stores `sku` + `name`, so the
item/variation-id and internal alias-mapping tiers are wired opportunistically
(any `itemId`/`variationId`/`lineItemId` present on the raw line is used) and
otherwise documented as the **alias-mapping follow-up** below.

---

## Files changed

**New**
- `src/services/print-queue-identity.ts` — pure, no-DB identity module
  (`resolveQueueLineIdentity`, `collapseIdentityLines`, `buildQueueComboKey`,
  constants). Single source of truth; mirrored on the frontend.

**Changed (backend)**
- `src/services/print-queue.ts`
  - `collapseQueueSkuLines` rewritten to use `collapseIdentityLines` — keeps
    blank-SKU lines; falls back to title (then UNRESOLVED), never `UNKNOWN SKU`.
  - Batch-header card render: title from `cardTitle`; second row is a real
    `sku: X` **or** a safe `no SKU — eBay item` / UNRESOLVED note.
  - `buildComboSummaryLine` (manifest combo line) shows titles for no-SKU lines.
  - Fallback mock-label `SKU:` line no longer prints `Unknown SKU`.

**Changed (frontend)**
- `web/src/components/Views/orders-parity.ts` — mirrored identity helpers;
  `getPrintQueueSkuLines`, `buildPrintQueueSkuComboKey`, `buildQueueAddPayload`,
  and `groupPrintQueueEntries` keep no-SKU lines, group by title, and display the
  title instead of a raw group id. (Also fixed a latent bug where the legacy
  `SKU:<…>` group-id parse mistook a `SKU:NOSKU:…` combo wrapper for a real SKU.)

**New artifacts**
- `scripts/ps-070-ebay-nosku-identity-guard.ts` — imports **both** layers and
  asserts token-for-token parity + the DoD grouping rules.
- `scripts/ps-070-batch-pdf-cert.ts` — renders the batch header in-memory (fake
  names only) and decodes the PDF to prove `UNKNOWN SKU` is gone and the title /
  UNRESOLVED label is present.

---

## Before / after Print Queue + batch headers

| Scenario | Before | After |
|---|---|---|
| Single no-SKU eBay order | card `sku: UNKNOWN SKU` | card title **Samyang Buldak Variety Pack**, second row `no SKU — eBay item` |
| Two unrelated no-SKU eBay orders | both bucketed as `UNKNOWN SKU` | two distinct groups, one per title |
| Two orders, same no-SKU title | grouped by separate `ORDER:<id>` (no batch) | one batch group `Samyang Buldak Variety Pack` (2 orders) |
| Multi-SKU combo `Booster-gel-001` + no-SKU eBay line | eBay line dropped; combo shows only the SKU | combo shows **Booster Gel** `sku: Booster-gel-001` **and** **Samyang Buldak Variety Pack** `no SKU` |
| No sku / no title / no id | `UNKNOWN SKU` (looks pickable) | `UNRESOLVED EBAY ITEM — review order details` (flagged unsafe) |

Per DJ's header design, each item is its own outlined card: product name top-left,
qty right-aligned (`x1`), `sku:` line below — no-SKU lines substitute the safe
no-SKU/UNRESOLVED note for the `sku:` value.

---

## Commands run — pass/fail

| Command | Result |
|---|---|
| `npm run typecheck` (backend + web) | ✅ PASS |
| `npm run build:web` (vite) | ✅ PASS (~12 s) |
| `npx tsx scripts/ps-070-ebay-nosku-identity-guard.ts` (34 assertions) | ✅ PASS |
| `npx tsx scripts/ps-070-batch-pdf-cert.ts` (PDF, 3 cases) | ✅ PASS |
| `node scripts/print-queue-persistence-guard.mjs` | ✅ PASS (no regression) |
| `node scripts/print-queue-durable-guard.mjs` | ✅ PASS |
| `node scripts/print-queue-invalid-label-guard.mjs` | ✅ PASS (9/9) |

## Browser/manual certification

Automated PDF certification (`ps-070-batch-pdf-cert.ts`) stands in for the manual
browser path: it renders the real batch-header renderer with no-SKU / combo /
unresolved fixtures (fake picker names only) and decodes the emitted PDF to
confirm the title appears and `UNKNOWN SKU` does not. No DB, network, postage,
labels, or marketplace calls are involved.

---

## Remaining / follow-ups

- **eBay item/variation-id + internal SKU alias mapping** — canonical
  `order_items` stores only `sku` + `name`, so tiers 2/4 (id-based identity) and
  an internal alias table are wired to *use* ids when present on the raw line but
  there is no persisted id/alias source yet. Adding an
  `ebay_item_alias (itemId|variationId|titleFingerprint → internal SKU)` table +
  a small mapping UI would let operators promote a recurring no-SKU eBay product
  to a canonical SKU. The identity resolver already has the plug-in point
  (`firstStableId` + the `EBAY_ID:` tokens).
- **Marketplace prefix** — the ticket's `eBay: <title>` example is shown as a
  plain title here (the line has no reliable marketplace field); threading the
  order's marketplace through would let the card prefix `eBay:` safely.

---

## Safety confirmation

- **No real labels, postage, or marketplace notifications** — all new code is
  pure logic + an in-memory PDF render; guards/cert never touch the network, DB,
  or label/postage providers.
- **No shipped/cancelled mutation** — Print Queue operates on awaiting orders;
  no `orders` (shipped/cancelled) or `shipments` rows or schema were changed. The
  PS-073 recipient-name override path was not touched.
- **No PII / secrets** — fixtures use fake picker names; the recipient surface
  (`BatchRecipient = { name, orderNumber }`) is unchanged; no addresses, emails,
  phones, tracking, label URLs, payloads, or tokens are exposed.
- **RBAC / scope unchanged** — no auth, client/store scope, ownership, or label
  URL validation was modified; this is display/grouping only.
- **Type-safe** — backend + web `typecheck` pass; `build:web` succeeds.
