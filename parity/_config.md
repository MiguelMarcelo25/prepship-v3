# Parity: _config

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 198  |  **MATCH:** 161  |  **MISSING:** 37  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### Backend Routes

- [ ] `DELETE /clients/:clientid` — DELETE /api/clients/:clientId(int) — **[MISSING]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L28
      v4: —
      Fix needed: <TODO: port route `DELETE /clients/:clientid` from v2>

- [ ] `GET /carriers` — GET /api/carriers — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L14
      v4: —
      Fix needed: <TODO: port route `GET /carriers` from v2>

- [ ] `GET /carriers` — GET /api/carrier-accounts — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L15
      v4: —
      Fix needed: <TODO: port route `GET /carriers` from v2>

- [x] `GET /clients` — GET /api/clients — **[MATCH]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L19
      v4: web/src/pages/Picklist.tsx:L51

- [ ] `GET /counts` — GET /api/counts — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L12
      v4: —
      Fix needed: <TODO: port route `GET /counts` from v2>

- [x] `GET /health` — GET /health — **[MATCH]**
      v2: apps/api/src/app/create-app.ts:L55
      v4: src/routes/health.ts:L6

- [ ] `GET /init-data` — GET /api/init-data — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L11
      v4: —
      Fix needed: <TODO: port route `GET /init-data` from v2>

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

- [ ] `GET /stores` — GET /api/stores — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L13
      v4: —
      Fix needed: <TODO: port route `GET /stores` from v2>

- [x] `GET /sync/status` — GET /api/sync/status — **[MATCH]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L9
      v4: src/routes/sync.ts:L31

- [ ] `POST /cache/refresh-carriers` — POST /api/cache/refresh-carriers — **[MISSING]**
      v2: apps/api/src/modules/init/api/init-routes.ts:L16
      v4: —
      Fix needed: <TODO: port route `POST /cache/refresh-carriers` from v2>

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

- [ ] `POST /sync/trigger` — POST /api/sync/trigger — **[MISSING]**
      v2: apps/api/src/modules/shipments/api/shipment-routes.ts:L10
      v4: —
      Fix needed: <TODO: port route `POST /sync/trigger` from v2>

- [ ] `PUT /clients/:clientid` — PUT /api/clients/:clientId(int) — **[MISSING]**
      v2: apps/api/src/modules/clients/api/client-routes.ts:L22
      v4: —
      Fix needed: <TODO: port route `PUT /clients/:clientid` from v2>


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

- [ ] `column:clients.client_id` — column clients.clientId INTEGER — **[MISSING]**
      v2: apps/api/src/modules/clients/test-support.ts:L1
      v4: —
      Fix needed: <TODO: port schema `column:clients.client_id` from v2>

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
      Fix needed: <TODO: port api-client `apiclient:browserates` from v2>

- [ ] `apiclient:buildheaders` — apiClient.buildHeaders() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L151
      v4: —
      Fix needed: <TODO: port api-client `apiclient:buildheaders` from v2>

- [x] `apiclient:bulkupdateinventorydimensions` — apiClient.bulkUpdateInventoryDimensions() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L515
      v4: web/src/lib/v2-apiClient.ts:L1421

- [x] `apiclient:clearandrefetchallrates` — apiClient.clearAndRefetchAllRates() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L704
      v4: web/src/lib/v2-apiClient.ts:L624

- [x] `apiclient:clearqueue` — apiClient.clearQueue() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L1046
      v4: web/src/lib/v2-apiClient.ts:L969

- [ ] `apiclient:cleartoken` — apiClient.clearToken() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L141
      v4: —
      Fix needed: <TODO: port api-client `apiclient:cleartoken` from v2>

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

- [ ] `apiclient:createreturnlabel` — apiClient.createReturnLabel() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L1025
      v4: —
      Fix needed: <TODO: port api-client `apiclient:createreturnlabel` from v2>

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
      Fix needed: <TODO: port api-client `apiclient:fetchorderdetail` from v2>

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

