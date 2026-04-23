# Parity: v4-only atoms

These atoms exist in v4 but have no v2 counterpart. Either:
- **Improvement** (v4 deliberately added something v2 lacks) → mark `[INTENTIONALLY_CHANGED]` below
- **Dead-code candidate** (not in v2 because not needed) → mark for review

## billing
- [ ] `GET /billing/ref-rates` — GET /billing/ref-rates — **[V4_ONLY]**
      v4: src/routes/billing.ts:L484
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients` — GET /clients — **[V4_ONLY]**
      v4: web/src/pages/Billing.tsx:L64
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.active` — column billing_config.active boolean — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L36
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.additional_unit_fee` — column billing_config.additionalUnitFee numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.billing_mode` — column billing_config.billingMode text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L35
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.client_id` — column billing_config.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.created_at` — column billing_config.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L37
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.package_cost_markup` — column billing_config.packageCostMarkup numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.pick_pack_fee` — column billing_config.pickPackFee numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.pick_pack_max_units` — column billing_config.pickPackMaxUnits integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.shipping_markup_flat` — column billing_config.shippingMarkupFlat numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.shipping_markup_pct` — column billing_config.shippingMarkupPct numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.storage_fee_per_cu_ft` — column billing_config.storageFeePerCuFt numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L32
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_config.updated_at` — column billing_config.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L38
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.client_id` — column billing_line_items.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L45
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.created_at` — column billing_line_items.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L58
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.description` — column billing_line_items.description text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L53
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.id` — column billing_line_items.id serial — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L44
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.invoiced` — column billing_line_items.invoiced boolean — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L57
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.line_type` — column billing_line_items.lineType text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L52
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.order_id` — column billing_line_items.orderId integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L48
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.order_number` — column billing_line_items.orderNumber text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L49
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.qty` — column billing_line_items.qty numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L54
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.ship_date` — column billing_line_items.shipDate timestamp — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L51
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.shipment_id` — column billing_line_items.shipmentId integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L50
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.total_cost` — column billing_line_items.totalCost numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L56
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_line_items.unit_cost` — column billing_line_items.unitCost numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L55
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.carrier` — column billing_ref_rates.carrier text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L93
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.cost` — column billing_ref_rates.cost numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L95
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.fetched_at` — column billing_ref_rates.fetchedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L97
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.id` — column billing_ref_rates.id serial — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L90
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.service` — column billing_ref_rates.service text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L94
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.source` — column billing_ref_rates.source text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L96
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.weight_oz` — column billing_ref_rates.weightOz integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L91
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:billing_ref_rates.zip_to` — column billing_ref_rates.zipTo text — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L92
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:client_package_prices.client_id` — column client_package_prices.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L74
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:client_package_prices.is_custom` — column client_package_prices.isCustom boolean — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L79
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:client_package_prices.package_id` — column client_package_prices.packageId integer — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L77
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:client_package_prices.price` — column client_package_prices.price numeric — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L78
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:client_package_prices.updated_at` — column client_package_prices.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L80
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:billing_config` — table billing_config — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:billing_line_items` — table billing_line_items — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L41
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:billing_ref_rates` — table billing_ref_rates — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L87
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:client_package_prices` — table client_package_prices — **[V4_ONLY]**
      v4: src/db/schema/billing.ts:L71
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:billingdetails` — billingDetails(...) — **[V4_ONLY]**
      v4: src/services/billing.ts:L486
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:billingsummary` — billingSummary(...) — **[V4_ONLY]**
      v4: src/services/billing.ts:L438
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:generatelineitems` — generateLineItems(...) — **[V4_ONLY]**
      v4: src/services/billing.ts:L50
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:upsertbillingconfig` — upsertBillingConfig(...) — **[V4_ONLY]**
      v4: src/services/billing.ts:L506
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## _config
- [ ] `apiclient:createlabelbatch` — apiClient.createLabelBatch() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L920
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:downloadordersexport` — apiClient.downloadOrdersExport() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L829
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:downloadqueueprintjob` — apiClient.downloadQueuePrintJob() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1013
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:fetchinitdata` — apiClient.fetchInitData() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L470
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:fetchqueueprintjobpdfurl` — apiClient.fetchQueuePrintJobPdfUrl() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1026
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:openbillinginvoice` — apiClient.openBillingInvoice() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1042
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:openlabel` — apiClient.openLabel() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L945
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:returnlabel` — apiClient.returnLabel() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L936
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `apiclient:saveorderdims` — apiClient.saveOrderDims() — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L882
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:useclients` — useClients(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L492
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:useinventory` — useInventory(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L638
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:uselocations` — useLocations(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L330
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:useorderdetail` — useOrderDetail(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L270
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:useorders` — useOrders(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L159
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:usepackages` — usePackages(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L749
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `hook:useshippingaccounts` — useShippingAccounts(...) — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L393
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `DELETE /clientid` — DELETE clientId — **[V4_ONLY]**
      v4: web/src/pages/Picklist.tsx:L96
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `DELETE /clients/:id` — DELETE /clients/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/clients.ts:L59
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /admin/test-clients` — GET /admin/test-clients — **[V4_ONLY]**
      v4: src/routes/admin.ts:L367
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /billing/config` — GET /billing/config — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1642
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /billing/fetch-ref-rates/status` — GET /billing/fetch-ref-rates/status — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1822
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clientid` — GET clientId — **[V4_ONLY]**
      v4: web/src/components/PrintQueueDrawer.tsx:L88
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clientid` — GET clientId — **[V4_ONLY]**
      v4: web/src/pages/Invoice.tsx:L55
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clientid` — GET clientId — **[V4_ONLY]**
      v4: web/src/pages/Picklist.tsx:L34
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients/:id` — GET /clients/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/clients.ts:L34
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients/order-stats` — GET /clients/order-stats — **[V4_ONLY]**
      v4: src/routes/clients.ts:L173
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients/order-stats` — GET /clients/order-stats — **[V4_ONLY]**
      v4: web/src/components/Sidebar.tsx:L72
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients/order-stats` — GET /clients/order-stats — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L362
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients/order-stats` — GET /clients/order-stats — **[V4_ONLY]**
      v4: web/src/pages/Clients.tsx:L44
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients/unassigned-orphans` — GET /clients/unassigned-orphans — **[V4_ONLY]**
      v4: src/routes/clients.ts:L224
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /cron/sync-orders` — GET /cron/sync-orders — **[V4_ONLY]**
      v4: src/routes/cron.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /cron/sync-shipments` — GET /cron/sync-shipments — **[V4_ONLY]**
      v4: src/routes/cron.ts:L34
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /datefrom` — GET dateFrom — **[V4_ONLY]**
      v4: web/src/pages/Invoice.tsx:L57
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /dateto` — GET dateTo — **[V4_ONLY]**
      v4: web/src/pages/Invoice.tsx:L58
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/carriers` — GET /init/carrier-accounts — **[V4_ONLY]**
      v4: src/routes/init.ts:L106
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/carriers` — GET /init/carriers — **[V4_ONLY]**
      v4: src/routes/init.ts:L138
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/carriers` — GET /init/carrier-accounts — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L542
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/counts` — GET /init/counts — **[V4_ONLY]**
      v4: src/routes/init.ts:L39
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/counts` — GET /init/counts — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L361
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/init-data` — GET /init/init-data — **[V4_ONLY]**
      v4: src/routes/init.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/init-data` — GET /init/init-data — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L471
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /init/stores` — GET /init/stores — **[V4_ONLY]**
      v4: src/routes/init.ts:L119
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /locations` — GET /locations — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L333
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /locations` — GET /locations — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1470
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /orders/sync/status` — GET /orders/sync/status — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L596
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /packages` — GET /packages — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L752
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /packages` — GET /packages — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1550
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /rates/carriers` — GET /rates/carriers — **[V4_ONLY]**
      v4: web/src/hooks/v2Hooks.ts:L396
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /settings` — GET /settings — **[V4_ONLY]**
      v4: web/src/contexts/MarkupsContext.tsx:L89
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /settings/orders.columnprefs` — GET /settings/orders.columnPrefs — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L571
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /status` — GET status — **[V4_ONLY]**
      v4: web/src/pages/Picklist.tsx:L33
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /admin/clients/:id/flag-test` — PATCH /admin/clients/:id{[0-9]+}/flag-test — **[V4_ONLY]**
      v4: src/routes/admin.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /clients/:id` — PATCH /clients/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/clients.ts:L47
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /admin/purge-test-orders` — POST /admin/purge-test-orders — **[V4_ONLY]**
      v4: src/routes/admin.ts:L41
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /admin/reset-sync` — POST /admin/reset-sync — **[V4_ONLY]**
      v4: src/routes/admin.ts:L403
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /admin/seed-test-orders` — POST /admin/seed-test-orders — **[V4_ONLY]**
      v4: src/routes/admin.ts:L169
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /admin/upsert-keyed-client` — POST /admin/upsert-keyed-client — **[V4_ONLY]**
      v4: src/routes/admin.ts:L321
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /billing/backfill-ref-rates` — POST /billing/backfill-ref-rates — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1830
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /billing/fetch-ref-rates` — POST /billing/fetch-ref-rates — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1814
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /billing/generate` — POST /billing/generate — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1695
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /billing/package-prices/set-default` — POST /billing/package-prices/set-default — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1806
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /clients/:id/backfill-orders` — POST /clients/:id{[0-9]+}/backfill-orders — **[V4_ONLY]**
      v4: src/routes/clients.ts:L76
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /cron/sync-all` — POST /cron/sync-all — **[V4_ONLY]**
      v4: src/routes/cron.ts:L41
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /cron/sync-orders` — POST /cron/sync-orders — **[V4_ONLY]**
      v4: src/routes/cron.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /cron/sync-shipments` — POST /cron/sync-shipments — **[V4_ONLY]**
      v4: src/routes/cron.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory` — POST /inventory — **[V4_ONLY]**
      v4: web/src/components/NewInventoryModal.tsx:L57
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/bulk-update-dims` — POST /inventory/bulk-update-dims — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1424
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/import-from-orders` — POST /inventory/import-from-orders — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1405
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/sync-products` — POST /inventory/sync-products — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1416
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /labels` — POST /labels — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L917
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /locations` — POST /locations — **[V4_ONLY]**
      v4: web/src/components/LocationModal.tsx:L67
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /locations` — POST /locations — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1491
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /packages` — POST /packages — **[V4_ONLY]**
      v4: web/src/components/PackageModal.tsx:L75
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /packages` — POST /packages — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1566
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /packages/sync` — POST /packages/sync — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1632
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /parent-skus` — POST /parent-skus — **[V4_ONLY]**
      v4: web/src/components/InventoryDrawer.tsx:L254
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /parent-skus` — POST /parent-skus — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1452
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /print-queue/add` — POST /print-queue/add — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L966
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /print-queue/clear` — POST /print-queue/clear — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L972
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /print-queue/print` — POST /print-queue/print — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L995
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /products` — POST /products — **[V4_ONLY]**
      v4: web/src/components/ProductModal.tsx:L59
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /products` — POST /products — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1106
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /products/save-defaults` — POST /products/save-defaults — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1112
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /rates` — POST /rates — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1848
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /rates/cache-clear-and-refetch` — POST /rates/cache-clear-and-refetch — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L628
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /sync/orders` — POST /sync/orders — **[V4_ONLY]**
      v4: src/routes/sync.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /sync/orders` — POST /sync/orders — **[V4_ONLY]**
      v4: web/src/components/SyncOrdersButton.tsx:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /sync/orders` — POST /sync/orders — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L603
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PUT /billing/package-prices` — PUT /billing/package-prices — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L1797
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PUT /settings/orders.columnprefs` — PUT /settings/orders.columnPrefs — **[V4_ONLY]**
      v4: web/src/lib/v2-apiClient.ts:L586
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:clients.brand_color` — column clients.brandColor text — **[V4_ONLY]**
      v4: src/db/schema/clients.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:clients.brand_logo` — column clients.brandLogo text — **[V4_ONLY]**
      v4: src/db/schema/clients.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:clients.brand_name` — column clients.brandName text — **[V4_ONLY]**
      v4: src/db/schema/clients.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:clients.id` — column clients.id serial — **[V4_ONLY]**
      v4: src/db/schema/clients.ts:L4
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:clients.is_test` — column clients.isTest boolean — **[V4_ONLY]**
      v4: src/db/schema/clients.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:settings.key` — column settings.key text — **[V4_ONLY]**
      v4: src/db/schema/settings.ts:L4
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:settings.value` — column settings.value text — **[V4_ONLY]**
      v4: src/db/schema/settings.ts:L5
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:sync_meta.key` — column sync_meta.key text — **[V4_ONLY]**
      v4: src/db/schema/sync-meta.ts:L8
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:sync_meta.value` — column sync_meta.value text — **[V4_ONLY]**
      v4: src/db/schema/sync-meta.ts:L9
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:settings` — table settings — **[V4_ONLY]**
      v4: src/db/schema/settings.ts:L3
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:sync_meta` — table sync_meta — **[V4_ONLY]**
      v4: src/db/schema/sync-meta.ts:L7
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `clients:modal:clientmodal` — clients modal ClientModal — **[V4_ONLY]**
      v4: web/src/pages/Clients.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `products:modal:productmodal` — products modal ProductModal — **[V4_ONLY]**
      v4: web/src/pages/Products.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## inventory
- [ ] `DELETE /inventory/:id/parents/:parentskuid` — DELETE /inventory/:id{[0-9]+}/parents/:parentSkuId{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L374
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `DELETE /parent-skus/:id` — DELETE /parent-skus/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/parent-skus.ts:L53
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `DELETE /products/:id` — DELETE /products/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/products.ts:L168
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients` — GET /clients — **[V4_ONLY]**
      v4: web/src/pages/Inventory.tsx:L113
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /inventory/:id` — GET /inventory/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L144
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /inventory/:id/ledger` — GET /inventory/:id{[0-9]+}/ledger — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L151
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /inventory/:id/parents` — GET /inventory/:id{[0-9]+}/parents — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L327
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /inventory/:id/sku-orders` — GET /inventory/:id{[0-9]+}/sku-orders — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L165
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /inventory/stats` — GET /inventory/stats — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L101
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /products` — GET /products — **[V4_ONLY]**
      v4: src/routes/products.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /products/:id` — GET /products/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/products.ts:L67
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /inventory/:id` — PATCH /inventory/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L236
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /parent-skus/:id` — PATCH /parent-skus/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/parent-skus.ts:L37
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /products/:id` — PATCH /products/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/products.ts:L91
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory` — POST /inventory — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L230
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/:id/add-parent` — POST /inventory/:id{[0-9]+}/add-parent — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L346
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/:id/adjust` — POST /inventory/:id{[0-9]+}/adjust — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L402
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/:id/receive` — POST /inventory/:id{[0-9]+}/receive — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L258
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/import-from-orders` — POST /inventory/import-from-orders — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L547
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/import-from-orders` — POST /inventory/import-from-orders — **[V4_ONLY]**
      v4: web/src/pages/Inventory.tsx:L129
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/sync-products` — POST /inventory/sync-products — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L621
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /inventory/sync-products` — POST /inventory/sync-products — **[V4_ONLY]**
      v4: web/src/pages/Inventory.tsx:L119
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /products` — POST /products — **[V4_ONLY]**
      v4: src/routes/products.ts:L85
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PUT /inventory/:id/set-parent` — PUT /inventory/:id{[0-9]+}/set-parent — **[V4_ONLY]**
      v4: src/routes/inventory.ts:L276
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.created_at` — column inventory_ledger.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L63
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.created_by` — column inventory_ledger.createdBy text — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L62
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.id` — column inventory_ledger.id serial — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L54
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.inventory_id` — column inventory_ledger.inventoryId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L55
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.note` — column inventory_ledger.note text — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L61
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.order_id` — column inventory_ledger.orderId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L60
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.qty` — column inventory_ledger.qty integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L59
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_ledger.type` — column inventory_ledger.type text — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L58
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_sku_parents.created_at` — column inventory_sku_parents.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/inventory-sku-parents.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_sku_parents.inventory_id` — column inventory_sku_parents.inventoryId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory-sku-parents.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_sku_parents.is_primary` — column inventory_sku_parents.isPrimary boolean — **[V4_ONLY]**
      v4: src/db/schema/inventory-sku-parents.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory_sku_parents.parent_sku_id` — column inventory_sku_parents.parentSkuId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory-sku-parents.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.active` — column inventory.active boolean — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L40
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.base_unit_qty` — column inventory.baseUnitQty integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L36
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.client_id` — column inventory.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.created_at` — column inventory.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L41
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.cu_ft_override` — column inventory.cuFtOverride real — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L38
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.height` — column inventory.height real — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.id` — column inventory.id serial — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.image_url` — column inventory.imageUrl text — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.length` — column inventory.length real — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.name` — column inventory.name text — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.package_id` — column inventory.packageId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L39
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.parent_sku_id` — column inventory.parentSkuId integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.reorder_level` — column inventory.reorderLevel integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.sku` — column inventory.sku text — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.stock_qty` — column inventory.stockQty integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.units_per_pack` — column inventory.unitsPerPack integer — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L37
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.updated_at` — column inventory.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L42
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.weight_oz` — column inventory.weightOz real — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:inventory.width` — column inventory.width real — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.base_unit_qty` — column parent_skus.baseUnitQty integer — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.client_id` — column parent_skus.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.created_at` — column parent_skus.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.id` — column parent_skus.id serial — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.name` — column parent_skus.name text — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.sku` — column parent_skus.sku text — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:parent_skus.updated_at` — column parent_skus.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.default_package_code` — column product_defaults.defaultPackageCode text — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.height` — column product_defaults.height numeric — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.length` — column product_defaults.length numeric — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.sku` — column product_defaults.sku text — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.updated_at` — column product_defaults.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.weight_oz` — column product_defaults.weightOz numeric — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:product_defaults.width` — column product_defaults.width numeric — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.created_at` — column products.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.default_package_code` — column products.defaultPackageCode text — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.height` — column products.height real — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.id` — column products.id serial — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L12
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.image_url` — column products.imageUrl text — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.length` — column products.length real — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.name` — column products.name text — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.sku` — column products.sku text — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.updated_at` — column products.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.weight_oz` — column products.weightOz real — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:products.width` — column products.width real — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:inventory` — table inventory — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:inventory_ledger` — table inventory_ledger — **[V4_ONLY]**
      v4: src/db/schema/inventory.ts:L51
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:inventory_sku_parents` — table inventory_sku_parents — **[V4_ONLY]**
      v4: src/db/schema/inventory-sku-parents.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:parent_skus` — table parent_skus — **[V4_ONLY]**
      v4: src/db/schema/parent-skus.ts:L11
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:product_defaults` — table product_defaults — **[V4_ONLY]**
      v4: src/db/schema/product-defaults.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:products` — table products — **[V4_ONLY]**
      v4: src/db/schema/products.ts:L11
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:applymovement` — applyMovement(...) — **[V4_ONLY]**
      v4: src/services/inventory.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:inventorystats` — inventoryStats(...) — **[V4_ONLY]**
      v4: src/services/inventory.ts:L52
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `inventory:modal:inventorydrawer` — inventory modal InventoryDrawer — **[V4_ONLY]**
      v4: web/src/pages/Inventory.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `inventory:modal:newinventorymodal` — inventory modal NewInventoryModal — **[V4_ONLY]**
      v4: web/src/pages/Inventory.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## locations
- [ ] `DELETE /locations/:id` — DELETE /locations/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/locations.ts:L58
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /locations/:id` — GET /locations/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/locations.ts:L33
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /locations/:id` — PATCH /locations/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/locations.ts:L46
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /locations/:id/default` — POST /locations/:id{[0-9]+}/default — **[V4_ONLY]**
      v4: src/routes/locations.ts:L65
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /locations/sync` — POST /locations/sync — **[V4_ONLY]**
      v4: src/routes/locations.ts:L72
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /locations/sync` — POST /locations/sync — **[V4_ONLY]**
      v4: web/src/pages/Locations.tsx:L47
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.active` — column locations.active boolean — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.city` — column locations.city text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.company` — column locations.company text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L12
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.country` — column locations.country text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.created_at` — column locations.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.id` — column locations.id serial — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L10
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.is_default` — column locations.isDefault boolean — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.name` — column locations.name text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L11
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.phone` — column locations.phone text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.postal_code` — column locations.postalCode text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.state` — column locations.state text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.street1` — column locations.street1 text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.street2` — column locations.street2 text — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:locations.updated_at` — column locations.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:locations` — table locations — **[V4_ONLY]**
      v4: src/db/schema/locations.ts:L9
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getdefaultlocation` — getDefaultLocation(...) — **[V4_ONLY]**
      v4: src/services/locations.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:setdefaultlocation` — setDefaultLocation(...) — **[V4_ONLY]**
      v4: src/services/locations.ts:L5
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `locations:modal:locationmodal` — locations modal LocationModal — **[V4_ONLY]**
      v4: web/src/pages/Locations.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## orders
- [ ] `GET /labels/:lookup` — GET /labels/:lookup — **[V4_ONLY]**
      v4: src/routes/labels.ts:L221
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /orders/:id` — GET /orders/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/orders.ts:L440
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /orders/:id/dims` — GET /orders/:id{[0-9]+}/dims — **[V4_ONLY]**
      v4: src/routes/orders.ts:L690
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /orders/:id/full` — GET /orders/:id{[0-9]+}/full — **[V4_ONLY]**
      v4: src/routes/orders.ts:L459
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /orders/sync/status` — GET /orders/sync/status — **[V4_ONLY]**
      v4: src/routes/orders.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /shipments/:id` — GET /shipments/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/shipments.ts:L71
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /shipments/status` — GET /shipments/status — **[V4_ONLY]**
      v4: src/routes/shipments.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /orders/:id` — PATCH /orders/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/orders.ts:L489
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /labels` — POST /labels — **[V4_ONLY]**
      v4: src/routes/labels.ts:L96
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /labels/create-batch` — POST /labels/create-batch — **[V4_ONLY]**
      v4: src/routes/labels.ts:L118
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/:id/best-rate` — POST /orders/:id{[0-9]+}/best-rate — **[V4_ONLY]**
      v4: src/routes/orders.ts:L594
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/:id/residential` — POST /orders/:id{[0-9]+}/residential — **[V4_ONLY]**
      v4: src/routes/orders.ts:L551
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/:id/save-dims` — POST /orders/:id{[0-9]+}/save-dims — **[V4_ONLY]**
      v4: src/routes/orders.ts:L656
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/:id/selected-package-id` — POST /orders/:id{[0-9]+}/selected-package-id — **[V4_ONLY]**
      v4: src/routes/orders.ts:L573
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/:id/selected-pid` — POST /orders/:id{[0-9]+}/selected-pid — **[V4_ONLY]**
      v4: src/routes/orders.ts:L562
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/:id/shipped-external` — POST /orders/:id{[0-9]+}/shipped-external — **[V4_ONLY]**
      v4: src/routes/orders.ts:L615
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /orders/sync` — POST /orders/sync — **[V4_ONLY]**
      v4: src/routes/orders.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /shipments/sync` — POST /shipments/sync — **[V4_ONLY]**
      v4: src/routes/shipments.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.created_at` — column mock_labels.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.order_number` — column mock_labels.orderNumber text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.pdf_base64` — column mock_labels.pdfBase64 text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.service_label` — column mock_labels.serviceLabel text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.ship_date` — column mock_labels.shipDate text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.ship_from` — column mock_labels.shipFrom text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.ship_to` — column mock_labels.shipTo text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.shipment_id` — column mock_labels.shipmentId integer — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.tracking_number` — column mock_labels.trackingNumber text — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:mock_labels.weight_oz` — column mock_labels.weightOz numeric — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.best_rate_at` — column order_overrides.bestRateAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L67
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.best_rate_dims` — column order_overrides.bestRateDims text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L68
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.best_rate_json` — column order_overrides.bestRateJson jsonb — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L66
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.externally_shipped_source` — column order_overrides.externallyShippedSource text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L70
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.notes` — column order_overrides.notes text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L56
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.order_id` — column order_overrides.orderId integer — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L51
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.rate_dims_h` — column order_overrides.rateDimsH real — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L63
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.rate_dims_l` — column order_overrides.rateDimsL real — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L61
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.rate_dims_w` — column order_overrides.rateDimsW real — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L62
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.rate_weight_oz` — column order_overrides.rateWeightOz real — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L60
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.ref_ups_rate` — column order_overrides.refUpsRate text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L59
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.ref_usps_rate` — column order_overrides.refUspsRate text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L58
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.residential` — column order_overrides.residential boolean — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L54
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.selected_package_id` — column order_overrides.selectedPackageId text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L65
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.selected_pid` — column order_overrides.selectedPid integer — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L64
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.shipping_account` — column order_overrides.shippingAccount text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L69
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.tags` — column order_overrides.tags jsonb — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L57
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.tracking_number` — column order_overrides.trackingNumber text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L55
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:order_overrides.updated_at` — column order_overrides.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L71
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.carrier_code` — column orders.carrierCode text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L30
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.client_id` — column orders.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.created_at` — column orders.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L39
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.customer_email` — column orders.customerEmail text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.external_order_id` — column orders.externalOrderId text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.externally_fulfilled_verified` — column orders.externallyFulfilledVerified boolean — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L38
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.externally_shipped` — column orders.externallyShipped boolean — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L37
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.id` — column orders.id serial — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.items` — column orders.items jsonb — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L35
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.order_date` — column orders.orderDate timestamp — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.order_number` — column orders.orderNumber text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.order_status` — column orders.orderStatus text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.order_total` — column orders.orderTotal numeric — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L33
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.raw` — column orders.raw jsonb — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L36
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.service_code` — column orders.serviceCode text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L31
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.ship_to_city` — column orders.shipToCity text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.ship_to_name` — column orders.shipToName text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.ship_to_postal_code` — column orders.shipToPostalCode text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.ship_to_state` — column orders.shipToState text — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.shipping_amount` — column orders.shippingAmount numeric — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L34
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.store_id` — column orders.storeId integer — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.updated_at` — column orders.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L40
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:orders.weight_oz` — column orders.weightOz real — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L32
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.client_id` — column print_queue_orders.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.created_at` — column print_queue_orders.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.id` — column print_queue_orders.id text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.item_description` — column print_queue_orders.itemDescription text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.label_url` — column print_queue_orders.labelUrl text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.last_printed_at` — column print_queue_orders.lastPrintedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.multi_sku_data` — column print_queue_orders.multiSkuData jsonb — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.order_id` — column print_queue_orders.orderId text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.order_number` — column print_queue_orders.orderNumber text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.order_qty` — column print_queue_orders.orderQty integer — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.primary_sku` — column print_queue_orders.primarySku text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.print_count` — column print_queue_orders.printCount integer — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.queued_at` — column print_queue_orders.queuedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.sku_group_id` — column print_queue_orders.skuGroupId text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:print_queue_orders.status` — column print_queue_orders.status text — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:return_labels.created_at` — column return_labels.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:return_labels.id` — column return_labels.id serial — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:return_labels.reason` — column return_labels.reason text — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:return_labels.return_shipment_id` — column return_labels.returnShipmentId integer — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:return_labels.return_tracking_number` — column return_labels.returnTrackingNumber text — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:return_labels.shipment_id` — column return_labels.shipmentId integer — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.carrier_code` — column shipments.carrierCode text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.client_id` — column shipments.clientId integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.cost` — column shipments.cost numeric — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L32
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.create_date` — column shipments.createDate timestamp — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.created_at` — column shipments.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L54
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.dims_h` — column shipments.dimsH real — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L31
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.dims_l` — column shipments.dimsL real — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.dims_w` — column shipments.dimsW real — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L30
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.id` — column shipments.id serial — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.is_return` — column shipments.isReturn boolean — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L51
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_carrier` — column shipments.labelCarrier text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L37
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_cost` — column shipments.labelCost numeric — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L40
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_created_at` — column shipments.labelCreatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L35
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_format` — column shipments.labelFormat text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L36
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_provider` — column shipments.labelProvider integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L42
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_service` — column shipments.labelService text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L38
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_ship_date` — column shipments.labelShipDate timestamp — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L41
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_shipment_id` — column shipments.labelShipmentId integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L43
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_tracking` — column shipments.labelTracking text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L39
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.label_url` — column shipments.labelUrl text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L34
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.order_id` — column shipments.orderId integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.order_number` — column shipments.orderNumber text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.other_cost` — column shipments.otherCost numeric — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L33
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.provider_account_id` — column shipments.providerAccountId integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L47
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.provider_account_nickname` — column shipments.providerAccountNickname text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L48
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.return_for_shipment_id` — column shipments.returnForShipmentId integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L52
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.return_reason` — column shipments.returnReason text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L53
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.selected_package_id` — column shipments.selectedPackageId text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L46
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.selected_pid` — column shipments.selectedPid integer — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L45
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.selected_rate_json` — column shipments.selectedRateJson jsonb — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L44
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.service_code` — column shipments.serviceCode text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.ship_date` — column shipments.shipDate timestamp — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.source` — column shipments.source text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L50
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.tracking_number` — column shipments.trackingNumber text — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.updated_at` — column shipments.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L55
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.voided` — column shipments.voided boolean — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L49
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:shipments.weight_oz` — column shipments.weightOz real — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:mock_labels` — table mock_labels — **[V4_ONLY]**
      v4: src/db/schema/mock-labels.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:order_overrides` — table order_overrides — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L50
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:orders` — table orders — **[V4_ONLY]**
      v4: src/db/schema/orders.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:print_queue_orders` — table print_queue_orders — **[V4_ONLY]**
      v4: src/db/schema/print-queue.ts:L11
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:return_labels` — table return_labels — **[V4_ONLY]**
      v4: src/db/schema/return-labels.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:shipments` — table shipments — **[V4_ONLY]**
      v4: src/db/schema/shipments.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:addtoqueue` — addToQueue(...) — **[V4_ONLY]**
      v4: src/services/print-queue.ts:L72
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:clearqueue` — clearQueue(...) — **[V4_ONLY]**
      v4: src/services/print-queue.ts:L133
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:createbatch` — createBatchV2(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L822
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:createlabel` — createLabelV2(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L583
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:createlabelbatch` — createLabelBatch(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L878
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:createlabelfromrate` — createLabelFromRate(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L369
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:createlabelfromshipment` — createLabelFromShipment(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L421
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:createreturnlabel` — createReturnLabelV2(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L1128
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getmergejobstatus` — getMergeJobStatus(...) — **[V4_ONLY]**
      v4: src/services/print-queue.ts:L180
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getmocklabel` — getMockLabel(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L93
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getmocklabelasync` — getMockLabelAsync(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L97
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:listqueue` — listQueue(...) — **[V4_ONLY]**
      v4: src/services/print-queue.ts:L43
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:lookuplabel` — lookupLabel(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L452
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:removefromqueue` — removeFromQueue(...) — **[V4_ONLY]**
      v4: src/services/print-queue.ts:L124
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:retrievelabel` — retrieveLabelV2(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L1216
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:savemocklabel` — saveMockLabel(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L132
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:startprintjob` — startPrintJob(...) — **[V4_ONLY]**
      v4: src/services/print-queue.ts:L145
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:voidlabel` — voidLabelV2(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L1064
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:voidlabel` — voidLabel(...) — **[V4_ONLY]**
      v4: src/services/labels.ts:L1124
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `orders:modal:orderdetaildrawer` — orders modal OrderDetailDrawer — **[V4_ONLY]**
      v4: web/src/components/Views/OrdersView.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `orders:modal:ratebrowsermodal` — orders modal RateBrowserModal — **[V4_ONLY]**
      v4: web/src/components/Views/OrdersView.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `orders:modal:trackingmodal` — orders modal TrackingModal — **[V4_ONLY]**
      v4: web/src/components/Views/OrdersView.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## packages
- [ ] `DELETE /packages/:id` — DELETE /packages/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/packages.ts:L61
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /packages/:id` — GET /packages/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/packages.ts:L36
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /packages/:id/ledger` — GET /packages/:id{[0-9]+}/ledger — **[V4_ONLY]**
      v4: src/routes/packages.ts:L210
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /packages/:id` — PATCH /packages/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/packages.ts:L49
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PATCH /packages/:id/reorder-level` — PATCH /packages/:id{[0-9]+}/reorder-level — **[V4_ONLY]**
      v4: src/routes/packages.ts:L242
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /packages/:id/adjust` — POST /packages/:id{[0-9]+}/adjust — **[V4_ONLY]**
      v4: src/routes/packages.ts:L173
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /packages/:id/receive` — POST /packages/:id{[0-9]+}/receive — **[V4_ONLY]**
      v4: src/routes/packages.ts:L124
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `PUT /packages/:id` — PUT /packages/:id{[0-9]+} — **[V4_ONLY]**
      v4: src/routes/packages.ts:L228
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.balance_after` — column package_ledger.balanceAfter integer — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.change_type` — column package_ledger.changeType text — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.created_at` — column package_ledger.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.id` — column package_ledger.id serial — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.note` — column package_ledger.note text — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.package_id` — column package_ledger.packageId integer — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.qty_delta` — column package_ledger.qtyDelta integer — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.unit_cost` — column package_ledger.unitCost numeric — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:package_ledger.user_id` — column package_ledger.userId uuid — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.carrier_code` — column packages.carrierCode text — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.created_at` — column packages.createdAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L29
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.domestic` — column packages.domestic boolean — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L23
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.height` — column packages.height real — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.id` — column packages.id serial — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.international` — column packages.international boolean — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.is_default` — column packages.isDefault boolean — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L28
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.length` — column packages.length real — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.name` — column packages.name text — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.package_code` — column packages.packageCode text — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.reorder_level` — column packages.reorderLevel integer — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.source` — column packages.source text — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.stock_qty` — column packages.stockQty integer — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L25
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.tare_weight_oz` — column packages.tareWeightOz real — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.type` — column packages.type text — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.unit_cost` — column packages.unitCost numeric — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L27
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.updated_at` — column packages.updatedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L30
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:packages.width` — column packages.width real — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:package_ledger` — table package_ledger — **[V4_ONLY]**
      v4: src/db/schema/package-ledger.ts:L13
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:packages` — table packages — **[V4_ONLY]**
      v4: src/db/schema/packages.ts:L12
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `packages:modal:packageledgerdrawer` — packages modal PackageLedgerDrawer — **[V4_ONLY]**
      v4: web/src/pages/Packages.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `packages:modal:packagemodal` — packages modal PackageModal — **[V4_ONLY]**
      v4: web/src/pages/Packages.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `packages:modal:packagereceivemodal` — packages modal PackageReceiveModal — **[V4_ONLY]**
      v4: web/src/pages/Packages.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## rates
- [ ] `DELETE /rates/cache` — DELETE /rates/cache — **[V4_ONLY]**
      v4: src/routes/rates.ts:L188
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /rates/backfill-best/active` — GET /rates/backfill-best/active — **[V4_ONLY]**
      v4: src/routes/rates.ts:L184
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /rates/backfill-best/status/:jobid` — GET /rates/backfill-best/status/:jobId — **[V4_ONLY]**
      v4: src/routes/rates.ts:L178
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /rates/carriers` — GET /rates/carriers — **[V4_ONLY]**
      v4: src/routes/rates.ts:L152
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /rates/backfill-best` — POST /rates/backfill-best — **[V4_ONLY]**
      v4: src/routes/rates.ts:L159
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /rates/cache-clear-and-refetch` — POST /rates/cache-clear-and-refetch — **[V4_ONLY]**
      v4: src/routes/rates.ts:L199
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.best_rate` — column rate_cache.bestRate jsonb — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L18
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.cache_key` — column rate_cache.cacheKey text — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.fetched_at` — column rate_cache.fetchedAt timestamp — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.rates` — column rate_cache.rates jsonb — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L17
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.to_zip` — column rate_cache.toZip text — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L16
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.weight_oz` — column rate_cache.weightOz real — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `column:rates.weight_version` — column rate_cache.weightVersion integer — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L19
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `table:rates` — table rate_cache — **[V4_ONLY]**
      v4: src/db/schema/rates.ts:L11
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:fetchliverates` — fetchLiveRates(...) — **[V4_ONLY]**
      v4: src/services/rates.ts:L172
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getactivebackfilljob` — getActiveBackfillJob(...) — **[V4_ONLY]**
      v4: src/services/rates-backfill.ts:L87
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getactiverefratesjob` — getActiveRefRatesJob(...) — **[V4_ONLY]**
      v4: src/services/ref-rates-fetch.ts:L60
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getbackfilljob` — getBackfillJob(...) — **[V4_ONLY]**
      v4: src/services/rates-backfill.ts:L83
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getrates` — getRates(...) — **[V4_ONLY]**
      v4: src/services/rates.ts:L239
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getrefratesjob` — getRefRatesJob(...) — **[V4_ONLY]**
      v4: src/services/ref-rates-fetch.ts:L56
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:ratecachekey` — rateCacheKey(...) — **[V4_ONLY]**
      v4: src/services/rates.ts:L115
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:startbackfillbestrates` — startBackfillBestRates(...) — **[V4_ONLY]**
      v4: src/services/rates-backfill.ts:L91
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:startrefratesfetch` — startRefRatesFetch(...) — **[V4_ONLY]**
      v4: src/services/ref-rates-fetch.ts:L67
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## _shipstation
- [ ] `ss:/orders/markasshipped` — ShipStation /orders/markasshipped — **[V4_ONLY]**
      v4: src/lib/shipstation/labels.ts:L293
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/stores` — ShipStation /stores — **[V4_ONLY]**
      v4: src/routes/clients.ts:L126
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/carriers` — ShipStation /v2/carriers — **[V4_ONLY]**
      v4: src/routes/init.ts:L22
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/carriers` — ShipStation /v2/carriers — **[V4_ONLY]**
      v4: src/routes/init.ts:L108
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/carriers` — ShipStation /v2/carriers — **[V4_ONLY]**
      v4: src/routes/init.ts:L140
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/carriers` — ShipStation /v2/carriers — **[V4_ONLY]**
      v4: src/routes/packages.ts:L72
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/carriers` — ShipStation /v2/carriers — **[V4_ONLY]**
      v4: src/routes/rates.ts:L153
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/carriers` — ShipStation /v2/carriers — **[V4_ONLY]**
      v4: src/services/rates.ts:L76
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/labels` — ShipStation /v2/labels — **[V4_ONLY]**
      v4: src/lib/shipstation/labels.ts:L161
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/labels` — ShipStation /v2/labels?page_size=500&sort_dir=desc — **[V4_ONLY]**
      v4: src/lib/shipstation/labels.ts:L227
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/labels` — ShipStation /v2/labels — **[V4_ONLY]**
      v4: src/services/labels.ts:L445
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/v2/rates` — ShipStation /v2/rates — **[V4_ONLY]**
      v4: src/services/rates.ts:L178
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `ss:/warehouses` — ShipStation /warehouses — **[V4_ONLY]**
      v4: src/routes/locations.ts:L90
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## analysis
- [ ] `GET /analysis/daily-shipments` — GET /analysis/daily-shipments — **[V4_ONLY]**
      v4: src/routes/analysis.ts:L69
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /analysis/overview` — GET /analysis/overview — **[V4_ONLY]**
      v4: src/routes/analysis.ts:L9
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /analysis/overview` — GET /analysis/overview — **[V4_ONLY]**
      v4: web/src/pages/Analysis.tsx:L130
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /analysis/sku-breakdown` — GET /analysis/sku-breakdown — **[V4_ONLY]**
      v4: src/routes/analysis.ts:L168
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /analysis/sku-daily` — GET /analysis/sku-daily — **[V4_ONLY]**
      v4: src/routes/analysis.ts:L102
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /analysis/top-skus` — GET /analysis/top-skus — **[V4_ONLY]**
      v4: src/routes/analysis.ts:L257
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /clients` — GET /clients — **[V4_ONLY]**
      v4: web/src/pages/Analysis.tsx:L145
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## settings
- [ ] `DELETE /settings/:key` — DELETE /settings/:key — **[V4_ONLY]**
      v4: src/routes/settings.ts:L35
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /admin/test-clients` — GET /admin/test-clients — **[V4_ONLY]**
      v4: web/src/components/Views/SettingsView.tsx:L91
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /rates/carriers` — GET /rates/carriers — **[V4_ONLY]**
      v4: web/src/pages/Settings.tsx:L55
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /settings` — GET /settings — **[V4_ONLY]**
      v4: src/routes/settings.ts:L10
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `GET /settings` — GET /settings — **[V4_ONLY]**
      v4: web/src/pages/Settings.tsx:L61
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /admin/purge-test-orders` — POST /admin/purge-test-orders — **[V4_ONLY]**
      v4: web/src/components/Views/SettingsView.tsx:L145
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `POST /admin/seed-test-orders` — POST /admin/seed-test-orders — **[V4_ONLY]**
      v4: web/src/components/Views/SettingsView.tsx:L115
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getsetting` — getSetting(...) — **[V4_ONLY]**
      v4: src/services/settings.ts:L5
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getsettingnumber` — getSettingNumber(...) — **[V4_ONLY]**
      v4: src/services/settings.ts:L24
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:setsetting` — setSetting(...) — **[V4_ONLY]**
      v4: src/services/settings.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `settings:keyboard:enter` — settings keyboard Enter — **[V4_ONLY]**
      v4: web/src/pages/Settings.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `settings:keyboard:escape` — settings keyboard Escape — **[V4_ONLY]**
      v4: web/src/pages/Settings.tsx:L1
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)

## _worker-contracts
- [ ] `dto:bulkcachedratesrequest` — interface BulkCachedRatesRequest — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L156
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:columnconfig` — interface ColumnConfig — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L141
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:liveraterequest` — interface LiveRateRequest — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L168
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:markup` — interface Markup — **[V4_ONLY]**
      v4: web/src/types/markups.ts:L9
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:markupsmap` — type MarkupsMap — **[V4_ONLY]**
      v4: web/src/types/markups.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:markuptype` — type MarkupType — **[V4_ONLY]**
      v4: web/src/types/markups.ts:L7
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:orderaddress` — interface OrderAddress — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L26
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:orderdimensions` — interface OrderDimensions — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L15
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:orderdto` — interface OrderDTO — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L54
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:orderitem` — interface OrderItem — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L6
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:orderpicklistresponse` — type OrderPicklistResponseDto — **[V4_ONLY]**
      v4: web/src/types/api.ts:L14
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:ordersfilteroptions` — interface OrdersFilterOptions — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L118
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:ordersqueryparams` — interface OrdersQueryParams — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L126
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:orderweight` — interface OrderWeight — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L21
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:printqueueentry` — type PrintQueueEntryDto — **[V4_ONLY]**
      v4: web/src/types/api.ts:L45
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:ratecacheentry` — interface RateCacheEntry — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L108
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:rategroup` — interface RateGroup — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L98
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:ratesmap` — interface RatesMap — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L114
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:rbmarkupsresponse` — type RbMarkupsResponse — **[V4_ONLY]**
      v4: web/src/types/markups.ts:L20
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `dto:skugroup` — interface SkuGroup — **[V4_ONLY]**
      v4: web/src/types/orders.ts:L149
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getshipmentsyncstatus` — getShipmentSyncStatus(...) — **[V4_ONLY]**
      v4: src/services/shipment-sync.ts:L395
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:getsyncstatus` — getSyncStatus(...) — **[V4_ONLY]**
      v4: src/services/order-sync.ts:L377
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:startsyncscheduler` — startSyncScheduler(...) — **[V4_ONLY]**
      v4: src/services/sync-scheduler.ts:L86
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:stopsyncscheduler` — stopSyncScheduler(...) — **[V4_ONLY]**
      v4: src/services/sync-scheduler.ts:L132
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:syncorders` — syncOrders(...) — **[V4_ONLY]**
      v4: src/services/order-sync.ts:L335
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
- [ ] `service:syncshipments` — syncShipments(...) — **[V4_ONLY]**
      v4: src/services/shipment-sync.ts:L290
      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)
