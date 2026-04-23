# Parity: _config

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 198  |  **MATCH:** 189  |  **MISSING:** 9  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [x] `DELETE /clients/:clientid` — DELETE /api/clients/:clientId(int) — **[MATCH]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L28
      v4: src/routes/clients.ts:L59

- [x] `GET /carriers` — GET /api/carriers — **[MATCH]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L14
      v4: src/routes/init.ts:L138

- [x] `GET /carriers` — GET /api/carrier-accounts — **[MATCH]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L15
      v4: src/routes/init.ts:L106

- [x] `GET /clients` — GET /api/clients — **[MATCH]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L19
      v4: web/src/pages/Picklist.tsx:L51

- [x] `GET /counts` — GET /api/counts — **[MATCH]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L12
      v4: src/routes/init.ts:L39
      Note: mounted under /init prefix (GET /init/counts) rather than root.

- [x] `GET /health` — GET /health — **[MATCH]**
      v2: apps/api/src/app/create-app.ts:L55
      v4: src/routes/health.ts:L6

- [x] `GET /init-data` — GET /api/init-data — **[MATCH]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L11
      v4: src/routes/init.ts:L13
      Note: mounted under /init prefix (GET /init/init-data) rather than root.

- [x] `GET /labels/:lookup/retrieve` — GET /api/labels/:lookup/retrieve — **[MATCH]**
      v2: apps/api/src/modules/labels/api/label-routes.ts:L98
      v4: src/routes/labels.ts:L200

- [x] `GET /labels/mock/:shipmentid` — GET /api/labels/mock/:shipmentId — **[MATCH]**
      v2: apps/api/src/modules/labels/api/label-routes.ts:L74
      v4: src/routes/labels.ts:L168

- [x] `GET /shipments` — GET /api/shipments — **[MATCH]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L20
      v4: src/routes/shipments.ts:L45

- [x] `GET /shipments/status` — GET /api/shipments/status — **[MATCH]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L8
      v4: web/src/lib/v2-apiClient.ts:L611

- [x] `GET /stores` — GET /api/stores — **[MATCH]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L13
      v4: src/routes/init.ts:L119
      Note: mounted under /init prefix (GET /init/stores) rather than root.

- [x] `GET /sync/status` — GET /api/sync/status — **[MATCH]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L9
      v4: src/routes/sync.ts:L31

- [ ] `POST /cache/refresh-carriers` — POST /api/cache/refresh-carriers — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L16
      v4: —
      Fix needed: Add `POST /init/cache/refresh-carriers` handler in `src/routes/init.ts` that resets the in-process carrier cache in `src/services/rates.ts` (set module-level `cachedCarrierIds = null; carriersFetchedAt = 0;` via an exported `resetCarrierCache()` helper) and re-invokes `ssRequest<CarriersResponse>('/v2/carriers', { dedupeKey: 'carriers:list' })` so the next rate call sees fresh carrier IDs. Return `{ ok: true, count: <carriers.length> }`.
      Classification: INTENTIONALLY_CHANGED — v4 has 15-min TTL auto-refresh in `src/services/rates.ts`; explicit refresh endpoint unnecessary.

- [x] `POST /clients` — POST /api/clients — **[MATCH]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L20
      v4: web/src/lib/v2-apiClient.ts:L506

- [x] `POST /clients/sync-stores` — POST /api/clients/sync-stores — **[MATCH]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L21
      v4: web/src/pages/Clients.tsx:L57

- [x] `POST /labels/:shipmentid/return` — POST /api/labels/:shipmentId(int)/return — **[MATCH]**
      v2: apps/api/src/modules/labels/api/label-routes.ts:L89
      v4: src/routes/labels.ts:L150

- [x] `POST /labels/:shipmentid/void` — POST /api/labels/:shipmentId(int)/void — **[MATCH]**
      v2: apps/api/src/modules/labels/api/label-routes.ts:L80
      v4: src/routes/labels.ts:L137

- [x] `POST /labels/create` — POST /api/labels/create — **[MATCH]**
      v2: apps/api/src/modules/labels/api/label-routes.ts:L39
      v4: src/routes/labels.ts:L107

- [x] `POST /labels/create-batch` — POST /api/labels/create-batch — **[MATCH]**
      v2: apps/api/src/modules/labels/api/label-routes.ts:L21
      v4: web/src/lib/v2-apiClient.ts:L929

- [x] `POST /shipments/sync` — POST /api/shipments/sync — **[MATCH]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L7
      v4: web/src/lib/v2-apiClient.ts:L619

- [x] `POST /sync/trigger` — POST /api/sync/trigger — **[MATCH]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L10
      v4: src/routes/sync.ts:L17
      Note: v4 exposes this as POST /sync/orders (legacy order-sync trigger); v2-apiClient.triggerLegacySync() calls /sync/orders.

