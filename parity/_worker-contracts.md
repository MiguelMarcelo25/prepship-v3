# Parity: _worker-contracts

Source: `v2orginal/`
Target: `prepship-v4-stable/`

**Atoms:** 101  |  **MATCH:** 95  |  **MISSING:** 6  |  **Behavior review needed:** 0

Generated: 2026-04-23

---

### DTOs

- [x] `dto:address` — interface AddressInputDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L1
      v4: src/routes/labels.ts:L20
      Note: v4 inlines this as Zod schema `addressInput` (all 9 fields: name, company, street1, street2, city, state, postalCode, country, phone).

- [x] `dto:adjustinventory` — interface AdjustInventoryInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L129
      v4: src/routes/inventory.ts:L472
      Note: v4 inlines this as Zod schema on POST /inventory/adjust (invSkuId, qty, note). v2's `type` and `adjustedAt` fields are derived server-side (type always 'adjust') so not part of the request body.

- [ ] `dto:allowedsettingkey` — type AllowedSettingKey — **[MISSING]**
      v2: packages/contracts/src/settings/contracts.ts:L12
      v4: —
      Fix needed: add a frozen `ALLOWED_SETTINGS` tuple (rbMarkups, rbSettings, colVisibility, colPrefs, colWidths, dateRange, pageSize, defaultView) + `AllowedSettingKey` type in src/routes/settings.ts and gate PUT /:key / DELETE /:key against it. v4 currently accepts any free-form key, which diverges from v2's allowlist guard.

- [x] `dto:analysisdailysalesquery` — interface AnalysisDailySalesQuery — **[MATCH]**
      v2: packages/contracts/src/analysis/contracts.ts:L36
      v4: src/routes/analysis.ts:L97
      Note: v4 inlines this as Zod schema `skuDailyQuery` (dateFrom, dateTo, clientId, topN). v2's `top` is called `topN` in v4.

- [x] `dto:analysisdailysalesresponse` — interface AnalysisDailySalesResponse — **[MATCH]**
      v2: packages/contracts/src/analysis/contracts.ts:L49
      v4: src/routes/analysis.ts:L160
      Note: v4 inlines this as the response shape of `GET /analysis/sku-daily` and `/daily-sales` — `{topSkus: [{sku, name, total_qty}], days: [...]}`. v2's `series/dates` is restructured as pivoted `days` array in v4.

- [x] `dto:analysissku` — interface AnalysisSkuDto — **[MATCH]**
      v2: packages/contracts/src/analysis/contracts.ts:L9
      v4: src/routes/analysis.ts:L174
      Note: v4 inlines this as the row shape returned from `/sku-breakdown` and `/skus` — includes sku, name, image_url, clientId, orders, pending, ext_shipped, std_orders/total, exp_orders/total, total_qty, total_shipping.

- [x] `dto:analysisskuquery` — interface AnalysisSkuQuery — **[MATCH]**
      v2: packages/contracts/src/analysis/contracts.ts:L3
      v4: src/routes/analysis.ts:L163
      Note: v4 inlines this as Zod schema `skuBreakdownQuery` (dateFrom, dateTo, clientId, limit). v4 uses `dateFrom/dateTo` where v2 uses `from/to`.

- [x] `dto:analysisskusresponse` — interface AnalysisSkusResponse — **[MATCH]**
      v2: packages/contracts/src/analysis/contracts.ts:L31
      v4: src/routes/analysis.ts:L250
      Note: v4 inlines this as `{data: rows, totalSkus, totalOrders}` returned from `/sku-breakdown`. v2's `skus/orderCount` → v4's `data/totalOrders`.

- [x] `dto:autocreatepackage` — interface AutoCreatePackageInput — **[MATCH]**
      v2: packages/contracts/src/packages/contracts.ts:L33
      v4: src/routes/packages.ts:L264
      Note: v4 inlines this as Zod schema on POST /packages/auto-create (length, width, height, name?, tareWeightOz?). v2's `sku/clientId` are not used in v4's dims-first auto-create.

- [x] `dto:backfillbillingreferencerates` — interface BackfillBillingReferenceRatesInput — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L122
      v4: src/routes/billing.ts:L539
      Note: v4 inlines this as the body shape of POST /billing/backfill-ref-rates Shape B (`{from, to, clientId?}`). v4 extends with an optional `rates[]` for Shape A.

- [x] `dto:backfillbillingreferenceratesresult` — interface BackfillBillingReferenceRatesResult — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L127
      v4: src/routes/billing.ts:L588
      Note: v4 inlines this as the `{ok, filled, missing, total, message?}` response from POST /billing/backfill-ref-rates.

