-- PrepShip V2 — Initial PostgreSQL Schema
-- Converted from SQLite schema in scripts/setup-mock-env.cjs

CREATE TABLE IF NOT EXISTS clients (
  "clientId" SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  "storeIds" JSONB DEFAULT '[]',
  "contactName" TEXT,
  email TEXT,
  phone TEXT,
  ss_api_key TEXT,
  ss_api_secret TEXT,
  active INTEGER DEFAULT 1,
  "createdAt" BIGINT,
  "updatedAt" BIGINT,
  "brandColor" TEXT,
  "brandLogo" TEXT,
  "brandName" TEXT,
  ss_api_key_v2 TEXT,
  rate_source_client_id INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  "orderId" SERIAL PRIMARY KEY,
  "orderNumber" TEXT NOT NULL,
  "orderStatus" TEXT NOT NULL DEFAULT 'awaiting_shipment',
  "orderDate" TEXT,
  "storeId" INTEGER,
  "customerEmail" TEXT,
  "shipToName" TEXT,
  "shipToCity" TEXT,
  "shipToState" TEXT,
  "shipToPostalCode" TEXT,
  "carrierCode" TEXT,
  "serviceCode" TEXT,
  "weightValue" REAL,
  "orderTotal" REAL DEFAULT 0,
  "shippingAmount" REAL DEFAULT 0,
  items JSONB DEFAULT '[]',
  raw JSONB DEFAULT '{}',
  "updatedAt" BIGINT,
  external_shipped INTEGER DEFAULT 0,
  "clientId" INTEGER,
  externally_fulfilled_verified INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_local (
  "orderId" INTEGER PRIMARY KEY,
  external_shipped INTEGER DEFAULT 0,
  tracking_number TEXT,
  notes TEXT DEFAULT '',
  tags JSONB DEFAULT '[]',
  "updatedAt" BIGINT,
  residential INTEGER,
  ref_usps_rate TEXT,
  ref_ups_rate TEXT,
  rate_weight_oz REAL,
  rate_dims_l REAL,
  rate_dims_w REAL,
  rate_dims_h REAL,
  selected_pid INTEGER,
  best_rate_json TEXT,
  best_rate_at BIGINT,
  best_rate_dims TEXT,
  selected_package_id TEXT,
  shipping_account TEXT,
  external_shipped_source TEXT,
  items JSONB
);

CREATE TABLE IF NOT EXISTS shipments (
  "shipmentId" SERIAL PRIMARY KEY,
  "orderId" INTEGER,
  "orderNumber" TEXT,
  "shipmentCost" REAL DEFAULT 0,
  "otherCost" REAL DEFAULT 0,
  "carrierCode" TEXT,
  "serviceCode" TEXT,
  "trackingNumber" TEXT,
  "shipDate" TEXT,
  voided INTEGER DEFAULT 0,
  "updatedAt" BIGINT,
  "providerAccountId" INTEGER,
  "createDate" TEXT,
  weight_oz REAL,
  dims_l REAL,
  dims_w REAL,
  dims_h REAL,
  "labelUrl" TEXT,
  label_created_at BIGINT,
  label_format TEXT,
  source TEXT,
  "clientId" INTEGER,
  selected_rate_json TEXT,
  selected_pid INTEGER,
  selected_package_id TEXT,
  "label_shipmentId" INTEGER,
  label_cost REAL,
  label_raw_cost REAL,
  label_carrier TEXT,
  label_service TEXT,
  label_tracking TEXT,
  "label_shipDate" TEXT,
  label_provider INTEGER,
  orphaned_original_orderId INTEGER,
  reconciliation_layer TEXT,
  reconciliation_confidence REAL,
  reconciliation_timestamp BIGINT,
  reconciliation_notes TEXT,
  provider_account_nickname TEXT
);

CREATE TABLE IF NOT EXISTS mock_labels (
  shipment_id INTEGER PRIMARY KEY,
  order_number TEXT,
  tracking_number TEXT,
  service_label TEXT,
  weight_oz REAL,
  ship_from TEXT,
  ship_to TEXT,
  ship_date TEXT,
  pdf_base64 TEXT,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS print_queue_orders (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  order_number TEXT,
  label_url TEXT NOT NULL,
  sku_group_id TEXT NOT NULL,
  primary_sku TEXT,
  item_description TEXT,
  order_qty INTEGER DEFAULT 1,
  multi_sku_data TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  print_count INTEGER NOT NULL DEFAULT 0,
  last_printed_at BIGINT,
  queued_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(order_id, client_id)
);

CREATE TABLE IF NOT EXISTS sku_qty_dims (
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  length REAL,
  width REAL,
  height REAL,
  "updatedAt" BIGINT,
  PRIMARY KEY (sku, qty)
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS locations (
  "locationId" SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  street1 TEXT,
  street2 TEXT,
  city TEXT,
  state TEXT,
  "postalCode" TEXT,
  country TEXT DEFAULT 'US',
  phone TEXT,
  "isDefault" INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS billing_config (
  "clientId" INTEGER PRIMARY KEY,
  "pickPackFee" REAL,
  "additionalUnitFee" REAL,
  "packageCostMarkup" REAL,
  "shippingMarkupPct" REAL,
  "shippingMarkupFlat" REAL,
  billing_mode TEXT,
  "storageFeePerCuFt" REAL,
  "storageFeeMode" TEXT,
  "palletPricingPerMonth" REAL,
  "palletCuFt" REAL,
  active INTEGER DEFAULT 1,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS billing_line_items (
  id SERIAL PRIMARY KEY,
  "clientId" INTEGER NOT NULL,
  "orderId" INTEGER NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "shipDate" TEXT NOT NULL,
  "lineType" TEXT NOT NULL,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  "unitCost" REAL NOT NULL,
  "totalCost" REAL NOT NULL,
  invoiced INTEGER DEFAULT 0,
  "createdAt" BIGINT,
  UNIQUE("orderId", "lineType", description)
);

CREATE TABLE IF NOT EXISTS billing_ref_rates (
  id SERIAL PRIMARY KEY,
  wt INTEGER,
  "zipTo" TEXT,
  carrier TEXT,
  service TEXT,
  cost REAL,
  source TEXT,
  "fetchedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS carrier_cache (
  "apiKeyHash" TEXT PRIMARY KEY,
  carriers JSONB,
  fetched_at BIGINT
);

CREATE TABLE IF NOT EXISTS client_package_prices (
  "clientId" INTEGER NOT NULL,
  "packageId" INTEGER NOT NULL,
  price REAL NOT NULL,
  is_custom INTEGER DEFAULT 0,
  "updatedAt" BIGINT,
  PRIMARY KEY ("clientId", "packageId")
);

CREATE TABLE IF NOT EXISTS inventory (
  "invSkuId" SERIAL PRIMARY KEY,
  "clientId" INTEGER,
  sku TEXT,
  name TEXT,
  "stockQty" INTEGER DEFAULT 0,
  "reorderLevel" INTEGER DEFAULT 0,
  "imageUrl" TEXT,
  weight_oz REAL,
  length REAL,
  width REAL,
  height REAL,
  active INTEGER DEFAULT 1,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id SERIAL PRIMARY KEY,
  "invSkuId" INTEGER NOT NULL,
  type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  "orderId" INTEGER,
  note TEXT,
  "createdBy" TEXT,
  "createdAt" BIGINT
);

CREATE TABLE IF NOT EXISTS inventory_parent_skus (
  "parentId" SERIAL PRIMARY KEY,
  "clientId" INTEGER,
  name TEXT,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS inventory_sku_parents (
  id SERIAL PRIMARY KEY,
  "invSkuId" INTEGER,
  "parentId" INTEGER
);

CREATE TABLE IF NOT EXISTS inventory_skus (
  id SERIAL PRIMARY KEY,
  "clientId" INTEGER NOT NULL,
  sku TEXT NOT NULL,
  name TEXT DEFAULT '',
  "minStock" INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  "weightOz" REAL DEFAULT 0,
  "parentSkuId" INTEGER,
  "baseUnitQty" INTEGER DEFAULT 1,
  length REAL DEFAULT 0,
  width REAL DEFAULT 0,
  height REAL DEFAULT 0,
  "productLength" REAL DEFAULT 0,
  "productWidth" REAL DEFAULT 0,
  "productHeight" REAL DEFAULT 0,
  "packageId" INTEGER,
  units_per_pack INTEGER DEFAULT 1,
  "cuFtOverride" REAL,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS order_shipments_return (
  id SERIAL PRIMARY KEY,
  "shipmentId" INTEGER,
  "returnShipmentId" INTEGER,
  "returnTrackingNumber" TEXT,
  reason TEXT,
  "createdAt" BIGINT
);

CREATE TABLE IF NOT EXISTS package_ledger (
  id SERIAL PRIMARY KEY,
  "packageId" INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT,
  "unitCost" REAL,
  "createdAt" BIGINT
);

CREATE TABLE IF NOT EXISTS packages (
  "packageId" SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'box',
  length REAL DEFAULT 0,
  width REAL DEFAULT 0,
  height REAL DEFAULT 0,
  "tareWeightOz" REAL DEFAULT 0,
  source TEXT DEFAULT 'custom',
  "carrierCode" TEXT,
  "packageCode" TEXT,
  domestic INTEGER,
  international INTEGER,
  "stockQty" INTEGER DEFAULT 0,
  "reorderLevel" INTEGER DEFAULT 10,
  "unitCost" REAL,
  "isDefault" INTEGER DEFAULT 0,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS parent_skus (
  "parentSkuId" SERIAL PRIMARY KEY,
  "clientId" INTEGER NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  "baseUnitQty" INTEGER DEFAULT 1,
  "createdAt" BIGINT,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS product_defaults (
  id SERIAL PRIMARY KEY,
  sku TEXT,
  "productId" INTEGER,
  "serviceCode" TEXT,
  "packageCode" TEXT,
  "shippingProviderId" INTEGER,
  "weightOz" REAL,
  length REAL,
  width REAL,
  height REAL,
  "updatedAt" BIGINT
);

CREATE TABLE IF NOT EXISTS products (
  "productId" SERIAL PRIMARY KEY,
  sku TEXT UNIQUE,
  name TEXT,
  "imageUrl" TEXT,
  "weightOz" REAL DEFAULT 0,
  length REAL DEFAULT 0,
  width REAL DEFAULT 0,
  height REAL DEFAULT 0,
  "defaultPackageCode" TEXT,
  "modifyDate" BIGINT,
  "updatedAt" BIGINT,
  "createdAt" BIGINT
);

CREATE TABLE IF NOT EXISTS rate_cache (
  cache_key TEXT PRIMARY KEY,
  weight_oz REAL,
  to_zip TEXT,
  rates JSONB NOT NULL,
  best_rate JSONB,
  fetched_at BIGINT,
  weight_version INTEGER
);

CREATE TABLE IF NOT EXISTS return_labels (
  "shipmentId" INTEGER PRIMARY KEY,
  "returnShipmentId" INTEGER,
  "returnTrackingNumber" TEXT,
  reason TEXT,
  "createdAt" BIGINT
);

CREATE TABLE IF NOT EXISTS sku_defaults (
  sku TEXT PRIMARY KEY,
  "weightOz" REAL DEFAULT 0,
  length REAL DEFAULT 0,
  width REAL DEFAULT 0,
  height REAL DEFAULT 0,
  "packageCode" TEXT,
  "updatedAt" BIGINT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders ("orderStatus");
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders ("clientId");
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders ("storeId");
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders ("orderDate");
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments ("orderId");
CREATE INDEX IF NOT EXISTS idx_shipments_client ON shipments ("clientId");
CREATE INDEX IF NOT EXISTS idx_shipments_date ON shipments ("shipDate");
CREATE INDEX IF NOT EXISTS idx_billing_line_items_client ON billing_line_items ("clientId");
CREATE INDEX IF NOT EXISTS idx_billing_line_items_date ON billing_line_items ("shipDate");
CREATE INDEX IF NOT EXISTS idx_inventory_skus_client ON inventory_skus ("clientId");
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_sku ON inventory_ledger ("invSkuId");
CREATE INDEX IF NOT EXISTS idx_print_queue_client ON print_queue_orders (client_id, status);