- [x] `PUT /clients/:clientid` — PUT /api/clients/:clientId(int) — **[MATCH]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L22
      v4: src/routes/clients.ts:L47
      Note: v4 uses PATCH semantics (partial body via `body.partial()`) instead of PUT; same update endpoint.


### Services

- [x] `service:generatefakeshipmentid` — generateFakeShipmentId(...) — **[MATCH]**
      v2: apps/api/src/modules/labels/application/mock-label-generator.ts:L170
      v4: src/services/mock-label-generator.ts:L68

- [x] `service:generatefaketrackingnumber` — generateFakeTrackingNumber(...) — **[MATCH]**
      v2: apps/api/src/modules/labels/application/mock-label-generator.ts:L165
      v4: src/services/mock-label-generator.ts:L63

- [x] `service:generatemocklabelhtml` — generateMockLabelHtml(...) — **[MATCH]**
      v2: apps/api/src/modules/labels/application/mock-label-generator.ts:L47
      v4: src/services/mock-label-generator.ts:L27

- [x] `service:generatemocklabelpdf` — generateMockLabelPdf(...) — **[MATCH]**
      v2: apps/api/src/modules/labels/application/mock-label-generator.ts:L194
      v4: src/services/mock-label-generator.ts:L87

- [x] `service:servicecodetolabel` — serviceCodeToLabel(...) — **[MATCH]**
      v2: apps/api/src/modules/labels/application/mock-label-generator.ts:L175
      v4: src/services/mock-label-generator.ts:L72


### DB Schema

- [x] `column:clients.active` — column clients.active INTEGER — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L17

- [x] `column:clients.client_id` — column clients.clientId INTEGER — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L4
      Note: v4 renamed `clientId INTEGER` to `id SERIAL PRIMARY KEY` (auto-increment); same role as PK.

- [x] `column:clients.contact_name` — column clients.contactName TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L7

- [x] `column:clients.created_at` — column clients.createdAt INTEGER — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L23

- [x] `column:clients.email` — column clients.email TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L8

- [x] `column:clients.name` — column clients.name TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L5

- [x] `column:clients.phone` — column clients.phone TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L9

- [x] `column:clients.rate_source_client_id` — column clients.rate_source_client_id INTEGER — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L13

- [x] `column:clients.ss_api_key` — column clients.ss_api_key TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L10

- [x] `column:clients.ss_api_key_v2` — column clients.ss_api_key_v2 TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L12

- [x] `column:clients.ss_api_secret` — column clients.ss_api_secret TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L11

- [x] `column:clients.store_ids` — column clients.storeIds TEXT — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L6

- [x] `column:clients.updated_at` — column clients.updatedAt INTEGER — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L24

- [x] `table:clients` — table clients — **[MATCH]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: src/db/schema/clients.ts:L3


### Frontend Hooks

- [x] `hook:useautopolling` — useAutoPolling(...) — **[MATCH]**
      v2: apps/react/src/hooks/useAutoPolling.ts:L9
      v4: web/src/hooks/useAutoPolling.ts:L10

- [x] `hook:useinitstores` — useInitStores(...) — **[MATCH]**
      v2: apps/react/src/hooks/useInitStores.ts:L12
      v4: web/src/hooks/useInitStores.ts:L13

- [x] `hook:usekeyboardshortcuts` — useKeyboardShortcuts(...) — **[MATCH]**
      v2: apps/react/src/hooks/useKeyboardShortcuts.ts:L11
      v4: web/src/hooks/useKeyboardShortcuts.ts:L12

- [x] `hook:usestores` — useStores(...) — **[MATCH]**
      v2: apps/react/src/hooks/useStores.ts:L12
      v4: web/src/hooks/useStores.ts:L13

- [x] `hook:usesyncpoller` — useSyncPoller(...) — **[MATCH]**
      v2: apps/react/src/hooks/useSyncPoller.ts:L9
      v4: web/src/hooks/useSyncPoller.ts:L10


### Contexts

- [x] `context:toastcontext` — ToastContext — **[MATCH]**
      v2: apps/react/src/contexts/ToastContext.tsx:L17
      v4: web/src/contexts/ToastContext.tsx:L18


### apiClient Methods

- [x] `apiclient:addtoqueue` — apiClient.addToQueue() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1039
      v4: web/src/lib/v2-apiClient.ts:L965

- [x] `apiclient:adjustinventory` — apiClient.adjustInventory() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L477
      v4: web/src/lib/v2-apiClient.ts:L1364

- [x] `apiclient:adjustpackage` — apiClient.adjustPackage() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L758
      v4: web/src/lib/v2-apiClient.ts:L1608