- [x] `dto:batchlabelresultitem` — interface BatchLabelResultItem — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L93
      v4: src/services/labels.ts (createBatchV2 result items)
      Note: v4 inlines this as the return shape of `createBatchV2` — per-order `{orderId, success, shipmentId?, trackingNumber?, cost?, error?}` returned by POST /labels/create-batch.

- [x] `dto:billingconfig` — interface BillingConfigDto — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L3
      v4: src/db/schema/billing.ts:L67
      Note: v4 inlines this as Drizzle `$inferSelect` (`export type BillingConfig = typeof billingConfig.$inferSelect`) and the GET /billing/config select projection in src/routes/billing.ts:L26. v2's `billing_mode` is camel-cased to `billingMode`; v4 has `pickPackMaxUnits`, no `storageFeeMode`/`palletPricingPerMonth`/`palletCuFt`.

- [x] `dto:billingdetail` — interface BillingDetailDto — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L66
      v4: src/services/billing.ts:L486
      Note: v4 inlines this as the return of `billingDetails()` — selects all fields from `billing_line_items` ($inferSelect of BillingLineItem). Detail-level join (label weight/dims/refRates/packageName) is computed at query time rather than as a named DTO.

- [x] `dto:billingdetailsquery` — interface BillingDetailsQuery — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L48
      v4: src/routes/billing.ts:L130
      Note: v4 inlines this as Zod schema `detailsSchema` (from/to/dateFrom/dateTo + clientId + limit). Accepts both v2's `from/to` and v4's `dateFrom/dateTo`.

- [x] `dto:billingpackageprice` — interface BillingPackagePriceDto — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L87
      v4: src/db/schema/billing.ts:L104
      Note: v4 inlines this as `ClientPackagePrice` ($inferSelect of clientPackagePrices) + package-name/dims added via join in route. v4 stores `price` as numeric text vs v2 number.

- [x] `dto:billingpackagepricesquery` — interface BillingPackagePricesQuery — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L97
      v4: src/routes/billing.ts:L406
      Note: v4 inlines this as Zod `z.object({ clientId: z.coerce.number().int() })` on GET /billing/package-prices.

- [x] `dto:billingreferenceratefetchstatus` — interface BillingReferenceRateFetchStatusDto — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L135
      v4: src/routes/billing.ts:L709
      Note: v4 inlines this as the response shape of GET /billing/fetch-ref-rates/status (`{running, done, total, errors, status, message, totalRefRates, ...}`). v4 extends v2 with additional fields (inserted, status, message, failureSamples, totalRefRates).

- [x] `dto:billingsummary` — interface BillingSummaryDto — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L36
      v4: src/services/billing.ts:L438
      Note: v4 inlines this as the return of `billingSummary()` — per-client `{clientId, total, byType, count}` aggregated from billing_line_items. v4's `byType` map subsumes v2's separate `pickPackTotal/additionalTotal/packageTotal/shippingTotal/storageTotal` fields.

- [x] `dto:billingsummaryquery` — interface BillingSummaryQuery — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L18
      v4: src/routes/billing.ts:L120
      Note: v4 inlines this as Zod `generateSchema` (from/to/dateFrom/dateTo + clientId). Accepts both v2 and v4 param name shapes via `generateRawSchema.transform(...)`.

- [x] `dto:browseratesrequest` — interface BrowseRatesRequestDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L87
      v4: src/routes/rates.ts:L41
      Note: v4 inlines this as Zod schema `browseBody = rateBody.omit({carrierIds:true}).extend({carrierId: z.string()})` on POST /rates/browse.

- [x] `dto:bulkcachedratesitemresult` — interface BulkCachedRatesItemResult — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L54
      v4: src/routes/rates.ts:L115
      Note: v4 inlines this as the per-item shape returned by POST /rates/cached/bulk — `{weightOz, toZip, hit: rateCache|null}`. v4 returns the rateCache row rather than the fully-materialized `{cached, rates, best}` aggregate; structurally equivalent for the consumer.

- [x] `dto:bulkcachedratesrequestitem` — interface BulkCachedRatesRequestItem — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L42
      v4: src/routes/rates.ts:L108
      Note: v4 inlines this as Zod schema `bulkBody.items[]` — `{weightOz, toZip}`. v4 trims the request to just the lookup keys (the other v2 fields were carried to avoid a follow-up read).

- [x] `dto:bulkcachedratesresponse` — interface BulkCachedRatesResponseDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L61
      v4: web/src/types/orders.ts:L179

- [x] `dto:bulkupdateinventorydimensions` — interface BulkUpdateInventoryDimensionsInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L165
      v4: src/routes/inventory.ts:L497
      Note: v4 inlines this as Zod schema `bulkDimsBody` on POST /inventory/bulk-update-dims (items array with id, weightOz, length, width, height, baseUnitQty, unitsPerPack, cuFtOverride, packageId). v4's shape is a superset of v2's.

