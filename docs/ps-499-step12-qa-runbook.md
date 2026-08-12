# PS-499 Step 12 — runtime / UI QA runbook

Manual pass against the real Billing bulk-import UI. Every check below is a
*persistence or payload* assertion, not a visual impression: the point is to prove
the browser sends sparse payloads and the server applies exactly those authorities.

**Scope guard.** Local, non-production, disposable fixture only. No production
backfill, no billing regeneration, no carrier request, no invoice mutation, no void,
no refund.

---

## 0. Setup

```bash
npx tsx scripts/ps-499-step12-qa-fixture.ts            # plan, read-only
npx tsx scripts/ps-499-step12-qa-fixture.ts --apply    # write the fixture
npm run dev                                            # api + web
```

The fixture refuses any non-loopback `DATABASE_URL`. It seeds one disposable client,
`PS-499 QA (disposable)`, with nine orders — one per scenario, so a mistake in one
case cannot contaminate another.

Fixed arithmetic to check the UI against:

| Fact | Value |
|---|---|
| `package_cost_markup` | 10% |
| BOX A configured / billed | 5.00 → **5.50** |
| BOX B configured / billed | 8.00 → **8.80** |
| BOX C | no configured price → must **422** |

Baseline on every fixture order: pick&pack `3.50`, additional `0.75`, box `5.50`,
shipping `12.00`.

**Capture for every case:** the request body from the Network tab, the response
status and body, and the Billing values *after a page refresh* (not just the
optimistic UI). Screenshots required for success, 422, and finalized-lock.

---

## 1. A — shipping-only, positive

Paste into bulk import on **PS499-QA-1**: order number, blank box, shipping `20.83`.

- [ ] Request body contains exactly: `source: "bulk_import"`, `clientId`, `shipping`, `reason` (plus `orderDescription` only if a description column was supplied)
- [ ] Request body does **not** contain `pickPack`, `additional`, `packageCost`, `packageId`
- [ ] Response `200`
- [ ] After refresh: shipping `20.83`
- [ ] After refresh: pick&pack `3.50`, additional `0.75`, box `5.50` — all unchanged

## 2. B — shipping-only, explicit $0

**PS499-QA-2**, shipping `0`.

- [ ] Request body has an own property `shipping: 0` (it is not dropped as falsy)
- [ ] Response `200`, UI reports success
- [ ] After refresh: shipping `$0.00`
- [ ] No prep-fee waiver appears; pick&pack still `3.50`

## 3. C — box-only, different box

**PS499-QA-3**, box `PS499-QA BOX B 12x10x3`, blank shipping.

- [ ] Request body contains `packageId`; does **not** contain `packageCost` or `shipping`
- [ ] After refresh: box cost `8.80` — the backend markup, not the raw `8.00`
- [ ] After refresh: shipping still `12.00`, prep lines unchanged

## 4. D — box-only, the SAME box already stamped

**PS499-QA-4** is seeded with a stale pinned price of `99.00` and a leftover
"no box cost" review line. Paste **BOX A** — the box already on the order.

- [ ] The import is accepted (a pasted box is intent even when it matches)
- [ ] After refresh: box cost `5.50` — the stale `99.00` pin is gone
- [ ] The "no box cost / needs review" indicator is gone
- [ ] Prep and shipping unchanged

> This is the blocker-2 regression. Before the fix the whole box-resolution block
> was skipped here, leaving the stale pin and the review line in place.

## 5. E — combined box + shipping

**PS499-QA-5**, box BOX B *and* shipping `20.83`.

- [ ] Request body contains exactly `packageId` and `shipping` (plus source/clientId/reason)
- [ ] After refresh: box `8.80`, shipping `20.83`
- [ ] Prep lines unchanged

## 6. F — blank cells must omit, not resend

**PS499-QA-6**. Two separate imports:

- [ ] Blank box + shipping `15.00` → request has **no** `packageId`; after refresh the box is still BOX A at `5.50` (the current box was not resent)
- [ ] Box BOX B + blank shipping → request has **no** `shipping`; after refresh shipping is still `12.00` and did **not** become `0.00`

## 7. G — unpriced box, visible failure

**PS499-QA-7**, box `PS499-QA BOX C 8x8x8 (unpriced)`.

- [ ] Response `422`, error `BULK_IMPORT_PACKAGE_PRICE_UNRESOLVED`
- [ ] The failure is visible in the UI — the row is not silently skipped
- [ ] The row remains editable / unapplied, and keeps its typed values for retry
- [ ] After refresh: nothing on the order changed
- [ ] Editing that failed row clears any stale status indicator (no lingering "Saved")
- [ ] **Screenshot required**

## 8. H — manual modal regression

**PS499-QA-8**, via *Edit Billing Detail* (not bulk import).

- [ ] Request body contains `source: "manual_edit"`
- [ ] It still sends the full explicit set: `pickPack`, `additional`, `packageCost`, `shipping`, `packageId`, `reason`
- [ ] The save applies and persists after refresh
- [ ] Bulk restrictions do **not** leak in: the modal is not rejected for sending generated money fields

## 9. I — finalized lockdown

**PS499-QA-9** is seeded invoiced. Run all three bulk modes against it.

- [ ] Shipping-only → `409`, body `{"error":"Billing for order <id> is finalized and cannot be modified."}`
- [ ] Box-only → same `409`
- [ ] Combined → same `409`
- [ ] After refresh: nothing on the order changed in any of the three
- [ ] **Screenshot required**

---

## 10. Teardown

```bash
npx tsx scripts/ps-499-step12-qa-fixture.ts --teardown
```

The finalized order (PS499-QA-9) will be reported as left in place. That is correct:
finalized billing is immutable by design and the production trigger refuses to delete
it. Drop the local database if a clean slate is needed. Audit rows are append-only
and are deliberately not removed.

---

## Evidence bundle to attach

1. Request body + response status/body for each of the 9 scenarios
2. Post-refresh Billing values for each
3. Screenshots: one success, the 422, the finalized-lock
4. Explicit confirmation: no production data, no regeneration, no carrier call, no
   invoice mutation
5. The exact commit SHA the QA ran against