- [x] `apiclient:backfillbillingreferencerates` — apiClient.backfillBillingReferenceRates() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L856
      v4: web/src/lib/v2-apiClient.ts:L1827

- [ ] `apiclient:browserates` — apiClient.browseRates() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L888
      v4: —
      Fix needed: Add `browseRates(data): Promise<{ rates: unknown[] }>` to the `apiClient` object in `web/src/lib/v2-apiClient.ts` that calls `api.post<{ rates: unknown[] }>('/rates/browse', data)` wrapped in `safe(...)` with `{ rates: [] }` fallback. Backend route already exists at `src/routes/rates.ts:L45` (POST /rates/browse). Current RateBrowserModal inlines its own `browseRates()` function at `web/src/components/RateBrowserModal.tsx:L430` — exposing the apiClient method enables reuse from other views.
      Classification: FIX_NEEDED — backend exists (`POST /rates/browse`); only the v2-shim wrapper is missing. [priority: LOW]

- [x] `apiclient:buildheaders` — apiClient.buildHeaders() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L151
      v4: web/src/lib/api.ts:L25
      Note: inlined inside `request()` in `web/src/lib/api.ts` (reads Supabase session instead of localStorage app-token). v2-apiClient.ts also defines a local `authHeaders()` at L19 for the blob-fetch path.

- [x] `apiclient:bulkupdateinventorydimensions` — apiClient.bulkUpdateInventoryDimensions() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L515
      v4: web/src/lib/v2-apiClient.ts:L1421

- [x] `apiclient:clearandrefetchallrates` — apiClient.clearAndRefetchAllRates() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L704
      v4: web/src/lib/v2-apiClient.ts:L624

- [x] `apiclient:clearqueue` — apiClient.clearQueue() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1046
      v4: web/src/lib/v2-apiClient.ts:L969

- [x] `apiclient:cleartoken` — apiClient.clearToken() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L141
      v4: web/src/lib/supabase.ts
      Note: v4 delegates session lifecycle to Supabase — `supabase.auth.signOut()` replaces manual localStorage token clearing. The matching `setToken` in v4 is a no-op (v2-apiClient.ts:L310).

- [x] `apiclient:createclient` — apiClient.createClient() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L341
      v4: web/src/lib/v2-apiClient.ts:L501

- [x] `apiclient:createclientrecord` — apiClient.createClientRecord() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L348
      v4: web/src/lib/v2-apiClient.ts:L505

- [x] `apiclient:createlabel` — apiClient.createLabel() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1004
      v4: web/src/lib/v2-apiClient.ts:L916

- [x] `apiclient:createlocation` — apiClient.createLocation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L594
      v4: web/src/lib/v2-apiClient.ts:L1490

- [x] `apiclient:createlocationmutation` — apiClient.createLocationMutation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L587
      v4: web/src/lib/v2-apiClient.ts:L1494

- [x] `apiclient:createpackagemutation` — apiClient.createPackageMutation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L724
      v4: web/src/lib/v2-apiClient.ts:L1563

- [x] `apiclient:createparentsku` — apiClient.createParentSku() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L531
      v4: web/src/lib/v2-apiClient.ts:L1451

- [x] `apiclient:createreturnlabel` — apiClient.createReturnLabel() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1025
      v4: web/src/lib/v2-apiClient.ts:L936
      Note: v4 renamed to `returnLabel(shipmentId, reason?)` — same endpoint (POST /labels/:shipmentId/return) and same body shape `{ reason }`.

- [x] `apiclient:deleteclientrecord` — apiClient.deleteClientRecord() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L378
      v4: web/src/lib/v2-apiClient.ts:L521

- [x] `apiclient:deletelocation` — apiClient.deleteLocation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L643
      v4: web/src/lib/v2-apiClient.ts:L1513

- [x] `apiclient:deletelocationmutation` — apiClient.deleteLocationMutation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L639
      v4: web/src/lib/v2-apiClient.ts:L1521

- [x] `apiclient:deletepackagemutation` — apiClient.deletePackageMutation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L738
      v4: web/src/lib/v2-apiClient.ts:L1582

- [x] `apiclient:downloadmanifest` — apiClient.downloadManifest() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L925
      v4: web/src/lib/v2-apiClient.ts:L1942

- [x] `apiclient:fetchanalysisdailysales` — apiClient.fetchAnalysisDailySales() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L913
      v4: web/src/lib/v2-apiClient.ts:L1861

- [x] `apiclient:fetchanalysisskus` — apiClient.fetchAnalysisSkus() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L902
      v4: web/src/lib/v2-apiClient.ts:L1889