- [x] `dto:cachedratesresponse` — interface CachedRatesResponseDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L35
      v4: src/routes/rates.ts:L135
      Note: v4 inlines this as `{data: RateCache[]}` returned from GET /rates/cached (using Drizzle `$inferSelect` on rateCache). v4 returns raw cache rows; consumers materialize `{cached, rates, best}` client-side.

- [x] `dto:carrieraccount` — interface CarrierAccountDto — **[MATCH]**
      v2: packages/contracts/src/init/contracts.ts:L23
      v4: web/src/types/api.ts:L10

- [x] `dto:carrierlookupresponse` — interface CarrierLookupResponseDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L66
      v4: src/routes/rates.ts:L152
      Note: v4 inlines this as the `CarriersResponse` passthrough (`{carriers: [...]}` typed via `src/lib/shipstation/types.ts`) returned from GET /rates/carriers and GET /init/carrier-accounts.

- [x] `dto:client` — interface ClientDto — **[MATCH]**
      v2: packages/contracts/src/clients/contracts.ts:L1
      v4: src/db/schema/clients.ts:L27
      Note: v4 inlines this as Drizzle `$inferSelect` (`export type Client = typeof clients.$inferSelect`). Returned directly from GET /clients. Field names differ (v4 uses `id`/`storeIds`/etc, v2 maps to `clientId`) but the structural shape is covered.

- [x] `dto:client` — interface ClientDto — **[MATCH]**
      v2: packages/contracts/src/init/contracts.ts:L48
      v4: src/db/schema/clients.ts:L27
      Note: v4 inlines this as Drizzle `$inferSelect` on the clients table. `rateSourceClientId` and other v2-specific fields exist on the v4 clients schema (brandName/brandColor/rateSourceClientId). Shape covered by same `Client` type as the `/clients` module.

- [x] `dto:createbatchlabelrequest` — interface CreateBatchLabelRequestDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L83
      v4: src/routes/labels.ts:L52
      Note: v4 inlines this as Zod schema `batchBody` on POST /labels/create-batch (orderIds, serviceCode, carrierCode?, packageCode?, confirmation?, testLabel?, shippingProviderId).

- [x] `dto:createbatchlabelresponse` — interface CreateBatchLabelResponseDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L102
      v4: src/services/labels.ts (createBatchV2 return)
      Note: v4 inlines this as the return shape of `createBatchV2()` — `{created, failed, summary: {total, created, failed}}` returned from POST /labels/create-batch.

- [x] `dto:createclient` — interface CreateClientInput — **[MATCH]**
      v2: packages/contracts/src/clients/contracts.ts:L14
      v4: src/routes/clients.ts:L12
      Note: v4 inlines this as Zod schema `body` on POST /clients (name, storeIds?, contactName?, email?, phone?, plus ssApiKey, ssApiSecret, brand fields, etc — v4's shape is a superset of v2's).

- [x] `dto:createlabelrequest` — interface CreateLabelRequestDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L13
      v4: web/src/types/api.ts:L11

- [x] `dto:createlabelresponse` — interface CreateLabelResponseDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L31
      v4: src/services/labels.ts (createLabelV2 return)
      Note: v4 inlines this as the return of `createLabelV2()` — `{shipmentId, trackingNumber, labelUrl, cost, voided, orderStatus, apiVersion:'v2'}` returned from POST /labels and POST /labels/create.

- [x] `dto:fetchbillingreferenceratesresult` — interface FetchBillingReferenceRatesResult — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L143
      v4: src/routes/billing.ts:L675
      Note: v4 inlines this as the response of POST /billing/fetch-ref-rates (`{ok, jobId, status, total, orders, queued}`) with status polled via GET /billing/fetch-ref-rates/status.

- [x] `dto:generatebilling` — interface GenerateBillingInput — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L54
      v4: src/routes/billing.ts:L113
      Note: v4 inlines this as Zod `generateSchema` (from/to/dateFrom/dateTo + clientId). Same schema used across /generate, /summary, /details.

- [x] `dto:generatebillingresult` — interface GenerateBillingResult — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L60
      v4: src/services/billing.ts:L435
      Note: v4 inlines this as the return of `generateLineItems()` — `{generated, skipped, message}` returned from POST /billing/generate. v4 exposes `generated/skipped/message` instead of v2's `{ok, generated, total}`.

- [x] `dto:generatemanifest` — interface GenerateManifestInput — **[MATCH]**
      v2: packages/contracts/src/manifests/contracts.ts:L1
      v4: src/routes/manifests.ts:L10
      Note: v4 inlines this as Zod schema `query` on GET /manifests/generate (dateFrom, dateTo, carrierCode?, clientId?). v2's `startDate/endDate` → v4's `dateFrom/dateTo`; `carrierId` → `carrierCode`.

