# ShipStation API — Deep Dive: What v4 Fetches and Where It Lands

Canonical reference for every ShipStation endpoint v4 calls. For each: what the request
sends, what the response contains, which fields v4 actually reads, and which DB columns
those fields land in.

Base URLs:
- **V1**: `https://ssapi.shipstation.com` — Basic Auth: `SHIPSTATION_API_KEY:SHIPSTATION_API_SECRET`
- **V2**: `https://api.shipstation.com` — Header: `API-Key: $SHIPSTATION_API_KEY_V2`

Per-client overrides: `clients.ssApiKey`, `clients.ssApiSecret`, `clients.ssApiKeyV2`.
Fallback chain via `src/lib/shipstation/credentials.ts`: direct client → rate-source client → env default.

---

## V1 ENDPOINTS — Basic Auth

### 1. `GET /orders` — Order Sync (3 passes)

**Caller:** `src/services/order-sync.ts:299` (`fetchOrdersPage`)
**Runs:** Every 3 min via in-process scheduler, plus manual triggers via `/orders/sync` + `/cron/sync-orders`.
**Three parallel passes per sync**: `orderStatus=shipped` (2hr window), `orderStatus=cancelled` (2hr), `orderStatus=awaiting_shipment` (4hr).

**Request query params sent:**
```
orderStatus=shipped|cancelled|awaiting_shipment
modifyDateStart=YYYY-MM-DD HH:MM:SS   (UTC, watermark or window floor)
pageSize=500                           (v2-parity)
page=1,2,3…                            (paginated)
sortBy=ModifyDate
sortDir=ASC
```

**Response shape:** `{ orders: SSOrder[], total: number, page: number, pages: number }`

