import { buildSidebarSections } from '../web/src/components/Sidebar/sidebar-data.js';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  if (!pass) {
    console.log('  actual:  ', actual);
    console.log('  expected:', expected);
    failures += 1;
  }
}

const sections = buildSidebarSections(
  [
    { storeId: 1, storeName: 'HUGRAB' },
    { storeId: 2, storeName: 'KF Goods' },
    { storeId: 3, storeName: 'Heritage Kids Press' },
    { storeId: 4, storeName: 'Tran Agency' },
    { storeId: 5, storeName: 'Walmart - DJC' },
    { storeId: 6, storeName: 'eBay - DJC' },
    { storeId: 7, storeName: 'Manual Orders' },
    { storeId: 8, storeName: 'Techtok' },
    { storeId: 9, storeName: 'KimlyParc' },
    { storeId: 10, storeName: 'Test Orders', isTest: true },
  ],
  {
    byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 26 }],
    byStatusStore: [
      { orderStatus: 'awaiting_shipment', storeId: 1, cnt: 11 },
      { orderStatus: 'awaiting_shipment', storeId: 2, cnt: 4 },
      { orderStatus: 'awaiting_shipment', storeId: 3, cnt: 5 },
      { orderStatus: 'awaiting_shipment', storeId: 4, cnt: 2 },
      { orderStatus: 'awaiting_shipment', storeId: 8, cnt: 1 },
    ],
  },
);

check(
  'awaiting sidebar clients sort alphabetically, not by count',
  sections.awaiting_shipment.stores.map((store) => store.name),
  [
    'eBay - DJC',
    'Heritage Kids Press',
    'HUGRAB',
    'KF Goods',
    'KimlyParc',
    'Manual Orders',
    'Techtok',
    'Tran Agency',
    'Walmart - DJC',
    'Test Orders',
  ],
);

check(
  'test clients remain pinned after real clients',
  sections.awaiting_shipment.stores.at(-1)?.name,
  'Test Orders',
);

if (failures > 0) {
  console.error(`FAIL sidebar client sort guard: ${failures} failure(s)`);
  process.exit(1);
}

console.log('PASS sidebar client sort guard');
