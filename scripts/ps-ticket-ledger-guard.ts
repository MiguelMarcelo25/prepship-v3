import { existsSync, readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PS ticket ledger guard failed: ${message}`);
  }
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const ledgerPath = 'docs/ps-tickets/ps-ledger.md';
assert(existsSync(ledgerPath), 'docs/ps-tickets/ps-ledger.md must exist');

const ledger = read(ledgerPath);
assert(ledger.includes('| PS-337 | Best Rate remove second line |'), 'ledger must reserve PS-337 for best-rate second-line work');
assert(
  ledger.includes('| PS-338 | Keep rates visible during browse refresh |'),
  'ledger must reserve PS-338 for browse refresh visibility work',
);
assert(ledger.includes('| PS-339 | eBay API testing certification |'), 'ledger must assign eBay API testing to PS-339');
assert(ledger.includes('| PS-340 | Rate Browser frontend bridge audit |'), 'ledger must reserve PS-340 for Rate Browser bridge cleanup');
assert(ledger.includes('| PS-341 | Frontend compatibility helper audit |'), 'ledger must reserve PS-341 for frontend compatibility cleanup');
assert(ledger.includes('| PS-342 | Legacy rate display adapter cleanup |'), 'ledger must reserve PS-342 for legacy rate adapter cleanup');
assert(ledger.includes('| PS-343 | RateBrowserModal money normalization cleanup |'), 'ledger must reserve PS-343 for RateBrowserModal money cleanup');
assert(ledger.includes('| PS-344 | Order row workflow shape cleanup |'), 'ledger must reserve PS-344 for order row workflow shape cleanup');

const packageJson = read('package.json');
assert(
  !packageJson.includes('test:ps-337-ebay-api-testing-certification'),
  'eBay guard must not keep duplicate PS-337 package script',
);
assert(
  packageJson.includes('test:ps-339-ebay-api-testing-certification'),
  'eBay guard must be registered as PS-339',
);
assert(
  packageJson.includes('test:ps-340-ratebrowser-bridge-audit'),
  'PS-340 Rate Browser bridge audit guard must be registered',
);
assert(
  packageJson.includes('test:ps-341-frontend-compatibility-helper-audit'),
  'PS-341 frontend compatibility helper audit guard must be registered',
);
assert(
  packageJson.includes('test:ps-342-legacy-rate-display-adapter-cleanup'),
  'PS-342 legacy rate adapter cleanup guard must be registered',
);
assert(
  packageJson.includes('test:ps-343-ratebrowsermodal-money-normalization-cleanup'),
  'PS-343 RateBrowserModal money cleanup guard must be registered',
);
assert(
  packageJson.includes('test:ps-344-order-row-workflow-shape-cleanup'),
  'PS-344 order row workflow shape cleanup guard must be registered',
);

assert(!existsSync('docs/ps-tickets/ps-337-ebay-api-testing-certification.md'), 'duplicate PS-337 eBay doc must be renamed');
assert(
  !existsSync('scripts/ps-337-ebay-api-testing-certification-guard.ts'),
  'duplicate PS-337 eBay guard must be renamed',
);
assert(existsSync('docs/ps-tickets/ps-339-ebay-api-testing-certification.md'), 'PS-339 eBay doc must exist');
assert(existsSync('scripts/ps-339-ebay-api-testing-certification-guard.ts'), 'PS-339 eBay guard must exist');

console.log('PS ticket ledger guard passed');
