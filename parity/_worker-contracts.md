# Parity: _worker-contracts

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 101  |  **MATCH:** 12  |  **MISSING:** 89  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### DTOs

- [ ] `dto:address` — interface AddressInputDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:address` from v2>

- [ ] `dto:adjustinventory` — interface AdjustInventoryInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L129
      v4: —
      Fix needed: <TODO: port dto `dto:adjustinventory` from v2>

- [ ] `dto:allowedsettingkey` — type AllowedSettingKey — **[MISSING]**
      v2: packages/contracts/src/settings/contracts.ts:L12
      v4: —
      Fix needed: <TODO: port dto `dto:allowedsettingkey` from v2>

- [ ] `dto:analysisdailysalesquery` — interface AnalysisDailySalesQuery — **[MISSING]**
      v2: packages/contracts/src/analysis/contracts.ts:L36
      v4: —
      Fix needed: <TODO: port dto `dto:analysisdailysalesquery` from v2>

- [ ] `dto:analysisdailysalesresponse` — interface AnalysisDailySalesResponse — **[MISSING]**
      v2: packages/contracts/src/analysis/contracts.ts:L49
      v4: —
      Fix needed: <TODO: port dto `dto:analysisdailysalesresponse` from v2>

- [ ] `dto:analysissku` — interface AnalysisSkuDto — **[MISSING]**
      v2: packages/contracts/src/analysis/contracts.ts:L9
      v4: —
      Fix needed: <TODO: port dto `dto:analysissku` from v2>

- [ ] `dto:analysisskuquery` — interface AnalysisSkuQuery — **[MISSING]**
      v2: packages/contracts/src/analysis/contracts.ts:L3
      v4: —
      Fix needed: <TODO: port dto `dto:analysisskuquery` from v2>

- [ ] `dto:analysisskusresponse` — interface AnalysisSkusResponse — **[MISSING]**
      v2: packages/contracts/src/analysis/contracts.ts:L31
      v4: —
      Fix needed: <TODO: port dto `dto:analysisskusresponse` from v2>

- [ ] `dto:autocreatepackage` — interface AutoCreatePackageInput — **[MISSING]**
      v2: packages/contracts/src/packages/contracts.ts:L33
      v4: —
      Fix needed: <TODO: port dto `dto:autocreatepackage` from v2>

- [ ] `dto:backfillbillingreferencerates` — interface BackfillBillingReferenceRatesInput — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L122
      v4: —
      Fix needed: <TODO: port dto `dto:backfillbillingreferencerates` from v2>

- [ ] `dto:backfillbillingreferenceratesresult` — interface BackfillBillingReferenceRatesResult — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L127
      v4: —
      Fix needed: <TODO: port dto `dto:backfillbillingreferenceratesresult` from v2>

- [ ] `dto:batchlabelresultitem` — interface BatchLabelResultItem — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L93
      v4: —
      Fix needed: <TODO: port dto `dto:batchlabelresultitem` from v2>

- [ ] `dto:billingconfig` — interface BillingConfigDto — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L3
      v4: —
      Fix needed: <TODO: port dto `dto:billingconfig` from v2>

- [ ] `dto:billingdetail` — interface BillingDetailDto — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L66
      v4: —
      Fix needed: <TODO: port dto `dto:billingdetail` from v2>

- [ ] `dto:billingdetailsquery` — interface BillingDetailsQuery — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L48
      v4: —
      Fix needed: <TODO: port dto `dto:billingdetailsquery` from v2>

- [ ] `dto:billingpackageprice` — interface BillingPackagePriceDto — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L87
      v4: —
      Fix needed: <TODO: port dto `dto:billingpackageprice` from v2>

- [ ] `dto:billingpackagepricesquery` — interface BillingPackagePricesQuery — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L97
      v4: —
      Fix needed: <TODO: port dto `dto:billingpackagepricesquery` from v2>

- [ ] `dto:billingreferenceratefetchstatus` — interface BillingReferenceRateFetchStatusDto — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L135
      v4: —
      Fix needed: <TODO: port dto `dto:billingreferenceratefetchstatus` from v2>

- [ ] `dto:billingsummary` — interface BillingSummaryDto — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L36
      v4: —
      Fix needed: <TODO: port dto `dto:billingsummary` from v2>

- [ ] `dto:billingsummaryquery` — interface BillingSummaryQuery — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L18
      v4: —
      Fix needed: <TODO: port dto `dto:billingsummaryquery` from v2>

- [ ] `dto:browseratesrequest` — interface BrowseRatesRequestDto — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L87
      v4: —
      Fix needed: <TODO: port dto `dto:browseratesrequest` from v2>

- [ ] `dto:bulkcachedratesitemresult` — interface BulkCachedRatesItemResult — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L54
      v4: —
      Fix needed: <TODO: port dto `dto:bulkcachedratesitemresult` from v2>

- [ ] `dto:bulkcachedratesrequestitem` — interface BulkCachedRatesRequestItem — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L42
      v4: —
      Fix needed: <TODO: port dto `dto:bulkcachedratesrequestitem` from v2>

- [x] `dto:bulkcachedratesresponse` — interface BulkCachedRatesResponseDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L61
      v4: web/src/types/orders.ts:L179

- [ ] `dto:bulkupdateinventorydimensions` — interface BulkUpdateInventoryDimensionsInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L165
      v4: —
      Fix needed: <TODO: port dto `dto:bulkupdateinventorydimensions` from v2>

- [ ] `dto:cachedratesresponse` — interface CachedRatesResponseDto — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L35
      v4: —
      Fix needed: <TODO: port dto `dto:cachedratesresponse` from v2>

- [x] `dto:carrieraccount` — interface CarrierAccountDto — **[MATCH]**
      v2: packages/contracts/src/init/contracts.ts:L23
      v4: web/src/types/api.ts:L10

- [ ] `dto:carrierlookupresponse` — interface CarrierLookupResponseDto — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L66
      v4: —
      Fix needed: <TODO: port dto `dto:carrierlookupresponse` from v2>

- [ ] `dto:client` — interface ClientDto — **[MISSING]**
      v2: packages/contracts/src/clients/contracts.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:client` from v2>

