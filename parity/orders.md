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

- [ ] `GET /orders/:orderid` — GET /api/orders/:orderId(int) — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L49
      v4: —
      Fix needed: <TODO: port route `GET /orders/:orderid` from v2>

- [ ] `GET /orders/:orderid/dims` — GET /api/orders/:orderId(int)/dims — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L97
      v4: —
      Fix needed: <TODO: port route `GET /orders/:orderid/dims` from v2>

- [ ] `GET /orders/:orderid/full` — GET /api/orders/:orderId(int)/full — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L42
      v4: —
      Fix needed: <TODO: port route `GET /orders/:orderid/full` from v2>

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

- [ ] `POST /orders/:orderid/best-rate` — POST /api/orders/:orderId(int)/best-rate — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L85
      v4: —
      Fix needed: <TODO: port route `POST /orders/:orderid/best-rate` from v2>

- [ ] `POST /orders/:orderid/residential` — POST /api/orders/:orderId(int)/residential — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L62
      v4: —
      Fix needed: <TODO: port route `POST /orders/:orderid/residential` from v2>

- [ ] `POST /orders/:orderid/save-dims` — POST /api/orders/:orderId(int)/save-dims — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L91
      v4: —
      Fix needed: <TODO: port route `POST /orders/:orderid/save-dims` from v2>

- [ ] `POST /orders/:orderid/selected-package-id` — POST /api/orders/:orderId(int)/selected-package-id — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L74
      v4: —
      Fix needed: <TODO: port route `POST /orders/:orderid/selected-package-id` from v2>

- [ ] `POST /orders/:orderid/selected-pid` — POST /api/orders/:orderId(int)/selected-pid — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L68
      v4: —
      Fix needed: <TODO: port route `POST /orders/:orderid/selected-pid` from v2>

- [ ] `POST /orders/:orderid/shipped-external` — POST /api/orders/:orderId(int)/shipped-external — **[MISSING]**
      v2: apps/api/src/modules/orders/api/order-routes.ts:L56
      v4: —
      Fix needed: <TODO: port route `POST /orders/:orderid/shipped-external` from v2>

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
      Fix needed: <TODO: port service `service:assertpersistedorderbestratedto` from v2>

- [ ] `service:normalizeorderbestratedto` — normalizeOrderBestRateDto(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L95
      v4: —
      Fix needed: <TODO: port service `service:normalizeorderbestratedto` from v2>

- [ ] `service:normalizeorderselectedratedto` — normalizeOrderSelectedRateDto(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L133
      v4: —
      Fix needed: <TODO: port service `service:normalizeorderselectedratedto` from v2>

- [ ] `service:parseorderratejson` — parseOrderRateJson(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/order-rate-dto.ts:L85
      v4: —
      Fix needed: <TODO: port service `service:parseorderratejson` from v2>

- [ ] `service:resolvecarriernickname` — resolveCarrierNickname(...) — **[MISSING]**
      v2: apps/api/src/modules/orders/application/carrier-resolver.ts:L31
      v4: —
      Fix needed: <TODO: port service `service:resolvecarriernickname` from v2>


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