**SSOrder fields v4 reads:**
| Field (SS) | Type | Used for |
|---|---|---|
| `orderId` | number | Stored as `orders.external_order_id` (TEXT) — conflict key |
| `orderNumber` | string | `orders.order_number` — display + dedup |
| `orderStatus` | string | `orders.order_status` (awaiting_shipment/shipped/cancelled/on_hold) |
| `orderDate` | ISO string | `orders.order_date` (timestamptz) |
| `modifyDate` | ISO string | NOT stored — only used to advance watermark |
| `customerEmail` | string | `orders.customer_email` |
| `shipTo.name` | string | `orders.ship_to_name` |
| `shipTo.city` | string | `orders.ship_to_city` |
| `shipTo.state` | string | `orders.ship_to_state` |
| `shipTo.postalCode` | string | `orders.ship_to_postal_code` |
| `shipTo.residential` | boolean | **NOT stored on first pass** — residential helper fills separately |
| `shipTo.street1`/`street2`/`company`/`phone` | string | Stored in `orders.raw` JSONB (full payload preserved) |
| `weight.value` + `weight.units` | `{value, units: 'ounces'\|'pounds'\|'grams'}` | Converted to oz → `orders.weight_oz` |
| `carrierCode` | string | `orders.carrier_code` (can be overridden later) |
| `serviceCode` | string | `orders.service_code` |
| `orderTotal` | number | `orders.order_total` (numeric → stringified) |
| `shippingAmount` | number | `orders.shipping_amount` |
| `items[]` | array | Stored verbatim in `orders.items` JSONB |
| `advancedOptions.storeId` | number | `orders.store_id` — maps to `clients.storeIds` array |
| `externallyFulfilled` / `externally_shipped` / `advancedOptions.nonMachinable` | boolean | Collapsed into `orders.externally_shipped` (preserves any true value — doesn't clobber) |

**Full original payload** also stored in `orders.raw` JSONB for forensics + rehydration.

**Upsert conflict key:** `orders.external_order_id`. `ON CONFLICT DO UPDATE` overwrites most columns but **preserves `externally_shipped=true`** (once set, stays set).

---

### 2. `GET /orders?pageSize=100&page=1` — Residential Lookup

**Caller:** `src/lib/shipstation/residential.ts:30` (`lookupResidential`)
**Runs:** On-demand only — not during sync. Used by rate computation when an order's residential flag isn't known.

**Request:** Same as above, hardcoded `pageSize=100&page=1`. 5-second timeout.

**Response fields v4 reads:** `orders[].orderNumber` + `orders[].shipTo.residential` (boolean).

**Storage:** NOT stored. Returned directly to the caller as `Map<orderId, residential>` for use in rate-estimate calls.

---

### 3. `GET /shipments` — Shipment Sync

**Caller:** `src/services/shipment-sync.ts:333` (inner pagination loop)
**Runs:** Every 3 min via scheduler. Manual via `/shipments/sync` + `/cron/sync-shipments`.

**Request query params:**
```
createDateStart=YYYY-MM-DD HH:MM:SS
pageSize=500
page=1,2,3…
sortBy=CreateDate
sortDir=ASC
```

**Response:** `{ shipments: SSShipment[], total, page, pages }`

**SSShipment fields v4 reads:**
| Field (SS) | Type | Used for |
|---|---|---|
| `shipmentId` | number | `shipments.label_shipment_id` — conflict key for existing lookup |
| `orderId` | number | Matched to `orders.external_order_id` (string cast) to resolve `shipments.order_id` (FK) |
| `orderNumber` | string | `shipments.order_number` |
| `createDate` | ISO | `shipments.create_date` (preserved via COALESCE on re-sync) |
| `shipDate` | ISO | `shipments.ship_date` + `shipments.label_ship_date` |
| `shipmentCost` | number | `shipments.cost` (numeric) |
| `trackingNumber` | string | `shipments.tracking_number` + `shipments.label_tracking` |
| `carrierCode` | string | `shipments.carrier_code` + `shipments.label_carrier` |
| `serviceCode` | string | `shipments.service_code` + `shipments.label_service` |
| `weight.value` + `weight.units` | — | Converted → `shipments.weight_oz` |
| `dimensions.length/width/height` | number | `shipments.dims_l/w/h` |
| `voided` | boolean | `shipments.voided` |
| `isReturnLabel` | boolean | `shipments.is_return` |

**Other fields returned but NOT consumed by v4:** `orderKey`, `userId`, `customerEmail`, `insuranceCost`, `batchNumber`, `packageCode`, `confirmation`, `warehouseId`, `voidDate`, `marketplaceNotified`, `notifyErrorMessage`, `shipTo{}`, `advancedOptions{}`, `shipmentItems[]`, `labelData`, `formData`.

**Side effects on upsert:**
1. `shipments.source = 'shipstation'` set on every SS-sourced row.
2. If the matched order's status was `awaiting_shipment`, order's `order_status` flips to `'shipped'` after the batch.
3. `providerAccountId` preserved from existing row if the response didn't carry one (COALESCE-style preservation — commit `6982785`).
4. If the order already has a non-voided PrepShip-sourced shipment (`source IN 'prepship','prepship_v2','test_offline'`), the SS shipment is **skipped entirely** — avoids duplicates.

---

### 4. `GET /shipments/{shipmentId}` — Fallback Label URL Lookup

**Caller:** `src/lib/shipstation/labels.ts:252` (`ssGetShipmentV1`)
**Runs:** On-demand when a fresh label URL is needed and `/v2/labels` didn't return one.

**Response fields consumed:** Same as V1 /shipments single-object form. Specifically reads `labelDownload.pdf` / `labelDownload.href` to hydrate `shipments.label_url`.

---

### 5. `POST /orders/markasshipped` — External Ship Notification

**Caller:** `src/lib/shipstation/labels.ts:290` (`ssMarkOrderShippedV1`)
**Runs:** Fire-and-forget after v4 creates a V2 label, to tell ShipStation "we shipped this".

**Request body:**
```json
{
  "orderId": 123456789,
  "carrierCode": "stamps_com",
  "shipDate": "2026-04-24",
  "trackingNumber": "9405...",
  "notifyCustomer": false,
  "notifySalesChannel": true
}
```

**Response:** Only checks status. No fields stored.

---

### 6. `GET /stores` — Store List Sync

**Caller:** `src/routes/clients.ts:126` (`POST /clients/sync-stores` handler)
**Runs:** Manual only — no scheduled sync.

**Response:** `SSStore[]`

**Fields v4 reads:**
| Field | → DB |
|---|---|
| `storeId` | Added to `clients.storeIds[]` int array |
| `storeName` / `companyName` | `clients.name` |
| `accountName` | `clients.contact_name` |
| `email` | `clients.email` |
| `phone` | `clients.phone` |
| `active` | `clients.active` |

**Other fields returned but ignored:** `marketplaceName`, `integrationUrl`, `refreshDate`, `lastRefreshAttempt`, `createDate`, `modifyDate`, `statusMappings[]`, `autoRefresh`, various SS-specific metadata (22+ fields in the raw payload).

---

### 7. `GET /products` — Product Catalog Sync

**Caller:** `src/routes/inventory.ts:641` (`POST /inventory/sync-products`)
**Runs:** Manual only. Iterates through all active clients with per-client credentials + the main env-account.

**Request query params:** `?pageSize=500&page=N` (paginated)

**SSProduct fields v4 reads:**
| Field | → DB |
|---|---|
| `productId` | NOT stored |
| `sku` | `inventory.sku` (conflict key with `client_id`) |
| `name` | `inventory.name` |
| `weightOz` | `inventory.weight_oz` |
| `length` / `width` / `height` | `inventory.length/width/height` |
| `active` | `inventory.active` |
| `thumbnailUrl` / `imageUrl` | `inventory.image_url` (prefers thumbnail) |

**Owner mapping:** products sync'd under env-main credentials → `clientId=null` (shared catalog). Products under per-client credentials → `clientId = <owning client>`. So clients with their own ShipStation account get their own isolated product rows.

---

## V2 ENDPOINTS — API-Key Header

### 1. `GET /v2/carriers` — Carrier Discovery

**Caller:** `src/services/rates.ts:137` (rates flow) + `src/routes/init.ts:22` (bootstrap) + `src/routes/packages.ts:72` (package-catalog sync)

**Request:** No params. Dedupe key: `carriers:list`. 15-min in-process cache.

**Response shape:**
```typescript
{
  carriers: [{
    carrier_id: "se-123456",
    carrier_code: "stamps_com" | "ups" | "fedex" | "usps" | "dhl_express" | ...,
    account_number: string,
    requires_funded_amount: boolean,
    balance: number,
    nickname: string,            // e.g. "USPS Chase x7439"
    friendly_name: string,
    primary: boolean,
    has_multi_package_supporting_services: boolean,
    supports_label_messages: boolean,
    services: [{ carrier_id, carrier_code, service_code, name, domestic, international, is_multi_package_supported }],
    packages: [{ package_id, package_code, name }],
    disabled_by_billing_plan: boolean
  }]
}
```

**Fields v4 reads:**
- `carrier_id`, `carrier_code`, `nickname`, `friendly_name` → returned to frontend for the rate browser carrier picker
- `disabled_by_billing_plan` → used to filter out unavailable carriers
- `services[]` → proxied through `/rates/carriers-for-store` response
- `packages[]` → `POST /packages/sync` reads this array to seed the `packages` table (name, package_code, domestic, international flags)

**DB writes (only from `/packages/sync`):**
- `packages` rows: `name`, `type='box'`, `carrier_code`, `package_code`, `source='shipstation'`, `domestic=true`, `international=false`. Existing rows (by `carrier_code+package_code`) skipped.

---

### 2. `POST /v2/rates/estimate` — Rate Shopping (Per-Carrier)

**Caller:** `src/services/rates.ts:324` (`fetchEstimateForCarrier`)
**Runs:** One call per carrier, in parallel, on every rate-shop request.

**Request body (flat, v2-parity shape from commit `8d670ce`):**
```json
{
  "carrier_ids": ["se-123456"],
  "from_country_code": "US",
  "from_postal_code": "90248",
  "to_country_code": "US",
  "to_postal_code": "10001",
  "weight": { "value": 16, "unit": "ounce" },
  "address_residential_indicator": "yes" | "no" | "unknown",
  "ship_date": "2026-04-24T00:00:00.000Z",
  "to_city_locality": "New York",     // stamps_com only
  "to_state_province": "NY",          // stamps_com only
  "dimensions": {                     // optional
    "length": 10, "width": 8, "height": 4, "unit": "inch"
  }
}
```

**Response shape:** `EstimateRate[]` (flat array) OR `{ rates: EstimateRate[] }`

**EstimateRate fields v4 reads (mapped into `Rate` for cache):**
| Field | Use |
|---|---|
| `rate_id` | Identifier for later label-from-rate creation |
| `service_code` | Primary filter / display |
| `service_type` | Human label ("Priority Mail Express") |
| `package_type` | Filter against `BLOCKED_PACKAGE_TYPES` |
| `carrier_id` + `carrier_code` + `carrier_nickname` | Display + filter |
| `shipping_amount: {amount, currency}` | Primary cost number (marked-up at read time) |
| `other_amount: {amount, currency}` | Additional fees (fuel surcharge, etc.) |
| `insurance_amount` + `confirmation_amount` | Optional add-ons |
| `delivery_days` | Display |
| `estimated_delivery_date` | Display |
| `zone` | Display |
| `guaranteed_service` | Display flag |
| `warning_messages[]` / `error_messages[]` | Diagnostic logging only |

**Blocked rates filter** (applied post-response): drops anything where `service_code ∈ BLOCKED_SERVICE_CODES`, `package_type ∈ BLOCKED_PACKAGE_TYPES`, or `service_type` matches `/flat[\s-]?rate|\bbox\b/i`.

**Cache:** Results stored in `rates` table keyed by `(weight_oz, to_zip, dims, residential, carrier_ids-hash)`. 6-hour TTL.

---

### 3. `POST /v2/labels` — Label Creation

**Caller:** `src/lib/shipstation/labels.ts:161` (`ssCreateLabel`)

**Request body:**
```json
{
  "shipment": {
    "carrier_id": "se-123456",
    "service_code": "usps_priority_mail",
    "ship_date": "2026-04-24",
    "ship_from": { name, company_name, phone, address_line1, city_locality, state_province, postal_code, country_code, address_residential_indicator },
    "ship_to":   { same shape },
    "packages": [{
      "weight": { "value": 16, "unit": "ounce" },
      "dimensions": { "length": 10, "width": 8, "height": 4, "unit": "inch" },
      "package_code": "package"
    }],
    "confirmation": "none" | "delivery" | "signature" | "adult_signature",
    "external_order_id": "113-3128025-8662606"
  },
  "is_return_label": false,
  "label_layout": "4x6",
  "label_format": "pdf",
  "label_download_type": "url"
}
```

**Response fields v4 reads:**
| Field | → DB (`shipments`) |
|---|---|
| `label_id` | NOT stored — v4 uses `shipment_id` as the key |
| `shipment_id` | Stripped `se-` prefix, stored as `shipments.label_shipment_id` (int) |
| `tracking_number` | `shipments.tracking_number` + `shipments.label_tracking` |
| `label_download.pdf` / `.href` | `shipments.label_url` |
| `label_format` | `shipments.label_format` (default 'pdf') |
| `shipment_cost.amount` | `shipments.cost` + `shipments.label_cost` |
| `voided` | `shipments.voided` |
| `carrier_code` | `shipments.label_carrier` |
| `service_code` | `shipments.label_service` |
| `ship_date` | `shipments.label_ship_date` |

**Side effects:**
- New `shipments` row inserted with `source='prepship'`.
- Order flipped to `order_status='shipped'`.
- Fire-and-forget V1 `POST /orders/markasshipped` so ShipStation's UI also shows shipped.
- Label creation rate-limited per client: 10/min.

---

### 4. `GET /v2/labels?page_size=500&sort_dir=desc` — Recent Labels Lookup

**Caller:** `src/lib/shipstation/labels.ts:228` (`ssListRecentLabels`)
**Runs:** On-demand when a stored `shipments.label_url` expires (SS URLs expire after ~24h). Fetches the most recent 500 labels.

**Response:** `{ labels: [...] }`

**Fields v4 reads per label:**
- `label_id` → match key
- `shipment_id` (after `se-` strip) → match by `label_shipment_id`
- `tracking_number` → secondary match key
- `label_download.pdf` / `.href` → overwrites `shipments.label_url` with fresh URL

---

### 5. `PUT /v2/labels/{labelId}/void` AND `POST /v2/shipments/{shipmentId}/void`

**Callers:**
- `src/lib/shipstation/labels.ts:188` — `ssVoidLabel` (by label_id)
- `src/lib/shipstation/labels.ts:197` — `ssVoidShipment` (by shipment_id, with `se-` prefix)

Both are void operations; v4 uses the shipment-based one in production. Request body: `{}` (empty).

**Response:** Ignored. v4 updates its own DB on success.

**DB side effects:**
- `shipments.voided = true`, `shipments.updated_at = now()`
- `orders.order_status = 'awaiting_shipment'` (reset so a new label can be created)

---

### 6. `POST /v2/shipments/{shipmentId}/returnlabel` — Return Label

**Caller:** `src/lib/shipstation/labels.ts:204` (`ssCreateReturnLabel`, after commit `3d1e951`)

**Request body:** `{ "reason": "Customer Return" }` (or whatever reason string)

**Response fields v4 reads:**
- `shipment_id` (after `se-` strip) → `shipments.label_shipment_id` on new return shipment row
- `tracking_number` → `shipments.tracking_number`
- `shipment_cost.amount` → `shipments.cost`
- `label_download.pdf` / `.href` → `shipments.label_url`

**DB writes:**
- New `shipments` row with `source='prepship'`, `is_return=true`, `return_for_shipment_id = <original>`, `return_reason = <reason>`.
- Also mirrored into `return_labels` table (commit `0f4c03f` Round 4).

---

### 7. `GET /v2/shipments` — V2 Enrichment Pass

**Caller:** `src/services/shipment-sync.ts:454` (`enrichProviderAccountIds`)
**Runs:** After every V1 shipment sync pass per account — only if the account has a V2 key set.

**Request query params:**
```
page_size=500
page=N
sort_dir=DESC
created_at_start=<same as V1 watermark>
```

**Response shape:** Same as V1 /shipments but with V2 field naming.

**Fields v4 reads:**
- `tracking_number` → match key (joins back to V1-synced shipment row)
- `carrier_id` → numeric after `se-` strip → `shipments.provider_account_id`

**Purpose:** V1 `/shipments` doesn't return `carrierId` as a numeric ID — only `carrierCode`. The numeric ID (used by ShipStation's billing system) is exposed only via V2. This pass fills that gap so billing reconciliation works.

