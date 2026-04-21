# Phase 0 Inventory — v2 ↔ v4-stable mapping

Generated during the v2→v4 port planning. Not committed by default.
Source codebases:
- **v2** (reference): `x:\Private\prepship-v2`
- **v4-stable** (target): `x:\Private\prepship-final\prepship-v4-stable`

Stack check: v4-stable already runs React 18 + Vite 6 + Tailwind 3 + Drizzle + Postgres + Hono + Supabase auth — no platform migration needed.

---

## 1. Frontend view mapping

| # | v2 View | v2 File | v4 Page | v4 File | v4 Route | Completion | Gap Severity |
|---|---------|---------|---------|---------|----------|------------|--------------|
| 1 | Orders | `components/Views/OrdersView.tsx` (2992 lines) | Orders | `pages/Orders.tsx` | `/orders/:status/:orderId?` | ~75% | medium (in progress) |
| 2 | Inventory | `components/Views/InventoryView.tsx` | Inventory | `pages/Inventory.tsx` | `/inventory`, `/inventory/:id` | ~70% | medium |
| 3 | Analysis | `components/Views/AnalysisView.tsx` | Analysis | `pages/Analysis.tsx` | `/analysis` | ~70% | medium (diff chart lib) |
| 4 | Settings | `components/Views/SettingsView.tsx` | Settings | `pages/Settings.tsx` | `/settings` | ~80% | small |
| 5 | Packages | `components/Views/PackagesView.tsx` | Packages | `pages/Packages.tsx` | `/packages` | ~75% | medium |
| 6 | Locations | `components/Views/LocationsView.tsx` | Locations | `pages/Locations.tsx` | `/locations` | ~80% | small |
| 7 | Manifests | `components/Views/ManifestsView.tsx` (modal in v2) | Manifest | `pages/Manifest.tsx` (page in v4) | `/manifest` | ~60% | medium |
| 8 | Rates | `components/Views/RatesView.tsx` | RateShop | `pages/RateShop.tsx` | `/rates` | ~65% | small |
| 9 | Billing | `components/Views/BillingView.tsx` | Billing | `pages/Billing.tsx` | `/billing` | ~75% | medium |

**v4-only pages (no v2 equivalent — keep as-is):**
- Picklist (`pages/Picklist.tsx`) — v2 has this as a button inside Orders
- Clients (`pages/Clients.tsx`)
- Products (`pages/Products.tsx`)
- Invoice (`pages/Invoice.tsx`)
- Login (`pages/Login.tsx`)

---

## 2. Shared shell components

| Component | v2 Location | v4 Location | Status |
|-----------|-------------|-------------|--------|
| Sidebar shell | `components/Sidebar/Sidebar.tsx` | `components/Sidebar.tsx` | simplified in v4 |
| Sidebar orders section (per-store/status) | `components/Sidebar/SidebarOrders.tsx` | — | **missing** |
| Sidebar workspace picker | `components/Sidebar/SidebarWorkspace.tsx` | — | **missing** |
| Sidebar date-range filter | `components/Sidebar/SidebarFilter.tsx` | — | **missing** |
| Topbar | inline in `Home.tsx` | `components/Topbar.tsx` | both present |
| Layout / route wrapper | inline in `Home.tsx` | `components/Layout.tsx` | both present |
| Auth guard | inline | `components/ProtectedRoute.tsx` | both present |
| Stores context | `contexts/StoresContext.tsx` | — (React Query) | different model |
| Markups context | `contexts/MarkupsContext.tsx` | — (local state) | different model |
| Toast / notifications | `contexts/ToastContext.tsx` | inline / TBD | partial |
| Print Queue drawer | inline in OrdersView | `components/PrintQueueDrawer.tsx` | v4 present |
| Sync worker status pill | inline in Home.tsx | partial (button only) | **partial** |
| Zoom menu | inline in Home.tsx | — | **missing** |
| Mobile menu toggle | inline in Home.tsx | — | **missing** |

---

## 3. Sub-components per view (gaps in v4)

