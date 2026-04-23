# Parity: inventory

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 26  |  **MATCH:** 18  |  **MISSING:** 8  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `DELETE /parent-skus/:parentskuid` — DELETE /api/parent-skus/:parentSkuId(int) — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L61
      v4: src/routes/parent-skus.ts:L53
      Note: v4 mounts router at `/parent-skus`, so `DELETE /:id{[0-9]+}` resolves to the v2 path.

- [x] `GET /inventory` — GET /api/inventory — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L24
      v4: src/routes/inventory.ts:L21

- [x] `GET /inventory/:inventoryid/ledger` — GET /api/inventory/:inventoryId(int)/ledger — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L67
      v4: src/routes/inventory.ts:L151

- [x] `GET /inventory/:inventoryid/sku-orders` — GET /api/inventory/:inventoryId(int)/sku-orders — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L68
      v4: src/routes/inventory.ts:L166

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

- [x] `POST /inventory/import-dims` — POST /api/inventory/import-dims — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L42
      v4: src/routes/inventory.ts:L621
      Note: v4 renamed to `POST /inventory/sync-products` — pulls product catalog (incl. dims/weights) from ShipStation v1 and upserts inventory rows. Same semantic as v2's importProductDimensions. See AUDIT_INVENTORY.md and v2-apiClient.ts:L1411.

- [x] `POST /inventory/populate` — POST /api/inventory/populate — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L41
      v4: src/routes/inventory.ts:L547
      Note: v4 renamed to `POST /inventory/import-from-orders` — scans `orders.items` JSONB and seeds inventory rows for unseen SKUs. Same semantic as v2's populate(). apiClient wraps it as `apiClient.populateInventory()` (v2-apiClient.ts:L1401).

- [x] `POST /inventory/receive` — POST /api/inventory/receive — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L25
      v4: src/routes/inventory.ts:L423
      Note: Batch 2 port added `newStock` to each per-item result row (post-receive `inventory.stockQty` from `applyMovement`). Closes the v2 ReceiveInventoryResultDto parity gap so receiving UIs can render the new on-hand total without a round-trip fetch.

- [x] `POST /parent-skus` — POST /api/parent-skus — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L58
      v4: src/routes/parent-skus.ts:L31

- [x] `POST /products/:sku/defaults` — POST /api/products/:sku/defaults — **[MATCH]**
      v2: apps/api/src/modules/products/api/product-routes.ts:L34
      v4: src/routes/products.ts:L114
      Note: v4 consolidated into `POST /products/save-defaults` (sku passed in body, not URL). v2's handleSaveSkuDefaults simply wraps handleSaveDefaults with the URL-param sku — same semantic. v4 apiClient uses `/products/save-defaults`.

- [x] `POST /products/save-defaults` — POST /api/products/save-defaults — **[MATCH]**
      v2: apps/api/src/modules/products/api/product-routes.ts:L24
      v4: src/routes/products.ts:L114

- [x] `PUT /inventory/:inventoryid` — PUT /api/inventory/:inventoryId(int) — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L85
      v4: src/routes/inventory.ts:L236
      Note: v4 uses `PATCH /inventory/:id` instead of PUT — same body shape and semantic (partial update of inventory item fields). v4 apiClient's `updateInventoryItem` calls `api.patch` (v2-apiClient.ts:L1189). Non-obvious: packages module added a PUT alias for v2 parity (packages.ts:L228) but inventory module did not; consider adding an equivalent PUT alias if strict method parity is required.

- [x] `PUT /inventory/:inventoryid/set-parent` — PUT /api/inventory/:inventoryId(int)/set-parent — **[MATCH]**
      v2: apps/api/src/modules/inventory/api/inventory-routes.ts:L74
      v4: src/routes/inventory.ts:L276
      Note: v4 also dual-writes to the new `inventory_sku_parents` join table (Round 4 multi-parent M2M addition) in addition to the legacy `inventory.parentSkuId` FK.


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
