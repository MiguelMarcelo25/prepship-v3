# Parity: rates

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 7  |  **MATCH:** 4  |  **MISSING:** 3  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [ ] `GET /carriers-for-store` — GET /api/carriers-for-store — **[MISSING]**
      v2: apps/api/src/modules/rates/api/rates-routes.ts:L33
      v4: —
      Fix needed: <TODO: port route `GET /carriers-for-store` from v2>

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
      Fix needed: <TODO: port route `POST /rates/prefetch` from v2>


### Frontend Hooks

- [ ] `hook:userates` — useRates(...) — **[MISSING]**
      v2: apps/react/src/hooks/useRates.ts:L39
      v4: —
      Fix needed: <TODO: port hook `hook:userates` from v2>


---

**Verified-by:** _________  **Date:** _________
