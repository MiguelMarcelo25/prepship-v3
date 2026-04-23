# Parity: inventory

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 26  |  **MATCH:** 18  |  **MISSING:** 8  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [ ] `DELETE /parent-skus/:parentskuid` — DELETE /api/parent-skus/:parentSkuId(int) — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L61
      v4: —
      Fix needed: <TODO: port route `DELETE /parent-skus/:parentskuid` from v2>

- [x] `GET /inventory` — GET /api/inventory — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L24
      v4: src/routes/inventory.ts:L21

- [ ] `GET /inventory/:inventoryid/ledger` — GET /api/inventory/:inventoryId(int)/ledger — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L67
      v4: —
      Fix needed: <TODO: port route `GET /inventory/:inventoryid/ledger` from v2>

- [ ] `GET /inventory/:inventoryid/sku-orders` — GET /api/inventory/:inventoryId(int)/sku-orders — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L68
      v4: —
      Fix needed: <TODO: port route `GET /inventory/:inventoryid/sku-orders` from v2>

- [x] `GET /inventory/alerts` — GET /api/inventory/alerts — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L32
      v4: src/routes/inventory.ts:L114

- [x] `GET /inventory/ledger` — GET /api/inventory/ledger — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L31
      v4: src/routes/inventory.ts:L60

- [x] `GET /parent-skus` — GET /api/parent-skus — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L48
      v4: src/routes/parent-skus.ts:L14

- [x] `GET /products/bulk` — GET /api/products/bulk — **[MATCH]**
      v2: apps/api/src/modules/products/api/product-routes.ts:L13
      v4: src/routes/products.ts:L45

- [x] `GET /products/by-sku/:sku` — GET /api/products/by-sku/:sku — **[MATCH]**
      v2: apps/api/src/modules/products/api/product-routes.ts:L14
      v4: src/routes/products.ts:L60

- [x] `POST /inventory/adjust` — POST /api/inventory/adjust — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L28
      v4: src/routes/inventory.ts:L469

- [x] `POST /inventory/bulk-update-dims` — POST /api/inventory/bulk-update-dims — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L45
      v4: src/routes/inventory.ts:L516

- [ ] `POST /inventory/import-dims` — POST /api/inventory/import-dims — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L42
      v4: —
      Fix needed: <TODO: port route `POST /inventory/import-dims` from v2>

- [ ] `POST /inventory/populate` — POST /api/inventory/populate — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L41
      v4: —
      Fix needed: <TODO: port route `POST /inventory/populate` from v2>

- [x] `POST /inventory/receive` — POST /api/inventory/receive — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L25
      v4: src/routes/inventory.ts:L423

- [x] `POST /parent-skus` — POST /api/parent-skus — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L58
      v4: src/routes/parent-skus.ts:L31

- [ ] `POST /products/:sku/defaults` — POST /api/products/:sku/defaults — **[MISSING]**
      v2: apps/api/src/modules/products/api/product-routes.ts:L34
      v4: —
      Fix needed: <TODO: port route `POST /products/:sku/defaults` from v2>

- [x] `POST /products/save-defaults` — POST /api/products/save-defaults — **[MATCH]**
      v2: apps/api/src/modules/products/api/product-routes.ts:L24
      v4: src/routes/products.ts:L114

- [ ] `PUT /inventory/:inventoryid` — PUT /api/inventory/:inventoryId(int) — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L85
      v4: —
      Fix needed: <TODO: port route `PUT /inventory/:inventoryid` from v2>

- [ ] `PUT /inventory/:inventoryid/set-parent` — PUT /api/inventory/:inventoryId(int)/set-parent — **[MISSING]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L74
      v4: —
      Fix needed: <TODO: port route `PUT /inventory/:inventoryid/set-parent` from v2>


### CSS Classes

- [x] `css:inventory-drawer-overlay` — .inventory-drawer-overlay — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1

- [x] `css:inventory-drawer-panel` — .inventory-drawer-panel — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1

- [x] `css:inventory-inline-button` — .inventory-inline-button — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1

- [x] `css:inventory-modal` — .inventory-modal — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1

- [x] `css:inventory-overlay` — .inventory-overlay — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1

- [x] `css:inventory-recv-row` — .inventory-recv-row — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1

- [x] `css:inventory-thumb-preview` — .inventory-thumb-preview — **[MATCH]**
      v2: apps/react/src/components/Views/InventoryView.css:L1
      v4: web/src/components/Views/InventoryView.css:L1


---

**Verified-by:** _________  **Date:** _________
