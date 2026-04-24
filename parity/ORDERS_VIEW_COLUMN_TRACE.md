# Orders View — Column-by-Column Data Trace

For each column in the Awaiting Shipment / Shipped table, exactly where the
data comes from (ShipStation endpoint or v4-derived), which DB column stores
it, and which frontend code renders it.

All frontend renderer line numbers reference `web/src/components/Views/OrdersView.tsx`.
All column-dispatch lines live around `L2068-2123` in a single `switch` block
inside the row-rendering function.

---

## Summary — columns grouped by fetch origin

| Origin | Columns |
|---|---|
| **Pulled fresh on every order sync** (`GET /orders`) | Order Date, Recipient, Item Name, SKU, Qty, Weight, Ship To, Order Total, initial Carrier |
| **Populated when label is created** (`POST /v2/labels`) | Tracking #, Label Created, final Carrier, Shipping Account |
| **Populated by rate-estimate** (`POST /v2/rates/estimate`) | Best Rate |
| **Pure client-side derivation** (computed at render, never stored) | Ship Margin, Age |
| **Resolved via v4 business logic** (no direct ShipStation field) | Client |

---

## 1. Order Date

- **Source:** `GET /orders` → `orders[].orderDate` (ISO 8601 string, UTC)
- **DB column:** `orders.order_date` (timestamptz)
- **Frontend:** `OrdersView.tsx:1971` — `case 'date'` reads `order.orderDate`, formats via the `formatDate()` helper
- **Notes:**
  - Falls back to `order.orderDate ?? ''` if ShipStation's `/orders` omits it (rare)
  - Display format: `MM/DD/YY h:mm AM/PM`, timezone converted from UTC to browser local
  - Sort comparator at `OrdersView.tsx:561` uses the raw timestamptz value

## 2. Client

- **Source:** **v4-derived**. ShipStation doesn't have a "client" concept — v4 resolves `orders.store_id` → `clients.storeIds[]` membership
- **DB column:** `orders.client_id` (int FK → `clients.id`), join resolves to `clients.name`
- **Frontend:** `OrdersView.tsx:1978` — `case 'client'` reads `order.clientName`, truncated to 14 chars, colored via `getClientPalette()`
- **Notes:**
  - `order.clientName` hydrated by the `useOrders` hook from the `/clients` endpoint
  - Unassigned orders (orphan `storeId`) display as "Untagged"
  - If an order's `client_id` is in `clients.is_test=true`, it's filtered out of the listing entirely (see `src/routes/orders.ts:79`)

## 3. Recipient

- **Source:** `GET /orders` → `orders[].shipTo.name`
- **DB column:** `orders.ship_to_name` (text)
- **Frontend:** `OrdersView.tsx:1989` — `case 'customer'` renders `order.shipToName`
- **Notes:**
  - If `shipTo.name` is missing, v4's sync falls back to `null` — the cell shows em dash
  - Full ship-to object (company, street1/2, phone) preserved in `orders.raw` JSONB for forensics

## 4. Item Name

- **Source:** `GET /orders` → `orders[].items[].name` (array)
- **DB column:** `orders.items` (JSONB array — full verbatim payload)
- **Frontend:** `OrdersView.tsx:1991` — `case 'itemname'` iterates `getActiveItems(order, detail).map(item => item.name)`, renders each name as a row with thumbnail
- **Notes:**
  - Multi-item orders show all names stacked vertically
  - `getActiveItems()` filters out line items flagged as `adjustment` / `coupon` / `insurance` etc.
  - Thumbnail from `items[].imageUrl` when present
  - Sort comparator concatenates first item's name to lowercase

## 5. SKU

- **Source:** `GET /orders` → `orders[].items[].sku`
- **DB column:** Same `orders.items` JSONB as Item Name
- **Frontend:** `OrdersView.tsx:2040` — `case 'sku'` maps `items.map(i => i.sku)`, renders each
- **Notes:**
  - Rendered as clickable link per SKU — opens the inventory drawer filtered to that SKU
  - Multi-SKU orders show all SKUs in a vertical list (same row-split as Item Name)
  - If a SKU has stock-level concerns (below reorder), shows a colored dot indicator

## 6. Qty