**DB side effects:** `UPDATE shipments SET provider_account_id = ? WHERE tracking_number = ? AND provider_account_id IS NULL`. Only backfills; never overwrites an existing value.

---

## Summary Tables

### Tables written by ShipStation sync (ordered by volume)

| Table | Source endpoint(s) | Typical row count |
|---|---|---|
| `orders` | `GET /orders` (3 status passes) | tens of thousands |
| `shipments` | `GET /shipments` + `POST /v2/labels` + `POST /v2/shipments/:id/returnlabel` | thousands |
| `inventory` | `GET /products` | hundreds to thousands |
| `clients` | `GET /stores` (upsert per store), `POST /clients/sync-stores` | ~10-50 |
| `packages` | `GET /v2/carriers` (via `POST /packages/sync`) | ~20-100 |
| `rates` | `POST /v2/rates/estimate` (cache writes) | high churn, 6hr TTL |
| `return_labels` | `POST /v2/shipments/:id/returnlabel` | rare |
| `mock_labels` | dev-only test flow | dev only |

### Fields ShipStation returns that v4 stores in full (as JSONB)

| Table | Column | Content |
|---|---|---|
| `orders` | `raw` | Full `SSOrder` object (all 30+ fields from `/orders`) |
| `orders` | `items` | `SSOrder.items[]` array (SKU, name, quantity, imageUrl per line) |
| `orders` | `best_rate_json` (via `order_overrides`) | Full selected rate object from `/v2/rates/estimate` |
| `shipments` | `selected_rate_json` | Full rate object used to create the label |

