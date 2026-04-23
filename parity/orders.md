# Parity: orders

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 59  |  **MATCH:** 45  |  **MISSING:** 14  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `DELETE /print-queue/:entryid` — DELETE /api/queue/:entryId — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L62
      v4: src/routes/print-queue.ts:L129

- [x] `GET /orders` — GET /api/orders — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L21
      v4: src/routes/orders.ts:L48

- [x] `GET /orders/:orderid` — GET /api/orders/:orderId(int) — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L49
      v4: src/routes/orders.ts:L440
      Note: v4 uses Hono regex `'/:id{[0-9]+}'` instead of Express `:orderId(int)`.

- [x] `GET /orders/:orderid/dims` — GET /api/orders/:orderId(int)/dims — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L97
      v4: src/routes/orders.ts:L690

- [x] `GET /orders/:orderid/full` — GET /api/orders/:orderId(int)/full — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L42
      v4: src/routes/orders.ts:L459
      Note: v4 implements `/full` as an alias of `GET /:id` returning the same order+overrides+shipments payload.

- [x] `GET /orders/daily-stats` — GET /api/orders/daily-stats — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L24
      v4: src/routes/orders.ts:L278

- [x] `GET /orders/export` — GET /api/orders/export — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L25
      v4: src/routes/orders.ts:L737

- [x] `GET /orders/ids` — GET /api/orders/ids — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L22
      v4: src/routes/orders.ts:L133

- [x] `GET /orders/picklist` — GET /api/orders/picklist — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L23
      v4: src/routes/orders.ts:L389

- [x] `GET /orders/store-counts` — GET /api/orders/store-counts — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L41
      v4: src/routes/orders.ts:L161

- [x] `GET /print-queue` — GET /api/queue — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L12
      v4: src/routes/print-queue.ts:L23

- [x] `GET /print-queue/print/download/:jobid` — GET /api/queue/print/download/:jobId — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L49
      v4: src/routes/print-queue.ts:L113

- [x] `GET /print-queue/print/status/:jobid` — GET /api/queue/print/status/:jobId — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L44
      v4: src/routes/print-queue.ts:L97

- [x] `POST /orders/:orderid/best-rate` — POST /api/orders/:orderId(int)/best-rate — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L85
      v4: src/routes/orders.ts:L594

- [x] `POST /orders/:orderid/residential` — POST /api/orders/:orderId(int)/residential — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L62
      v4: src/routes/orders.ts:L551

- [x] `POST /orders/:orderid/save-dims` — POST /api/orders/:orderId(int)/save-dims — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L91
      v4: src/routes/orders.ts:L656

- [x] `POST /orders/:orderid/selected-package-id` — POST /api/orders/:orderId(int)/selected-package-id — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L74
      v4: src/routes/orders.ts:L573
      Note: v4 accepts either `{packageId}` or `{selectedPid}` in the body and coalesces to `selectedPackageId` (text).

- [x] `POST /orders/:orderid/selected-pid` — POST /api/orders/:orderId(int)/selected-pid — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L68
      v4: src/routes/orders.ts:L562

- [x] `POST /orders/:orderid/shipped-external` — POST /api/orders/:orderId(int)/shipped-external — **[MATCH]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L56
      v4: src/routes/orders.ts:L615
      Note: v4 accepts either `{externallyShipped}` or `{externalShipped}` in the body and updates the `orders.externallyShipped` column plus `order_overrides.externallyShippedSource`.

- [x] `POST /print-queue/add` — POST /api/queue/add — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L20
      v4: src/routes/print-queue.ts:L43

- [x] `POST /print-queue/clear` — POST /api/queue/clear — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L28
      v4: src/routes/print-queue.ts:L63

- [x] `POST /print-queue/print` — POST /api/queue/print — **[MATCH]**
      v2: apps/api/src/modules/queue/api/queue-routes.ts:L36
      v4: src/routes/print-queue.ts:L76


### Services