- [ ] `apiclient:getdownloadfilename` — apiClient.getDownloadFilename() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L183
      v4: —
      Fix needed: <TODO: port api-client `apiclient:getdownloadfilename` from v2>

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

- [ ] `apiclient:loadtoken` — apiClient.loadToken() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L122
      v4: —
      Fix needed: <TODO: port api-client `apiclient:loadtoken` from v2>

- [x] `apiclient:markordershippedexternal` — apiClient.markOrderShippedExternal() — **[MATCH]**
      v2: apps/react/src/api/client.ts:L965
      v4: web/src/lib/v2-apiClient.ts:L686

- [ ] `apiclient:parseerrormessage` — apiClient.parseErrorMessage() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L164
      v4: —
      Fix needed: <TODO: port api-client `apiclient:parseerrormessage` from v2>

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

- [ ] `apiclient:request` — apiClient.request() — **[MISSING]**
      v2: apps/react/src/api/client.ts:L202
      v4: —
      Fix needed: <TODO: port api-client `apiclient:request` from v2>

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

- [ ] `const:blocked_carrier_ids` — export const BLOCKED_CARRIER_IDS — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L5
      v4: —
      Fix needed: <TODO: port constant `const:blocked_carrier_ids` from v2>

- [ ] `const:blocked_name_re` — export const BLOCKED_NAME_RE — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L26
      v4: —
      Fix needed: <TODO: port constant `const:blocked_name_re` from v2>

- [ ] `const:blocked_package_types` — export const BLOCKED_PACKAGE_TYPES — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L16
      v4: —
      Fix needed: <TODO: port constant `const:blocked_package_types` from v2>

- [ ] `const:blocked_service_codes` — export const BLOCKED_SERVICE_CODES — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L7
      v4: —
      Fix needed: <TODO: port constant `const:blocked_service_codes` from v2>

- [ ] `const:carrier_accounts_v2` — export const CARRIER_ACCOUNTS_V2 — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L39
      v4: —
      Fix needed: <TODO: port constant `const:carrier_accounts_v2` from v2>

- [ ] `const:excluded_store_ids` — export const EXCLUDED_STORE_IDS — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L4
      v4: —
      Fix needed: <TODO: port constant `const:excluded_store_ids` from v2>

- [ ] `const:expedited_services` — export const EXPEDITED_SERVICES — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L29
      v4: —
      Fix needed: <TODO: port constant `const:expedited_services` from v2>

- [ ] `const:media_mail_allowed_stores` — export const MEDIA_MAIL_ALLOWED_STORES — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L27
      v4: —
      Fix needed: <TODO: port constant `const:media_mail_allowed_stores` from v2>

- [ ] `const:ss_baseline_carrier_codes` — export const SS_BASELINE_CARRIER_CODES — **[MISSING]**
      v2: apps/api/src/common/prepship-config.ts:L6
      v4: —
      Fix needed: <TODO: port constant `const:ss_baseline_carrier_codes` from v2>


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

- [ ] `css:react-empty-panel` — .react-empty-panel — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-empty-panel` from v2>

- [ ] `css:react-empty-panel-copy` — .react-empty-panel-copy — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-empty-panel-copy` from v2>

- [ ] `css:react-empty-panel-icon` — .react-empty-panel-icon — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-empty-panel-icon` from v2>

- [ ] `css:react-empty-panel-title` — .react-empty-panel-title — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-empty-panel-title` from v2>

- [ ] `css:react-placeholder-card` — .react-placeholder-card — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-placeholder-card` from v2>

- [ ] `css:react-placeholder-eyebrow` — .react-placeholder-eyebrow — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-placeholder-eyebrow` from v2>

- [ ] `css:react-sidebar-clear` — .react-sidebar-clear — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-sidebar-clear` from v2>

- [ ] `css:react-zoom-wrap` — .react-zoom-wrap — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:react-zoom-wrap` from v2>

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

- [ ] `css:zoom-opt` — .zoom-opt — **[MISSING]**
      v2: apps/react/src/App.css:L1
      v4: —
      Fix needed: <TODO: port css-class `css:zoom-opt` from v2>


---

**Verified-by:** _________  **Date:** _________
