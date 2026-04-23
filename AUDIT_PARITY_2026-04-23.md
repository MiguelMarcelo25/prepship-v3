# v2 → v4-stable Parity Gap Analysis — 2026-04-23

**Scope:** full-stack parity scan across backend routes/services, frontend views/hooks/apiClient, database schema, and worker jobs. Supersedes the module-specific audits dated 2026-04-21 (which are stale after ~30 commits of parity work).

**Source of truth:** `x:/Private/prepship-final/v2orginal/` (SQLite + monorepo — `apps/api`, `apps/react`, `apps/web`, `apps/worker`, `packages/contracts`, `packages/shared`).

**Target:** `x:/Private/prepship-final/prepship-v4-stable/` (Hono + Drizzle + Postgres/Supabase backend, Vite + React + TanStack Query frontend).

---

## 1. Summary score

| Area | v2 surface | v4 surface | Parity | Notes |
|---|---|---|---|---|
| Backend routes | ~80 endpoints across 14 modules | ~95 endpoints across 20 modules | ~75% | Most CRUD present; several v2 endpoints not yet ported |
| Database schema | ~18 tables (SQLite) | 21 tables (Postgres/Drizzle) | **100%** | Round 4: added inventory_sku_parents, return_labels, mock_labels, product_defaults, sync_meta (migration 0014). v4 is now a superset of v2. |
| Worker/cron | 1 job skeleton | Sync-scheduler + cron routes | 100%+ | v4 is actually ahead — in-process scheduler already running |
| Frontend views | 9 Views + 12 hooks + 4 contexts | ~14 pages + ~14 hooks + 4 contexts | ~70% | Bulk-copied OrdersView/InventoryView work but several features partial |
| apiClient methods | ~120 methods | ~120 methods (compat shim) | ~90% | Shim `web/src/lib/v2-apiClient.ts` covers most; 6 still `notImpl()`, several "semantic mismatch" |
| Contracts/DTOs | 16 modules of exported types | Inlined structural types | Acceptable | v4 chose to inline vs copy packages/contracts — pragmatic |

**Overall: ~80% parity.** Remaining 20% is mostly discrete backend endpoints and the last-mile wiring of already-ported UI stubs.

---

## 2. Backend gaps (v4 missing vs v2)

### Orders — `src/routes/orders.ts`
Missing endpoints (high priority — blocks full OrdersView):
- `GET /orders/:id/full` — full order with line items + shipments (v4 has only `/orders/:id`)
- `GET /orders/ids` — find order IDs by SKU (query: `sku`)
- `GET /orders/picklist` — picklist aggregation for pick-pack workflow
- `GET /orders/store-counts` — order count per storeId
- `POST /orders/:id/shipped-external` — mark externally shipped (body: `{externalShipped, source?}`) — v4 PATCH /:id schema currently rejects these fields
- `POST /orders/:id/residential` — dedicated endpoint (v4 uses PATCH /:id)
- `POST /orders/:id/selected-pid` — dedicated endpoint
- `POST /orders/:id/selected-package-id` — dedicated endpoint
- `POST /orders/:id/best-rate` — dedicated endpoint

Note: v4 supports most of these via `PATCH /orders/:id` with body fields — but v2 apiClient calls the dedicated routes. Decision: add thin POST aliases that forward to the same update logic OR widen PATCH schema and fix the v2 shim. **Recommendation: add POST aliases** (matches v2 shape exactly, no shim refactor).

### Labels — `src/routes/labels.ts`
Path differences (pure aliasing, cheap to fix):
- v2 `POST /labels/create` → v4 `POST /labels` — add alias
- v2 `POST /labels/create-batch` → v4 `POST /labels/batch` — add alias
- v2 `GET /labels/:lookup/retrieve` → v4 `GET /labels/:id` — add alias
- v2 `POST /labels/:id/void` / `/return` ✓ (parity)