- [x] `dto:getcachedratesquery` — interface GetCachedRatesQuery — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L26
      v4: src/routes/rates.ts:L67
      Note: v4 inlines this as Zod schema `cachedQuery` on GET /rates/cached. Accepts both v2's short param names (wt, zip, l, w, h) and v4's long names via transform.

- [x] `dto:getorderidsquery` — interface GetOrderIdsQuery — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L86
      v4: src/routes/orders.ts:L136
      Note: v4 inlines this as Zod schema on GET /orders/ids (sku, qty?, orderStatus?, storeId?).

- [x] `dto:getorderidsresponse` — interface GetOrderIdsResponse — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L93
      v4: src/routes/orders.ts:L156
      Note: v4 inlines this as `{data: [{id, order_number}]}` response from GET /orders/ids. v4 returns row objects with `id + order_number` where v2 returned `ids: number[]` — structurally richer but covers the ids-lookup use.

- [x] `dto:getorderpicklistquery` — interface GetOrderPicklistQuery — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L107
      v4: src/routes/orders.ts:L122
      Note: v4 inlines this as Zod schema `picklistQuery` on GET /orders/picklist (status, clientId?, storeId?, dateFrom?, dateTo?). v4 renames `orderStatus` → `status` and `dateStart/dateEnd` → `dateFrom/dateTo`.

- [x] `dto:getorderpicklistresponse` — interface GetOrderPicklistResponse — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L114
      v4: src/routes/orders.ts:L433
      Note: v4 inlines this as `{skus, totalSkus, totalUnits}` returned from GET /orders/picklist. v4 renames `skus`/adds `totalSkus/totalUnits` aggregates.

- [x] `dto:initcounts` — interface InitCountsDto — **[MATCH]**
      v2: packages/contracts/src/init/contracts.ts:L43
      v4: src/routes/init.ts:L43
      Note: v4 inlines this as the response of GET /init/counts — `{awaiting, shipped, cancelled, on_hold, queue, inventory}`. v2 structured this as `{byStatus, byStatusStore}` (nested arrays); v4 flattens to a single object with per-status counts.

- [ ] `dto:initdata` — interface InitDataDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L61
      v4: —
      Fix needed: GET /init/init-data returns `{clients, locations, packages, carriers}` — missing v2's `stores` array (fan-out of clients.storeIds), `counts` (InitCountsDto), and `markups` (Record<string, unknown>). Either extend /init-data to return those four keys for v2 parity, or update the React bootstrap to issue four parallel calls (/init/init-data + /init/stores + /init/counts + /settings?key=markups).

- [ ] `dto:initstore` — interface InitStoreDto — **[MISSING]**
      v2: packages/contracts/src/init/contracts.ts:L1
      v4: —
      Fix needed: GET /init/stores returns only `{storeId, clientId, clientName, active}` — v2's InitStoreDto carries 22 fields (storeName, marketplaceId, marketplaceName, accountName, email, integrationUrl, companyName, phone, publicEmail, website, refreshDate, lastRefreshAttempt, createDate, modifyDate, autoRefresh, statusMappings, isLocal). Either persist the full ShipStation store payload on sync (extend the clients table or add a stores table) and expose them via /init/stores, or document that v4 intentionally trims this shape (Phase E INTENTIONALLY_CHANGED).

- [x] `dto:inventoryalert` — interface InventoryAlertDto — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L50
      v4: src/routes/inventory.ts:L114
      Note: v4 inlines this as the row shape returned from GET /inventory/alerts (`{type:'sku', id, sku, name, stock, minStock, parentSkuId, clientId}`). v4 currently only emits type='sku' (parent alerts not yet wired).

- [x] `dto:inventoryitem` — interface InventoryItemDto — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L3
      v4: src/db/schema/inventory.ts:L71
      Note: v4 inlines this as Drizzle `$inferSelect` on the inventory table (`export type Inventory = typeof inventory.$inferSelect`). v4 stores canonical fields; display-layer enrichments (clientName, packageName, parentName, status, baseUnits) are computed on read rather than being on the DTO itself.

- [x] `dto:inventoryledgerentry` — interface InventoryLedgerEntryDto — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L35
      v4: src/routes/inventory.ts:L71
      Note: v4 inlines this as the projection returned from GET /inventory/ledger — joins inventory + inventoryLedger for `{id, inventoryId, sku, name, clientId, type, qty, orderId, note, createdBy, createdAt}`. Same field set as v2 (minus `skuName/clientName` which are derivable from the join).

