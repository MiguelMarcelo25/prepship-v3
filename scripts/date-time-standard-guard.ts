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

assert(
  read('web/src/hooks/v2Hooks.ts').includes('californiaDayStartIso') &&
    read('web/src/hooks/v2Hooks.ts').includes('californiaDayEndIso'),
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
assert(
  read('src/routes/billing.ts').includes('coerceCaliforniaIsoDay'),
  'Billing route YYYY-MM-DD filters must coerce as California business days',
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

console.log('PASS date/time standard guard');
