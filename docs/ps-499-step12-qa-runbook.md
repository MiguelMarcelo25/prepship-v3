# PS-499 Step 12 — runtime / UI QA runbook

Manual pass against the real Billing bulk-import UI. Every check is a *payload or
persistence* assertion, not a visual impression. The point is to prove the browser
sends sparse payloads and the server applies exactly those authorities.

**A screenshot is never sufficient on its own.** Each scenario needs the request
body, the response, and the post-refresh state. Where the critical state is not
visible in the UI — a cleared price pin, an absent sidecar — a database query is
required.

**Scope guard.** Disposable database only. No production backfill, no billing
regeneration, no carrier request, no invoice mutation, no void, no refund.

---

## 0. Setup — dedicated disposable database

Preferred, because teardown is dropping the database rather than deleting rows the
application deliberately protects:

```bash
createdb prepship_ps499_qa
DATABASE_URL=postgres://…/prepship_ps499_qa npm run migrate
NODE_ENV=test DATABASE_URL=postgres://…/prepship_ps499_qa \
  npm run seed:ps-499-step12 -- --apply --confirm=PS499-STEP12-DISPOSABLE
NODE_ENV=test DATABASE_URL=postgres://…/prepship_ps499_qa npm run dev
```

`--apply` refuses unless **all** of: `NODE_ENV=test`, loopback host, a database name
carrying a disposable marker, the confirmation token, and no existing fixture for
the same run id. There is no `--force`.

The seeder prints a **run id**. Record it — every order number is
`PS499-QA-<runId>-<n>` and the evidence bundle is keyed on it.

Fixed arithmetic to check the UI against:

| Fact | Value |
|---|---|
| `package_cost_markup` | 10% |
| BOX A configured / billed | 5.00 → **5.50** |
| BOX B configured / billed | 8.00 → **8.80** |
| BOX C | no configured price → must **422** |

Baseline on every fixture order: pick&pack `3.50`, additional `0.75`, box `5.50`,
shipping `12.00`. All non-zero and non-default, so an accidental resend or a
silent conversion to zero is visible.

### Teardown

```bash
NODE_ENV=test … npm run seed:ps-499-step12 -- --teardown --run=<runId>   # row-level
dropdb prepship_ps499_qa                                                  # preferred
```

Row-level teardown will report the finalized order as **retained** — the production
trigger refuses to delete finalized billing, which is correct. Do not un-invoice it
or weaken the trigger to clean up; drop the database instead.

---

## Evidence header — record once per run

| Field | Value |
|---|---|
| Commit SHA served by API | |
| Commit SHA served by frontend | |
| Database name | |
| Fixture run id | |
| Tester | |
| Date / time | |

---

## Per-scenario evidence template

Copy this for each of the ten scenarios. "Looked unchanged" is not an assertion.

```
Scenario:            
Order:               PS499-QA-<runId>-<n>
BEFORE  (UI + DB):   pick&pack ____  additional ____  box ____  shipping ____
REQUEST  body:       <paste exact JSON from Network tab / HAR>
  own-properties present:  
  properties ABSENT:       
RESPONSE:            status ____  body ____
UI result:           
AFTER REFRESH (UI):  pick&pack ____  additional ____  box ____  shipping ____
DB verification:     <query output where required below>
```

---

## 1 · A — shipping-only, positive

Order `-1`. Paste: order number, **blank box**, shipping `20.83`.

- [ ] Request contains exactly `source: "bulk_import"`, `clientId`, `shipping`, `reason` (plus `orderDescription` only if a description column was supplied)
- [ ] Request does **not** contain `pickPack`, `additional`, `packageCost`, `packageId`
- [ ] Response `200`
- [ ] After refresh: shipping `20.83`; pick&pack `3.50`, additional `0.75`, box `5.50` unchanged
- [ ] **Screenshot** (this is the required "successful sparse import" shot)

## 2 · B — shipping-only, explicit $0

Order `-2`. Shipping `0`.

- [ ] Request has an own property `shipping: 0` — not dropped as falsy
- [ ] Response `200`
- [ ] After refresh: shipping `$0.00`
- [ ] **DB:** no prep waiver was created

```sql
SELECT * FROM billing_fee_waivers WHERE order_id = <id>;          -- expect 0 rows
SELECT * FROM billing_manual_overrides
 WHERE order_id = <id> AND line_type IN ('pick_pack','additional_unit');  -- expect 0 rows
```

## 3 · C — box-only, different box

Order `-3`. Box `BOX B`, blank shipping.

- [ ] Request contains `packageId`; does **not** contain `packageCost` or `shipping`
- [ ] After refresh: box cost `8.80` — the backend markup, not the raw `8.00`
- [ ] After refresh: shipping still `12.00`, prep unchanged
- [ ] **DB:** box resolution written with no pinned price

```sql
SELECT package_id, override_price FROM billing_box_resolutions WHERE order_id = <id>;
-- expect the BOX B id and override_price IS NULL
```

## 4 · D — box-only, the SAME box already stamped

Order `-4`, seeded with a stale pinned price of `99.00` and a leftover
`package_cost_missing` review line. Paste **BOX A** — the box already on the order.