- [ ] `dto:legacysyncstatus` — interface LegacySyncStatusDto — **[MISSING]**
      v2: packages/contracts/src/shipments/contracts.ts:L16
      v4: —
      Fix needed: GET /orders/sync/status (getSyncStatus) returns `{lastSyncedAt, orderCount, isRunning}` — missing v2's `status: 'idle'|'syncing'|'done'|'error'`, `error: string|null`, `page: number`, `mode: 'idle'|'incremental'|'full'`, `ratesCached: number`, `ratePrefetchRunning: boolean`. Either extend the status response with those fields (especially `status/error/mode`, which progress UIs rely on) or document as INTENTIONALLY_CHANGED in Phase E.

- [x] `dto:legacysynctriggerresponse` — interface LegacySyncTriggerResponseDto — **[MATCH]**
      v2: packages/contracts/src/shipments/contracts.ts:L11
      v4: src/routes/orders.ts:L20
      Note: v4 inlines this as the response of POST /orders/sync — returns the full `SyncResult` object (`{synced, pages, lastSyncedAt, ...}`) rather than the v2 `{queued, mode}` shape. v4 executes the sync inline rather than queueing.

- [x] `dto:listinventoryledgerquery` — interface ListInventoryLedgerQuery — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L157
      v4: src/routes/inventory.ts:L54
      Note: v4 inlines this as Zod schema `ledgerQuery` on GET /inventory/ledger (pagination + clientId, sku, type). v2's `dateStart/dateEnd/limit` are handled via pagination + an implicit 200-row limit.

- [x] `dto:listinventoryquery` — interface ListInventoryQuery — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L152
      v4: src/routes/inventory.ts:L15
      Note: v4 inlines this as Zod schema `listQuery` on GET /inventory (pagination + clientId, search, lowStock). v4 adds `search/lowStock` as a superset.

- [x] `dto:listordersquery` — interface ListOrdersQuery — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L5
      v4: src/routes/orders.ts:L38
      Note: v4 inlines this as Zod schema `listQuery = paginationSchema.extend({...})` with status, clientId, storeId, excludeClientId, dateFrom, dateTo, search. v4 uses `status/dateFrom/dateTo` where v2 uses `orderStatus/dateStart/dateEnd`.

- [x] `dto:listordersresponse` — interface ListOrdersResponse — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L79
      v4: web/src/types/orders.ts:L133

- [x] `dto:liveratesrequest` — interface LiveRatesRequestDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L70
      v4: src/routes/rates.ts:L18
      Note: v4 inlines this as Zod schema `rateBody` on POST /rates (weightOz, toZip, toCountry?, toState?, toCity?, toAddress?, toName?, residential?, dimsL/W/H?, carrierIds?, forceRefresh?). v4's shape is flatter than v2's nested weight/dimensions objects; the corresponding React-side shape with v2's nested form lives at web/src/types/orders.ts:L168 (`LiveRateRequest`).

- [x] `dto:location` — interface LocationDto — **[MATCH]**
      v2: packages/contracts/src/locations/contracts.ts:L1
      v4: web/src/types/api.ts:L12

- [x] `dto:orderbestrate` — type OrderBestRateDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L59
      v4: web/src/types/orders.ts:L37
      Note: v4 inlines this as `Rate` interface plus the `bestRate?: Rate` field on `OrderDTO`. v4's Rate matches v2's `OrderBestRateDto` structurally — serviceCode/Name/carrierCode are nullable on the rendered order.

- [x] `dto:orderexportquery` — interface OrderExportQuery — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L148
      v4: src/routes/orders.ts:L723
      Note: v4 inlines this as Zod schema `exportQuery` on GET /orders/export (status, dateFrom?, dateTo?, clientId?). v4 adds date/client filters as a superset of v2's `{orderStatus, pageSize}`.

- [x] `dto:orderexportrow` — interface OrderExportRow — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L153
      v4: src/routes/orders.ts:L796
      Note: v4 inlines this as the CSV row generated by GET /orders/export (header at :796). v4's CSV has more columns (Order #, Recipient, Item Name, Weight, Ship To, Carrier, Service, Tracking #, Order Total, Best Rate, Label Cost, Ship Margin, Age (hrs), Raw API, Best Rate JSON) — superset of v2's row.

- [x] `dto:orderfull` — interface OrderFullDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L128
      v4: web/src/types/api.ts:L13

- [x] `dto:orderoverride` — interface OrderOverrideInput — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L119
      v4: src/routes/orders.ts:L475
      Note: v4 inlines this as Zod schema `patchBody` on PATCH /orders/:id (residential, notes, tags, trackingNumber, selectedPid, selectedPackageId, bestRateJson, bestRateDims, shippingAccount, externallyShipped, externallyShippedSource). v4's shape is a superset of v2's OrderOverrideInput.

- [x] `dto:orderpicklistitem` — interface OrderPicklistItemDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L97
      v4: web/src/types/api.ts:L15

