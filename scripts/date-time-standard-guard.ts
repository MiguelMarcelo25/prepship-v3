import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  californiaDayEnd,
  californiaDayStart,
} from '../src/lib/time/california';
import {
  formatShipStationV1DateParam,
  parseShipStationV1Date,
} from '../src/lib/shipstation/v1-date';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

assert.equal(
  parseShipStationV1Date('2026-05-28T15:18:15.0000000')?.toISOString(),
  '2026-05-28T22:18:15.000Z',
  'ShipStation v1 bare timestamps must parse as account-local California time',
);
assert.equal(
  formatShipStationV1DateParam(Date.parse('2026-05-28T22:00:00.000Z')),
  '2026-05-28 15:00:00',
  'ShipStation v1 query params must send account-local wall-clock text',
);
assert.equal(
  californiaDayStart('2026-05-28').toISOString(),
  '2026-05-28T07:00:00.000Z',
  'California day start should be PDT-aware UTC',
);
assert.equal(
  californiaDayEnd('2026-05-28').toISOString(),
  '2026-05-29T06:59:59.999Z',
  'California day end should be PDT-aware UTC',
);

const criticalFiles = [
  'web/src/components/Views/OrdersView.tsx',
  'web/src/components/Views/InventoryView.tsx',
  'web/src/components/Views/billing-parity.ts',
  'web/src/components/Views/AnalysisView.tsx',
  'web/src/components/OrderDetailDrawer.tsx',
  'web/src/hooks/v2Hooks.ts',
  'web/src/pages/Invoice.tsx',
  'web/src/components/DateRangePicker.tsx',
  'src/routes/orders.ts',
  'src/routes/billing.ts',
  'src/routes/dashboard.ts',
];

for (const file of criticalFiles) {
  const text = read(file);
  assert(
    !/formatNaivePt/.test(text),
    `${file} must not use legacy naive-PT display helpers; repair legacy data instead`,
  );
}

// PS-157: useOrders split out of v2Hooks.ts into its own module; the
// California day-boundary date filters now live in web/src/hooks/useOrders.ts.
assert(
  read('web/src/hooks/useOrders.ts').includes('californiaDayStartIso') &&
    read('web/src/hooks/useOrders.ts').includes('californiaDayEndIso'),
  'Orders date filters must use California day boundaries',
);
assert(
  read('web/src/components/Views/inventory-parity.ts').includes('californiaDayEpochMs'),
  'Inventory History date filters must use California day boundaries',
);
assert(
  read('web/src/components/DateRangePicker.tsx').includes('californiaDateInputValue'),
  'Dashboard date picker presets must use California today, not browser-local today',
);
// PS-208 re-anchor: billing ranges are CALENDAR DAYS owned by
// src/lib/time/billing-day.ts — NOT California business days. ship_date rows
// are stored at UTC midnight, so the old California coercion (07:00:00Z
// bounds) EXCLUDED the first day's rows from every month. Billing must use
// billingDayRange and must never re-import the California coercion.
assert(
  read('src/routes/billing.ts').includes('billingDayRange'),
  'Billing routes must derive range bounds from billingDayRange (src/lib/time/billing-day.ts)',
);
assert(
  !read('src/routes/billing.ts').includes('coerceCaliforniaIsoDay'),
  'Billing routes must NOT use California day coercion — ship_date is a UTC-midnight calendar day (PS-208)',
);
assert(
  read('src/routes/dashboard.ts').includes("America/Los_Angeles"),
  'Dashboard day grouping must use California dates, not UTC dates',
);

// PS-047: the daily-strip fulfillment window must resolve its noon boundary
// through the DST-aware California primitive, not literal noon-UTC.
assert(
  read('src/lib/time/fulfillment-window.ts').includes('californiaWallClockToUtc'),
  'Fulfillment window noon boundary must use californiaWallClockToUtc (true noon Pacific)',
);
assert(
  !/Date\.UTC\(\s*year,\s*month\s*-\s*1,\s*day,\s*12\s*,\s*0\s*,\s*0\s*\)/.test(read('src/routes/orders.ts')),
  'orders.ts must not bound the daily-stats window at literal noon-UTC',
);

// App-wide Pacific standardization (UI + analytics): files that render true
// timestamps as a user-facing date/time must do so via the shared ca-time
// helpers (which force America/Los_Angeles), not the browser-local default.
const caTimeConsumers = [
  // PS-139: web/src/utils/orders.ts removed (0-importer dead file; OrdersView/OrderDetailDrawer
  // define their own ageHours/getPrimarySku). Dropped from this readFileSync list before deletion.
  'web/src/components/RateBrowserModal.tsx',
  'web/src/pages/PromptLibrary.tsx',
  'web/src/pages/Picklist.tsx',
  'web/src/components/Views/packages-parity.ts',
  'web/src/components/Views/SettingsView.tsx',
];
for (const file of caTimeConsumers) {
  assert(
    read(file).includes('ca-time'),
    `${file} must render dates via the shared ca-time helpers (Pacific), not browser-local`,
  );
}

// Analytics SQL must bucket/format order & ship dates in California, never UTC.
const analysis = read('src/routes/analysis.ts');
assert(
  !analysis.includes("at time zone 'UTC'"),
  'analysis.ts must group order/ship dates in California time, not UTC',
);
assert(
  !/date_trunc\('(?:day|week|month)',\s*now\(\)\)/.test(analysis),
  "analysis.ts KPI windows must truncate in California (now() at time zone 'America/Los_Angeles'), not bare UTC now()",
);
assert(
  analysis.includes('America/Los_Angeles'),
  'analysis.ts date grouping must use America/Los_Angeles',
);

// Inventory history daily-sales buckets must be California days on both the
// SQL grouping and the JS contiguous axis (otherwise boundary days misalign).
const inventory = read('src/routes/inventory.ts');
assert(
  !/date_trunc\('day',\s*o\.order_date\)/.test(inventory),
  'inventory.ts history must group by California day, not bare UTC',
);
assert(
  inventory.includes('America/Los_Angeles'),
  'inventory.ts history grouping/buckets must use America/Los_Angeles',
);

// PS-208: billing ship dates are calendar days stored at UTC midnight. The
// invoice must extract the day AT UTC — any America/Los_Angeles conversion
// shifts a UTC-midnight May 1 row to April 30 (the SP6447 bug). Note the
// "Invoice generated <today>" footer stamp is a true instant and stays
// Pacific; only ship_date is day-typed.
assert(
  !/ship_date at time zone 'America\/Los_Angeles'/.test(read('src/routes/billing.ts')),
  'billing.ts must not timezone-convert ship_date — it is a UTC-midnight calendar day (PS-208)',
);
assert(
  read('src/routes/billing.ts').includes("to_char(b.ship_date at time zone 'UTC', 'YYYY-MM-DD')"),
  'billing.ts invoice ship_date must extract the calendar day at UTC (PS-208)',
);

console.log('PASS date/time standard guard');
