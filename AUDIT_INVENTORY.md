# Inventory Feature Audit — v4-stable vs v2

**Scope:** Phase 1 read-only audit of the Inventory module. Compares v2 reference
(`x:/Private/prepship-v2`) against v4-stable
(`x:/Private/prepship-final/prepship-v4-stable`).

Sources read:
- v2 UI: [apps/react/src/components/Views/InventoryView.tsx](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx) (1534 lines)
- v2 API: [apps/api/src/modules/inventory/api/inventory-routes.ts](../../prepship-v2/apps/api/src/modules/inventory/api/inventory-routes.ts)
- v2 schema: [scripts/init-postgres.cjs](../../prepship-v2/scripts/init-postgres.cjs#L239-L288)
- v4 UI: [web/src/pages/Inventory.tsx](web/src/pages/Inventory.tsx),
  [web/src/components/InventoryDrawer.tsx](web/src/components/InventoryDrawer.tsx),
  [web/src/components/NewInventoryModal.tsx](web/src/components/NewInventoryModal.tsx)
- v4 API: [src/routes/inventory.ts](src/routes/inventory.ts)
- v4 schema: [src/db/schema/inventory.ts](src/db/schema/inventory.ts),
  [src/db/schema/parent-skus.ts](src/db/schema/parent-skus.ts)

---

## 1. Frontend gaps

### 1.1 Adjust Quantity modal — MISSING
v2 has a dedicated modal with Type picker (Receive / Return / Damage / Adjust),
Direction toggle (+Add / −Remove), qty, note, and backdate date picker
— [InventoryView.tsx:1372-1442](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1372-L1442).
v4 replaces this with two inline forms in the drawer (`Receive stock` +
`Adjust stock`) — [InventoryDrawer.tsx:155-177](web/src/components/InventoryDrawer.tsx#L155-L177)
and `MovementCard` at [InventoryDrawer.tsx:485-548](web/src/components/InventoryDrawer.tsx#L485-L548).
No type classification, no Return/Damage ledger categories, no date backdate.

### 1.2 Edit SKU modal — MISSING (only partial inline edit)
v2 edit modal covers: weight, minStock, unitsPerPack, parentSku, baseUnitQty,
**package L/W/H + product L/W/H split**, packageId, cuFtOverride
— [InventoryView.tsx:1260-1345](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1260-L1345).
v4 `SummaryCard` only edits `name` and `reorderLevel`
— [InventoryDrawer.tsx:379-483](web/src/components/InventoryDrawer.tsx#L379-L483).
Missing editable fields in v4: `unitsPerPack`, `baseUnitQty`, product-dim split,
`packageId`, `cuFtOverride`.

### 1.3 Create Parent SKU modal — PARTIAL
v2 launches a dedicated modal from the Edit-SKU select (`__create__` option) —
[InventoryView.tsx:1287-1296](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1287-L1296)
and modal body at [1347-1370](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1347-L1370).
v4 has an inline creation form inside `ParentSkuCard`
— [InventoryDrawer.tsx:224-377](web/src/components/InventoryDrawer.tsx#L224-L377).
Functional but not invokable from the (missing) Edit-SKU flow; no linkage to
`baseUnitQty` on the inventory row (that column doesn't exist in v4 — see §3).

### 1.4 Ledger / History detail — MISSING SKU drawer + global history
v2 has two distinct surfaces:
1. **Per-SKU Orders drawer** with a 30-day canvas bar chart, totals strip
   (30-day units, total orders, avg/day) and recent-orders table
   — [InventoryView.tsx:1444-1518](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1444-L1518),
   powered by `openSkuDrawer` at [L715-732](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L715-L732).
2. **Global History tab** with clientId / type / from / to filters
   — [L1198-1258](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1198-L1258).

v4 only renders a per-inventoryId ledger list inside the drawer
— [InventoryDrawer.tsx:179-214](web/src/components/InventoryDrawer.tsx#L179-L214).
No chart, no stats, no per-order linkage, no global ledger/history page.

### 1.5 Client linking — MISSING dedicated Clients tab
v2 exposes a full Clients tab inside Inventory with CRUD, ShipStation `storeIds`
input, rate-source picker, and `↻ Sync from ShipStation`
— [InventoryView.tsx:1097-1196](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1097-L1196).
v4 treats clients as a read-only filter + a group-by on the table
— [Inventory.tsx:149-160](web/src/pages/Inventory.tsx#L149-L160),
filter at [L220-233](web/src/pages/Inventory.tsx#L220-L233).
No store-IDs wiring, no rate-source field, no sync button in this view.

### 1.6 Low-stock banner — MISSING
v2 renders a prominent red pill `⚠ N Low/Out` that, when clicked, activates the
alertOnly filter — [InventoryView.tsx:793-804](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L793-L804),
populated from `/inventory/alerts`. v4 exposes only a checkbox
`Low/Out only` with no count — [Inventory.tsx:234-245](web/src/pages/Inventory.tsx#L234-L245).

### 1.7 Other UI gaps (lower priority but present in v2)
- **Bulk Edit dims mode** — inline editable cells w/ Save-All
  ([InventoryView.tsx:808-822](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L808-L822),
  [852-858](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L852-L858)).
  v4 has the **endpoint** ([inventory.ts:188-209](src/routes/inventory.ts#L188-L209)) but no UI trigger.
- **Receive tab** (multi-SKU drafts, autocomplete, per-pack hints,
  backdate) — [L1008-1095](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1008-L1095).
  v4 only supports single-item receive on a drawer.
- **Tabs shell** (Stock / Receive / Clients / History) —
  [L777-791](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L777-L791).
  v4 is a single list page.
- **Hover-zoom thumbnail preview** — [L302, 764-770, 1520-1531](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L764-L770).

---

## 2. Backend gaps

Comparison of v2 routes
([inventory-routes.ts](../../prepship-v2/apps/api/src/modules/inventory/api/inventory-routes.ts))
to v4 ([inventory.ts](src/routes/inventory.ts)):

| v2 endpoint | v4 status |
|---|---|
| `GET /api/inventory` | ✓ `GET /inventory` |
| `GET /api/inventory/ledger` (global, filters) | **MISSING** |
| `POST /api/inventory/receive` (bulk, client-scoped) | **Partial** — only per-ID `POST /inventory/:id/receive` |
| `POST /api/inventory/adjust` (typed + `adjustedAt`) | **Partial** — per-ID, no `type`/`adjustedAt` |
| `GET /api/inventory/alerts` | **MISSING** (required by low-stock banner §1.6) |
| `POST /api/inventory/populate` | ✓ equivalent: `POST /inventory/import-from-orders` ([inventory.ts:215-269](src/routes/inventory.ts#L215-L269)) |
| `POST /api/inventory/import-dims` | ✓ equivalent: `POST /inventory/sync-products` ([L275-351](src/routes/inventory.ts#L275-L351)) |
| `POST /api/inventory/bulk-update-dims` | ✓ ([L188-209](src/routes/inventory.ts#L188-L209)) |
| `GET /api/parent-skus` | ✓ (separate module) |
| `POST /api/parent-skus` | ✓ |
| `DELETE /api/parent-skus/:id` | **MISSING** |
| `GET /api/inventory/:id/ledger` | ✓ ([L65-74](src/routes/inventory.ts#L65-L74)) |
| `GET /api/inventory/:id/sku-orders` | **MISSING** — needed for SKU drawer §1.4 |
| `PUT /api/inventory/:id/set-parent` | ✓ ([L135-152](src/routes/inventory.ts#L135-L152)) |
| `PUT /api/inventory/:id` | ~ equivalent (`PATCH`) |

**Net missing:** `/alerts`, global `/ledger`, `/:id/sku-orders`, bulk
client-scoped `/receive`, typed+dated `/adjust`, `DELETE /parent-skus/:id`.

---

## 3. Schema gaps (Drizzle)

### 3.1 `inventory` table
v2 `inventory_skus` columns (from [init-postgres.cjs:249-270](../../prepship-v2/scripts/init-postgres.cjs#L249-L270))
vs v4 `inventory` ([schema/inventory.ts:15-39](src/db/schema/inventory.ts#L15-L39)):

| v2 column | v4 column | Status |
|---|---|---|
| `minstock` | `reorderLevel` | ✓ renamed |
| `weightoz` | `weightOz` | ✓ |
| `length/width/height` | `length/width/height` | ✓ (v4 treats as "package" dims) |
| `parentskuid` | `parentSkuId` | ✓ |
| `active` | `active` | ✓ |
| — | `imageUrl` | v4 addition |
| — | `stockQty` | v4 addition (v2 derived from ledger) |
| `baseunitqty` | **missing** | GAP |
| `productlength` | **missing** | GAP |
| `productwidth` | **missing** | GAP |
| `productheight` | **missing** | GAP |
| `packageid` | **missing** | GAP |
| `units_per_pack` | **missing** | GAP |
| `cuftoverride` | **missing** | GAP |

### 3.2 `inventory_ledger` table
v2 has a separate `delta INTEGER` column alongside `qty`
([init-postgres.cjs:276-286](../../prepship-v2/scripts/init-postgres.cjs#L276-L286)).
v4 `inventoryLedger` ([schema/inventory.ts:41-59](src/db/schema/inventory.ts#L41-L59))
has only `qty`. Low-impact unless something reads `delta` specifically.

### 3.3 `parent_skus` table
v2 ([init-postgres.cjs:239-247](../../prepship-v2/scripts/init-postgres.cjs#L239-L247))
and v4 ([schema/parent-skus.ts](src/db/schema/parent-skus.ts)) are equivalent
(id, clientId, name, sku, baseUnitQty, createdAt, updatedAt). ✓

---

## 4. Priority punch list

### SMALL (< 1 day each)
- **S1** Add `GET /inventory/alerts?clientId=` — returns `[{clientId, count, rows}]` for SKUs where `stockQty <= reorderLevel`. Unblocks low-stock banner.
- **S2** Add red `⚠ N Low/Out` banner in [Inventory.tsx](web/src/pages/Inventory.tsx) header; clicking sets `lowStock=true`.
- **S3** Add `DELETE /parent-skus/:id` (guard: reject if any `inventory.parentSkuId` references it).
- **S4** Extend `/inventory/:id/adjust` body with `type: 'receive'|'return'|'damage'|'adjust'` and optional `adjustedAt`, route to `inventoryLedger.type` / `.createdAt`.
- **S5** Drop `imageUrl.url()` from `createBody` validator in [inventory.ts:80](src/routes/inventory.ts#L80) or tolerate ShipStation CDN URLs — minor; flag only.

### MEDIUM (1–3 days each)
- **M1** Drizzle migration + schema update adding `baseUnitQty`, `unitsPerPack`, `productLength/Width/Height`, `packageId`, `cuFtOverride` to `inventory`. See [inventory.ts:15-39](src/db/schema/inventory.ts#L15-L39).
- **M2** Replace the `SummaryCard` inline edit with a full **Edit SKU modal** covering all fields from M1 (mirror [InventoryView.tsx:1260-1345](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1260-L1345)). Wire to `PATCH /inventory/:id`.
- **M3** Build **Adjust Quantity modal** with Type / Direction / Qty / Note / Date (mirror [InventoryView.tsx:1372-1442](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1372-L1442)).
- **M4** Add **global History tab/page**: new `GET /inventory/ledger?clientId=&type=&from=&to=` joined to SKU name, plus UI with filters (mirror [InventoryView.tsx:1198-1258](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1198-L1258)).
- **M5** **Bulk Edit dims** mode on the stock table — backend already exists at [inventory.ts:188-209](src/routes/inventory.ts#L188-L209); add toggle + inline inputs + save-all.
- **M6** **Bulk Receive** variant (`POST /inventory/receive` client-scoped, items array) + Receive tab with draft rows, SKU autocomplete, units-per-pack hint.

### LARGE (multi-day)
- **L1** **Per-SKU Orders drawer**: new `GET /inventory/:id/sku-orders` (scan `orders.items` JSONB, group by day for 30d, return orders + `dailySales`). Front-end canvas chart + stats strip + orders table (mirror [InventoryView.tsx:1444-1518](../../prepship-v2/apps/react/src/components/Views/InventoryView.tsx#L1444-L1518)). Wire SKU cells in [Inventory.tsx:302](web/src/pages/Inventory.tsx#L302) to open it.
- **L2** **Clients tab** inside Inventory (or cross-link to a clients page if one exists): CRUD, `storeIds` linking, rate-source picker, sync-from-ShipStation. Check whether v4 already has a clients surface before duplicating; if it does, add a deep-link button here.
- **L3** **Tabs shell** (Stock / Receive / Clients / History) — required only if M4/M6/L2 land and the single-list page becomes crowded.

---

**Summary:** v4's backend parity is ~60% of v2; schema is missing 7 columns on
`inventory`; the UI has the skeleton but lacks every modal of consequence
(adjust, edit-SKU, SKU-orders drawer), the global history surface, and the
low-stock banner. Landing S1–S4 + M1–M3 closes ~80% of the daily-use gap.