### Orders
- **Missing**: Rate Browser modal (v2's `/api/rates/browse` flow)
- Present: OrderDrawer, BatchLabelModal, ColumnsPopover, PrintQueueDrawer, OrdersTopbarActions

### Inventory
- **Missing**: adjust quantity modal (receive/return/damage), edit SKU modal, create parent SKU modal, inventory ledger detail view, client-link form, low-stock banner
- Present: InventoryDrawer, NewInventoryModal

### Packages
- **Missing**: receive-quantity modal, adjust-quantity modal (with sign toggle), billing default price modal, per-package ledger view, low-stock banner
- Present: PackageModal (basic CRUD only)

### Billing
- **Missing**: detail drilldown modal (per-client breakdown), backfill ref-rates workflow UI, PDF invoice link
- Present: config table, summary table, package pricing, date range picker, generate invoices button

### Manifests
- Structure changed: v2 is a modal overlay, v4 is a full page. Feature parity exists + v4 enhancements.

### Analysis
- Uses Recharts (v4) vs canvas (v2) — visual output differs

### Locations, Rates, Settings
- Near parity. Small polish items only.

---

## 4. Backend endpoint coverage

**Total v2 endpoints:** ~90
**Matched in v4:** ~65 (~72%)
**v4-only (new):** ~25
**Fully missing in v4:** ~15

### Resource-by-resource status

| Resource | Present | Partial | Missing | New in v4 |
|----------|---------|---------|---------|-----------|
| Orders | 14 | 5 (field mutations collapsed into PATCH) | 2 (export, dims save) | — |
| Clients | 5 | — | 1 (reattribute) | 3 (order-stats, unassigned-orphans, backfill) |
| Products | 3 | — | 1 (save defaults shape) | 5 (list/CRUD) |
| Inventory | 10 | 4 (dimension endpoints) | 4 (alerts, populate, import-dims, sku-orders) | 4 (stats, import-from-orders, sync-products, get-single) |
| Packages | 8 | — | 5 (ledger, receive, adjust, reorder-level, low-stock) | — |
| Locations | 6 | — | — | 1 (sync warehouses) |
| Rates | 4 | 1 (body shape) | 3 (carriers-for-store, browse, prefetch) | 5 (carriers, backfill jobs x3, cache purge) |
| Shipments | 4 | — | 2 (sync, worker-status) | 1 (get-single) |
| Settings | 3 | — | 1 (cache clear/refetch) | 2 (list, delete) |
| Manifests | 2 | — | — | — |
| Billing | 9 | — | 1 (invoice HTML) | 1 (ref-rates query) |
| Labels | 4 | 1 (create shape) | 2 (mock, return) | — |
| Analysis | 0 | — | 2 (skus, daily-sales) | 5 (overview, daily, sku-breakdown, top-skus, etc.) |
| Init | 2 | — | 3 (stores, carriers, refresh) | — |
| Print Queue | 7 | — | — | — (path prefix changed) |

### Critical backend gaps driving frontend port

1. **Packages**: receive, adjust, ledger, reorder-level — blocks Packages UI port
2. **Inventory**: low-stock alerts, sku-orders, import-dims — blocks Inventory UI port
3. **Rates**: `/rates/browse` — blocks Rate Browser modal in Orders
4. **Billing**: `/billing/invoice` HTML rendering — blocks invoice PDF link
5. **Labels**: mock, return — blocks test/refund flows
6. **Sync**: worker-status endpoint — blocks sync pill UI

---

## 5. DB schema state (Drizzle, Postgres)

v4 schemas present:
`orders, orderOverrides, clients, products, inventory, inventoryLedger, shipments, locations, packages, rateCache, billingConfig, clientPackagePrices, billingRefRates, settings, parentSkus, printQueueOrders, printMergeJobs`

v4 is **more normalized** than v2:
- v4 splits overrides into `orderOverrides` (v2 stuffed them into raw JSON)
- v4 has first-class `products`, `parentSkus` (v2 nested inside inventory)
- v4 has `inventoryLedger`, `clientPackagePrices`, `billingRefRates` (new)

No schema migrations needed to reach parity — v4's schema is a superset of v2's.

---

## 6. Workers / background jobs

**v2:** separate `apps/worker` process with `orders.sync.shadow` and `OrderStatusSyncWorker` running on interval.
**v4:** no pg-boss or persistent queue. Sync is triggered on-demand via `/sync/orders` or `/cron/sync-orders`. Rate-backfill and print-merge use in-memory Map-based job tracking.

**Gap:** v4 has `pg-boss` in dependencies but doesn't appear to use it yet. If we want v2-style auto-sync we either:
- Wire pg-boss jobs (proper), or
- Rely on external cron hitting `/cron/sync-orders` (simpler, Vercel-friendly)

---

## 7. Auth differences

| | v2 | v4 |
|---|---|---|
| Mechanism | Custom `X-App-Token` header | Supabase JWT (Bearer) |
| User identity | Token value only | Full user object (id, email, role) |
| Role support | none | `app_metadata.role` |
| Cron protection | N/A | `x-cron-secret` header |

**No action needed** — v4's auth is stricter and better. v2-style auth is not being ported.

---

## 8. Key observations for Phase 1 planning

1. **v4 is 60-80% complete per view** — this is mostly polish + missing modals/ledgers, not ground-up rewrites.
2. **Biggest backend gaps cluster in Packages** — 5 missing endpoints. Phase 2 should tackle Packages first.
3. **Rate Browser modal** in Orders is the single biggest v2 feature missing from v4.
4. **Sidebar** needs the most work: missing per-store breakdown, workspace picker, date-range filter.
5. **Analysis** uses a different chart library (Recharts) — decide whether to match v2's canvas style or keep Recharts. Recommend keeping Recharts.
6. **Manifests** changed from modal to page — this is an improvement, keep v4's approach.
7. Several v2 features have no v4 equivalent but are valuable (zoom menu, mobile menu, sync worker pill) — add these in Phase 4 polish.

---

## Open questions for user

- **Sidebar per-store breakdown**: v2 shows awaiting/shipped counts per store/client inside the sidebar. v4 shows per-client only. Port v2's behavior or keep v4's?
- **Zoom menu**: worth porting? (affects table density in v2)
- **pg-boss vs cron**: which background job model?
- **Dev DB seed**: is there realistic seed data, or do we need to generate some?
- **Sync worker pill**: port the status-display UI in Topbar?

---

## Recommended Phase 1 priority (based on gap severity)

1. **Orders** — finish the in-progress work + Rate Browser modal
2. **Packages** — biggest backend gap, then UI ledger/receive/adjust modals
3. **Inventory** — adjust/edit/parent-SKU modals + ledger
4. **Billing** — detail drilldown modal + invoice rendering
5. **Sidebar** — per-store breakdown, workspace picker
6. **Manifests / Rates / Settings / Locations / Analysis** — smaller polish items