- [ ] `service:assertpersistedorderbestratedto` — assertPersistedOrderBestRateDto(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L119
      v4: —
      Fix needed: port assertPersistedOrderBestRateDto() from v2 (apps/api/src/modules/orders/application/order-rate-dto.ts) into a new src/services/order-rate-dto.ts; invoke from the POST /orders/:id/best-rate and PATCH /orders/:id handlers in src/routes/orders.ts (which currently accept `z.unknown()` and persist raw JSON without guaranteeing carrierCode/serviceCode are present). v4 may have intentionally dropped this strict validation — needs Phase E review.

- [ ] `service:normalizeorderbestratedto` — normalizeOrderBestRateDto(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L95
      v4: —
      Fix needed: port normalizeOrderBestRateDto() from v2 (apps/api/src/modules/orders/application/order-rate-dto.ts) into src/services/order-rate-dto.ts; call from src/services/rates-backfill.ts (runBackfill picks a `best` rate and writes it raw) and from POST /orders/:id/best-rate in src/routes/orders.ts so stored bestRateJson has canonical keys (shipmentCost, otherCost, carrierNickname, zone, etc.) rather than raw ShipStation snake_case fields. v4 may have intentionally dropped this normalization layer — needs Phase E review.

- [ ] `service:normalizeorderselectedratedto` — normalizeOrderSelectedRateDto(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L133
      v4: —
      Fix needed: port normalizeOrderSelectedRateDto() from v2 (apps/api/src/modules/orders/application/order-rate-dto.ts) into src/services/order-rate-dto.ts; call from src/services/labels.ts where `selectedRateJson` is assembled before insert into shipments (labels.ts:544 currently hand-builds the object with only providerAccountId/shippingProviderId). v4 may have intentionally dropped this normalization layer — needs Phase E review.

- [ ] `service:parseorderratejson` — parseOrderRateJson(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L85
      v4: —
      Fix needed: port parseOrderRateJson() from v2 (apps/api/src/modules/orders/application/order-rate-dto.ts) into src/services/order-rate-dto.ts. Less critical in v4 because `bestRateJson`/`selectedRateJson` are stored as Postgres `jsonb` (auto-parsed) rather than TEXT as in v2's SQLite, so a JSON.parse wrapper is rarely needed — may be dropped by design. Needs Phase E review.

- [ ] `service:resolvecarriernickname` — resolveCarrierNickname(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/carrier-resolver.ts:L31
      v4: —
      Fix needed: port resolveCarrierNickname() from v2 (apps/api/src/modules/orders/application/carrier-resolver.ts) into a new src/services/carrier-resolver.ts along with the CARRIER_ACCOUNTS_V2 config table (currently only lives in v2's packages/common/prepship-config.ts). v4 currently reads `carrier_nickname` straight from the ShipStation API response via src/routes/init.ts:L147 and inlines fallback logic in web/src/components/RateBrowserModal.tsx — it does not decode UPS 1Z tracking account codes or map providerAccountId → nickname server-side, so orders with providerAccountId but no upstream nickname render inconsistently. v4 may have intentionally delegated this to the upstream API — needs Phase E review.


### DB Schema

- [x] `column:sku_qty_dims.height` — column sku_qty_dims.height REAL — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L32

- [x] `column:sku_qty_dims.length` — column sku_qty_dims.length REAL — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L30

- [x] `column:sku_qty_dims.qty` — column sku_qty_dims.qty INTEGER — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L29

- [x] `column:sku_qty_dims.sku` — column sku_qty_dims.sku TEXT — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L28

- [x] `column:sku_qty_dims.updated_at` — column sku_qty_dims.updatedAt INTEGER — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L33

- [x] `column:sku_qty_dims.width` — column sku_qty_dims.width REAL — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L31

- [x] `table:sku_qty_dims` — table sku_qty_dims — **[MATCH]**
      v2: apps/api/src/modules/orders/data/sqlite-order-repository.ts:L1
      v4: src/db/schema/products.ts:L25


### View: Actions / Keyboard

- [x] `orders:keyboard:arrowdown` — orders keyboard ArrowDown — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.tsx:L1
      v4: web/src/components/Views/OrdersView.tsx:L1

- [x] `orders:keyboard:arrowup` — orders keyboard ArrowUp — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.tsx:L1
      v4: web/src/components/Views/OrdersView.tsx:L1

- [x] `orders:keyboard:enter` — orders keyboard Enter — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.tsx:L1
      v4: web/src/components/Views/OrdersView.tsx:L1

- [x] `orders:keyboard:escape` — orders keyboard Escape — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.tsx:L1
      v4: web/src/components/Views/OrdersView.tsx:L1


### Frontend Hooks

- [x] `hook:useorderdetail` — useOrderDetail(...) — **[MATCH]**
      v2: apps/react/src/hooks/useOrderDetail.ts:L11
      v4: web/src/hooks/useOrderDetail.ts:L12

- [x] `hook:useorders` — useOrders(...) — **[MATCH]**
      v2: apps/react/src/hooks/useOrders.ts:L25
      v4: web/src/hooks/useOrders.ts:L26

- [x] `hook:useorderswithdetails` — useOrdersWithDetails(...) — **[MATCH]**
      v2: apps/react/src/hooks/useOrdersWithDetails.ts:L10
      v4: web/src/hooks/useOrdersWithDetails.ts:L11

- [x] `hook:useshippedorderscache` — useShippedOrdersCache(...) — **[MATCH]**
      v2: apps/react/src/hooks/useShippedOrdersCache.ts:L9
      v4: web/src/hooks/useShippedOrdersCache.ts:L10

- [x] `hook:usestoreorders` — useStoreOrders(...) — **[MATCH]**
      v2: apps/react/src/hooks/useStoreOrders.ts:L9
      v4: web/src/hooks/useStoreOrders.ts:L10


### CSS Classes

- [x] `css:error` — .error — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:loading` — .loading — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:no-data` — .no-data — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:order-id` — .order-id — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:orders-controls` — .orders-controls — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:orders-header` — .orders-header — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:orders-pagination` — .orders-pagination — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:orders-table` — .orders-table — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:orders-table-container` — .orders-table-container — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:orders-view` — .orders-view — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:page-info` — .page-info — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:status-awaiting_shipment` — .status-awaiting_shipment — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:status-badge` — .status-badge — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:status-cancelled` — .status-cancelled — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:status-filter` — .status-filter — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1

- [x] `css:status-shipped` — .status-shipped — **[MATCH]**
      v2: apps/react/src/components/Views/OrdersView.css:L1
      v4: web/src/components/Views/OrdersView.css:L1


---

**Verified-by:** _________  **Date:** _________