- [ ] The import is accepted (a pasted box is intent even when it matches)
- [ ] After refresh: box cost `5.50` — the stale `99.00` is gone
- [ ] The "no box cost / needs review" indicator is gone
- [ ] Prep and shipping unchanged
- [ ] **DB:** all four facts

```sql
SELECT total_cost FROM billing_line_items
 WHERE order_id = <id> AND line_type = 'package_cost';              -- expect 5.50
SELECT count(*) FROM billing_line_items
 WHERE order_id = <id> AND line_type = 'package_cost_missing';      -- expect 0
SELECT package_id, override_price FROM billing_box_resolutions
 WHERE order_id = <id>;                                             -- BOX A, NULL
SELECT * FROM billing_manual_overrides WHERE order_id = <id>;       -- expect 0 rows
```

> This is the blocker-2 regression. Before the fix the box-resolution block was
> skipped entirely here, leaving the stale pin and the review line in place.

## 5 · E — combined box + shipping

Order `-5`. Box `BOX B` **and** shipping `20.83`.

- [ ] Request contains exactly `packageId` and `shipping` (plus source/clientId/reason)
- [ ] After refresh: box `8.80`, shipping `20.83`, prep unchanged
- [ ] **DB:** exactly one manual override, for shipping; `override_price IS NULL`

## 6 · F1 — blank SHIPPING must omit

Order `-6`. Box `BOX B`, **shipping cell left blank**.

- [ ] Request has **no** `shipping` own-property
- [ ] After refresh: shipping is still `12.00` — it did **not** become `0.00`
- [ ] Box became `8.80`

## 7 · F2 — blank BOX must omit

Order `-7`. Shipping `15.00`, **box cell left blank**.

- [ ] Request has **no** `packageId` own-property
- [ ] After refresh: the box is still BOX A at `5.50` — the current box was not resent
- [ ] Shipping became `15.00`

> These are separate orders deliberately. One row with both cells blank proves
> neither omission.

## 8 · G — unpriced box, visible failure and unchanged durable state

Order `-8`. Box `BOX C` (unpriced). **Record the BEFORE state first.**

- [ ] Request contains `packageId` = BOX C
- [ ] Response `422`, error `BULK_IMPORT_PACKAGE_PRICE_UNRESOLVED`
- [ ] The failure is visible in the UI — the row is not silently skipped
- [ ] The row remains editable / unapplied and keeps its typed values for retry
- [ ] Editing that failed row clears any stale status indicator (no lingering "Saved")
- [ ] After refresh: every value identical to BEFORE
- [ ] **DB:** nothing was committed by the failed attempt

```sql
SELECT line_type, total_cost FROM billing_line_items WHERE order_id = <id> ORDER BY line_type;
SELECT * FROM billing_box_resolutions WHERE order_id = <id>;   -- expect 0 rows
SELECT * FROM billing_manual_overrides WHERE order_id = <id>;  -- expect 0 rows
SELECT count(*) FROM audit_log
 WHERE resource_id = <id> AND action = 'invoice_line_edit';    -- expect 0
```

- [ ] **Screenshot** (this is the required "visible 422" shot)

> A 422 toast alone is not proof. A route could in principle return 422 after a
> partial commit; these queries are what rule that out at the UI layer.

## 9 · H — manual modal regression

Order `-9`, via *Edit Billing Detail* (not bulk import).

- [ ] Request contains `source: "manual_edit"`
- [ ] It still sends the full explicit set: `pickPack`, `additional`, `packageCost`, `shipping`, `packageId`, `reason`
- [ ] The save persists after refresh
- [ ] Bulk restrictions do **not** leak in — the modal is not rejected for sending generated money fields
- [ ] Deliberate manual `$0` package cost is still durable: set box cost to `0`, save, refresh, confirm it reads `$0.00` and the row does **not** revert to "needs review"

```sql
SELECT override_price FROM billing_box_resolutions WHERE order_id = <id>;
-- a MANUAL $0 is an explicit decision: expect override_price = 0.00, not NULL
```

## 10 · I — finalized lockdown

Order `-10`, seeded invoiced. Run all three bulk modes against it.

- [ ] Shipping-only → `409`, body `{"error":"Billing for order <id> is finalized and cannot be modified."}`
- [ ] Box-only → same `409`
- [ ] Combined → same `409`
- [ ] After refresh: nothing changed in any of the three
- [ ] **DB:** no line, sidecar or audit row from any of the three attempts
- [ ] **Screenshot** (this is the required "finalized-lock" shot)

---

## Evidence bundle to attach

1. The evidence header above, filled in
2. A completed per-scenario template for all ten scenarios, each with the exact request body (HAR entry or copied JSON — not a collapsed DevTools screenshot), response status/body, and post-refresh values
3. Query output for every **DB** block above; negative assertions must show the query and its empty result, not the words "none found"
4. The three screenshots: successful sparse import, visible 422, finalized lock
5. Explicit confirmation: no production data, no regeneration, no carrier call, no invoice mutation
6. The exact commit SHA the QA ran against, matching the header
