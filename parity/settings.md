# Parity: settings

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 3  |  **MATCH:** 2  |  **MISSING:** 1  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `GET /settings/:key` — GET /api/settings/:key — **[MATCH]**
      v2: apps/api/src/modules/settings/api/settings-routes.ts:L8
      v4: src/routes/settings.ts:L15

- [ ] `POST /cache/clear-and-refetch` — POST /api/cache/clear-and-refetch — **[MISSING]**
      v2: apps/api/src/modules/settings/api/settings-routes.ts:L26
      v4: —
      Fix needed: <TODO: port route `POST /cache/clear-and-refetch` from v2>

- [x] `PUT /settings/:key` — PUT /api/settings/:key — **[MATCH]**
      v2: apps/api/src/modules/settings/api/settings-routes.ts:L17
      v4: src/routes/settings.ts:L24


---

**Verified-by:** _________  **Date:** _________
