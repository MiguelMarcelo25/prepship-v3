#!/usr/bin/env node
/**
 * setup-mock-env.cjs
 *
 * Creates a fully self-contained mock SQLite database for local development.
 * No ShipStation credentials needed. All data is fake but realistic.
 *
 * Usage:
 *   node scripts/setup-mock-env.cjs                    # creates ./dev.db
 *   node scripts/setup-mock-env.cjs --db ./my.db       # custom path
 *   node scripts/setup-mock-env.cjs --clear            # wipe mock data and re-seed
 *
 * Then set in .env:
 *   SQLITE_DB_PATH=./dev.db
 *   WORKER_SYNC_ENABLED=false
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : path.join(__dirname, '..', 'dev.db');
const clear = args.includes('--clear');

console.log(`Setting up mock database at: ${dbPath}`);

// ─── Schema ───────────────────────────────────────────────────────────────────

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    clientId INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    storeIds TEXT DEFAULT '[]',
    contactName TEXT,
    email TEXT,
    phone TEXT,
    ss_api_key TEXT,
    ss_api_secret TEXT,
    active INTEGER DEFAULT 1,
    createdAt INTEGER,
    updatedAt INTEGER,
    brandColor TEXT,
    brandLogo TEXT,
    brandName TEXT,
    ss_api_key_v2 TEXT,
    rate_source_client_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    orderId INTEGER PRIMARY KEY,
    orderNumber TEXT NOT NULL,
    orderStatus TEXT NOT NULL DEFAULT 'awaiting_shipment',
    orderDate TEXT,
    storeId INTEGER,
    customerEmail TEXT,
    shipToName TEXT,
    shipToCity TEXT,
    shipToState TEXT,
    shipToPostalCode TEXT,
    carrierCode TEXT,
    serviceCode TEXT,
    weightValue REAL,
    orderTotal REAL DEFAULT 0,
    shippingAmount REAL DEFAULT 0,
    items TEXT DEFAULT '[]',
    raw TEXT DEFAULT '{}',
    updatedAt INTEGER,
    external_shipped INTEGER DEFAULT 0,
    clientId INTEGER,
    externally_fulfilled_verified INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS order_local (
    orderId INTEGER PRIMARY KEY,
    external_shipped INTEGER DEFAULT 0,
    tracking_number TEXT,
    notes TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    updatedAt INTEGER,
    residential INTEGER,
    ref_usps_rate TEXT,
    ref_ups_rate TEXT,
    rate_weight_oz REAL,
    rate_dims_l REAL,
    rate_dims_w REAL,
    rate_dims_h REAL,
    selected_pid INTEGER,
    best_rate_json TEXT,
    best_rate_at INTEGER,
    best_rate_dims TEXT,
    selected_package_id TEXT,
    shipping_account TEXT,
    external_shipped_source TEXT,
    items TEXT
  );

  CREATE TABLE IF NOT EXISTS shipments (
    shipmentId INTEGER PRIMARY KEY,
    orderId INTEGER,
    orderNumber TEXT,
    shipmentCost REAL DEFAULT 0,
    otherCost REAL DEFAULT 0,
    carrierCode TEXT,
    serviceCode TEXT,
    trackingNumber TEXT,
    shipDate TEXT,
    voided INTEGER DEFAULT 0,
    updatedAt INTEGER,
    providerAccountId INTEGER,
    createDate TEXT,
    weight_oz REAL,
    dims_l REAL,
    dims_w REAL,
    dims_h REAL,
    labelUrl TEXT,
    label_created_at INTEGER,
    label_format TEXT,
    source TEXT,
    clientId INTEGER,
    selected_rate_json TEXT,
    selected_pid INTEGER,
    selected_package_id TEXT,
    label_shipmentId INTEGER,
    label_cost REAL,
    label_raw_cost REAL,
    label_carrier TEXT,
    label_service TEXT,
    label_tracking TEXT,
    label_shipDate TEXT,
    label_provider INTEGER,
    orphaned_original_orderId INTEGER,
    reconciliation_layer TEXT,
    reconciliation_confidence REAL,
    reconciliation_timestamp INTEGER,
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
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
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
    last_printed_at INTEGER,
    queued_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(order_id, client_id)
  );

  CREATE TABLE IF NOT EXISTS sku_qty_dims (
    sku TEXT NOT NULL,
    qty INTEGER NOT NULL,
    length REAL,
    width REAL,
    height REAL,
    updatedAt INTEGER,
    PRIMARY KEY (sku, qty)
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updatedAt INTEGER
  );

  -- ─── Tables added for full API compatibility ──────────────────────────────

  CREATE TABLE IF NOT EXISTS locations (
    locationId INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    street1 TEXT,
    street2 TEXT,
    city TEXT,
    state TEXT,
    postalCode TEXT,
    country TEXT DEFAULT 'US',
    phone TEXT,
    isDefault INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS billing_config (
    clientId INTEGER PRIMARY KEY,
    pickPackFee REAL,
    additionalUnitFee REAL,
    packageCostMarkup REAL,
    shippingMarkupPct REAL,
    shippingMarkupFlat REAL,
    billing_mode TEXT,
    storageFeePerCuFt REAL,
    storageFeeMode TEXT,
    palletPricingPerMonth REAL,
    palletCuFt REAL,
    active INTEGER DEFAULT 1,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS billing_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId INTEGER NOT NULL,
    orderId INTEGER NOT NULL,
    orderNumber TEXT NOT NULL,
    shipDate TEXT NOT NULL,
    lineType TEXT NOT NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL,
    unitCost REAL NOT NULL,
    totalCost REAL NOT NULL,
    invoiced INTEGER DEFAULT 0,
    createdAt INTEGER,
    UNIQUE(orderId, lineType, description)
  );

  CREATE TABLE IF NOT EXISTS billing_ref_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wt INTEGER,
    zipTo TEXT,
    carrier TEXT,
    service TEXT,
    cost REAL,
    source TEXT,
    fetchedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS carrier_cache (
    apiKeyHash TEXT PRIMARY KEY,
    carriers TEXT,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS client_package_prices (
    clientId INTEGER NOT NULL,
    packageId INTEGER NOT NULL,
    price REAL NOT NULL,
    is_custom INTEGER DEFAULT 0,
    updatedAt INTEGER,
    PRIMARY KEY (clientId, packageId)
  );

  CREATE TABLE IF NOT EXISTS inventory (
    invSkuId INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId INTEGER,
    sku TEXT,
    name TEXT,
    stockQty INTEGER DEFAULT 0,
    reorderLevel INTEGER DEFAULT 0,
    imageUrl TEXT,
    weight_oz REAL,
    length REAL,
    width REAL,
    height REAL,
    active INTEGER DEFAULT 1,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS inventory_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invSkuId INTEGER NOT NULL,
    type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    orderId INTEGER,
    note TEXT,
    createdBy TEXT,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS inventory_parent_skus (
    parentId INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId INTEGER,
    name TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS inventory_sku_parents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invSkuId INTEGER,
    parentId INTEGER
  );

  CREATE TABLE IF NOT EXISTS inventory_skus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId INTEGER NOT NULL,
    sku TEXT NOT NULL,
    name TEXT DEFAULT '',
    minStock INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    weightOz REAL DEFAULT 0,
    parentSkuId INTEGER,
    baseUnitQty INTEGER DEFAULT 1,
    length REAL DEFAULT 0,
    width REAL DEFAULT 0,
    height REAL DEFAULT 0,
    productLength REAL DEFAULT 0,
    productWidth REAL DEFAULT 0,
    productHeight REAL DEFAULT 0,
    packageId INTEGER,
    units_per_pack INTEGER DEFAULT 1,
    cuFtOverride REAL,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS order_shipments_return (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipmentId INTEGER,
    returnShipmentId INTEGER,
    returnTrackingNumber TEXT,
    reason TEXT,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS package_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    packageId INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT,
    unitCost REAL,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS packages (
    packageId INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'box',
    length REAL DEFAULT 0,
    width REAL DEFAULT 0,
    height REAL DEFAULT 0,
    tareWeightOz REAL DEFAULT 0,
    source TEXT DEFAULT 'custom',
    carrierCode TEXT,
    packageCode TEXT,
    domestic INTEGER,
    international INTEGER,
    stockQty INTEGER DEFAULT 0,
    reorderLevel INTEGER DEFAULT 10,
    unitCost REAL,
    isDefault INTEGER DEFAULT 0,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS parent_skus (
    parentSkuId INTEGER PRIMARY KEY AUTOINCREMENT,
    clientId INTEGER NOT NULL,
    name TEXT NOT NULL,
    sku TEXT,
    baseUnitQty INTEGER DEFAULT 1,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS product_defaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT,
    productId INTEGER,
    serviceCode TEXT,
    packageCode TEXT,
    shippingProviderId INTEGER,
    weightOz REAL,
    length REAL,
    width REAL,
    height REAL,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS products (
    productId INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE,
    name TEXT,
    imageUrl TEXT,
    weightOz REAL DEFAULT 0,
    length REAL DEFAULT 0,
    width REAL DEFAULT 0,
    height REAL DEFAULT 0,
    defaultPackageCode TEXT,
    modifyDate INTEGER,
    updatedAt INTEGER,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS rate_cache (
    cache_key TEXT PRIMARY KEY,
    weight_oz REAL,
    to_zip TEXT,
    rates TEXT NOT NULL,
    best_rate TEXT,
    fetched_at INTEGER,
    weight_version INTEGER
  );

  CREATE TABLE IF NOT EXISTS return_labels (
    shipmentId INTEGER PRIMARY KEY,
    returnShipmentId INTEGER,
    returnTrackingNumber TEXT,
    reason TEXT,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS sku_defaults (
    sku TEXT PRIMARY KEY,
    weightOz REAL DEFAULT 0,
    length REAL DEFAULT 0,
    width REAL DEFAULT 0,
    height REAL DEFAULT 0,
    packageCode TEXT,
    updatedAt INTEGER
  );
`);

if (clear) {
  db.exec(`
    DELETE FROM clients WHERE clientId < 100;
    DELETE FROM orders WHERE clientId < 100;
    DELETE FROM order_local WHERE orderId IN (SELECT orderId FROM orders WHERE clientId < 100);
    DELETE FROM shipments WHERE clientId < 100;
  `);
  console.log('Cleared existing mock data.');
}

const now = Date.now();

// ─── Mock Clients ─────────────────────────────────────────────────────────────

const CLIENTS = [
  { clientId: 1, name: 'Acme E-Commerce', storeIds: '[10001]', contactName: 'Alice Chen', email: 'alice@acme.com', brandColor: '#3b82f6' },
  { clientId: 2, name: 'Seoul Kitchen Goods', storeIds: '[10002]', contactName: 'Bob Park', email: 'bob@seoulkitchen.com', brandColor: '#ef4444' },
  { clientId: 3, name: 'SoCal Outdoor Supply', storeIds: '[10003]', contactName: 'Carol Martinez', email: 'carol@socaloutdoor.com', brandColor: '#22c55e' },
  { clientId: 11, name: 'Test Orders', storeIds: '[999999]', contactName: 'Dev Team', email: 'dev@test.local', brandColor: '#8b5cf6' },
];

for (const c of CLIENTS) {
  db.prepare(`
    INSERT OR IGNORE INTO clients (clientId, name, storeIds, contactName, email, active, createdAt, updatedAt, brandColor)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(c.clientId, c.name, c.storeIds, c.contactName, c.email, now, now, c.brandColor);
}
console.log(`✓ ${CLIENTS.length} mock clients`);

// ─── Mock Products / SKUs ─────────────────────────────────────────────────────

const SKUS = [
  // client 1 — e-commerce
  { sku: 'ACM-HEADSET-001', name: 'Wireless Gaming Headset', weightOz: 14, price: 79.99, qty: 1 },
  { sku: 'ACM-KEYBD-002',   name: 'Mechanical Keyboard TKL', weightOz: 28, price: 129.99, qty: 1 },
  { sku: 'ACM-MOUSE-003',   name: 'Ergonomic Mouse 4000 DPI', weightOz: 6, price: 49.99, qty: 1 },
  // client 2 — Korean food
  { sku: 'SKG-RAMEN-5PK',   name: 'Samyang Buldak Ramen 5-Pack', weightOz: 25, price: 11.99, qty: 5 },
  { sku: 'SKG-SAUCE-2PK',   name: 'Gochujang Sauce 2-Pack', weightOz: 18, price: 14.99, qty: 2 },
  { sku: 'SKG-SNACK-BOX',   name: 'Korean Snack Variety Box', weightOz: 32, price: 29.99, qty: 1 },
  // client 3 — outdoor
  { sku: 'SCO-COOLER-001',  name: '20qt Hard Cooler', weightOz: 96, price: 89.99, qty: 1 },
  { sku: 'SCO-BOTTLE-001',  name: 'Insulated Water Bottle 32oz', weightOz: 12, price: 34.99, qty: 1 },
  // test
  { sku: 'TEST-RAMEN-001',  name: 'Test Ramen 5-Pack', weightOz: 26, price: 10.99, qty: 5 },
  { sku: 'TEST-GEAR-001',   name: 'Test Label Roll 4x6', weightOz: 8, price: 24.99, qty: 1 },
];

// Seed sku_qty_dims for rate shopping
const DIMS = {
  'ACM-HEADSET-001': { l: 12, w: 10, h: 5 },
  'ACM-KEYBD-002':   { l: 17, w: 7,  h: 3 },
  'ACM-MOUSE-003':   { l: 8,  w: 5,  h: 4 },
  'SKG-RAMEN-5PK':   { l: 13, w: 9,  h: 5 },
  'SKG-SAUCE-2PK':   { l: 9,  w: 6,  h: 5 },
  'SKG-SNACK-BOX':   { l: 14, w: 12, h: 6 },
  'SCO-COOLER-001':  { l: 18, w: 14, h: 12 },
  'SCO-BOTTLE-001':  { l: 13, w: 4,  h: 4 },
  'TEST-RAMEN-001':  { l: 13, w: 9,  h: 5 },
  'TEST-GEAR-001':   { l: 10, w: 6,  h: 4 },
};

for (const [sku, d] of Object.entries(DIMS)) {
  const s = SKUS.find(s => s.sku === sku);
  db.prepare(`INSERT OR REPLACE INTO sku_qty_dims (sku, qty, length, width, height, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sku, s?.qty ?? 1, d.l, d.w, d.h, now);
}

// ─── Address pool ─────────────────────────────────────────────────────────────

const ADDRESSES = [
  ['Alice Johnson',    'Los Angeles',   'CA', '90001'],
  ['Bob Martinez',     'New York',      'NY', '10001'],
  ['Carol Williams',   'Chicago',       'IL', '60601'],
  ['David Brown',      'Houston',       'TX', '77001'],
  ['Eva Davis',        'Phoenix',       'AZ', '85001'],
  ['Frank Wilson',     'Philadelphia',  'PA', '19101'],
  ['Grace Moore',      'San Antonio',   'TX', '78201'],
  ['Henry Taylor',     'San Diego',     'CA', '92101'],
  ['Isabel Anderson',  'San Jose',      'CA', '95101'],
  ['James Thomas',     'Austin',        'TX', '78701'],
  ['Karen White',      'Seattle',       'WA', '98101'],
  ['Liam Harris',      'Denver',        'CO', '80201'],
  ['Mia Jackson',      'Boston',        'MA', '02101'],
  ['Noah Clark',       'Portland',      'OR', '97201'],
  ['Olivia Lewis',     'Nashville',     'TN', '37201'],
];

// ─── Carriers for mock shipped orders ─────────────────────────────────────────

const CARRIERS = [
  { carrierCode: 'stamps_com', serviceCode: 'usps_priority_mail',      nickname: 'USPS Chase x7439', providerAccountId: 433542, cost: 8.97  },
  { carrierCode: 'stamps_com', serviceCode: 'usps_media_mail',         nickname: 'USPS Chase x7439', providerAccountId: 433542, cost: 5.22  },
  { carrierCode: 'ups',        serviceCode: 'ups_ground',               nickname: 'GG6381',           providerAccountId: 565326, cost: 12.50 },
  { carrierCode: 'ups',        serviceCode: 'ups_surepost_1_lb_or_greater', nickname: 'ORION',        providerAccountId: 596001, cost: 7.79  },
];

// ─── Seed Orders ──────────────────────────────────────────────────────────────

let orderCount = 0;
let shipmentCount = 0;
const BASE_AWAITING = 20000;
const BASE_SHIPPED  = 21000;

// Per-client SKU map
const CLIENT_SKUS = {
  1:  SKUS.filter(s => s.sku.startsWith('ACM')),
  2:  SKUS.filter(s => s.sku.startsWith('SKG')),
  3:  SKUS.filter(s => s.sku.startsWith('SCO')),
  11: SKUS.filter(s => s.sku.startsWith('TEST')),
};

const CLIENT_STORES = { 1: 10001, 2: 10002, 3: 10003, 11: 999999 };

function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// Awaiting shipment orders (30 per client)
for (const clientId of [1, 2, 3, 11]) {
  const skus = CLIENT_SKUS[clientId];
  const storeId = CLIENT_STORES[clientId];
  for (let i = 0; i < 30; i++) {
    const orderId = BASE_AWAITING + clientId * 100 + i;
    const sku = randomChoice(skus);
    const addr = ADDRESSES[orderCount % ADDRESSES.length];
    const orderNum = `MOCK-${clientId}-AW-${String(i + 1).padStart(3, '0')}`;
    const orderDate = new Date(Date.now() - randomInt(1, 72) * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO orders
        (orderId, orderNumber, orderStatus, orderDate, clientId, storeId,
         carrierCode, serviceCode, weightValue, shipToName, shipToCity, shipToState,
         shipToPostalCode, orderTotal, shippingAmount, updatedAt, items)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orderId, orderNum, 'awaiting_shipment', orderDate, clientId, storeId,
      'stamps_com', 'usps_priority_mail', sku.weightOz,
      addr[0], addr[1], addr[2], addr[3],
      sku.price, 5.99, now,
      JSON.stringify([{ sku: sku.sku, name: sku.name, quantity: sku.qty, unitPrice: sku.price, adjustment: false }])
    );
    orderCount++;
  }
}

// Shipped orders (20 per client, with real mock shipment records)
for (const clientId of [1, 2, 3, 11]) {
  const skus = CLIENT_SKUS[clientId];
  const storeId = CLIENT_STORES[clientId];
  for (let i = 0; i < 20; i++) {
    const orderId = BASE_SHIPPED + clientId * 100 + i;
    const sku = randomChoice(skus);
    const carrier = randomChoice(CARRIERS);
    const addr = ADDRESSES[(orderCount + i) % ADDRESSES.length];
    const orderNum = `MOCK-${clientId}-SH-${String(i + 1).padStart(3, '0')}`;
    const shipDate = new Date(Date.now() - randomInt(1, 14) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const orderDate = new Date(Date.parse(shipDate) - randomInt(1, 3) * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO orders
        (orderId, orderNumber, orderStatus, orderDate, clientId, storeId,
         carrierCode, serviceCode, weightValue, shipToName, shipToCity, shipToState,
         shipToPostalCode, orderTotal, shippingAmount, updatedAt, items)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orderId, orderNum, 'shipped', orderDate, clientId, storeId,
      carrier.carrierCode, carrier.serviceCode, sku.weightOz,
      addr[0], addr[1], addr[2], addr[3],
      sku.price, 5.99, now,
      JSON.stringify([{ sku: sku.sku, name: sku.name, quantity: sku.qty, unitPrice: sku.price, adjustment: false }])
    );

    // Generate a fake tracking number
    const trackingNumber = carrier.carrierCode === 'ups'
      ? `1Z${carrier.providerAccountId === 565326 ? 'GG6381' : 'R05H19'}YW${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`
      : `9449050106151${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;

    const shipmentId = 8000000 + clientId * 1000 + i;
    db.prepare(`
      INSERT OR REPLACE INTO shipments
        (shipmentId, orderId, orderNumber, carrierCode, serviceCode, trackingNumber,
         shipDate, shipmentCost, otherCost, voided, updatedAt, clientId,
         providerAccountId, provider_account_nickname, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      shipmentId, orderId, orderNum, carrier.carrierCode, carrier.serviceCode, trackingNumber,
      shipDate, carrier.cost, 0, 0, now, clientId,
      carrier.providerAccountId, carrier.nickname, 'mock'
    );

    db.prepare(`
      INSERT OR REPLACE INTO order_local (orderId, external_shipped, tracking_number, updatedAt)
      VALUES (?, 0, ?, ?)
    `).run(orderId, trackingNumber, now);

    shipmentCount++;
  }
  orderCount += 20;
}

// 10 externally shipped orders per client (Amazon/marketplace — no SS label)
for (const clientId of [1, 2, 3]) {
  const storeId = CLIENT_STORES[clientId];
  for (let i = 0; i < 10; i++) {
    const orderId = BASE_SHIPPED + clientId * 100 + 50 + i;
    const addr = ADDRESSES[i % ADDRESSES.length];
    const orderNum = `MOCK-${clientId}-EX-${String(i + 1).padStart(3, '0')}`;
    const orderDate = new Date(Date.now() - randomInt(1, 10) * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT OR REPLACE INTO orders
        (orderId, orderNumber, orderStatus, orderDate, clientId, storeId,
         carrierCode, shipToName, shipToCity, shipToState, shipToPostalCode,
         orderTotal, shippingAmount, updatedAt, items)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orderId, orderNum, 'shipped', orderDate, clientId, storeId,
      'ups_walleted', addr[0], addr[1], addr[2], addr[3],
      randomInt(20, 80), 0, now, '[]'
    );

    db.prepare(`INSERT OR REPLACE INTO order_local (orderId, external_shipped, updatedAt) VALUES (?,1,?)`).run(orderId, now);
    orderCount++;
  }
}

console.log(`✓ ${orderCount} mock orders (awaiting + shipped + external)`);
console.log(`✓ ${shipmentCount} mock shipment records`);

// ─── Summary ──────────────────────────────────────────────────────────────────

const counts = db.prepare(`
  SELECT orderStatus, COUNT(*) as c FROM orders GROUP BY orderStatus
`).all();

console.log('\n📦 Order summary:');
for (const row of counts) console.log(`   ${row.orderStatus}: ${row.c}`);

console.log(`\n✅ Mock database ready at: ${dbPath}`);
console.log('\nNext steps:');
console.log(`  1. Update your .env:`);
console.log(`     SQLITE_DB_PATH=${dbPath}`);
console.log(`     WORKER_SYNC_ENABLED=false`);
console.log(`  2. Start the servers: npm run dev:api  and  npm run dev:web`);
console.log(`  3. Open http://localhost:4011`);
console.log(`  4. Select any client from the dropdown to see orders`);
