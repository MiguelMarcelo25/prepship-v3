# Parity: locations

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 6  |  **MATCH:** 3  |  **MISSING:** 3  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [ ] `DELETE /locations/:locationid` — DELETE /api/locations/:locationId(int) — **[MISSING]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L31
      v4: —
      Fix needed: <TODO: port route `DELETE /locations/:locationid` from v2>

- [x] `GET /locations` — GET /api/locations — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L21
      v4: web/src/pages/Locations.tsx:L32

- [x] `POST /locations` — POST /api/locations — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L22
      v4: src/routes/locations.ts:L40

- [ ] `POST /locations/:locationid/set-default` — POST /api/locations/:locationId(int)/setDefault — **[MISSING]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L34
      v4: —
      Fix needed: <TODO: port route `POST /locations/:locationid/set-default` from v2>

- [ ] `PUT /locations/:locationid` — PUT /api/locations/:locationId(int) — **[MISSING]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L25
      v4: —
      Fix needed: <TODO: port route `PUT /locations/:locationid` from v2>


### Frontend Hooks

- [x] `hook:uselocations` — useLocations(...) — **[MATCH]**
      v2: apps/react/src/hooks/useLocations.ts:L11
      v4: web/src/hooks/useLocations.ts:L12


---

**Verified-by:** _________  **Date:** _________