### Inventory — `src/routes/inventory.ts`
Missing:
- `GET /inventory/alerts` — low-stock alerts (v2 `InventoryAlertDto[]`)
- `GET /inventory/:id/sku-orders` — orders consuming a SKU (+30-day sales chart data)
- `PUT /inventory/:id/set-parent` — assign a parent SKU
- `POST /inventory/populate` — seed from order history (v4 has `/inventory/import-from-orders` — different path, same semantic)
- `POST /inventory/import-dims` — import dims (v4 has `/sync-products` — different)
- `POST /inventory/bulk-update-dims` — bulk dim update

### Packages — `src/routes/packages.ts`
Missing:
- `GET /packages/low-stock` — dedicated endpoint (v2-apiClient derives client-side)
- `GET /packages/find-by-dims` — find by LWH
- `POST /packages/auto-create` — auto-create from dims
- `PATCH /packages/:id/reorder-level` — dedicated endpoint (v4 uses general PATCH)

### Analysis — `src/routes/analysis.ts`
Missing (big gap — blocks AnalysisView chart + SKU table):
- `GET /analysis/skus` — SKU performance metrics (query: clientId, dateFrom/To, search)
- `GET /analysis/daily-sales` — time-series top-SKU sales

v4 has only `/analysis/overview` (a single-KPI endpoint).

### Init — `src/routes/init.ts`
Missing:
- `GET /stores` — ShipStation store list (v4 has `/init-data` with partial data; v2 has separate)
- `GET /carriers` — carrier list
- `GET /carrier-accounts` — carrier account list
- `POST /cache/refresh-carriers` — force-refresh

### Clients — `src/routes/clients.ts`
Missing:
- `POST /clients/sync-stores` — sync all ShipStation stores → clients (v4 has per-client `/:id/backfill-orders` — different semantic)

### Settings — `src/routes/settings.ts`
Missing:
- `POST /cache/clear-and-refetch` — clear rate cache + force refetch

### Products — `src/routes/products.ts`
Missing:
- `POST /products/save-defaults` — v4 has `POST /products` for create but no dedicated defaults endpoint

### Summary: ~23 missing/aliased endpoints. ~5 days of backend work at 4-5 endpoints/day with tests.

---

## 3. Database schema gaps

v4 Drizzle schema is 95% parity-ready. Minor items:

- **`skuQtyDims`** — v4 has this table; v2 doesn't. Keep; v4 enhancement.
- **`return_labels`** — v2 has a separate table; v4 uses `shipments.isReturn + returnForShipmentId + returnReason` columns. Cleaner; keep v4 approach but verify v2 apiClient's `createReturnLabel` return shape matches.
- **`inventory_sku_parents` (many-to-many)** — v2 has it; v4 uses a single `parentSkuId` FK on `inventory`. v4 approach can't model multi-parent membership. **Decision needed**: if v2 never used M2M in practice, keep v4's simpler shape; otherwise add the join table.
- **`products.defaults` split** — v2 has a separate `product_defaults` table; v4 inlines defaults on `products`. Cleaner; keep v4.
- **`mock_labels`** — v2 has table; v4 uses in-memory. v4 mock labels don't survive restart; acceptable for dev.
- **`sync_meta`** — v4 uses general `settings` KV table. Acceptable.
- **`carrier_accounts`** — neither v2 nor v4 persists these; both use in-memory cache from ShipStation. Parity.

**Action items:**
- (optional) Confirm no multi-parent SKU usage in v2 production data before committing to v4's FK-based parent model
- No migrations needed for parity — all listed gaps are implementable on current schema

---

## 4. Frontend gaps

`web/src/lib/v2-apiClient.ts` currently has:
- **6 `notImpl()` stubs** (per round-6 coordination log): `markOrderShippedExternal`, `fetchShipmentSyncStatus`, `triggerShipmentSync`, `clearAndRefetchAllRates`, `fetchInventoryLedger` (global), `fetchInventorySkuOrders`
- **6 "semantic mismatch" methods**: `populateInventory`, `importInventoryDimensions`, `fetchAnalysisDailySales`, `fetchAnalysisSkus`, `downloadManifest`, `setPackageReorderLevel`
- **Derivation methods**: `fetchLowStockPackages`, `fetchInventoryAlerts` (client-side derived, not server-queried)