- [ ] `dto:client` — interface ClientDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L48
      v4: —
      Fix needed: <TODO: port dto `dto:client` from v2>

- [ ] `dto:createbatchlabelrequest` — interface CreateBatchLabelRequestDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L83
      v4: —
      Fix needed: <TODO: port dto `dto:createbatchlabelrequest` from v2>

- [ ] `dto:createbatchlabelresponse` — interface CreateBatchLabelResponseDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L102
      v4: —
      Fix needed: <TODO: port dto `dto:createbatchlabelresponse` from v2>

- [ ] `dto:createclient` — interface CreateClientInput — **[MISSING]**
      v2: packages/contracts/src/clients/contracts.ts:L14
      v4: —
      Fix needed: <TODO: port dto `dto:createclient` from v2>

- [x] `dto:createlabelrequest` — interface CreateLabelRequestDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L13
      v4: web/src/types/api.ts:L11

- [ ] `dto:createlabelresponse` — interface CreateLabelResponseDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L31
      v4: —
      Fix needed: <TODO: port dto `dto:createlabelresponse` from v2>

- [ ] `dto:fetchbillingreferenceratesresult` — interface FetchBillingReferenceRatesResult — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L143
      v4: —
      Fix needed: <TODO: port dto `dto:fetchbillingreferenceratesresult` from v2>

- [ ] `dto:generatebilling` — interface GenerateBillingInput — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L54
      v4: —
      Fix needed: <TODO: port dto `dto:generatebilling` from v2>

- [ ] `dto:generatebillingresult` — interface GenerateBillingResult — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L60
      v4: —
      Fix needed: <TODO: port dto `dto:generatebillingresult` from v2>