- **Source:** `GET /orders` → sum of `orders[].items[].quantity` (or `items[].Quantity` — both case variants seen in SS responses)
- **DB column:** Not stored separately — computed from `orders.items` JSONB at render time
- **Frontend:** `OrdersView.tsx:2056` — `case 'qty'` uses a helper that sums all quantities across active items; if multi-item, shows badge-style highlighted count
- **Notes:**
  - When an order has multiple SKUs, the cell shows the **total combined quantity** (e.g. 2 SKUs × 3 qty each = 6)
  - The badge/highlight style is applied when total qty > 1 to draw attention to multi-unit orders

## 7. Weight

- **Source:** `GET /orders` → `orders[].weight: { value, units }` (units ∈ `ounces | pounds | grams`)
- **DB column:** `orders.weight_oz` (real, after unit conversion to ounces at sync time)
- **Frontend:** `OrdersView.tsx:2068` — `case 'weight'` reads `order.weight?.value` and passes through `formatWeight()` (displays as "X lb Y oz")
- **Notes:**
  - Conversion at sync: `pounds × 16`, `grams / 28.3495`, `ounces` passthrough (see `src/services/order-sync.ts:64-71`)
  - When ShipStation's weight is 0 or missing, the cell shows em dash — and `hasRateableDims()` flags the order as un-rateable until dims/weight are filled manually

## 8. Ship To

- **Source:** `GET /orders` → `orders[].shipTo.{city, state, postalCode}`
- **DB columns:** `orders.ship_to_city`, `orders.ship_to_state`, `orders.ship_to_postal_code` (all text)
- **Frontend:** `OrdersView.tsx:2070` — `case 'shipto'` calls `getShipToLine(order, detail)` which concatenates `"CITY, ST ZIP"`
- **Notes:**
  - Country code not displayed (assumed US); falls back to `shipTo.country` in `orders.raw` if non-US
  - Street1/street2 are in `orders.raw.shipTo.*` but not displayed in the list view — shown in the side drawer when row is clicked
  - `residential` flag also stored in `orders.raw.shipTo.residential` — affects rate shopping but not this cell

## 9. Carrier