- [x] `dto:ordersbystatus` — interface OrdersByStatusDto — **[MATCH]**
      v2: packages/contracts/src/init/contracts.ts:L34
      v4: src/routes/clients.ts:L173
      Note: v4 inlines this as the `byClient` row shape returned from GET /clients/order-stats (`{clientId, total, awaiting, shipped, cancelled, onHold, other}`). v4 flattens per-status counts into one record per client instead of v2's `{orderStatus, cnt}` row shape; covers the same use case.

- [x] `dto:ordersbystatusstore` — interface OrdersByStatusStoreDto — **[MATCH]**
      v2: packages/contracts/src/init/contracts.ts:L39
      v4: src/routes/orders.ts:L161
      Note: v4 inlines this as the response of GET /orders/store-counts — `{store_id, count}[]` rolled up by store, with an optional status filter. v4 drops the nested `orderStatus` per-store breakdown (single status at a time via query).

- [x] `dto:ordersdailystats` — interface OrdersDailyStatsDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L134
      v4: web/src/types/api.ts:L28

- [x] `dto:orderselectedrate` — interface OrderSelectedRateDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L67
      v4: web/src/types/orders.ts:L37
      Note: v4 inlines this as `Rate` interface (shippingProviderId, carrierCode, serviceCode, serviceName, amount, shipmentCost?, otherCost?, carrierNickname?, etc.). `selectedRate?: Rate` field on OrderDTO covers v2's OrderSelectedRateDto structural shape.

- [x] `dto:ordersummary` — interface OrderSummaryDto — **[MATCH]**
      v2: packages/contracts/src/orders/contracts.ts:L16
      v4: web/src/types/api.ts:L16

- [x] `dto:package` — interface PackageDto — **[MATCH]**
      v2: packages/contracts/src/packages/contracts.ts:L1
      v4: web/src/types/api.ts:L39

- [x] `dto:packageadjustment` — interface PackageAdjustmentInput — **[MATCH]**
      v2: packages/contracts/src/packages/contracts.ts:L27
      v4: src/routes/packages.ts:L168
      Note: v4 inlines this as Zod schema `adjustBody` (qtyDelta, note?) on POST /packages/:id/adjust — v4 uses `qtyDelta` instead of `qty`. Receive-specific `costPerUnit` lives on the separate POST /packages/:id/receive body (receiveBody with unitCost).

- [x] `dto:pagemeta` — interface PageMeta — **[MATCH]**
      v2: packages/contracts/src/common/pagination.ts:L1
      v4: src/lib/pagination.ts:L14
      Note: v4 inlines this as the `pagination` object inside `paginated(...)` return — `{page, pageSize, total, totalPages}`. v4 renames `pages` → `totalPages`.

- [x] `dto:parentsku` — interface ParentSkuDto — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L61
      v4: src/db/schema/parent-skus.ts:L27
      Note: v4 inlines this as Drizzle `$inferSelect` (`export type ParentSku = typeof parentSkus.$inferSelect`) — returned from GET /parent-skus and GET /inventory/:id/parents. v2's derived aggregates (childCount, totalBaseUnits, lowStockCount) are computed client-side from the parents list + inventory.

- [ ] `dto:parentskudetail` — interface ParentSkuDetailDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L73
      v4: —
      Fix needed: there is no GET /parent-skus/:id endpoint returning the v2 `ParentSkuDetailDto` shape (`ParentSkuDto + {children, lowStockChildren, lowStockCount}`). Either add a detail route that joins parent_skus + inventory_sku_parents + inventory to return the aggregated DTO, or document that the React client assembles this client-side from /parent-skus + /inventory.

- [x] `dto:productbulkitem` — interface ProductBulkItemDto — **[MATCH]**
      v2: packages/contracts/src/products/contracts.ts:L1
      v4: src/routes/products.ts:L41
      Note: v4 inlines this as the row shape returned from GET /products/bulk — Drizzle `$inferSelect` of the products table (sku, weightOz, length, width, height, defaultPackageCode, plus imageUrl/name etc). v4's shape is a superset.

- [x] `dto:productdefaults` — interface ProductDefaultsDto — **[MATCH]**
      v2: packages/contracts/src/products/contracts.ts:L10
      v4: web/src/types/api.ts:L53

- [x] `dto:rate` — interface RateDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L9
      v4: web/src/types/orders.ts:L37

- [x] `dto:ratedims` — interface RateDimsDto — **[MATCH]**
      v2: packages/contracts/src/rates/contracts.ts:L3
      v4: web/src/types/orders.ts:L15
      Note: v4 inlines this as `OrderDimensions` interface — `{length, width, height}`. Same shape.

- [x] `dto:receiveinventory` — interface ReceiveInventoryInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L113
      v4: src/routes/inventory.ts:L427
      Note: v4 inlines this as Zod schema on POST /inventory/receive (`{clientId, items: [{invSkuId, qty, note?}]}`). v4's items carry `invSkuId` directly instead of requiring a sku lookup.