- [ ] `dto:generatemanifest` — interface GenerateManifestInput — **[MISSING]**
      v2: packages/contracts/src/manifests/contracts.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:generatemanifest` from v2>

- [ ] `dto:getcachedratesquery` — interface GetCachedRatesQuery — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L26
      v4: —
      Fix needed: <TODO: port dto `dto:getcachedratesquery` from v2>

- [ ] `dto:getorderidsquery` — interface GetOrderIdsQuery — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L86
      v4: —
      Fix needed: <TODO: port dto `dto:getorderidsquery` from v2>

- [ ] `dto:getorderidsresponse` — interface GetOrderIdsResponse — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L93
      v4: —
      Fix needed: <TODO: port dto `dto:getorderidsresponse` from v2>

- [ ] `dto:getorderpicklistquery` — interface GetOrderPicklistQuery — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L107
      v4: —
      Fix needed: <TODO: port dto `dto:getorderpicklistquery` from v2>

- [ ] `dto:getorderpicklistresponse` — interface GetOrderPicklistResponse — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L114
      v4: —
      Fix needed: <TODO: port dto `dto:getorderpicklistresponse` from v2>

- [ ] `dto:initcounts` — interface InitCountsDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L43
      v4: —
      Fix needed: <TODO: port dto `dto:initcounts` from v2>

- [ ] `dto:initdata` — interface InitDataDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L61
      v4: —
      Fix needed: <TODO: port dto `dto:initdata` from v2>

- [ ] `dto:initstore` — interface InitStoreDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:initstore` from v2>

- [ ] `dto:inventoryalert` — interface InventoryAlertDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L50
      v4: —
      Fix needed: <TODO: port dto `dto:inventoryalert` from v2>

- [ ] `dto:inventoryitem` — interface InventoryItemDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L3
      v4: —
      Fix needed: <TODO: port dto `dto:inventoryitem` from v2>

- [ ] `dto:inventoryledgerentry` — interface InventoryLedgerEntryDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L35
      v4: —
      Fix needed: <TODO: port dto `dto:inventoryledgerentry` from v2>

- [ ] `dto:legacysyncstatus` — interface LegacySyncStatusDto — **[MISSING]**
      v2: packages/contracts/src/shipments/contracts.ts:L16
      v4: —
      Fix needed: <TODO: port dto `dto:legacysyncstatus` from v2>

- [ ] `dto:legacysynctriggerresponse` — interface LegacySyncTriggerResponseDto — **[MISSING]**
      v2: packages/contracts/src/shipments/contracts.ts:L11
      v4: —
      Fix needed: <TODO: port dto `dto:legacysynctriggerresponse` from v2>

- [ ] `dto:listinventoryledgerquery` — interface ListInventoryLedgerQuery — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L157
      v4: —
      Fix needed: <TODO: port dto `dto:listinventoryledgerquery` from v2>

- [ ] `dto:listinventoryquery` — interface ListInventoryQuery — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L152
      v4: —
      Fix needed: <TODO: port dto `dto:listinventoryquery` from v2>

- [ ] `dto:listordersquery` — interface ListOrdersQuery — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L5
      v4: —
      Fix needed: <TODO: port dto `dto:listordersquery` from v2>

- [x] `dto:listordersresponse` — interface ListOrdersResponse — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L79
      v4: web/src/types/orders.ts:L133

- [ ] `dto:liveratesrequest` — interface LiveRatesRequestDto — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L70
      v4: —
      Fix needed: <TODO: port dto `dto:liveratesrequest` from v2>

- [x] `dto:location` — interface LocationDto — **[MATCH]**
      v2: packages/contracts/src/locations/contracts.ts:L1
      v4: web/src/types/api.ts:L12

- [ ] `dto:orderbestrate` — type OrderBestRateDto — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L59
      v4: —
      Fix needed: <TODO: port dto `dto:orderbestrate` from v2>

- [ ] `dto:orderexportquery` — interface OrderExportQuery — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L148
      v4: —
      Fix needed: <TODO: port dto `dto:orderexportquery` from v2>

- [ ] `dto:orderexportrow` — interface OrderExportRow — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L153
      v4: —
      Fix needed: <TODO: port dto `dto:orderexportrow` from v2>

- [x] `dto:orderfull` — interface OrderFullDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L128
      v4: web/src/types/api.ts:L13