### Fields v4 explicitly IGNORES from ShipStation (intentional drop)

| Endpoint | Ignored fields | Why |
|---|---|---|
| `/orders` | `customerUsername`, `customerNotes`, `internalNotes`, `gift`, `paymentMethod`, `requestedShippingService`, `customsItems[]`, `tagIds[]` | Not used by v4 business logic |
| `/shipments` | `formData` (PDF of packing slip), `labelData` (base64 PDF) | v4 uses `label_url` instead (lighter) |
| `/stores` | `marketplaceName`, `integrationUrl`, `refreshDate`, `statusMappings[]`, `autoRefresh` | v4 only needs contact + identity |
| `/v2/carriers` | `account_number`, `balance`, `requires_funded_amount`, `primary` | Billing concerns handled elsewhere |
| `/v2/labels` (POST response) | `carrier_charge_event`, `insurance`, `is_international`, `batch_id`, `form_download` | Not needed for PrepShip's flow |
| `/v2/rates/estimate` | `rate_details[]`, `tags[]`, `error_messages[]` | v4 filters by service_code, not rate_details |

---

## Quick diagnostic: "why is X missing from v4?"

If v4's DB doesn't have data you'd expect to see in ShipStation:

1. **Check which endpoint would deliver it** using the tables above.
2. **Check if that endpoint actually runs in v4**:
   - Order data → auto (every 3 min)
   - Shipment data → auto (every 3 min)
   - Products → manual only (`POST /inventory/sync-products`)
   - Stores → manual only (`POST /clients/sync-stores`)
   - Carrier packages → manual (`POST /packages/sync`)
   - Labels/returns/voids → reactive to UI actions
3. **Check if v4 reads the field** (tables above). Some fields ShipStation returns are intentionally not mapped — that's by design, not a bug.
4. **Check credentials** — per-client calls fail silently if `clients.ssApiKey` is unset and the env default doesn't have permission for that client's data.

## Files to inspect when debugging

- Request body/response mapping: `src/lib/shipstation/labels.ts`, `src/lib/shipstation/types.ts`
- Rate-shop body: `src/services/rates.ts` (`fetchEstimateForCarrier`)
- Order field extraction: `src/services/order-sync.ts` (`upsertOrdersBatch`)
- Shipment field extraction: `src/services/shipment-sync.ts` (`shipmentValues`)
- Residential helper: `src/lib/shipstation/residential.ts`
- Credential resolver: `src/lib/shipstation/credentials.ts`
- Rate limiter + retry config: `src/lib/shipstation/client.ts` (V2), `src/lib/shipstation/v1-client.ts` (V1)
