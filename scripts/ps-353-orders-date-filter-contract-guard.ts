import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const contractPath = 'web/src/components/Views/orders-date-query-contract.ts';
const homePath = 'web/src/Home.tsx';
const ordersViewPath = 'web/src/components/Views/OrdersView.tsx';
const useOrdersPath = 'web/src/hooks/useOrders.ts';
const apiClientPath = 'web/src/lib/v2-apiClient.ts';
const packagePath = 'package.json';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  console.log(`ok   ${label}`);
}

check('PS-353 shared orders date query contract exists', existsSync(contractPath));

const contract = read(contractPath);
const home = read(homePath);
const ordersView = read(ordersViewPath);
const useOrders = read(useOrdersPath);
const apiClient = read(apiClientPath);
const pkg = read(packagePath);

const {
  isAllDatesOrdersFilter,
  resolveOrdersDateRangeForFilter,
} = await import('../web/src/components/Views/orders-date-query-contract.ts');

check('All Dates filter is explicitly identified', isAllDatesOrdersFilter('') === true);
check('non-All-Dates filter is not treated as All Dates', isAllDatesOrdersFilter('last-30') === false);

const allDatesRange = resolveOrdersDateRangeForFilter('');
check(
  'All Dates resolves to no dateStart/dateEnd bounds',
  allDatesRange.start === undefined && allDatesRange.end === undefined,
);

const last30Range = resolveOrdersDateRangeForFilter('last-30');
check(
  'bounded filters still resolve to a dateStart/dateEnd pair',
  typeof last30Range.start === 'string' &&
    last30Range.start.length >= 10 &&
    typeof last30Range.end === 'string' &&
    last30Range.end.length >= 10,
);

check(
  'contract module documents the PS-353 All Dates no-hidden-bounds rule',
  /PS-353/.test(contract) && /All Dates/.test(contract) && /dateFrom/.test(contract) && /dateTo/.test(contract),
);

check(
  'Home imports the PS-353 date query contract',
  /from ['"]\.\/components\/Views\/orders-date-query-contract['"]/.test(home),
);

check(
  'Home immediately mirrors non-custom date filter changes into sidebar/count date range',
  /function handleOrdersDateFilterChange\(nextFilter: OrdersDateFilter\)/.test(home) &&
    /setDateFilter\(nextFilter\)/.test(home) &&
    /setOrdersDateRange\(resolveOrdersDateRangeForFilter\(nextFilter\)\)/.test(home),
);

check(
  'Home passes the guarded date filter handler instead of raw setDateFilter',
  /onDateFilterChange=\{handleOrdersDateFilterChange\}/.test(home) &&
    !/onDateFilterChange=\{setDateFilter\}/.test(home),
);

check(
  'OrdersView consumes the same date query contract for table/export/select-all range',
  /resolveOrdersDateRangeForFilter\(dateFilter,\s*\{[\s\S]*customDateFrom[\s\S]*customDateTo[\s\S]*\}\)/.test(ordersView),
);

check(
  'useOrders sends date params only from resolved optional bounds',
  /dateFrom:\s*isoFrom/.test(useOrders) &&
    /dateTo:\s*isoTo/.test(useOrders) &&
    /if \(v === undefined \|\| v === ''\) continue/.test(read('web/src/lib/api.ts')),
);

check(
  'sidebar counts use the same optional dateStart/dateEnd contract',
  /fetchCounts\(filter\?: \{ dateStart\?: string; dateEnd\?: string \}\)/.test(apiClient) &&
    /const hasDate = Boolean\(filter\?\.dateStart \|\| filter\?\.dateEnd\)/.test(apiClient) &&
    /\/init\/counts\$\{qs\(\{ dateFrom, dateTo \}\)\}/.test(apiClient) &&
    /api\.get<any>\('\/init\/counts'/.test(apiClient),
);

check(
  'package wires PS-353 orders date filter contract guard',
  /"test:ps-353-orders-date-filter-contract":\s*"tsx scripts\/ps-353-orders-date-filter-contract-guard\.ts"/.test(pkg),
);

console.log('PASS PS-353 orders date filter contract guard');
