# Parity: rates

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 7  |  **MATCH:** 4  |  **MISSING:** 3  |  **Behavior review needed:** 0

<!-- Phase D verify 2026-04-23: all 3 MISSING confirmed genuinely absent; fix notes made concrete. Frontend compat shim `apiClient.fetchCarriersForStore` exists at web/src/lib/v2-apiClient.ts:555 but delegates to fetchCarrierAccounts — no dedicated backend route. -->


Generated: 2026-04-23

---

### Backend Routes

- [ ] `GET /carriers-for-store` — GET /api/carriers-for-store — **[MISSING]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L33
      v4: —
      Fix needed: Add `GET /api/carriers-for-store?storeId=…` backend route that returns `{ carriers: [] }` — today only a frontend compat shim (web/src/lib/v2-apiClient.ts:555) exists and it delegates to `/init/carrier-accounts`, returning the full carrier list rather than store-scoped carriers.

- [x] `GET /rates/cached` — GET /api/rates/cached — **[MATCH]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L42
      v4: src/routes/rates.ts:L135

- [x] `POST /rates` — POST /api/rates — **[MATCH]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L73
      v4: web/src/pages/RateShop.tsx:L93

- [x] `POST /rates/browse` — POST /api/rates/browse — **[MATCH]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L74
      v4: src/routes/rates.ts:L45

- [x] `POST /rates/cached/bulk` — POST /api/rates/cached/bulk — **[MATCH]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L62
      v4: src/routes/rates.ts:L115

- [ ] `POST /rates/prefetch` — POST /api/rates/prefetch — **[MISSING]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L77
      v4: —
      Fix needed: Add a no-op `POST /rates/prefetch` route in `src/routes/rates.ts` returning `{ queued: false, message: "Prefetch disabled - rates are cached on demand" }` to preserve v2 contract for any external callers (v2 handler: rates-handler.ts:L43 `handlePrefetchDisabled`).


### Frontend Hooks

- [ ] `hook:userates` — useRates(...) — **[MISSING]**
      v2: apps/react/src/hooks/useRates.ts:L39
      v4: —
      Fix needed: Hook was intentionally deleted in commit 04f8216 (see note at web/src/hooks/index.ts:L41) — callers now use `apiClient.fetchRates()`. If any consumer still imports `useRates`, re-add a thin wrapper at `web/src/hooks/useRates.ts` that delegates to `apiClient.fetchRates()` and exposes the `{ rates, loading, error, fetchRates, clearRates }` shape.


---

**Verified-by:** _________  **Date:** _________
