# Shipped View — Column-by-Column Data Trace

Companion to `ORDERS_VIEW_COLUMN_TRACE.md`. Same table component renders both
views (`web/src/components/Views/OrdersView.tsx`), but the column visibility
differs based on `currentStatus`:

| Status | Hidden column | Visible column (newly relevant) |
|---|---|---|
| `awaiting_shipment` | **tracking** (no label yet) | **age** (how stale is this awaiting order?) |
| `shipped` | **age** (it's shipped, age is moot) | **tracking** (the tracking number for the label) |

This is enforced in `web/src/components/Views/orders-parity.ts:115-117`:

```typescript
if (currentStatus === 'awaiting_shipment') hiddenColumns.add('tracking')
else hiddenColumns.add('age')
```

Everything else in the column registry is identical. But the **meaning** of
several columns shifts once an order is shipped — the data is the same, the
interpretation is different.

---

## Summary — Shipped view columns (17 visible, in default order)

| # | Column | Same as Awaiting? | Changed meaning? |
|---|---|---|---|
| 1 | select | ✓ | — |
| 2 | Order Date | ✓ | — (still order creation date from SS) |
| 3 | Client | ✓ | — |
| 4 | Order # | ✓ | — |
| 5 | Recipient | ✓ | — |
| 6 | Item Name | ✓ | — |
| 7 | SKU | ✓ | — |
| 8 | Qty | ✓ | — |
| 9 | Weight | ✓ | Now reflects the actual shipped weight (label used this value) |
| 10 | Ship To | ✓ | — |
| 11 | **Carrier** | ✓ data source | **Now authoritative** — the actual carrier that shipped it |
| 12 | **Shipping Account** | ✓ data source | **Now authoritative** — the account actually billed |
| 13 | Order Total | ✓ | — |
| 14 | **Best Rate** | ✓ data source | **Now historical** — the rate that was selected at label time |
| 15 | **Ship Margin** | ✓ formula | **Now realized** — actual profit/loss on this shipment |
| 16 | **Tracking #** | **NEW in Shipped** | First time this column appears |
| 17 | **Label Created** | ✓ data source | **Now the primary time-reference** (replaces Age) |

---

## The columns that change meaning in Shipped

### 11. Carrier — *now authoritative*

- **In Awaiting:** shows the **intended** carrier (from bestRate/selectedRate/orders.carrier_code — may still change)
- **In Shipped:** shows the **actual** carrier from `shipments.carrier_code` (the label has been created — this is locked in)
- **Fallback chain** (`OrdersView.tsx:480`) — same code, but the first rung (`order.label?.carrierCode`) always wins now:

```
shipments.carrier_code  ← winner in Shipped view (always populated)
order_overrides.selected_rate_json.carrier_code
order_overrides.best_rate_json.carrier_code
orders.carrier_code
```

- **Why it matters:** in Awaiting, the Carrier cell is a "prediction" that can change if the user re-rates. In Shipped, it's a **fact** — the package is on a truck with that carrier.

### 12. Shipping Account — *now authoritative*

- **In Awaiting:** shows the account **selected** to charge (if user picked a rate)
- **In Shipped:** shows the account **actually charged** — from `shipments.provider_account_id`
- The V2 enrichment pass (`GET /v2/shipments` → `carrier_id`) backfills `provider_account_id` on every sync, so even if label was created offline or by a webhook, this cell eventually populates
- **Renderer:** `OrdersView.tsx:2074` → `renderShippingAccountCell(order)` at L498-506

### 14. Best Rate — *now historical*

- **In Awaiting:** current cheapest quote from `POST /v2/rates/estimate` (auto-refreshed every 10 min by rate backfill)
- **In Shipped:** the rate that **was** cheapest at label time — `order_overrides.best_rate_json` (snapshotted when label was created)
- **Important quirk:** rate backfill DOESN'T run on shipped orders. So this cell shows the stored snapshot indefinitely — stable reference for Ship Margin calculation
- **If you want the current best rate for a shipped order** (to compare against new market rates), you'd need to trigger a manual rate fetch — but that overwrites the snapshot

### 15. Ship Margin — *now realized*

- **In Awaiting:** projected margin = `order.orderTotal - currentBestRate.total`
- **In Shipped:** **realized margin** using the snapshotted best rate
- Still computed at render time (never stored) — renderer at `OrdersView.tsx:2081` → `renderMargin(order)`
- **Key caveat:** this uses `best_rate_json` NOT the actual `shipments.cost`. If the user picked a more expensive rate than "best", the realized margin shown here is WRONG (too optimistic)
  - To see true realized margin: `order.orderTotal - shipments.cost` (shipment_cost comes from the `POST /v2/labels` response)
  - Consider this a "potential margin" indicator, not the final P&L number

### 17. Label Created — *now the primary time-reference*

- **In Awaiting:** column is shown but empty (no label yet)
- **In Shipped:** the time-ago indicator that replaces Age
- **Source:** `shipments.label_created_at` (v4's clock at the time `POST /v2/labels` succeeded)
- **Display format (`formatLabelCreated()` helper):**
  - `<1 hr`: "Xm ago"
  - `<24 hr`: "Xh ago"
  - `<7 days`: "Xd ago"
  - `>7 days`: absolute date ("4/17 2:30 PM")

---

## The new column in Shipped

### 16. Tracking # — *hidden in Awaiting, visible in Shipped*

- **Source:** `POST /v2/labels` response → `tracking_number`
- **DB column:** `shipments.tracking_number` (text), also duplicated to `shipments.label_tracking`
- **Frontend:** `OrdersView.tsx:2083` — `case 'tracking'`
- **Rendering:**
  - Number rendered as blue underlined link (monospace)
  - Click → opens `TrackingModal` with real-time status (calls ShipStation via `GET /v2/tracking/...` or direct carrier API)
  - Copy icon next to the number — one-click copy to clipboard
  - Empty (em dash) if label was voided or never created — but in the Shipped view, the order status should only be `shipped` if a label exists
- **Population:**
  - **Primary path:** when v4 creates a label via `POST /v2/labels`, the response's `tracking_number` field gets written in `persistCreatedLabel()` at `src/services/labels.ts:763+`
  - **Secondary path:** shipment-sync discovers a shipment created outside v4 (by ShipStation UI or a webhook), pulls tracking from `GET /shipments`, stores it
  - **Return labels:** `POST /v2/shipments/:id/returnlabel` response → separate `shipments` row with `is_return=true`

---

## The column that's hidden in Shipped

### Age — *hidden in Shipped by design*

- Reason: once an order ships, "how old is this awaiting order?" stops being a useful question
- "Label Created" takes over as the primary time reference — more actionable (e.g., "did the package get picked up?" "is it overdue?")
- If you need to see age on a shipped order, unhide it via the Columns picker in the UI (it still works, just hidden by default)

---

## What triggers each Shipped-view cell to update

| Column | Updates when |
|---|---|
| Order Date | Order is re-synced (rare for shipped orders) |
| Client | Never (once set, stable) |
| Recipient | Order is re-synced |
| Item Name / SKU / Qty | Order is re-synced |
| Weight | Order is re-synced (rare post-label) OR user edits manually |
| Ship To | Order is re-synced |
| Carrier | Label created, voided, or shipment-sync re-syncs the row |
| Shipping Account | Label created, OR V2 enrichment pass fills `provider_account_id` |
| Order Total | Order is re-synced |
| Best Rate | Snapshot — does NOT auto-update for shipped orders (by design) |
| Ship Margin | Auto (recomputes on render from orderTotal + bestRate snapshot) |
| Tracking # | Label created, OR shipment-sync finds it from SS |
| Label Created | Label created (never changes) |

---

## Lineage for Shipped-specific fields

```
ShipStation                        v4 Postgres                        Frontend
-----------                        ----------                          --------
POST /v2/labels  ───────►  shipments.tracking_number         ──►  cell 16 (Tracking #)
                           shipments.carrier_code             ──►  cell 11 (Carrier, authoritative)
                           shipments.provider_account_id      ──►  cell 12 (Shipping Account, authoritative)
                           shipments.label_created_at         ──►  cell 17 (Label Created)
                           shipments.cost                     ──►  (not displayed — drives Ship Margin if you use actual cost)

POST /v2/rates/  ───────►  order_overrides.best_rate_json     ──►  cell 14 (Best Rate, snapshot) + cell 15 (Ship Margin)
estimate
(captured at label-creation time — never re-fetched for shipped orders)

GET /shipments   ───────►  shipments.* (fallback for rows v4 didn't create) ──►  cells 11, 12, 16, 17
(V1 sync pass)

GET /v2/shipments ──────►  shipments.provider_account_id (enrichment) ──►  cell 12 refresh
(V2 enrichment)
```

---

## Where to look in code when debugging a Shipped-view cell

Same table as Awaiting (all in `OrdersView.tsx`) — but the relevant writer files differ because the label-creation path becomes the primary data source:

| Cell | Primary writer | Frontend reader |
|---|---|---|
| Tracking # | `src/services/labels.ts:persistCreatedLabel` | `OrdersView.tsx:2083` |
| Carrier (authoritative) | `src/services/labels.ts:persistCreatedLabel` + `src/services/shipment-sync.ts` | `OrdersView.tsx:2072` → `renderCarrierCell()` L476-481 |
| Shipping Account (authoritative) | `src/services/labels.ts:persistCreatedLabel` + `src/services/shipment-sync.ts:enrichProviderAccountIds` | `OrdersView.tsx:2074` → `renderShippingAccountCell()` L498-506 |
| Label Created | `src/services/labels.ts:persistCreatedLabel` (line ~720+) | `OrdersView.tsx:2114` → `formatLabelCreated()` |
| Best Rate (snapshot) | Written by `POST /orders/:id/best-rate` (commit `82d862f` Round 1 alias) into `order_overrides.best_rate_json` | `OrdersView.tsx:2079` → `renderBestRatePrice()` L489-494 |
| Ship Margin (derived) | Formula only — no writer | `OrdersView.tsx:2081` → `renderMargin()` |

---

## Common Shipped-view debugging scenarios

### "The Tracking # column is empty for a shipped order"

- **Most likely:** the order was shipped externally (e.g. user hit "Mark as shipped externally"), so there's no `shipments.tracking_number` because there's no label
- **Check:** `SELECT tracking_number, label_shipment_id, source FROM shipments WHERE order_id = X` — if `source='prepship_v2_external'` or `source IS NULL`, external flow
- **Less likely:** shipment-sync hasn't run since the label was created elsewhere. Click sync button + refresh.

### "Carrier shows 'ups' but the label was FedEx"

- **Check the fallback chain order:**
  1. `SELECT carrier_code FROM shipments WHERE order_id = X AND voided = false` — should be FedEx
  2. If shipments row has correct carrier, the cell will render it
  3. If the cell still shows UPS, it's probably reading from `order_overrides.best_rate_json` OR `orders.carrier_code` (fallbacks)
  4. Likely cause: label failed, was voided, and the fallback to `order_overrides` kicked in — clear the override or create a new label

### "Ship Margin shows $8 but I actually paid $12 for the label"

- Expected — Ship Margin uses the SNAPSHOT of `best_rate_json` (what was cheapest when label was created), NOT `shipments.cost` (what was actually billed)
- If the user chose a pricier rate than the best (e.g. they chose expedited or a specific carrier), Margin shows optimistic projected margin not realized
- **True realized margin:** `order.orderTotal - shipments.cost` — requires a custom query or a code change to switch the Margin column to read from `shipments.cost` for shipped orders

### "Label Created shows '4h ago' but I created it yesterday"

- `shipments.label_created_at` is v4's clock at the POST /v2/labels success moment. It never changes
- Are you looking at a RETURN label? Return labels have a separate `shipments` row with its own `label_created_at`. The original label row might say "yesterday" while the return says "4h ago"
- Check: `SELECT label_created_at, is_return FROM shipments WHERE order_id = X ORDER BY id DESC`

---

## Cross-reference

- For AWAITING-view column semantics: see `parity/ORDERS_VIEW_COLUMN_TRACE.md`
- For the underlying ShipStation endpoints: see `parity/SHIPSTATION_API_DEEP_DIVE.md`
- For the column registry itself (which columns exist, their widths/labels): see `web/src/components/Views/orders-parity.ts:4-22`