Once backend gaps above land, these all become one-line swaps (remove `notImpl`, point at real route).

**Views in v4 matching v2:**
| v2 View | v4 path | Status |
|---|---|---|
| OrdersView | `web/src/components/Views/OrdersView.tsx` | ~85% (missing `.full` details, externally-shipped button) |
| AnalysisView | `web/src/components/Views/AnalysisView.tsx` | ~40% — missing chart + SKU drill-down (backend gap) |
| BillingView | `web/src/components/Views/BillingView.tsx` | ~95% (recent commits closed most gaps) |
| InventoryView | `web/src/components/Views/InventoryView.tsx` | ~65% — missing alerts tab, SKU-orders drawer, parent SKU UI |
| LocationsView | `web/src/components/Views/LocationsView.tsx` | ~100% |
| PackagesView | `web/src/components/Views/PackagesView.tsx` | ~90% (missing low-stock banner, find-by-dims search) |
| RatesView | `web/src/components/Views/RatesView.tsx` | ~100% |
| ManifestsView | `web/src/components/Views/ManifestsView.tsx` | ~90% (semantic mismatch on downloadManifest) |
| SettingsView | `web/src/components/Views/SettingsView.tsx` | ~90% (clearAndRefetch not wired) |

---

## 5. Worker parity

**v2 worker is a no-op skeleton.** v4 already has `src/services/sync-scheduler.ts` running in-process every 3 minutes, plus `src/routes/cron.ts` with GET/POST `/sync-orders`, `/sync-shipments`, `/sync-all` behind a `x-cron-secret` header.

**v4 is AHEAD of v2 here.** No porting needed — may even want to retire the v2 `apps/worker/` concept.

---

## 6. Prioritized punch list

Ordered by blast radius (most UI features unblocked per hour of work).

### P0 — blocks major UI flows (~5 days)
1. Orders: `POST /orders/:id/shipped-external` + `/residential` + `/selected-pid` + `/selected-package-id` + `/best-rate` aliases
2. Orders: `GET /orders/:id/full`, `/orders/ids`, `/orders/picklist`, `/orders/store-counts`
3. Analysis: `GET /analysis/skus` + `/analysis/daily-sales` (unblocks AnalysisView chart)
4. Inventory: `GET /inventory/alerts` + `/:id/sku-orders` (unblocks Alerts tab + SKU drill-down drawer)

### P1 — polish/convenience (~2 days)
5. Labels path aliases (`/labels/create`, `/labels/create-batch`, `/:lookup/retrieve`)
6. Packages: `GET /packages/low-stock`, `/find-by-dims`, `POST /packages/auto-create`, `PATCH /packages/:id/reorder-level`
7. Inventory: `PUT /:id/set-parent`, `POST /populate`, `/bulk-update-dims`, `/import-dims`
8. Settings: `POST /cache/clear-and-refetch`
9. Init: `GET /stores`, `/carriers`, `/carrier-accounts`, `POST /cache/refresh-carriers`

### P2 — edge cases (~1 day)
10. Clients: `POST /clients/sync-stores`
11. Products: `POST /products/save-defaults`
12. Frontend: unstub all 6 `notImpl()` and 6 semantic-mismatch methods

### P3 — frontend polish (~2 days)
13. AnalysisView chart integration (Recharts — per 2026-04-21 decision log)
14. InventoryView Alerts tab + SKU-orders drawer + parent SKU tab
15. PackagesView low-stock banner

**Total estimate: ~10 days of focused work for 100% parity.**

---

## 7. Porting strategy (rounds)

- **Round 1 (this session):** P0 backend endpoints — Orders + Analysis + Inventory alerts/sku-orders.
- **Round 2:** P1 backend — Labels aliases + Packages + Inventory management.
- **Round 3:** P2 + frontend wiring — unstub v2-apiClient, clear notImpls.
- **Round 4:** P3 — UI parity pass (AnalysisView chart, InventoryView tabs, Packages banner).
- **Round 5:** Typecheck + frontend build + manual smoke test. User review + commit.

No commits during implementation. Per user's standing rule (COORDINATION.md decisions log 2026-04-21): user review before each commit batch.