- [ ] `dto:orderoverride` — interface OrderOverrideInput — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L119
      v4: —
      Fix needed: <TODO: port dto `dto:orderoverride` from v2>

- [x] `dto:orderpicklistitem` — interface OrderPicklistItemDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L97
      v4: web/src/types/api.ts:L15

- [ ] `dto:ordersbystatus` — interface OrdersByStatusDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L34
      v4: —
      Fix needed: <TODO: port dto `dto:ordersbystatus` from v2>

- [ ] `dto:ordersbystatusstore` — interface OrdersByStatusStoreDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L39
      v4: —
      Fix needed: <TODO: port dto `dto:ordersbystatusstore` from v2>

- [x] `dto:ordersdailystats` — interface OrdersDailyStatsDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L134
      v4: web/src/types/api.ts:L28

- [ ] `dto:orderselectedrate` — interface OrderSelectedRateDto — **[MISSING]**
      v2: packages/contracts/src/orders/contracts.ts:L67
      v4: —
      Fix needed: <TODO: port dto `dto:orderselectedrate` from v2>

- [x] `dto:ordersummary` — interface OrderSummaryDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L16
      v4: web/src/types/api.ts:L16

- [x] `dto:package` — interface PackageDto — **[MATCH]**
      v2: packages/contracts/src/packages/contracts.ts:L1
      v4: web/src/types/api.ts:L39

- [ ] `dto:packageadjustment` — interface PackageAdjustmentInput — **[MISSING]**
      v2: packages/contracts/src/packages/contracts.ts:L27
      v4: —
      Fix needed: <TODO: port dto `dto:packageadjustment` from v2>

- [ ] `dto:pagemeta` — interface PageMeta — **[MISSING]**
      v2: packages/contracts/src/common/pagination.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:pagemeta` from v2>

- [ ] `dto:parentsku` — interface ParentSkuDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L61
      v4: —
      Fix needed: <TODO: port dto `dto:parentsku` from v2>

- [ ] `dto:parentskudetail` — interface ParentSkuDetailDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L73
      v4: —
      Fix needed: <TODO: port dto `dto:parentskudetail` from v2>

- [ ] `dto:productbulkitem` — interface ProductBulkItemDto — **[MISSING]**
      v2: packages/contracts/src/products/contracts.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:productbulkitem` from v2>

- [x] `dto:productdefaults` — interface ProductDefaultsDto — **[MATCH]**
      v2: packages/contracts/src/products/contracts.ts:L10
      v4: web/src/types/api.ts:L53

- [x] `dto:rate` — interface RateDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L9
      v4: web/src/types/orders.ts:L37

- [ ] `dto:ratedims` — interface RateDimsDto — **[MISSING]**
      v2: packages/contracts/src/rates/contracts.ts:L3
      v4: —
      Fix needed: <TODO: port dto `dto:ratedims` from v2>

- [ ] `dto:receiveinventory` — interface ReceiveInventoryInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L113
      v4: —
      Fix needed: <TODO: port dto `dto:receiveinventory` from v2>

- [ ] `dto:receiveinventoryitem` — interface ReceiveInventoryItemInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L107
      v4: —
      Fix needed: <TODO: port dto `dto:receiveinventoryitem` from v2>

- [ ] `dto:receiveinventoryresult` — interface ReceiveInventoryResultDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L120
      v4: —
      Fix needed: <TODO: port dto `dto:receiveinventoryresult` from v2>

- [ ] `dto:retrievelabelresponse` — interface RetrieveLabelResponseDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L69
      v4: —
      Fix needed: <TODO: port dto `dto:retrievelabelresponse` from v2>

- [ ] `dto:returnlabelrequest` — interface ReturnLabelRequestDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L54
      v4: —
      Fix needed: <TODO: port dto `dto:returnlabelrequest` from v2>

- [ ] `dto:returnlabelresponse` — interface ReturnLabelResponseDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L58
      v4: —
      Fix needed: <TODO: port dto `dto:returnlabelresponse` from v2>