- [x] `apiclient:fetchbillingconfigs` — apiClient.fetchBillingConfigs() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L784
      v4: web/src/lib/v2-apiClient.ts:L1638

- [x] `apiclient:fetchbillingdetails` — apiClient.fetchBillingDetails() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L819
      v4: web/src/lib/v2-apiClient.ts:L1762

- [x] `apiclient:fetchbillingpackageprices` — apiClient.fetchBillingPackagePrices() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L830
      v4: web/src/lib/v2-apiClient.ts:L1779

- [x] `apiclient:fetchbillingreferencerates` — apiClient.fetchBillingReferenceRates() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L844
      v4: web/src/lib/v2-apiClient.ts:L1811

- [x] `apiclient:fetchbillingreferenceratestatus` — apiClient.fetchBillingReferenceRateStatus() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L850
      v4: web/src/lib/v2-apiClient.ts:L1819

- [x] `apiclient:fetchbillingsummary` — apiClient.fetchBillingSummary() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L808
      v4: web/src/lib/v2-apiClient.ts:L1704

- [x] `apiclient:fetchcarrieraccounts` — apiClient.fetchCarrierAccounts() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L571
      v4: web/src/lib/v2-apiClient.ts:L538

- [x] `apiclient:fetchcarriersforstore` — apiClient.fetchCarriersForStore() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L881
      v4: web/src/lib/v2-apiClient.ts:L555

- [x] `apiclient:fetchclientdetail` — apiClient.fetchClientDetail() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L334
      v4: web/src/lib/v2-apiClient.ts:L493

- [x] `apiclient:fetchclients` — apiClient.fetchClients() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L309
      v4: web/src/lib/v2-apiClient.ts:L478

- [x] `apiclient:fetchcolumnprefs` — apiClient.fetchColumnPrefs() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L693
      v4: web/src/lib/v2-apiClient.ts:L567

- [x] `apiclient:fetchcounts` — apiClient.fetchCounts() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L320
      v4: web/src/lib/v2-apiClient.ts:L315

- [x] `apiclient:fetchdailystats` — apiClient.fetchDailyStats() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L947
      v4: web/src/lib/v2-apiClient.ts:L733

- [x] `apiclient:fetchinventory` — apiClient.fetchInventory() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L393
      v4: web/src/lib/v2-apiClient.ts:L1118

- [x] `apiclient:fetchinventoryalerts` — apiClient.fetchInventoryAlerts() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L430
      v4: web/src/lib/v2-apiClient.ts:L1194

- [x] `apiclient:fetchinventorydetail` — apiClient.fetchInventoryDetail() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L408
      v4: web/src/lib/v2-apiClient.ts:L1131

- [x] `apiclient:fetchinventoryitemledger` — apiClient.fetchInventoryItemLedger() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L436
      v4: web/src/lib/v2-apiClient.ts:L1232

- [x] `apiclient:fetchinventoryledger` — apiClient.fetchInventoryLedger() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L445
      v4: web/src/lib/v2-apiClient.ts:L1245

- [x] `apiclient:fetchinventoryskuorders` — apiClient.fetchInventorySkuOrders() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L545
      v4: web/src/lib/v2-apiClient.ts:L1258

- [x] `apiclient:fetchlegacysyncstatus` — apiClient.fetchLegacySyncStatus() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L677
      v4: web/src/lib/v2-apiClient.ts:L594

- [x] `apiclient:fetchlocationdetail` — apiClient.fetchLocationDetail() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L578
      v4: web/src/lib/v2-apiClient.ts:L1482

- [x] `apiclient:fetchlocations` — apiClient.fetchLocations() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L564
      v4: web/src/lib/v2-apiClient.ts:L1464

- [x] `apiclient:fetchlowstockpackages` — apiClient.fetchLowStockPackages() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L718
      v4: web/src/lib/v2-apiClient.ts:L1545

- [ ] `apiclient:fetchorderdetail` — apiClient.fetchOrderDetail() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L282
      v4: —
      Fix needed: Add `fetchOrderDetail(orderId: number): Promise<any>` to the `apiClient` object in `web/src/lib/v2-apiClient.ts` that calls `api.get<any>(\`/orders/${orderId}\`)` wrapped in `safe(...)` with `null` fallback. Backend route already exists at `src/routes/orders.ts:L440` (GET /orders/:id — returns the single order row without hydration). v4 currently only exposes `fetchOrderFull` (GET /orders/:id/full — hydrated); some v2 callers only need the plain row.
      Classification: FIX_NEEDED — backend `GET /orders/:id` exists; only the wrapper method is missing. [priority: LOW]

- [x] `apiclient:fetchorderdims` — apiClient.fetchOrderDims() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1000
      v4: web/src/lib/v2-apiClient.ts:L849

