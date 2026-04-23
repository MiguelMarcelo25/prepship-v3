# Parity: billing

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 34  |  **MATCH:** 34  |  **MISSING:** 0  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `GET /billing/config` — GET /api/billing/config — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L138
      v4: web/src/pages/Billing.tsx:L69

- [x] `GET /billing/details` — GET /api/billing/details — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L151
      v4: src/routes/billing.ts:L162

- [x] `GET /billing/fetch-ref-rates/status` — GET /api/billing/fetch-ref-rates/status — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L189
      v4: src/routes/billing.ts:L709

- [x] `GET /billing/invoice` — GET /api/billing/invoice — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L166
      v4: src/routes/billing.ts:L194

- [x] `GET /billing/package-prices` — GET /api/billing/package-prices — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L154
      v4: src/routes/billing.ts:L404

- [x] `GET /billing/summary` — GET /api/billing/summary — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L148
      v4: src/routes/billing.ts:L152

- [x] `POST /billing/backfill-ref-rates` — POST /api/billing/backfill-ref-rates — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L190
      v4: src/routes/billing.ts:L539

- [x] `POST /billing/fetch-ref-rates` — POST /api/billing/fetch-ref-rates — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L186
      v4: src/routes/billing.ts:L664

- [x] `POST /billing/generate` — POST /api/billing/generate — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L145
      v4: web/src/pages/Billing.tsx:L88

- [x] `POST /billing/package-prices/set-default` — POST /api/billing/package-prices/set-default — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L160
      v4: src/routes/billing.ts:L456

- [x] `PUT /billing/config/:clientid` — PUT /api/billing/config/:clientId(int) — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L139
      v4: src/routes/billing.ts:L62

- [x] `PUT /billing/package-prices` — PUT /api/billing/package-prices — **[MATCH]**
      v2: apps/api/src/modules/billing/api/billing-routes.ts:L157
      v4: src/routes/billing.ts:L431


### View: Columns

- [x] `billing:billing_detail_columns:{-id:-'additional',-label:-'addl-units',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'additional', label: 'Addl Units', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L93
      v4: web/src/components/Views/billing-parity.ts:L97

- [x] `billing:billing_detail_columns:{-id:-'bestrate',-label:-'best-rate',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'bestRate', label: 'Best Rate', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L96
      v4: web/src/components/Views/billing-parity.ts:L100

- [x] `billing:billing_detail_columns:{-id:-'itemnames',-label:-'item-name',-align:-'left',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'itemNames', label: 'Item Name', align: 'left', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L89
      v4: web/src/components/Views/billing-parity.ts:L93

- [x] `billing:billing_detail_columns:{-id:-'itemskus',-label:-'sku',-align:-'left',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'itemSkus', label: 'SKU', align: 'left', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L90
      v4: web/src/components/Views/billing-parity.ts:L94

- [x] `billing:billing_detail_columns:{-id:-'margin',-label:-'shipping-margin',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'margin', label: 'Shipping Margin', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L101
      v4: web/src/components/Views/billing-parity.ts:L105

- [x] `billing:billing_detail_columns:{-id:-'ordernumber',-label:-'order-#',-align:-'left',-always:-true-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'orderNumber', label: 'Order #', align: 'left', always: true } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L87
      v4: web/src/components/Views/billing-parity.ts:L91

- [x] `billing:billing_detail_columns:{-id:-'packagecost',-label:-'box-cost',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'packageCost', label: 'Box Cost', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L94
      v4: web/src/components/Views/billing-parity.ts:L98

- [x] `billing:billing_detail_columns:{-id:-'packagename',-label:-'box-size',-align:-'center',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'packageName', label: 'Box Size', align: 'center', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L95
      v4: web/src/components/Views/billing-parity.ts:L99

- [x] `billing:billing_detail_columns:{-id:-'pickpack',-label:-'pick-&-pack',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'pickpack', label: 'Pick & Pack', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L92
      v4: web/src/components/Views/billing-parity.ts:L96

- [x] `billing:billing_detail_columns:{-id:-'shipdate',-label:-'ship-date',-align:-'left',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'shipDate', label: 'Ship Date', align: 'left', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L88
      v4: web/src/components/Views/billing-parity.ts:L92

- [x] `billing:billing_detail_columns:{-id:-'shipping',-label:-'shipping',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'shipping', label: 'Shipping', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L99
      v4: web/src/components/Views/billing-parity.ts:L103

- [x] `billing:billing_detail_columns:{-id:-'total',-label:-'total',-align:-'right',-always:-true-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'total', label: 'Total', align: 'right', always: true } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L100
      v4: web/src/components/Views/billing-parity.ts:L104

- [x] `billing:billing_detail_columns:{-id:-'totalqty',-label:-'qty',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'totalQty', label: 'Qty', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L91
      v4: web/src/components/Views/billing-parity.ts:L95

- [x] `billing:billing_detail_columns:{-id:-'upsss',-label:-'ups-ss',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'upsss', label: 'UPS SS', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L97
      v4: web/src/components/Views/billing-parity.ts:L101

- [x] `billing:billing_detail_columns:{-id:-'uspsss',-label:-'usps-ss',-align:-'right',-always:-false-}` — billing.BILLING_DETAIL_COLUMNS: { id: 'uspsss', label: 'USPS SS', align: 'right', always: false } — **[MATCH]**
      v2: apps/react/src/components/Views/billing-parity.ts:L98
      v4: web/src/components/Views/billing-parity.ts:L102


### CSS Classes

- [x] `css:active` — .active — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1

- [x] `css:billing-detail-rate-hit` — .billing-detail-rate-hit — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1

- [x] `css:billing-detail-ss-row` — .billing-detail-ss-row — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1

- [x] `css:billing-detail-toggle` — .billing-detail-toggle — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1

- [x] `css:billing-grid` — .billing-grid — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1

- [x] `css:billing-summary-client-cell` — .billing-summary-client-cell — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1

- [x] `css:billing-summary-row` — .billing-summary-row — **[MATCH]**
      v2: apps/react/src/components/Views/BillingView.css:L1
      v4: web/src/components/Views/BillingView.css:L1


---

**Verified-by:** _________  **Date:** _________
