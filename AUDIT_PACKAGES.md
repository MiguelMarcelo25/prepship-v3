# AUDIT — Packages feature (v2 → v4-stable)

Read-only audit. Nothing in either tree has been modified.

Sources compared:
- v2 FE: [apps/react/src/components/Views/PackagesView.tsx](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx)
- v2 BE: [apps/api/src/modules/packages/api/package-routes.ts](../../prepship-v2/apps/api/src/modules/packages/api/package-routes.ts)
- v2 SQL: `scripts/init-schema.cjs` lines 48-79 (packages + package_ledger)
- v4 FE: [web/src/pages/Packages.tsx](web/src/pages/Packages.tsx), [web/src/components/PackageModal.tsx](web/src/components/PackageModal.tsx)
- v4 BE: [src/routes/packages.ts](src/routes/packages.ts)
- v4 Drizzle: [src/db/schema/packages.ts](src/db/schema/packages.ts)

---

## 1. Frontend gaps

### 1.1 Receive-stock modal — MISSING
v2 [PackagesView.tsx:735-818](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L735-L818) renders a dedicated 📥 modal with qty, cost/unit (updates package unitCost), and optional note. Submit calls `apiClient.receivePackage(packageId, payload)` and toasts the new running total.
v4 has no equivalent. There is no 📥 action button on the row ([Packages.tsx:327-344](web/src/pages/Packages.tsx#L327-L344)).

### 1.2 Adjust-stock modal (±) — MISSING
v2 [PackagesView.tsx:820-917](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L820-L917) — toggle Add / Remove, qty, note; signed delta sent to `/adjust`.
v4: no button, no modal.

### 1.3 Inline per-package ledger — MISSING
v2 [PackagesView.tsx:355-397](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L355-L397) (toggle handler) + [:635-682](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L635-L682) (table: Date / Change / Cost / Reason / Order#). Clicking the package name expands the ledger inline. Each ledger row can deep-link to an order via `onOpenOrder`.
v4: clicking the package name opens the **edit** modal instead ([Packages.tsx:290-296](web/src/pages/Packages.tsx#L290-L296)). No ledger UI at all.

### 1.4 Billing-default modal (📋) — MISSING
v2 [PackagesView.tsx:82-175](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L82-L175) + [:469-489](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L469-L489) sets a default billing price applied to every client that hasn't overridden it. Uses `apiClient.setDefaultPackagePrice` (billing module in v2).
v4: no action button, no modal. Cross-module — depends on a `client_package_prices` table that v4 also lacks.

### 1.5 Low-stock banner — DIVERGENT
v2 [PackagesView.tsx:201-204](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L201-L204) fetches `/api/packages/low-stock` (authoritative server query).
v4 [Packages.tsx:75-78](web/src/pages/Packages.tsx#L75-L78) re-derives low-stock client-side from the full list. Works for now but will misbehave once the table grows or gets server-side filtered.

### 1.6 Row actions — INCOMPLETE
v2 [PackagesView.tsx:719-724](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L719-L724): 📥 Receive, ± Adjust, ✏️ Edit, 📋 Default, 🗑 Delete.
v4 [Packages.tsx:327-344](web/src/pages/Packages.tsx#L327-L344): only Edit and Delete.

### 1.7 Package-type selector in Add/Edit form — MISSING
v2 [PackagesView.tsx:519-529](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L519-L529) exposes a type dropdown (box / poly_mailer / envelope / flat_rate_box_sm|md|lg / flat_rate_env). Drives carrier defaults for flat-rate products.
v4 [PackageModal.tsx:116-207](web/src/components/PackageModal.tsx#L116-L207) has no type field; all new packages stay on the schema default `'box'`.

### 1.8 Sync feedback UX — REGRESSION
v2 [PackagesView.tsx:339-353](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L339-L353) shows a spinner, waits 3s, then refreshes and toasts.
v4 [Packages.tsx:51-62](web/src/pages/Packages.tsx#L51-L62) uses `alert()` (blocking dialog) for success and failure. Replace with the toast system.

### 1.9 Reorder-level save — INDIRECT
Both FEs save on blur/enter. v2 hits a dedicated `PATCH …/reorder-level` endpoint; v4 [Packages.tsx:64-68](web/src/pages/Packages.tsx#L64-L68) pipes it through the generic `PATCH /:id` (which is fine functionally but loses the narrow validation + audit surface).

---

## 2. Backend gaps

v4 [src/routes/packages.ts](src/routes/packages.ts) implements only: `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /sync`.

Missing v2 endpoints ([package-routes.ts:28-86](../../prepship-v2/apps/api/src/modules/packages/api/package-routes.ts#L28-L86)):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/packages/low-stock` | authoritative list for banner |
| GET | `/api/packages/find-by-dims?length&width&height` | pick-a-box flow |
| POST | `/api/packages/auto-create` | create-from-dims when no match |
| GET | `/api/packages/:id/ledger` | per-package stock history |
| POST | `/api/packages/:id/receive` | qty + unitCost + note → stock += qty, update unitCost, append ledger row |
| POST | `/api/packages/:id/adjust` | signed delta + note → append ledger row |
| PATCH | `/api/packages/:id/reorder-level` | narrow write for inline input |

Also missing on the list endpoint: `GET /api/packages?source=custom|shipstation` filter ([package-routes.ts:30](../../prepship-v2/apps/api/src/modules/packages/api/package-routes.ts#L30)). Today v4 returns everything and the FE splits it; fine short term, costs pagination later.

Validation surface: v2 maps `"name is required"`, `"qty must be > 0"`, `"qty is required"`, `"reorderLevel must be a number"`, `"length, width, height are required"` to HTTP 400 via `inputErrorStatusWithMessages`. v4 gets this for free with `zValidator` except for the missing endpoints.

---

## 3. Schema gaps (Drizzle)

[src/db/schema/packages.ts](src/db/schema/packages.ts) vs v2 `scripts/init-schema.cjs:48-79`:

### 3.1 `package_ledger` table — MISSING ENTIRELY
v2 columns: `id, packageId, delta, reason, note, unitCost, createdAt`. UI also reads `orderId` per-row ([PackagesView.tsx:664-675](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L664-L675)) — the column exists on the DTO and should be persisted too. None of this exists in v4.

### 3.2 Missing columns on `packages`
- `active` (boolean, default true) — v2 uses it to hide soft-deleted / deprecated carrier packages without losing their ledger history.
- `serviceCodes` (text) — v2 `service_codes`, referenced by ShipStation rate lookups.

### 3.3 Precision
v4 [schema/packages.ts:27](src/db/schema/packages.ts#L27) uses `numeric(10,2)` for `unitCost`. v2 stores 3-decimal cents and the UI formats to 3 places ([PackagesView.tsx:552](../../prepship-v2/apps/react/src/components/Views/PackagesView.tsx#L552) step=`0.001`, formatter `formatPackageUnitCost`). Widen to `numeric(10,3)`.

### 3.4 Adjacent table for billing defaults — MISSING
The 📋 flow writes to `client_package_prices` (see v2 init-schema:196-203). Not in v4. Scope call: this is billing's table, not packages', but the packages UI is the only caller — decide ownership before building it.

---

## 4. Priority punch list

### Small (few hours each)
1. Add `GET /packages/low-stock` (single query, existing `packages` table) and swap [Packages.tsx:75-78](web/src/pages/Packages.tsx#L75-L78) to consume it.
2. Add `?source=` filter to `GET /packages`.
3. Add dedicated `PATCH /packages/:id/reorder-level` and wire [Packages.tsx:64-68](web/src/pages/Packages.tsx#L64-L68) to it.
4. Widen `unitCost` to `numeric(10,3)` + migration.
5. Add `type` dropdown to [PackageModal.tsx:116-207](web/src/components/PackageModal.tsx#L116-L207) — form state already trivial to extend.
6. Replace `alert()` in [Packages.tsx:60-62](web/src/pages/Packages.tsx#L60-L62) with the toast system.

### Medium (0.5–1 day each)
7. **New table `packageLedger`** (Drizzle schema + migration): `id, packageId fk, delta, reason, note, unitCost, orderId nullable, createdAt`.
8. **Receive flow** — `POST /packages/:id/receive` handler (tx: stockQty += qty, upsert unitCost, insert ledger row) + `ReceiveModal` component + row 📥 button.
9. **Adjust flow** — `POST /packages/:id/adjust` + `AdjustModal` (Add/Remove toggle) + row ± button.
10. **Ledger view** — `GET /packages/:id/ledger` + inline expand on name click in [Packages.tsx](web/src/pages/Packages.tsx) (replace current "click name → edit" with "click name → toggle ledger"; move edit to the ✏️ icon only).
11. **Dim lookup** — `GET /packages/find-by-dims` (exact L×W×H match) + `POST /packages/auto-create`. Needed by Orders package-picker.
12. Add `active` + `serviceCodes` columns + backfill.

### Large (multi-day)
13. **Billing-default flow** — decide owning module; build `client_package_prices` table, `POST /packages/:id/default-price` (or `/billing/...`), `BillingDefaultModal` component, wire 📋 button. Cross-module change; sequence after billing audit.
14. **Parity tests** — port v2's [packages.test.ts](../../prepship-v2/apps/api/test/packages.test.ts) + [packages-parity.test.ts](../../prepship-v2/apps/react/test/packages-parity.test.ts) so future refactors hold behaviour. Formatting helpers (`formatPackageDimensionsText`, `formatPackageUnitCost`, `getPackageStockColor`, `buildLowStockBannerText`) should migrate with their tests to avoid drifting labels.
15. ShipStation sync robustness — v2's delayed-refresh pattern is a workaround for eventual consistency in SS's API; v4 should keep it when 📥/± land or else users will see stale counts after multi-stock mutations.

---

**Summary:** v4 has the CRUD skeleton and sync; everything stock-movement-related (ledger, receive, adjust, low-stock endpoint, reorder-level endpoint, dim lookup, auto-create) is absent. The biggest single unlock is item 7 + 8 + 9 + 10 — together they restore stock management, which is the whole point of the Packages page.