- [x] `apiclient:fetchorderfull` — apiClient.fetchOrderFull() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L289
      v4: web/src/lib/v2-apiClient.ts:L662

- [x] `apiclient:fetchorders` — apiClient.fetchOrders() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L260
      v4: web/src/lib/v2-apiClient.ts:L650

- [x] `apiclient:fetchpackageledger` — apiClient.fetchPackageLedger() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L765
      v4: web/src/lib/v2-apiClient.ts:L1616

- [x] `apiclient:fetchpackages` — apiClient.fetchPackages() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L711
      v4: web/src/lib/v2-apiClient.ts:L1534

- [x] `apiclient:fetchparentskudetail` — apiClient.fetchParentSkuDetail() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L555
      v4: web/src/lib/v2-apiClient.ts:L1455

- [x] `apiclient:fetchpicklist` — apiClient.fetchPicklist() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L953
      v4: web/src/lib/v2-apiClient.ts:L785

- [x] `apiclient:fetchproducts` — apiClient.fetchProducts() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1080
      v4: web/src/lib/v2-apiClient.ts:L1081

- [x] `apiclient:fetchproductsbysku` — apiClient.fetchProductsBySku() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L863
      v4: web/src/lib/v2-apiClient.ts:L1094

- [x] `apiclient:fetchqueue` — apiClient.fetchQueue() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1032
      v4: web/src/lib/v2-apiClient.ts:L951

- [x] `apiclient:fetchqueueprintjobstatus` — apiClient.fetchQueuePrintJobStatus() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1071
      v4: web/src/lib/v2-apiClient.ts:L1004

- [x] `apiclient:fetchrates` — apiClient.fetchRates() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L895
      v4: web/src/lib/v2-apiClient.ts:L1843

- [x] `apiclient:fetchshipmentsyncstatus` — apiClient.fetchShipmentSyncStatus() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L659
      v4: web/src/lib/v2-apiClient.ts:L608

- [x] `apiclient:fetchstores` — apiClient.fetchStores() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L327
      v4: web/src/lib/v2-apiClient.ts:L440

- [x] `apiclient:generatebilling` — apiClient.generateBilling() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L797
      v4: web/src/lib/v2-apiClient.ts:L1691

- [x] `apiclient:getdownloadfilename` — apiClient.getDownloadFilename() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L183
      v4: web/src/lib/v2-apiClient.ts:L28
      Note: inlined as module-level `parseDownloadFilename(contentDisposition, fallback)` — same regex for `filename*=UTF-8''…` and `filename="…"`. Used by `fetchBlob()` at L272.

- [x] `apiclient:importinventorydimensions` — apiClient.importInventoryDimensions() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L508
      v4: web/src/lib/v2-apiClient.ts:L1410

- [x] `apiclient:listclients` — apiClient.listClients() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L313
      v4: web/src/lib/v2-apiClient.ts:L489

- [x] `apiclient:listorders` — apiClient.listOrders() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L275
      v4: web/src/lib/v2-apiClient.ts:L658

- [x] `apiclient:listparentskus` — apiClient.listParentSkus() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L524
      v4: web/src/lib/v2-apiClient.ts:L1438

- [x] `apiclient:loadtoken` — apiClient.loadToken() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L122
      v4: web/src/lib/api.ts:L21
      Note: v4 replaces manual localStorage token load with `supabase.auth.getSession()` inside the `request()` helper — same effect, handled by Supabase SDK.

- [x] `apiclient:markordershippedexternal` — apiClient.markOrderShippedExternal() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L965
      v4: web/src/lib/v2-apiClient.ts:L686

- [x] `apiclient:parseerrormessage` — apiClient.parseErrorMessage() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L164
      v4: web/src/lib/api.ts:L44
      Note: inlined inside `request()` — reads JSON body, prefers `{ error: string }` field, falls back to status line. Same surface as v2's private `parseErrorMessage`.

- [x] `apiclient:populateinventory` — apiClient.populateInventory() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L502
      v4: web/src/lib/v2-apiClient.ts:L1401

- [x] `apiclient:receiveinventory` — apiClient.receiveInventory() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L465
      v4: web/src/lib/v2-apiClient.ts:L1318

- [x] `apiclient:receivepackage` — apiClient.receivePackage() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L751
      v4: web/src/lib/v2-apiClient.ts:L1600

- [x] `apiclient:removefromqueue` — apiClient.removeFromQueue() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1053
      v4: web/src/lib/v2-apiClient.ts:L977

- [x] `apiclient:request` — apiClient.request() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L202
      v4: web/src/lib/api.ts:L19
      Note: v4's generic `request<T>(path, init)` plus the `api.get/post/put/patch/delete` helpers replace v2's private `ApiClient.request`. Same contract — query params, JSON body, auth header, error translation.