- [x] `dto:receiveinventoryitem` — interface ReceiveInventoryItemInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L107
      v4: src/routes/inventory.ts:L431
      Note: v4 inlines this as the `items[]` element of POST /inventory/receive body — `{invSkuId, qty, note?}`. v4 takes an `invSkuId` (the inventory row's id) where v2 took `{sku, name?, qty}`.

- [ ] `dto:receiveinventoryresult` — interface ReceiveInventoryResultDto — **[MISSING]**
      v2: packages/contracts/src/inventory/contracts.ts:L120
      v4: —
      Fix needed: POST /inventory/receive returns only `{invSkuId, ok, error?}` per item — v2's ReceiveInventoryResultDto carries `{sku, qty, baseUnitQty, baseUnits, invSkuId, newStock}`. Extend the per-item result to include `sku`, `qty`, `baseUnitQty`, `baseUnits`, and the post-receive `newStock` so receiving UIs can show the new on-hand total without a round-trip read.

- [x] `dto:retrievelabelresponse` — interface RetrieveLabelResponseDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L69
      v4: src/services/labels.ts (retrieveLabelV2 return)
      Note: v4 inlines this as the return of `retrieveLabelV2()` returned from GET /labels/:lookup/retrieve — `{orderId, orderNumber, shipmentId, trackingNumber, labelUrl, createdAt, carrier, service, cost}`.

- [x] `dto:returnlabelrequest` — interface ReturnLabelRequestDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L54
      v4: src/routes/labels.ts:L62
      Note: v4 inlines this as Zod schema `returnBody = z.object({reason?}).optional().default({})` on POST /labels/:shipmentId/return.

- [x] `dto:returnlabelresponse` — interface ReturnLabelResponseDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L58
      v4: src/services/labels.ts (createReturnLabelV2 return)
      Note: v4 inlines this as the return of `createReturnLabelV2()` — `{success, shipmentId, orderNumber, returnTrackingNumber, returnShipmentId, cost, reason, createdAt}` returned from POST /labels/:shipmentId/return.

- [x] `dto:savebillingpackageprice` — interface SaveBillingPackagePriceInput — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L101
      v4: src/routes/billing.ts:L421
      Note: v4 inlines this as each `prices[]` element of Zod schema `pricesBody` on PUT /billing/package-prices (`{packageId, price, isCustom?}`).

- [x] `dto:savebillingpackageprices` — interface SaveBillingPackagePricesInput — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L106
      v4: src/routes/billing.ts:L417
      Note: v4 inlines this as Zod schema `pricesBody = {clientId, prices: [...]}` on PUT /billing/package-prices.

- [x] `dto:savelocation` — interface SaveLocationInput — **[MATCH]**
      v2: packages/contracts/src/locations/contracts.ts:L16
      v4: src/routes/locations.ts:L12
      Note: v4 inlines this as Zod schema `body` on POST/PATCH /locations (name, company?, street1?, street2?, city?, state?, postalCode?, country?, phone?, active?). v4's `isDefault` is set via POST /locations/:id/default instead of the body.

- [x] `dto:savepackage` — interface SavePackageInput — **[MATCH]**
      v2: packages/contracts/src/packages/contracts.ts:L16
      v4: src/routes/packages.ts:L13
      Note: v4 inlines this as Zod schema `body` on POST/PATCH/PUT /packages (name, type?, length, width, height, tareWeightOz, source?, carrierCode?, packageCode?, domestic?, international?, stockQty?, reorderLevel?, unitCost?, isDefault?). v4's shape is a superset.

- [x] `dto:saveparentsku` — interface SaveParentSkuInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L95
      v4: src/routes/parent-skus.ts:L24
      Note: v4 inlines this as Zod schema `createBody` on POST /parent-skus (clientId, name, sku?, baseUnitQty?).

- [x] `dto:saveproductdefaults` — interface SaveProductDefaultsInput — **[MATCH]**
      v2: packages/contracts/src/products/contracts.ts:L20
      v4: src/routes/products.ts:L104
      Note: v4 inlines this as Zod schema `saveDefaultsBody` on POST /products/save-defaults (sku, name?, weightOz?, length?, width?, height?, defaultPackageCode?). v4 drops v2's `productId`/`weight`/`packageCode`/`packageId` aliases in favor of canonical names; resolvePackageId (v2's auto-create-by-dims behavior) is handled separately via POST /packages/auto-create.

- [x] `dto:saveproductdefaultsresult` — interface SaveProductDefaultsResult — **[MATCH]**
      v2: packages/contracts/src/products/contracts.ts:L32
      v4: src/routes/products.ts:L166
      Note: v4 inlines this as the returned `products.$inferSelect` row from POST /products/save-defaults. v4's response shape is simpler — just the upserted row — since package-creation side-effects happen on a separate call.

