# ORDERS — Phase 1 audit (v2 → v4-stable)

Read-only gap analysis. Partial port already in place (see bottom of doc).

---

## 1. Frontend gaps remaining

### 1.1 Rate Browser modal — **MISSING (blocker)**
- v2: `OrdersView.tsx:663-2979`, calls `POST /api/rates/browse` at `OrdersView.tsx:1421-1452`
- Filters by carrier, full rate grid (cost, service, EDD)
- Triggered by "🔍 Browse Rates" button and "🔄 Scout Review" link
- v4: no equivalent. `OrderDrawer.tsx:87-104` has `Rate` type but no modal

### 1.2 Batch panel UX — **different**
- v2: side panel w/ selected orders list + test-mode checkbox + Create/Queue + per-order item summaries (`OrdersView.tsx:1551-1619`)
- v4: `BatchLabelModal.tsx` is modal-based, no item summary per order

### 1.3 Inline carrier / shipping-account dropdowns — **missing**
- v2: editable `<select>` in table cell for awaiting_shipment orders (`OrdersView.tsx:1793-1810`, `renderShippingAccountCell`)
- v4: table is read-only; must open drawer

### 1.4 Full single-order editing panel — **partial**
- v2: `OrdersView.tsx:2121-2450` — rate preview + service override + **insurance** (carrier/shipsurance + value) + **confirmation** (delivery/signature/adult_signature/direct_signature) + package picker + warehouse location + save-as-SKU-default
- v4: `OrderDrawer.tsx` missing insurance, confirmation, warehouse location selectors

### 1.5 SKU Sort mode — **missing**
- v2: "📋 SKU Sort" button groups orders by primary SKU+qty (`OrdersView.tsx:636-821`, `orders-grouping.ts:1-33`, `groupOrdersBySku()`)
- v4: no SKU grouping toggle

### 1.6 Client color palette — **DONE ✅**
- Confirmed at `web/src/components/ui/Badge.tsx:49-82` (ClientBadge), used `Orders.tsx:770`

### 1.7 Keyboard shortcuts — **partial**
- v2 (`OrdersView.tsx:1065-1104`): `↑↓` navigate rows, `Enter` open row, `Esc` close, `⌘C` copy order #
- v4 (`OrderDrawer.tsx:167-189`): only `Esc` + `←/→` for prev/next

### 1.8 CSV Export — **missing**
- v2: "📥 Export CSV" calls `apiClient.downloadOrdersExport({ orderStatus, pageSize: 5000 })` (`OrdersView.tsx:2629-2651`)
- v4: no export button

### 1.9 Queue toast item merge — **simplified**
- v2: `orders-queue.ts:1-65` — "SKU x qty, SKU x qty +N more"
- v4: `BatchLabelModal.tsx` uses simpler toast text

### 1.10 Inline notes/tags editor — **missing**
- v2: inline edit in panel (saves to `order.raw`)
- v4: no notes/tags UI in drawer

---

## 2. Backend gaps

| Endpoint | v2 Ref | v4 Status |
|---|---|---|
| `POST /api/orders/:id/save-dims` | `order-routes.ts:93-95` | **missing** — cannot save package dims |
| `GET /api/orders/:id/dims` | `order-routes.ts:98-101` | **missing** — cannot retrieve saved dims |
| `POST /api/rates/browse` | `rates-routes.ts:74-75` | **missing** — blocks Rate Browser modal |
| `GET /api/orders/export` | `order-routes.ts:25-40` | **missing** — blocks CSV export |
| `POST /api/rates/cached` | `rates-routes.ts:42-61` | present |
| `GET /api/orders/picklist` | `orders.ts:149-198` | present |

### 2.1 Daily-stats response shape differs
- v2 returns: `upcomingOrders`, `totalOrders`, `needToShip`, `window{from,to,fromLabel,toLabel}`
- v4 (`src/routes/orders.ts:131-146`): `day`, `count`, `shipped` (per-day granular)
- Gap: `upcomingOrders` field missing — used in v2 `OrdersView.tsx:2691` for daily progress bar (this is why v4's "Upcoming" stat is hardcoded to 0)

---

## 3. Schema gaps

### `orderOverrides` table (`src/db/schema/orders.ts:50-72`) — missing columns

v2 stores these in `raw.advancedOptions` / `raw.insuranceOptions`:
- `confirmationType` — (`delivery | signature | adult_signature | direct_signature`)
- `insuranceType` — (`none | carrier | shipsurance`)
- `insuranceValue` — numeric
- `warehouseId` — int
- `billToMyOtherAccount` — int

v4 has fields v2 may not: `rateWeightOz`, `rateDimsL/W/H` — good to keep.

---

## 4. Priority punch list

| # | Task | Size | Files | Backend? |
|---|------|------|-------|----------|
| 1 | **Rate Browser modal** | Large | `Orders.tsx`, `OrderDrawer.tsx`, new modal | ✅ `/api/rates/browse` |
| 2 | CSV Export button | Medium | `Orders.tsx` topbar | ✅ `/api/orders/export` |
| 3 | Save-dims / get-dims endpoints + UI | Medium | `OrderDrawer.tsx` | ✅ `POST/GET /api/orders/:id/dims` |
| 4 | Table keyboard shortcuts (↑↓ rows, ⌘C copy order #) | Small | `Orders.tsx` | ❌ |
| 5 | Insurance + confirmation selectors in drawer | Medium | `OrderDrawer.tsx` | ⚠ extend `orderOverrides` schema |
| 6 | Warehouse location selector | Small | `OrderDrawer.tsx` | ⚠ extend schema |
| 7 | SKU Sort mode + grouping UI | Medium | `Orders.tsx`, `ColumnsPopover.tsx` | ❌ |
| 8 | Batch panel → side panel (or enhance modal) | Large | `BatchLabelModal.tsx`, `Orders.tsx` | ❌ |
| 9 | Inline carrier / shipping-account dropdowns | Medium | `Orders.tsx` cell renderers | ❌ |
| 10 | Daily-stats: add `upcomingOrders` + `needToShip` to response | Medium | `src/routes/orders.ts` | ✅ |
| 11 | Queue toast: SKU×qty merge format | Small | `BatchLabelModal.tsx` (port `orders-queue.ts`) | ❌ |
| 12 | Picklist print (awaiting_shipment only) — **DONE ✅** | — | — | — |
| 13 | Order notes/tags editor in drawer | Medium | `OrderDrawer.tsx` + PATCH `/orders/:id` | ❌ |
| 14 | Column-widths localStorage persistence | Small | `Orders.tsx` | ❌ |
| 15 | External shipment + >48h age highlighting — **DONE ✅** | — | — | — |

---

## 5. Already done ✅

- Status-aware column visibility (`Orders.tsx:339-350`)
- Prev/next nav in drawer (`OrderDrawer.tsx:157-189`)
- Progress-bar color logic (green/orange/blue)
- Exception row highlighting (awaiting_shipment + >48h or missing weight)
- Picklist button gated to awaiting_shipment
- Client color palette (ClientBadge)

---

## Recommendation

**Rate Browser modal (#1)** is the highest blocker — multiple advanced shipping features depend on it. Start with backend `POST /api/rates/browse`, then the modal UI in the drawer.

Second priority: **daily-stats endpoint extension (#10)** — small backend change that unlocks the "Upcoming" stat (currently hardcoded 0 in v4).