- [x] `apiclient:retrievelabel` — apiClient.retrieveLabel() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1011
      v4: web/src/lib/v2-apiClient.ts:L940

- [x] `apiclient:savebillingpackageprices` — apiClient.saveBillingPackagePrices() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L837
      v4: web/src/lib/v2-apiClient.ts:L1794

- [x] `apiclient:savecolumnprefs` — apiClient.saveColumnPrefs() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L697
      v4: web/src/lib/v2-apiClient.ts:L582

- [x] `apiclient:saveorderbestrate` — apiClient.saveOrderBestRate() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L993
      v4: web/src/lib/v2-apiClient.ts:L716

- [x] `apiclient:saveproductdefaults` — apiClient.saveProductDefaults() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1090
      v4: web/src/lib/v2-apiClient.ts:L1105

- [x] `apiclient:saveproductdefaultsv2` — apiClient.saveProductDefaultsV2() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L874
      v4: web/src/lib/v2-apiClient.ts:L1109

- [x] `apiclient:setdefaultlocation` — apiClient.setDefaultLocation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L650
      v4: web/src/lib/v2-apiClient.ts:L1525

- [x] `apiclient:setdefaultpackageprice` — apiClient.setDefaultPackagePrice() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L777
      v4: web/src/lib/v2-apiClient.ts:L1802

- [x] `apiclient:setinventoryparent` — apiClient.setInventoryParent() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L538
      v4: web/src/lib/v2-apiClient.ts:L1429

- [x] `apiclient:setorderresidential` — apiClient.setOrderResidential() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L972
      v4: web/src/lib/v2-apiClient.ts:L678

- [x] `apiclient:setorderselectedpackageid` — apiClient.setOrderSelectedPackageId() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L986
      v4: web/src/lib/v2-apiClient.ts:L702

- [x] `apiclient:setorderselectedpid` — apiClient.setOrderSelectedPid() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L979
      v4: web/src/lib/v2-apiClient.ts:L694

- [x] `apiclient:setpackagereorderlevel` — apiClient.setPackageReorderLevel() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L744
      v4: web/src/lib/v2-apiClient.ts:L1590

- [x] `apiclient:settoken` — apiClient.setToken() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L131
      v4: web/src/lib/v2-apiClient.ts:L310

- [x] `apiclient:startqueueprintjob` — apiClient.startQueuePrintJob() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1060
      v4: web/src/lib/v2-apiClient.ts:L987

- [x] `apiclient:submitinventoryadjustment` — apiClient.submitInventoryAdjustment() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L493
      v4: web/src/lib/v2-apiClient.ts:L1380

- [x] `apiclient:submitinventoryreceive` — apiClient.submitInventoryReceive() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L484
      v4: web/src/lib/v2-apiClient.ts:L1343

- [x] `apiclient:synccarrierpackages` — apiClient.syncCarrierPackages() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L771
      v4: web/src/lib/v2-apiClient.ts:L1629

- [x] `apiclient:syncclientsfromstores` — apiClient.syncClientsFromStores() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L384
      v4: web/src/lib/v2-apiClient.ts:L529

- [x] `apiclient:triggerlegacysync` — apiClient.triggerLegacySync() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L686
      v4: web/src/lib/v2-apiClient.ts:L599

- [x] `apiclient:triggershipmentsync` — apiClient.triggerShipmentSync() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L668
      v4: web/src/lib/v2-apiClient.ts:L616

- [x] `apiclient:updatebillingconfig` — apiClient.updateBillingConfig() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L790
      v4: web/src/lib/v2-apiClient.ts:L1651

- [x] `apiclient:updateclient` — apiClient.updateClient() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L358
      v4: web/src/lib/v2-apiClient.ts:L509

- [x] `apiclient:updateclientrecord` — apiClient.updateClientRecord() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L368
      v4: web/src/lib/v2-apiClient.ts:L517

- [x] `apiclient:updateinventoryitem` — apiClient.updateInventoryItem() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L417
      v4: web/src/lib/v2-apiClient.ts:L1139

- [x] `apiclient:updatelocation` — apiClient.updateLocation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L622
      v4: web/src/lib/v2-apiClient.ts:L1498

- [x] `apiclient:updatelocationmutation` — apiClient.updateLocationMutation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L612
      v4: web/src/lib/v2-apiClient.ts:L1506

- [x] `apiclient:updateorder` — apiClient.updateOrder() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L296
      v4: web/src/lib/v2-apiClient.ts:L670

- [x] `apiclient:updatepackagemutation` — apiClient.updatePackageMutation() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L731
      v4: web/src/lib/v2-apiClient.ts:L1571

