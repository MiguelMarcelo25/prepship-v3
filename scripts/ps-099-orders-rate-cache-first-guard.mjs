import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ordersView = fs.readFileSync(path.join(root, 'web/src/components/Views/OrdersView.tsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${message}`);
  }
}

assert(
  ordersView.includes('hasAnySavedBestRateForDisplay'),
  'OrdersView keeps a permissive saved-rate display check for first paint'
);

assert(
  !ordersView.includes('getOrderWithDisplayBestRate'),
  'OrdersView does not display stale saved carrier/account as final while exact passive recalculation is pending'
);

assert(
  ordersView.includes('const isCalculatingBestRate = !hasDisplayableBestRate && hasAnySavedBestRateForDisplay(displayOrder)'),
  'awaiting rows detect stale saved rates as calculating until exact best rate is ready'
);

assert(
  (ordersView.match(/!hasDisplayableBestRate && !isCalculatingBestRate/g) ?? []).length >= 3 &&
    (ordersView.match(/<div className="spin-center"><span className="spin-sm" \/><\/div>/g) ?? []).length >= 3,
  'stale saved rates show loading/spinner until recalculation returns the exact current best rate'
);

assert(
  packageJson.scripts?.['test:ps-099-orders-rate-cache-first'] ===
    'node scripts/ps-099-orders-rate-cache-first-guard.mjs',
  'package exposes PS-099 cache-first Orders rate guard'
);

if (process.exitCode) {
  console.error('\nPS-099 guard failed.');
  process.exit(process.exitCode);
}

console.log('\nPASS PS-099 Orders carrier/account cache-first display guard');
