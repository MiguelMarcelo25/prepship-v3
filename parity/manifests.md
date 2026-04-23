# Parity: manifests

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 18  |  **MATCH:** 17  |  **MISSING:** 1  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `GET /manifests/generate` — GET /api/manifests/generate — **[MATCH]**
      v2: apps/api/src/modules/manifests/api/manifests-routes.ts:L33
      v4: src/routes/manifests.ts:L17

- [ ] `POST /manifests/generate` — POST /api/manifests/generate — **[MISSING]**
      v2: apps/api/src/modules/manifests/api/manifests-routes.ts:L25
      v4: —
      Fix needed: Add `POST /api/manifests/generate` in `src/routes/manifests.ts` that reads `{ startDate, endDate, carrierId?, clientId? }` from the JSON body and returns the same manifest download response as the existing `GET /generate` handler (src/routes/manifests.ts:L17). v2 supports both GET (query) and POST (JSON body) for the same operation.
      Classification: FIX_NEEDED — v4 only implements GET; trivial to add POST alias accepting the same body shape. [priority: LOW]


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
