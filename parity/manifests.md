# Parity: manifests

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 18  |  **MATCH:** 18  |  **MISSING:** 0  |  **Behavior review needed:** 0

Generated: 2026-04-23

<!-- Phase E 2026-04-23: POST /manifests/generate ported at src/routes/manifests.ts — flipped to MATCH. -->

---

### Backend Routes

- [x] `GET /manifests/generate` — GET /api/manifests/generate — **[MATCH]**
      v2: apps/api/src/modules/manifests/api/manifests-routes.ts:L33
      v4: src/routes/manifests.ts:L17

- [x] `POST /manifests/generate` — POST /api/manifests/generate — **[MATCH]**
      v2: apps/api/src/modules/manifests/api/manifests-routes.ts:L25
      v4: src/routes/manifests.ts:L80
      Note: POST body accepts either v2 (`startDate/endDate/carrierId/clientId`) or v4 (`dateFrom/dateTo/carrierCode/clientId`) field names, normalized through a shared `loadManifest()` helper so GET and POST emit the identical response shape.


### CSS Classes

- [x] `css:manifest-body` — .manifest-body — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-close` — .manifest-close — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-date-row` — .manifest-date-row — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-fields` — .manifest-fields — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-footer` — .manifest-footer — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-header` — .manifest-header — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-header-title` — .manifest-header-title — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-help` — .manifest-help — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-inline-copy` — .manifest-inline-copy — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-label` — .manifest-label — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-modal` — .manifest-modal — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-overlay` — .manifest-overlay — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-select` — .manifest-select — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-status` — .manifest-status — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:manifest-summary` — .manifest-summary — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1

- [x] `css:ship-select` — .ship-select — **[MATCH]**
      v2: apps/react/src/components/Views/ManifestsView.css:L1
      v4: web/src/components/Views/ManifestsView.css:L1


---

**Verified-by:** _________  **Date:** _________
