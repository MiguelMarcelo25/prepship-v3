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

const packageJson = read('package.json');
assert(
  !packageJson.includes('test:ps-337-ebay-api-testing-certification'),
  'eBay guard must not keep duplicate PS-337 package script',
);
assert(
  packageJson.includes('test:ps-339-ebay-api-testing-certification'),
  'eBay guard must be registered as PS-339',
);

assert(!existsSync('docs/ps-tickets/ps-337-ebay-api-testing-certification.md'), 'duplicate PS-337 eBay doc must be renamed');
assert(
  !existsSync('scripts/ps-337-ebay-api-testing-certification-guard.ts'),
  'duplicate PS-337 eBay guard must be renamed',
);
assert(existsSync('docs/ps-tickets/ps-339-ebay-api-testing-certification.md'), 'PS-339 eBay doc must exist');
assert(existsSync('scripts/ps-339-ebay-api-testing-certification-guard.ts'), 'PS-339 eBay guard must exist');

console.log('PS ticket ledger guard passed');
