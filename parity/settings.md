# Parity: settings

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 3  |  **MATCH:** 3  |  **MISSING:** 0  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `GET /settings/:key` — GET /api/settings/:key — **[MATCH]**
      v2: apps/api/src/modules/settings/api/settings-routes.ts:L8
      v4: src/routes/settings.ts:L15

- [x] `POST /cache/clear-and-refetch` — POST /api/cache/clear-and-refetch — **[MATCH]**
      v2: apps/api/src/modules/settings/api/settings-routes.ts:L26
      v4: src/routes/rates.ts:L199
      Note: v4 moved the route under `/rates/cache-clear-and-refetch` (ownership with the rates module); frontend compat shim `apiClient.clearAndRefetchAllRates` calls the v4 path at web/src/lib/v2-apiClient.ts:L628.

- [x] `PUT /settings/:key` — PUT /api/settings/:key — **[MATCH]**
      v2: apps/api/src/modules/settings/api/settings-routes.ts:L17
      v4: src/routes/settings.ts:L24


---

**Verified-by:** _________  **Date:** _________