- [x] `apiclient:voidlabel` — apiClient.voidLabel() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1018
      v4: web/src/lib/v2-apiClient.ts:L932


### Constants (business rules)

- [x] `const:blocked_carrier_ids` — export const BLOCKED_CARRIER_IDS — **[MATCH]**
      v2: apps/api/src/common/prepship-config.ts:L5
      v4: web/src/utils/markups.ts:L33
      Note: v4 moved this constant client-side (rate filtering happens in the browser via `isBlockedRate` at markups.ts:L111). Same shippingProviderIds: 442017 (Amazon Buy Shipping), 566344 (Sendle), 593739 (Amazon Shipping US).

- [ ] `const:blocked_name_re` — export const BLOCKED_NAME_RE — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L26
      v4: web/src/utils/markups.ts:L41
      Fix needed: v4 regex is `/flat[\s-]?rate|\bbox\b/i` but v2 is `/flat[\s-]?rate|flat rate|\bbox\b/i` — v4 drops the explicit `flat rate` alternation. Functionally equivalent (the `flat[\s-]?rate` branch already matches "flat rate") but not a literal match. Either update v4 to include the redundant `flat rate` alternation for verbatim parity, or mark as INTENTIONALLY_CHANGED in Phase E. Also, v4's copy is client-only — backend rate filtering at `src/services/rates.ts:L84` uses a whitelist (ALLOWED_CODES) instead of this blocked-name regex.
      Classification: INTENTIONALLY_CHANGED — v4 regex `/flat[\s-]?rate|\bbox\b/i` matches a superset of v2's `/flat[\s-]?rate|flat rate|\bbox\b/i` (the "flat rate" alternation is redundant under `\s-?`).

- [x] `const:blocked_package_types` — export const BLOCKED_PACKAGE_TYPES — **[MATCH]**
      v2: apps/api/src/common/prepship-config.ts:L16
      v4: web/src/utils/markups.ts:L22
      Note: identical set (8 entries: flat_rate_envelope/legal/padded, small/medium/large flat_rate_box, regional_rate_box_a/b). Moved client-side — applied via `isBlockedRate` during pickBestRate.

- [x] `const:blocked_service_codes` — export const BLOCKED_SERVICE_CODES — **[MATCH]**
      v2: apps/api/src/common/prepship-config.ts:L7
      v4: src/services/rates.ts (+ web/src/utils/markups.ts:L13)
      Note: Batch 1 port — BLOCKED_SERVICE_CODES + BLOCKED_PACKAGE_TYPES + BLOCKED_NAME_RE + MEDIA_MAIL_ALLOWED_STORES + isBlockedRate() added to src/services/rates.ts; filter applied in fetchLiveRates() for both rates and invalid_rates arrays. Frontend markups.ts set updated to include `ups_surepost_less_than_1_lb` for full parity.
      Classification: MATCH — Batch 1 (commit TBD)

- [ ] `const:carrier_accounts_v2` — export const CARRIER_ACCOUNTS_V2 — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L39
      v4: —
      Fix needed: v4 intentionally has no hardcoded carrier-account catalog — `src/routes/init.ts:L106 /carrier-accounts` and `:L138 /carriers` fetch live data from ShipStation `/v2/carriers`. This is arguably a better design (no drift). HOWEVER v2 code paths that depend on per-account metadata (e.g. `clientId:10` binding ORION/GG6381/FedEx to client 10, nicknames like "ORION"/"ROCEL C81F70") have no v4 equivalent — billing clientId→account mapping is lost. Decide Phase E whether to (a) seed these 20 accounts into the DB/settings table, (b) port CARRIER_ACCOUNTS_V2 as a fallback constant used only when ShipStation omits clientId/nickname, or (c) mark INTENTIONALLY_CHANGED if the business-to-account association is now handled elsewhere (e.g. via clients.rateSourceClientId).
      Classification: FIX_NEEDED — without the hardcoded map, per-client ShipStation account attribution is lost for billing; clientId=10's multiple UPS accounts collapse into a single row. [priority: HIGH]

- [ ] `const:excluded_store_ids` — export const EXCLUDED_STORE_IDS — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L4
      v4: —
      Fix needed: v4 has no equivalent of EXCLUDED_STORE_IDS = [376720, 272465, 309763, 376827]. In v2 these stores were suppressed from orders sync + sidebar counts. v4 instead hides clients by `is_test` flag or by name `'api shipments'` (see `src/routes/init.ts:L57-L61` counts exclusion and `web/src/lib/v2-apiClient.ts:L47-L56` HIDDEN_CLIENT_NAMES). Check whether the 4 specific store IDs (376720, 272465, 309763, 376827) map to the test/api-shipments clients in the current v4 DB — if so, no action. If not, either (a) port EXCLUDED_STORE_IDS into `src/services/order-sync.ts` to skip matching storeIds during ShipStation sync, or (b) flag the owning clients as `is_test=true` in a migration so they naturally get filtered.
      Classification: UNCERTAIN — stores 376720/272465/309763/376827 may already be suppressed via `is_test` client flag; needs production DB check to confirm.

