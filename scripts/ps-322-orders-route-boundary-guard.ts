/**
 * PS-322 - orders.ts route-boundary cleanup guard.
 *
 * Pins one narrow extraction: best-rate dims validation belongs to the backend
 * Apply Best Rate service owner, while routes/orders.ts stays an HTTP boundary
 * that validates request shape, delegates to the owner, and returns errors.
 *
 * Pure/offline: no DB, no providers, no labels/postage, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const ordersRoute = read('src/routes/orders.ts');
const applyBestRateOwner = read('src/services/shipping-workflow/apply-best-rate.ts');
const packageJson = read('package.json');

check('apply-best-rate owner exports reusable dims-label parser',
  /export function parseBestRateDimsLabel\(/.test(applyBestRateOwner));

check('apply-best-rate owner exports persisted best-rate dims validator',
  /export function validateBestRateDimsForPersistedRate\(/.test(applyBestRateOwner));

check('orders route imports best-rate dims validation from the service owner',
  /import \{[^}]*buildApplyBestRatePatch[^}]*validateBestRateDimsForPersistedRate[^}]*\} from '\.\.\/services\/shipping-workflow\/apply-best-rate'/.test(ordersRoute));

check('orders route no longer defines route-local best-rate dims parser/schema/validator',
  !/function parseBestRateDimsLabel\(/.test(ordersRoute) &&
  !/const bestRateDimsSchema\b/.test(ordersRoute) &&
  !/function validateBestRateDimsForPersistedRate\(/.test(ordersRoute));

check('orders route remains a caller of the canonical persisted-rate dims validator',
  (ordersRoute.match(/validateBestRateDimsForPersistedRate\(/g)?.length ?? 0) >= 2);

check('package wires PS-322 route-boundary guard',
  /"test:ps-322-orders-route-boundary"\s*:\s*"tsx scripts\/ps-322-orders-route-boundary-guard\.ts"/.test(packageJson));

if (failures > 0) {
  console.error(`\nPS-322 orders route-boundary guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-322 orders route-boundary guard passed.');
