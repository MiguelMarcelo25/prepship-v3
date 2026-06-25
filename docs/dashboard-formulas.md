# PrepShip Dashboard — Charts, Graphs & Formulas Reference

Last updated: 2026-05-12
Audience: leadership / stakeholders who need to understand how each
number on the dashboard is derived. Every chart on the page is
documented below with its visual layout, the SQL formula that
populates it, and the client-side derivation that produces the
final on-screen value.

---

## Global filters that affect every chart

Every value below honors these top-of-page filters when set:

| Filter | Effect |
|---|---|
| **Client** | Restricts every aggregate to `orders.client_id = <selected>`. When "All Clients" is selected, no client filter is applied. |
| **Category** (SKU table only) | Local filter on the SKU table — does NOT re-query the backend. |
| **Brand** (SKU table only) | Local filter on the SKU table — does NOT re-query the backend. |

Every backend query also applies these **standing exclusions** — they
are NOT operator-toggleable and exist to keep dashboard numbers
clean:

- **Cancelled orders** are excluded: `order_status NOT IN ('cancelled')`
- **Adjustment line items** are excluded: `coalesce((item->>'adjustment')::boolean, false) = false`
- **Test / disabled store_ids** are excluded via `EXCLUDED_STORE_IDS_SQL`
- **Deactivated clients** are excluded: orders whose `client_id`
  belongs to a client where `clients.active = false` are dropped

## Date windows

Every chart uses two rolling 30-day windows so the dashboard can
compute "vs prior" comparisons:

- **Current 30 days** — `dateOnly(29)` to `dateOnly(0)` (today inclusive)
- **Prior 30 days** — `dateOnly(59)` to `dateOnly(30)` (the 30 days
  immediately before the current window)
- **Current 7 days** — last 7 days of the current 30-day window (the
  rightmost 7 entries of the daily-sales array)

`dateOnly(N)` = midnight (00:00 local) of `N` days before today.

> **`relativePct` now lives in [src/lib/kpi-delta.ts](../src/lib/kpi-delta.ts)** (PS-325 slice 2) — the
> single backend-owned definition of the "vs prior" relative-change rule, imported by DashboardView
> (it is no longer defined in the component). Formula unchanged: `((current - prior) / prior) × 100`,
> with `prior ≤ 0 && current ≤ 0 → 0%` and `prior ≤ 0 && current > 0 → +100%`. NaN/Infinity safety,
> rounding and the `+` sign stay in `formatPct`/`ChangeText` (presentation, not the definition).

---

# 1. KPI Cards (six cards across the top)

