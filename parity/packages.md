# Parity: packages

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 21  |  **MATCH:** 14  |  **MISSING:** 7  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `DELETE /packages/:packageid` — DELETE /api/packages/:packageId(int) — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L85
      v4: src/routes/packages.ts:L61

- [x] `GET /packages` — GET /api/packages — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L30
      v4: web/src/pages/Packages.tsx:L57

- [x] `GET /packages/:packageid` — GET /api/packages/:packageId(int) — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L72
      v4: src/routes/packages.ts:L36

- [x] `GET /packages/:packageid/ledger` — GET /api/packages/:packageId(int)/ledger — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L50
      v4: src/routes/packages.ts:L210

- [x] `GET /packages/find-by-dims` — GET /api/packages/find-by-dims — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L35
      v4: src/routes/packages.ts:L320

- [x] `GET /packages/low-stock` — GET /api/packages/low-stock — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L34
      v4: src/routes/packages.ts:L308

- [x] `PATCH /packages/:packageid/reorder-level` — PATCH /api/packages/:packageId(int)/reorder-level — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L63
      v4: src/routes/packages.ts:L242

- [x] `POST /packages` — POST /api/packages — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L31
      v4: src/routes/packages.ts:L43

- [x] `POST /packages/:packageid/adjust` — POST /api/packages/:packageId(int)/adjust — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L57
      v4: src/routes/packages.ts:L173
      Note: v4 body uses `qtyDelta` (v2 used `qty`) and writes to the new `package_ledger` table.

- [x] `POST /packages/:packageid/receive` — POST /api/packages/:packageId(int)/receive — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L51
      v4: src/routes/packages.ts:L124
      Note: v4 writes the stock delta + optional unitCost to the new `package_ledger` table in the same transaction.

- [x] `POST /packages/auto-create` — POST /api/packages/auto-create — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L46
      v4: web/src/components/Views/PackagesView.tsx:L537

- [x] `POST /packages/sync` — POST /api/packages/sync — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L49
      v4: web/src/pages/Packages.tsx:L63

- [x] `PUT /packages/:packageid` — PUT /api/packages/:packageId(int) — **[MATCH]**
      v2: apps/api/src/modules/packages/api/package-routes.ts:L79
      v4: src/routes/packages.ts:L228
      Note: v4 exposes both `PATCH /:id` (L49) and `PUT /:id` (L228) — the PUT alias was added explicitly for v2 apiClient parity.


### View: Modals / Drawers

- [x] `packages:modal:packageadjustmodal` — packages modal PackageAdjustModal — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.tsx:L1
      v4: web/src/pages/Packages.tsx:L1

- [x] `packages:modal:packagebillingdefaultmodal` — packages modal PackageBillingDefaultModal — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.tsx:L1
      v4: web/src/components/Views/PackagesView.tsx:L1


### View: Actions / Keyboard

- [x] `packages:keyboard:enter` — packages keyboard Enter — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.tsx:L1
      v4: web/src/components/Views/PackagesView.tsx:L1


### CSS Classes

- [x] `css:packages-inline-button` — .packages-inline-button — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.css:L1
      v4: web/src/components/Views/PackagesView.css:L1

- [x] `css:packages-modal` — .packages-modal — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.css:L1
      v4: web/src/components/Views/PackagesView.css:L1

- [x] `css:packages-modal-default` — .packages-modal-default — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.css:L1
      v4: web/src/components/Views/PackagesView.css:L1

- [x] `css:packages-modal-narrow` — .packages-modal-narrow — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.css:L1
      v4: web/src/components/Views/PackagesView.css:L1

- [x] `css:packages-overlay` — .packages-overlay — **[MATCH]**
      v2: apps/react/src/components/Views/PackagesView.css:L1
      v4: web/src/components/Views/PackagesView.css:L1


---

**Verified-by:** _________  **Date:** _________
