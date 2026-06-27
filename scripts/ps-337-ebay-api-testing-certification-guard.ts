/**
 * PS-337 guard - eBay API testing certification.
 *
 * This guard turns the custom Trello card "ebay is ready for api testing" into
 * a PS-track certification without running live eBay calls.
 */
import { existsSync, readFileSync } from 'node:fs';

const files = {
  packageJson: 'package.json',
  doc: 'docs/ps-tickets/ps-337-ebay-api-testing-certification.md',
  ebayConnector: 'src/connectors/store/ebay.ts',
  outbox: 'src/services/fulfillment/outbox.ts',
  payload: 'src/services/fulfillment/confirmation-payload.ts',
  mockedGuard: 'scripts/ebay-confirmation-mocked-guard.ts',
  smoke: 'scripts/smoke-marketplace-confirm.ts',
  retry: 'scripts/retry-marketplace-confirmation.ts',
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

let failures = 0;

function check(name: string, condition: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

function includesAll(name: string, source: string, needles: string[]): void {
  const missing = needles.filter((needle) => !source.includes(needle));
  check(name, missing.length === 0);
  for (const needle of missing) {
    console.error(`     missing: ${needle}`);
  }
}

check('PS-337 certification doc exists', existsSync(files.doc));

const packageJson = read(files.packageJson);
const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
const doc = existsSync(files.doc) ? read(files.doc) : '';
const ebayConnector = read(files.ebayConnector);
const outbox = read(files.outbox);
const payload = read(files.payload);
const mockedGuard = read(files.mockedGuard);
const smoke = read(files.smoke);
const retry = read(files.retry);

check(
  'package wires PS-337 eBay API testing certification guard',
  pkg.scripts?.['test:ps-337-ebay-api-testing-certification'] ===
    'tsx scripts/ps-337-ebay-api-testing-certification-guard.ts',
);

includesAll('PS-337 doc records custom Trello source and certification scope', doc, [
  'Custom Trello source card: https://trello.com/c/gRogisQ0',
  'PS-337 is the PrepShip PS-track version of the custom card',
  'certification ticket',
  'not a live marketplace mutation',
  'Current finding: eBay is ready for offline/mocked API certification',
]);

includesAll('PS-337 doc names canonical backend owners', doc, [
  'src/connectors/store/ebay.ts',
  'src/services/fulfillment/confirmation-payload.ts',
  'src/services/fulfillment/outbox.ts',
  'scripts/smoke-marketplace-confirm.ts',
  'scripts/ebay-confirmation-mocked-guard.ts',
]);

includesAll('PS-337 doc blocks live eBay side effects without exact approval', doc, [
  'Live eBay confirmation',
  'requires exact DJ approval',
  'DJ approves PS-337 eBay live API test',
  'No live marketplace notification',
  'No live marketplace notification, label purchase, postage, production order',
]);

includesAll('eBay connector owns API capability and fulfillment translation', ebayConnector, [
  "provider: 'ebay'",
  "'shipment.confirm'",
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  '/sell/fulfillment/v1/order',
  'shipping_fulfillment',
  'timedFetch',
]);

includesAll('eBay connector validates required confirmation inputs before provider calls', ebayConnector, [
  'eBay confirmation missing trackingNumber',
  'eBay confirmation missing orderId',
  'eBay confirmation missing line items with lineItemId',
  'eBay confirmation missing carrier code',
]);

includesAll('eBay connector protects retry/idempotency/error-safety behavior', ebayConnector, [
  'redactEbayError',
  'isAlreadyFulfilledConflict',
  'alreadyFulfilled',
  'retryable: res.status === 429 || res.status >= 500',
]);

includesAll('confirmation payload owner hydrates eBay identity once from order facts', payload, [
  'buildMarketplaceConfirmationIdentity',
  "if (provider === 'ebay')",
  'ebayOrderId',
  'lineItems',
  'lineItemId',
  'hydrateMarketplaceConfirmationPayload',
]);

includesAll('outbox owner hydrates payload and dispatches eBay through connector lifecycle', outbox, [
  'hydrateMarketplaceConfirmationPayload',
  "provider !== 'walmart' && provider !== 'ebay'",
  'resolveStoreConnector(row.provider,',
  'connector.confirmShipment',
  'processFulfillmentOutboxOnce',
]);

includesAll('mocked eBay guard covers success, validation, idempotency, retryability, and redaction', mockedGuard, [
  'missing credentials must fail safely',
  'missing tracking must fail safely',
  'missing line items must fail safely',
  'mocked eBay confirmation should succeed',
  'already-fulfilled/idempotent conflict should be treated as safe success',
  '5xx fulfillment failure must be retryable',
  'OAuth failure must redact tokens',
]);

includesAll('marketplace smoke remains read-only/default-safe for eBay API testing', smoke, [
  'READ_ONLY_BY_DEFAULT',
  "provider === 'ebay'",
  '--mock-process-once',
  'Refusing live processing',
  'liveMarketplaceCalled: false',
]);

includesAll('current exact live retry command is not silently widened to eBay', retry, [
  'Refusing retry: only Walmart marketplace confirmations are supported by this live command',
  "provider !== 'walmart'",
  '--live-approved',
  '--outbox-id',
]);

if (failures > 0) {
  console.error(`\nPS-337 eBay API testing certification guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-337 eBay API testing certification guard passed.');