- [x] `const:expedited_services` — export const EXPEDITED_SERVICES — **[MATCH]**
      v2: apps/api/src/common/prepship-config.ts:L29
      v4: src/routes/analysis.ts (top-of-file tuple + both sku-breakdown queries)
      Note: Batch 1 port — replaced the broad Postgres regex `(priority|express|overnight|expedited|next_day|2day|2_day)` at both query sites with `= ANY(ARRAY[...]::text[])` keyed off an EXPEDITED_SERVICES tuple matching v2's exact 13-service list. Fixes `usps_priority_mail` being mis-classified as expedited.
      Classification: MATCH — Batch 1 (commit TBD)

- [x] `const:media_mail_allowed_stores` — export const MEDIA_MAIL_ALLOWED_STORES — **[MATCH]**
      v2: apps/api/src/common/prepship-config.ts:L27
      v4: web/src/utils/markups.ts:L39
      Note: identical `new Set([376759])`. Applied in `isBlockedRate` at markups.ts:L117 to un-block `usps_media_mail` for that one store.

- [ ] `const:ss_baseline_carrier_codes` — export const SS_BASELINE_CARRIER_CODES — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L6
      v4: —
      Fix needed: v4 has no `SS_BASELINE_CARRIER_CODES = new Set(['stamps_com', 'ups_walleted'])` constant. v2 uses it to identify the ShipStation-provided baseline carrier accounts (vs. client-owned accounts) — relevant for rate-source fallback and billing "cost" (baseline) vs "charge" (client account) semantics. v4's rate allowlist at `src/services/rates.ts:L84` includes `stamps_com` in ALLOWED_CODES but doesn't distinguish baseline from client accounts. Add `export const SS_BASELINE_CARRIER_CODES = new Set(['stamps_com', 'ups_walleted'])` in a shared module (e.g. `src/lib/carrier-config.ts`) and consume in billing/rate-backfill to flag baseline-sourced rates.
      Classification: FIX_NEEDED — v4 can't distinguish baseline-provided carriers (`stamps_com`, `ups_walleted`) from client-owned accounts for billing cost vs charge accounting. [priority: MED]


### CSS Classes

- [x] `css:active` — .active — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:conn-dot` — .conn-dot — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:expanded` — .expanded — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:logo-sub` — .logo-sub — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:logo-wordmark` — .logo-wordmark — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:mobile-open` — .mobile-open — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:react-empty-panel` — .react-empty-panel — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L52

- [x] `css:react-empty-panel-copy` — .react-empty-panel-copy — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L74

- [x] `css:react-empty-panel-icon` — .react-empty-panel-icon — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L64

- [x] `css:react-empty-panel-title` — .react-empty-panel-title — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L68

- [x] `css:react-placeholder-card` — .react-placeholder-card — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L1

- [x] `css:react-placeholder-eyebrow` — .react-placeholder-eyebrow — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L10

- [x] `css:react-sidebar-clear` — .react-sidebar-clear — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L38

- [x] `css:react-zoom-wrap` — .react-zoom-wrap — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/App.css:L31

- [x] `css:selected` — .selected — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar` — .sidebar — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-bottom` — .sidebar-bottom — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-divider` — .sidebar-divider — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-logo` — .sidebar-logo — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-nav` — .sidebar-nav — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-search` — .sidebar-search — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-tool-icon` — .sidebar-tool-icon — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-tool-item` — .sidebar-tool-item — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:sidebar-tools` — .sidebar-tools — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-arrow` — .ss-arrow — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-badge` — .ss-badge — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-header` — .ss-header — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-label` — .ss-label — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-section` — .ss-section — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-store` — .ss-store — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-store-count` — .ss-store-count — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-store-name` — .ss-store-name — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:ss-stores` — .ss-stores — **[MATCH]**
      v2: apps/react/src/components/Sidebar/Sidebar.css:L1
      v4: web/src/components/Sidebar/Sidebar.css:L1

- [x] `css:zoom-opt` — .zoom-opt — **[MATCH]**
      v2: apps/react/src/App.css:L1
      v4: web/src/app-shell.css:L195
      Note: also defined in web/src/App.css:L31 as descendant selector (`.react-zoom-wrap .zoom-opt`). Used in Home.tsx:L454.


---

**Verified-by:** _________  **Date:** _________