- **Source priority (v4 falls through in order):**
  1. `shipments.carrier_code` (from `POST /v2/labels` response, once label is created)
  2. `order_overrides.selected_rate_json.carrier_code` (from user clicking a rate in Rate Browser)
  3. `order_overrides.best_rate_json.carrier_code` (from auto-rate-fetch)
  4. `orders.carrier_code` (initial ShipStation order's requested carrier)
- **DB columns:** `shipments.carrier_code`, `shipments.label_carrier`, `orders.carrier_code`
- **Frontend:** `OrdersView.tsx:2072` — `case 'carrier'` calls `renderCarrierCell(order)` which chains the 4 fallbacks above (`L480`), applies carrier-specific CSS class (`L324` `getCarrierClass()`)
- **Notes:**
  - Carrier pill coloring: UPS = orange, FedEx = purple, USPS/stamps = blue, others = gray
  - `order.bestRate?.carrierNickname` shown in place of raw code when available (e.g. "ORION" instead of "ups")
  - Once label is created, the cell shows the **actual carrier that shipped it**, which may differ from the `orders.carrier_code` ShipStation originally requested

## 10. Shipping Account

- **Source:** `POST /v2/labels` response → `carrier_id` (stripped of `se-` prefix) → `providerAccountId`, OR backfilled by V2 enrichment pass (`GET /v2/shipments`)
- **DB columns:** `shipments.provider_account_id` (int), `shipments.provider_account_nickname` (text, when set)
- **Frontend:** `OrdersView.tsx:2074` — `case 'custcarrier'` calls `renderShippingAccountCell(order)` which reads `order.bestRate?.carrierNickname` or resolves via `shippingProviderId` against the cached `/rates/carriers` response
- **Notes:**
  - Before label creation: shows the **selected rate's carrier account** (which account the user is about to charge)
  - After label creation: shows the **actual account the label was billed to**
  - Account nicknames come from `GET /v2/carriers` → `carriers[].nickname` (e.g. "USPS Chase x7439", "ORION", "FedEx One Balance")

## 11. Order Total

- **Source:** `GET /orders` → `orders[].orderTotal`
- **DB column:** `orders.order_total` (numeric, stringified)
- **Frontend:** `OrdersView.tsx:2077` — `case 'total'` renders `formatMoney(order.orderTotal ?? 0)` in bold
- **Notes:**
  - This is the **customer's order total** (what the customer paid for product + shipping + tax)
  - Does NOT include v4's rate markup — that's computed separately for Best Rate / Ship Margin
  - Formatter: `formatMoney()` outputs `$X.XX` with thousands separators

## 12. Best Rate

- **Source:** `POST /v2/rates/estimate` (one call per carrier in parallel), cheapest rate across all carriers selected as "best"
- **DB column:** `order_overrides.best_rate_json` (JSONB containing full rate shape)
- **Frontend:** `OrdersView.tsx:2079` — `case 'bestrate'` calls `renderBestRatePrice(order)` which reads `order.bestRate.shipmentCost + otherCost` (or `bestRate.amount` if pre-computed total)
- **Notes:**
  - Populated automatically by the **rate backfill scheduler** (runs every 10 min for orders with no/stale rate) — see `src/services/rates-backfill.ts`
  - Manually refreshable via "Fetch rates" button on the side drawer
  - Rate is cached in `rates` table by (weight, zip, dims, residential, carrierSet) for 6h before re-fetching
  - Displays empty (em dash) when order has no weight or dimensions (un-rateable)
  - Shows **marked-up price** — markup loaded from `settings` KV at read time, applied on top of ShipStation's raw number

## 13. Ship Margin

- **Source:** **Derived at render time** — no fetch, no storage
- **Formula:** `order.orderTotal - order.bestRate.total` (i.e. customer paid minus actual shipping cost)
- **Frontend:** `OrdersView.tsx:2081` — `case 'margin'` calls `renderMargin(order)` which does the subtraction inline
- **Notes:**
  - Positive margin (customer paid MORE than ship cost) = green
  - Negative margin (customer paid LESS than ship cost — you're losing money) = red
  - If `order.orderTotal` or `order.bestRate` is missing, shows em dash
  - **This is the key profitability metric** — drives pick/pack/ship decisions
  - Does NOT account for product cost, pick-pack fees, or package cost — those are computed separately in the Billing view

## 14. Tracking #

- **Source:** `POST /v2/labels` response → `tracking_number`
- **DB column:** `shipments.tracking_number` (text), also mirrored to `shipments.label_tracking`
- **Frontend:** `OrdersView.tsx:2083` — `case 'tracking'` reads `order.label?.trackingNumber`, renders as blue underlined link + copy icon
- **Notes:**
  - Clicking the number opens the tracking modal (calls `setTrackingModal(...)`), which shows shipment status fetched in real-time
  - Copy icon copies to clipboard silently
  - Empty (em dash) until a label is created — awaiting orders show nothing here
  - For orders created via v2's external ship flow, tracking also populates (v4 respects `POST /orders/:id/shipped-external`)

## 15. Label Created

- **Source:** `POST /v2/labels` response → `ship_date` AND v4 records `new Date()` at upsert time
- **DB columns:** `shipments.label_created_at` (timestamptz, v4's clock when label created), `shipments.label_ship_date` (from SS response)
- **Frontend:** `OrdersView.tsx:2114` — `case 'labelcreated'` reads `order.label?.createdAt` via `formatLabelCreated()`
- **Notes:**
  - Display format: relative ("2h ago", "3d ago") for recent; absolute ("4/23 1:30 PM") after 7 days
  - Empty until a label exists
  - `labelCreatedAt` persists even if label is voided (history trail); use `shipments.voided` to check if still active

## 16. Age

- **Source:** **Derived at render time** — no fetch, no storage
- **Formula:** `now() - order.orderDate`, rounded to most significant unit (minutes / hours / days)
- **Frontend:** `OrdersView.tsx:2116` — `case 'age'` uses:
  - `getAgeColor(order.orderDate)` — returns CSS color based on thresholds
  - `ageLabel(order.orderDate)` — returns display string
- **Color thresholds** (see `src/services/labels.ts` helper `isStaleOrder()` / OrdersView L324):
  - 0–24h: green (fresh)
  - 24–48h: yellow (warning)
  - 48h+: red (stale — needs attention)
- **Notes:**
  - Age is one of the **signals** that determines if an order shows in the "Need to Ship" strip counter
  - Orders stuck in `awaiting_shipment` >48h trigger the red dot visually
  - Age uses wall-clock math (browser time vs `orderDate`), so users in different timezones see slightly different ages

---

## Data lineage diagram (simplified)

```
ShipStation                     v4 Postgres                       Frontend
-----------                     ----------                         --------
GET /orders        ─────►  orders table (raw, items JSONB)  ──►  cells 1,3,4,5,6,7,8,11
                           orders.order_date                 ──►  cell 1 (Order Date)
                           orders.ship_to_*                  ──►  cell 8 (Ship To)
                           orders.items JSONB                ──►  cells 4,5,6
                           orders.weight_oz                  ──►  cell 7
                           orders.order_total                ──►  cell 11
                           orders.carrier_code               ──►  cell 9 (initial)

(v4 internal)      ─────►  orders.client_id                  ──►  cell 2 (Client)
(join clients)

POST /v2/rates     ─────►  order_overrides.best_rate_json    ──►  cell 12 (Best Rate)
/estimate                                                         cell 13 (Ship Margin, derived)

POST /v2/labels    ─────►  shipments.tracking_number          ──►  cell 14 (Tracking #)
                           shipments.carrier_code             ──►  cell 9 (final)
                           shipments.provider_account_id      ──►  cell 10 (Shipping Account)
                           shipments.label_created_at         ──►  cell 15 (Label Created)

GET /v2/shipments  ─────►  shipments.provider_account_id      ──►  cell 10 (backfill)
(enrichment)

(browser clock)    ────────────────────────────────────────►  cell 16 (Age, pure derived)
```

---

## Quick reference: "what updates this cell?"

| Cell | Refreshes when |
|---|---|
| Order Date | Order is (re)synced from ShipStation |
| Client | Never for an existing order (unless you manually reassign `clients.storeIds`) |
| Recipient | Order is (re)synced |
| Item Name / SKU / Qty | Order is (re)synced |
| Weight | Order is (re)synced, OR user edits dims/weight in the drawer |
| Ship To | Order is (re)synced |
| Carrier | (a) User picks a rate, or (b) label is created, or (c) order is re-synced |
| Shipping Account | Same as Carrier |
| Order Total | Only when ShipStation's customer-facing total changes (rare) |
| Best Rate | Rate backfill scheduler runs (every 10 min), OR user clicks "Fetch rates" |
| Ship Margin | Auto — recomputes whenever Order Total or Best Rate changes |
| Tracking # | Label is created |
| Label Created | Label is created |
| Age | Auto — every page render / interval tick |

---

## Where to look in code when debugging a specific column

| Cell | Sync writer | Frontend reader |
|---|---|---|
| Order Date | `src/services/order-sync.ts:170` | `OrdersView.tsx:1971` |
| Client | `src/services/order-sync.ts:158-166` (client_id resolution) | `OrdersView.tsx:1978`, `clients-api` hook |
| Recipient | `src/services/order-sync.ts:176` | `OrdersView.tsx:1989` |
| Item Name / SKU / Qty | `src/services/order-sync.ts:184` (items jsonb) | `OrdersView.tsx:1991,2040,2056` |
| Weight | `src/services/order-sync.ts:182` | `OrdersView.tsx:2068` + `formatWeight()` |
| Ship To | `src/services/order-sync.ts:177-179` | `OrdersView.tsx:2070` + `getShipToLine()` |
| Carrier | `src/services/labels.ts:persistCreatedLabel` + `src/services/order-sync.ts:180` | `OrdersView.tsx:2072` + `renderCarrierCell()` L476-481 |
| Shipping Account | `src/services/labels.ts:persistCreatedLabel` + `src/services/shipment-sync.ts:enrichProviderAccountIds` | `OrdersView.tsx:2074` + `renderShippingAccountCell()` L498-506 |
| Order Total | `src/services/order-sync.ts:185` | `OrdersView.tsx:2077` + `formatMoney()` |
| Best Rate | `src/services/rates.ts:fetchLiveRates` + `order_overrides.best_rate_json` upsert | `OrdersView.tsx:2079` + `renderBestRatePrice()` L489-494 |
| Ship Margin | (derived) | `OrdersView.tsx:2081` + `renderMargin()` |
| Tracking # | `src/services/labels.ts:persistCreatedLabel` | `OrdersView.tsx:2083` |
| Label Created | `src/services/labels.ts:persistCreatedLabel` | `OrdersView.tsx:2114` + `formatLabelCreated()` |
| Age | (derived) | `OrdersView.tsx:2117-2121` + `getAgeColor()` + `ageLabel()` |
