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
  ordersView.includes('getOrderWithDisplayBestRate'),
  'OrdersView can display saved carrier/account before exact passive recalculation finishes'
);

assert(
  ordersView.includes('getOrderWithDisplayBestRate(order)'),
  'awaiting carrier/account cells use cache-first display before showing a spinner'
);

assert(
  (ordersView.match(/data-rate-state=\{isRecalculatingSavedRate \? 'recalculating' : 'ready'\}/g) ?? []).length >= 3,
  'stale saved rates are shown with a recalculating state instead of blank spinner lock'
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