- [x] `dto:setdefaultbillingpackageprice` — interface SetDefaultBillingPackagePriceInput — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L111
      v4: src/routes/billing.ts:L458
      Note: v4 inlines this as Zod schema `{packageId, price}` on POST /billing/package-prices/set-default. v4 requires both fields (v2 had them optional).

- [x] `dto:setdefaultbillingpackagepriceresult` — interface SetDefaultBillingPackagePriceResult — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L116
      v4: src/routes/billing.ts:L476
      Note: v4 inlines this as the response `{updated, packageId, price}` from POST /billing/package-prices/set-default. v4 drops the `skipped` count and returns the echoed packageId/price.

- [x] `dto:setinventoryparent` — interface SetInventoryParentInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L102
      v4: src/routes/inventory.ts:L277
      Note: v4 inlines this as Zod schema on PUT /inventory/:id/set-parent (`{parentSkuId: number|null}`). v2's optional `baseUnitQty` is updated on the inventory row via PATCH rather than being part of set-parent.

- [x] `dto:shipmentsyncresponse` — interface ShipmentSyncResponseDto — **[MATCH]**
      v2: packages/contracts/src/shipments/contracts.ts:L1
      v4: src/routes/shipments.ts:L22
      Note: v4 inlines this as the response of POST /shipments/sync — the full `ShipmentSyncResult` (`{inserted, updated, ordersMarkedShipped, ...}`). v4 executes the sync inline and returns the result synchronously rather than v2's `{queued:true}` async response.

- [x] `dto:shipmentsyncstatus` — interface ShipmentSyncStatusDto — **[MATCH]**
      v2: packages/contracts/src/shipments/contracts.ts:L5
      v4: src/services/shipment-sync.ts:L395
      Note: v4 inlines this as the return of `getShipmentSyncStatus()` returned from GET /shipments/status — `{lastSyncedAt, shipmentCount, isRunning}`. v4 uses `lastSyncedAt` (ISO string) and `shipmentCount` vs v2's `lastSync` (ms epoch) and `count`; semantically equivalent.

- [x] `dto:topsku` — interface TopSkuDto — **[MATCH]**
      v2: packages/contracts/src/analysis/contracts.ts:L43
      v4: src/routes/analysis.ts:L261
      Note: v4 inlines this as the row shape from GET /analysis/top-skus — `{sku, total_qty, order_count}`. v2's `{sku, name, total}` — v4 adds `order_count` and keeps sku-level qty; name is fetched per-row via the sku-breakdown endpoint.

- [x] `dto:updatebillingconfig` — interface UpdateBillingConfigInput — **[MATCH]**
      v2: packages/contracts/src/billing/contracts.ts:L24
      v4: src/routes/billing.ts:L48
      Note: v4 inlines this as Zod schema `configBody` on PUT /billing/config/:clientId (pickPackFee, pickPackMaxUnits, additionalUnitFee, packageCostMarkup, shippingMarkupPct, shippingMarkupFlat, storageFeePerCuFt, billingMode, active). v4 adds pickPackMaxUnits/packageCostMarkup, drops storageFeeMode/palletPricingPerMonth/palletCuFt (features not yet implemented in v4).

- [x] `dto:updateclient` — interface UpdateClientInput — **[MATCH]**
      v2: packages/contracts/src/clients/contracts.ts:L22
      v4: src/routes/clients.ts:L47
      Note: v4 inlines this as `body.partial()` on PATCH /clients/:id — same fields as create (name, storeIds, contactName, email, phone, ssApiKey, ssApiSecret, ssApiKeyV2, rateSourceClientId) all optional. v4 uses camelCase (ssApiKey) where v2 used snake_case (ss_api_key).

- [x] `dto:updateinventoryitem` — interface UpdateInventoryItemInput — **[MATCH]**
      v2: packages/contracts/src/inventory/contracts.ts:L137
      v4: src/routes/inventory.ts:L237
      Note: v4 inlines this as `createBody.omit({sku:true}).partial().extend({sku: z.string().min(1).optional()})` on PATCH /inventory/:id. v4 renames `minStock` → `reorderLevel`; `units_per_pack` → `unitsPerPack`; v4's shape is a superset of v2's.

- [x] `dto:voidlabelresponse` — interface VoidLabelResponseDto — **[MATCH]**
      v2: packages/contracts/src/labels/contracts.ts:L41
      v4: src/services/labels.ts (voidLabelV2 return)
      Note: v4 inlines this as the return of `voidLabelV2()` returned from POST /labels/:shipmentId/void — `{success, shipmentId, orderNumber, voided, voidedAt, trackingNumber, refundAmount, refundInitiated, refundEstimate, note}`.


---

**Verified-by:** _________  **Date:** _________
