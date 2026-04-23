# Parity: locations

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 6  |  **MATCH:** 6  |  **MISSING:** 0  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `DELETE /locations/:locationid` — DELETE /api/locations/:locationId(int) — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L31
      v4: src/routes/locations.ts:L58

- [x] `GET /locations` — GET /api/locations — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L21
      v4: web/src/pages/Locations.tsx:L32

- [x] `POST /locations` — POST /api/locations — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L22
      v4: src/routes/locations.ts:L40

- [x] `POST /locations/:locationid/set-default` — POST /api/locations/:locationId(int)/setDefault — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L34
      v4: src/routes/locations.ts:L65
      Note: v4 path is `/:id/default` (not `/setDefault`); frontend compat shim calls the v4 path at web/src/lib/v2-apiClient.ts:L1528.

- [x] `PUT /locations/:locationid` — PUT /api/locations/:locationId(int) — **[MATCH]**
      v2: apps/api/src/modules/locations/api/location-routes.ts:L25
      v4: src/routes/locations.ts:L46
      Note: v4 uses `PATCH /:id` with a `body.partial()` validator instead of PUT; frontend compat shim (`apiClient.updateLocation`) calls the v4 path with PATCH at web/src/lib/v2-apiClient.ts:L1501.


### Frontend Hooks

- [x] `hook:uselocations` — useLocations(...) — **[MATCH]**
      v2: apps/react/src/hooks/useLocations.ts:L11
      v4: web/src/hooks/useLocations.ts:L12


---

**Verified-by:** _________  **Date:** _________