- [ ] `dto:savebillingpackageprice` — interface SaveBillingPackagePriceInput — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L101
      v4: —
      Fix needed: <TODO: port dto `dto:savebillingpackageprice` from v2>

- [ ] `dto:savebillingpackageprices` — interface SaveBillingPackagePricesInput — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L106
      v4: —
      Fix needed: <TODO: port dto `dto:savebillingpackageprices` from v2>

- [ ] `dto:savelocation` — interface SaveLocationInput — **[MISSING]**
      v2: packages/contracts/src/locations/contracts.ts:L16
      v4: —
      Fix needed: <TODO: port dto `dto:savelocation` from v2>

- [ ] `dto:savepackage` — interface SavePackageInput — **[MISSING]**
      v2: packages/contracts/src/packages/contracts.ts:L16
      v4: —
      Fix needed: <TODO: port dto `dto:savepackage` from v2>

- [ ] `dto:saveparentsku` — interface SaveParentSkuInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L95
      v4: —
      Fix needed: <TODO: port dto `dto:saveparentsku` from v2>

- [ ] `dto:saveproductdefaults` — interface SaveProductDefaultsInput — **[MISSING]**
      v2: packages/contracts/src/products/contracts.ts:L20
      v4: —
      Fix needed: <TODO: port dto `dto:saveproductdefaults` from v2>

- [ ] `dto:saveproductdefaultsresult` — interface SaveProductDefaultsResult — **[MISSING]**
      v2: packages/contracts/src/products/contracts.ts:L32
      v4: —
      Fix needed: <TODO: port dto `dto:saveproductdefaultsresult` from v2>

- [ ] `dto:setdefaultbillingpackageprice` — interface SetDefaultBillingPackagePriceInput — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L111
      v4: —
      Fix needed: <TODO: port dto `dto:setdefaultbillingpackageprice` from v2>

- [ ] `dto:setdefaultbillingpackagepriceresult` — interface SetDefaultBillingPackagePriceResult — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L116
      v4: —
      Fix needed: <TODO: port dto `dto:setdefaultbillingpackagepriceresult` from v2>

- [ ] `dto:setinventoryparent` — interface SetInventoryParentInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L102
      v4: —
      Fix needed: <TODO: port dto `dto:setinventoryparent` from v2>

- [ ] `dto:shipmentsyncresponse` — interface ShipmentSyncResponseDto — **[MISSING]**
      v2: packages/contracts/src/shipments/contracts.ts:L1
      v4: —
      Fix needed: <TODO: port dto `dto:shipmentsyncresponse` from v2>

- [ ] `dto:shipmentsyncstatus` — interface ShipmentSyncStatusDto — **[MISSING]**
      v2: packages/contracts/src/shipments/contracts.ts:L5
      v4: —
      Fix needed: <TODO: port dto `dto:shipmentsyncstatus` from v2>

- [ ] `dto:topsku` — interface TopSkuDto — **[MISSING]**
      v2: packages/contracts/src/analysis/contracts.ts:L43
      v4: —
      Fix needed: <TODO: port dto `dto:topsku` from v2>

- [ ] `dto:updatebillingconfig` — interface UpdateBillingConfigInput — **[MISSING]**
      v2: packages/contracts/src/billing/contracts.ts:L24
      v4: —
      Fix needed: <TODO: port dto `dto:updatebillingconfig` from v2>

- [ ] `dto:updateclient` — interface UpdateClientInput — **[MISSING]**
      v2: packages/contracts/src/clients/contracts.ts:L22
      v4: —
      Fix needed: <TODO: port dto `dto:updateclient` from v2>

- [ ] `dto:updateinventoryitem` — interface UpdateInventoryItemInput — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L137
      v4: —
      Fix needed: <TODO: port dto `dto:updateinventoryitem` from v2>

- [ ] `dto:voidlabelresponse` — interface VoidLabelResponseDto — **[MISSING]**
      v2: packages/contracts/src/labels/contracts.ts:L41
      v4: —
      Fix needed: <TODO: port dto `dto:voidlabelresponse` from v2>


---

**Verified-by:** _________  **Date:** _________