## 1.1 Total 7-Day Units
**File:** [DashboardView.tsx:1325-1331](web/src/components/Views/DashboardView.tsx#L1325-L1331)

| Component | Source | Formula |
|---|---|---|
| Value | `kpis.currentUnits7` | `sum( trend[last 7 days].current )` |
| Change indicator | `relativePct(currentUnits7, priorUnits7)` | `((current - prior) / prior) × 100`; if `prior = 0` and `current > 0` → returns `+100%`; if both `0` → `0%` |
| Sparkline | `last(trend.map(p => p.current), 10)` | Last 10 days of daily totals |

Where `trend[i].current` = **sum of units sold across every top SKU
on day `i`**, sourced from the SQL below.

## 1.2 Total 30-Day Units
**File:** [DashboardView.tsx:1331-1337](web/src/components/Views/DashboardView.tsx#L1331-L1337)

- Value = `sum( trend[all 30 days].current )` = total units sold over the current 30-day window
- Change = `relativePct(currentUnits30, priorUnits30)` (same formula as above, applied to the full 30-day windows)

## 1.3 Total Revenue (30 days)
**File:** [DashboardView.tsx:1337-1343](web/src/components/Views/DashboardView.tsx#L1337-L1343)

- Value = `currentAgg.revenue`
- Change = `relativePct(currentAgg.revenue, priorAgg.revenue)`

The aggregator is [`aggregateOrders`](web/src/components/Views/DashboardView.tsx#L478) and runs in the browser:

```text
revenue = SUM( order.orderTotal )                                    [client-side]
       across every order in window  (cancelled & test orders already
                                       excluded server-side)
```

`orderTotal` is the merchant-reported total per order (post-discount,
includes shipping, excludes refunds). This is the same number that
shows in the Orders list.

## 1.4 In Stock / Low Stock / Out of Stock cards
**Files:** [DashboardView.tsx:1344-1370](web/src/components/Views/DashboardView.tsx#L1344-L1370), formulas at [DashboardView.tsx:1171-1194](web/src/components/Views/DashboardView.tsx#L1171-L1194)

These three cards partition the inventory list (cached client-side
from `GET /inventory`) into three disjoint sets:

```text
For each SKU, let:
  stock = currentStock ?? stockQty       (current on-hand quantity)
  min   = minStock     ?? reorderLevel   (reorder threshold)

In Stock     : stock >  min
Low Stock    : stock >  0  AND  stock <= min
Out of Stock : stock <= 0
```

The denominator for the `% of total SKUs` label and the progress bar
is `max(1, inventory.length)` — `max(1, …)` so the math never divides
by zero when there are no SKUs.

`currentStock` and `minStock` are v2 legacy keys; the v4 schema
uses `stockQty` and `reorderLevel`. The `??` fallbacks let the
dashboard work against either shape.

---

# 2. Units Sold Trend (line chart)

**File:** [DashboardView.tsx:1374-1417](web/src/components/Views/DashboardView.tsx#L1374-L1417)
**Build function:** [`buildTrend`](web/src/components/Views/DashboardView.tsx#L511) at line 511

A 30-day line chart with two series:
- **Solid brand-blue line** = current 30 days
- **Dashed grey line**     = prior 30 days

Each daily point is computed as:

```text
trend[i].current = SUM_over_topSKUs( currentSeries[sku][i] )
trend[i].prior   = SUM_over_topSKUs( priorSeries[sku][i] )
```

Where `currentSeries[sku][i]` = units sold for that SKU on day `i`
(zero-padded for quiet days). The current+prior windows are aligned
by day-of-window — index `0` of the prior series aligns with index
`0` of the current series, so day 1 of the current 30 → day 1 of the
prior 30, etc.

## Backing SQL — `getSkuDaily` ([src/routes/analysis.ts:187](src/routes/analysis.ts#L187))

The dashboard calls `apiClient.fetchAnalysisDailySales` twice (once
per window). The endpoint returns the top-15 SKUs by volume in the
window, along with their per-day units.

**Step 1 — Pick the top 15 SKUs:**

```sql
WITH item_rows AS (
  SELECT
    case when item->>'sku' is not null then item->>'sku'
         else '_name_:' || lower(trim(item->>'name'))
    end AS sku,
    coalesce((item->>'quantity')::int, 1) AS qty
  FROM orders o, jsonb_array_elements(o.items) item
  WHERE o.order_status NOT IN ('cancelled')
    AND o.order_date BETWEEN $dateFrom AND $dateTo
    AND o.store_id NOT IN ($EXCLUDED_STORES)
    AND ($clientId IS NULL OR o.client_id = $clientId)
    AND coalesce((item->>'adjustment')::boolean, false) = false
    AND (o.client_id IS NULL OR exists(
          SELECT 1 FROM clients c
          WHERE c.id = o.client_id AND coalesce(c.active, true) = true))
)
SELECT sku, SUM(qty)::int AS total_qty
FROM item_rows
GROUP BY sku
ORDER BY total_qty DESC
LIMIT 15;
```

**Step 2 — Daily units per top SKU:**

```sql
SELECT
  to_char(o.order_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
  /* same SKU resolution as above */ AS sku,
  SUM( coalesce((item->>'quantity')::int, 1) )::int AS qty
FROM orders o, jsonb_array_elements(o.items) item
WHERE  /* same filters as Step 1 */
   AND sku IN ( $top15_skus )
GROUP BY day, sku
ORDER BY day ASC;
```

The frontend reshapes `days[]` → `series[sku] = number[]` and pads
to a fixed length so the line chart has one X-axis point per day in
the window, even days with zero sales.

---

# 3. Top SKUs (30d) panel

**File:** [DashboardView.tsx:1419-1446](web/src/components/Views/DashboardView.tsx#L1419-L1446)
**Source:** [`topSkuRows`](web/src/components/Views/DashboardView.tsx#L1140) at line 1140

```text
topSkuRows = skuRows
   .sortDescending( row.units30 )
   .slice(0, 5)        // top 5 SKUs only

For each row:
  units30  = SUM_over_30_days( currentSales.series[sku] )   (from chart 2's data)
  bar_width = max(5%, (row.units30 / topSku.units30) × 100%)
```

The bar is normalized to the #1 SKU's volume so the leader always
fills 100% and everyone else is a fraction of the leader.

---

# 4. Sales Performance Heatmap by SKU Family

**File:** [DashboardView.tsx](web/src/components/Views/DashboardView.tsx) (render + click-to-explain)
**Build function:** [`buildHeatmap` / `heatmapTone`](../src/lib/sales-heatmap-deviation.ts) — PS-325 slice 3:
the deviation/tone policy now lives in the backend-owned `src/lib/sales-heatmap-deviation.ts` (the
color palette `HEATMAP_TONE_HEX` stays in DashboardView as presentation). Formula below is unchanged.

Each row is a **product family** (Ramen Noodles, Drinks, Books, etc.),
auto-classified by [`productFamily`](web/src/components/Views/DashboardView.tsx#L433) using regex keywords against SKU + name.

Each column is one day in the **last 15 days** of the current 30-day window.

Each cell is color-coded by deviation from a baseline:

```text
For each family:
  baseline = average daily units in PRIOR 30 days
           = SUM( bucket.prior ) / 30

  If baseline = 0 (family had zero sales prior 30d):
    baseline = average daily units in CURRENT 30 days   [fallback]

For each cell (day):
  qty       = current units on that day for this family
  deviation = ((qty − baseline) / baseline) × 100        [%]

Color tone:
   deviation >=  +20%   → bright green   (high)
  +10% to +20%          → faded green    (mid)
  −10% to +10%          → faded orange   (flat)
  −10% to −20%          → solid orange   (dip)
  deviation <=  −20%    → red            (low)
```

Only the **top 6 families** by current total units are shown (the
tail is truncated to keep the chart readable).

---

# 5. SKU Performance Summary (table)

**File:** [DashboardView.tsx:1502-1925](web/src/components/Views/DashboardView.tsx#L1502-L1925)
**Row construction:** [`skuRows`](web/src/components/Views/DashboardView.tsx#L978) at line 978

This is the main table at the bottom of the dashboard. The row set
is built by merging three data sources for every SKU:

1. **Analysis breakdown** (`GET /analysis/sku-breakdown`) — shipping
   costs, revenue, image
2. **Top SKUs from daily-sales** (`GET /analysis/sku-daily`) — daily
   units arrays + 30-day totals
3. **Inventory** (`GET /inventory`) — stock levels, reorder thresholds

Each column's formula:

| Column | Formula |
|---|---|
| **SKU** | `inventory.sku` or `analysis.sku` (deduped) |
| **Product** | `analysis.name ?? topSku.name ?? inventory.name ?? sku` (first non-empty) |
| **Store** | `analysis.clientName ?? inventory.clientName ?? selectedClient.name ?? "All Clients"` |
| **Revenue** | `SUM_over_orders( orderTotal × (sku_qty / order_total_qty) )` — proportional allocation: an order with $100 total and 4 line items splits $25 to each item by quantity ratio |
| **Avg. Price** | `revenue / units30` (0 when no units sold) |
| **Avg. Shipping** | `analysis.blendedAvgShipping ?? standardAvgShipping ?? expeditedAvgShipping ?? (totalShipping / units30)` |
| **Stock Status** | `out` if `stock <= 0`; `low` if `stock <= minStock`; else `in` |
| **Days Supply** | `stock / (units30 / 30)` = `stock / dailyRate`; shows `-` when `dailyRate = 0` |
| **Restock Qty** | `max(0, ceil(targetStock − stock))` where `targetStock = max(minStock, dailyRate × 14)` — i.e. enough to refill to either the reorder floor OR 14 days of cover, whichever is larger |
| **7-Day Units** | `SUM_over_7d( currentSales.series[sku] )` — units sold in the last 7 days |
| **30-Day Units** | `SUM_over_30d( currentSales.series[sku] )` — units sold in the current window |
| **30-Day Avg.** | `priorUnits30 / 30` — average daily units in the PRIOR window |
| **vs Prior 30 Days** | `relativePct(units30, priorUnits30)` — same `((current - prior) / prior) × 100` formula as elsewhere |
| **Trend** (sparkline) | Last 12 entries of `currentSales.series[sku]`, color = green if `changePct ≥ 0` else red |

## Backing SQL — `getSkuBreakdown` ([src/routes/analysis.ts:336](src/routes/analysis.ts#L336))

This is the rich per-SKU aggregate that feeds the SKU table.
Returns one row per `(sku, client_id)` pair with these key totals
(condensed — see the source for the full SELECT list):

```sql
SELECT
  i.sku,
  i.name,
  client_id,
  COUNT(DISTINCT order_id)                              AS orders,
  SUM( CASE WHEN order_status='awaiting_shipment' …)    AS pending,
  -- Standard shipping breakdown:
  COUNT(DISTINCT CASE WHEN NOT expedited THEN order_id) AS std_orders,
  SUM( CASE WHEN NOT expedited THEN shipment_cost )     AS std_total,
  SUM( CASE WHEN NOT expedited THEN qty )               AS std_qty_total,
  -- Expedited shipping breakdown (UPS 2nd-Day, NDA, FedEx 2Day, etc):
  COUNT(DISTINCT CASE WHEN expedited THEN order_id)     AS exp_orders,
  SUM( CASE WHEN expedited THEN shipment_cost )         AS exp_total,
  SUM( CASE WHEN expedited THEN qty )                   AS exp_qty_total,
  -- Revenue & per-day map:
  SUM( unit_price × qty )                               AS total_revenue,
  jsonb_object_agg(day, daily_qty)                      AS daily_qty_map
FROM orders, items, …
WHERE order_date BETWEEN $from AND $to
  AND order_status NOT IN ('cancelled')
  AND adjustment IS FALSE
  AND store_id NOT IN ($EXCLUDED_STORES)
  AND (client_id IS NULL OR client.active = true)
GROUP BY i.sku, client_id;
```

`expedited` is defined as `service_code ∈ EXPEDITED_SERVICES` — see
[src/routes/inventory.ts:16-24](src/routes/inventory.ts#L16-L24) for the canonical list
(UPS 2nd Day Air, NDA, NDA Saver, NDA Early AM, 3 Day Select; USPS
Priority Mail Express; FedEx 2Day/2Day AM, Express Saver, Priority
Overnight, Standard Overnight, First Overnight).

---

# 6. Data freshness & caching

- The dashboard refetches on **mount** and whenever the **client
  filter** changes (no auto-refresh; click ⟳ Refresh for a manual
  reload).
- Per call, `fetchOrdersWindow` pages up to **5 pages × 2000 orders
  = 10,000 orders/window** (current and prior). For higher-volume
  accounts the floor is `pages × 2000`, capped to keep client-side
  aggregation responsive.
- "Data as of" timestamp at the top right shows the last successful
  load (local browser clock).

---

# 7. Glossary

| Term | Meaning |
|---|---|
| **Units** | Count of physical items sold = `SUM(item.quantity)` across non-cancelled, non-adjustment line items |
| **Revenue** | `order.orderTotal` summed across non-cancelled orders in the window. Per-SKU revenue is allocated proportionally by line-item quantity within each order. |
| **Daily rate** | `units30 / 30` — average daily units sold over the current 30-day window |
| **Days Supply** | `stock / dailyRate` — how many days the current stock would last at the current burn rate |
| **Reorder level** (`minStock`) | The threshold below which a SKU is flagged Low Stock; set per-SKU on the Inventory page |
| **Target stock** | `max(minStock, dailyRate × 14)` — the dashboard's recommended on-hand level (the higher of "reorder floor" or "14 days of cover") |
| **Restock Qty** | `max(0, target − current)` — how many units to order to hit target |
| **Expedited shipping** | Any of the carrier services listed in `EXPEDITED_SERVICES` (`src/routes/inventory.ts`) |
| **Adjustment** | Manual SKU correction line items used for inventory reconciliation; excluded from sales-velocity math everywhere |
