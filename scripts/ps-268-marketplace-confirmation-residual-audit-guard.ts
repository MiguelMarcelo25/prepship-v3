/**
 * PS-268 guard - marketplace confirmation residual certification.
 *
 * Offline/read-only only: no DB, no network, no providers, no labels, no
 * postage, no queue insert, no marketplace notifications, no production data
 * mutation, and no shipped/cancelled mutation. This guard pins the residual
 * marketplace confirmation map and verifies local shipped state, label/print
 * state, fulfillment outbox state, and upstream confirmation state stay
 * separated through the backend source-of-truth owners.
 */
import { existsSync, readFileSync } from 'node:fs';

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
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

const packageJson = read('package.json');
const docPath = 'docs/ps-tickets/ps-268-marketplace-confirmation-residual-audit.md';
const doc = read(docPath);

check('package wires PS-268 marketplace confirmation residual guard',
  /"test:ps-268-marketplace-confirmation-residual-audit"\s*:\s*"tsx scripts\/ps-268-marketplace-confirmation-residual-audit-guard\.ts"/.test(packageJson));

check('PS-268 marketplace confirmation residual matrix exists', existsSync(docPath));
checkIncludesAll('PS-268 doc records no-new-owner scope and current finding', doc, [
  'PS-268 does not create a new marketplace confirmation source of truth',
  'Marketplace confirmation residual scope',
  'Canonical owner map',
  'Imperfect data injection points',
  'No new unowned gap found',
  'No broad marketplace confirmation refactor',
]);

checkIncludesAll('PS-268 doc names backend marketplace confirmation owner cluster', doc, [
  'src/services/fulfillment/outbox.ts',
  'src/services/fulfillment/confirmation-payload.ts',
  'src/services/store-connector-orchestrator.ts',
  'src/connectors/store/shipstation.ts',
  'src/connectors/store/walmart.ts',
  'src/connectors/store/ebay.ts',
  'scripts/retry-marketplace-confirmation.ts',
  'scripts/repair-marketplace-confirmation.ts',
  'scripts/recover-missing-shipment-confirmations.ts',
]);

checkIncludesAll('PS-268 doc covers every confirmation state and path requested by the card', doc, [
  'ShipStation-source',
  'Walmart-source',
  'eBay/direct marketplace',
  'not_required',
  'not_supported',
  'local shipped',
  'label/print state',
  'fulfillment outbox state',
  'upstream marketplace/source confirmation state',
  'dry-run safe by default',
  'idempotent',
  'direct notify connector path',
]);

checkIncludesAll('PS-268 doc classifies residual ownership buckets', doc, [
  'already covered',
  'PS-330 canary-only',
  'PS-284 implementation',
  'new unowned gap',
]);

checkIncludesAll('PS-268 doc ties evidence to predecessor cards and commands', doc, [
  'PS-064',
  'PS-253',
  'PS-262A',
  'PS-263',
  'PS-285',
  'PS-318',
  'PS-330',
  'test:ps-268-marketplace-confirmation-residual-audit',
  'test:ps-318-shipping-workflow-certification',
  'test:ps-064-confirmation-outbox',
  'test:ps-285-marketplace-confirm-boundary',
  'test:walmart-confirmation:payload',
  'test:ebay-confirmation:mocked',
  'test:ps-262a-confirmation-payload-funnel',
  'test:ps-253-outbox-stale-reclaim',
  'test:ps-263-void-confirmation-retract',
  'test:shipment-confirmation-auto-recovery',
  'test:shipping-roundtrip-certification',
  'test:ps-330-controlled-canary-certification',
]);

checkIncludesAll('PS-268 doc records offline safety boundaries', doc, [
  'read-only/offline only',
  'No real labels',
  'No postage',
  'No queue insertions',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
]);

for (const command of [
  'test:ps-318-shipping-workflow-certification',
  'test:ps-064-confirmation-outbox',
  'test:ps-285-marketplace-confirm-boundary',
  'test:walmart-confirmation:payload',
  'test:ebay-confirmation:mocked',
  'test:ps-262a-confirmation-payload-funnel',
  'test:ps-253-outbox-stale-reclaim',
  'test:ps-263-void-confirmation-retract',
  'test:shipment-confirmation-auto-recovery',
  'test:shipping-roundtrip-certification',
  'test:ps-330-controlled-canary-certification',
]) {
  check(`package keeps PS-268 evidence command ${command}`, packageJson.includes(`"${command}"`));
}

const outbox = read('src/services/fulfillment/outbox.ts');
checkPatterns('outbox owner plans every marketplace confirmation lifecycle state without label side effects', outbox, [
  /export function buildShipmentConfirmationLifecyclePlan/,
  /safeToBuyLabel: false/,
  /plannedAction:\s*'order_not_found'/,
  /plannedAction:\s*'no_active_shipment'/,
  /plannedAction:\s*'already_succeeded'/,
  /plannedAction:\s*'already_pending'/,
  /plannedAction:\s*'mark_not_required_no_tracking'/,
  /plannedAction:\s*'mark_not_required'/,
  /plannedAction:\s*'mark_not_supported'/,
  /plannedAction:\s*'create_outbox_pending'/,
  /resolveStoreConnector\(provider, 'shipment\.confirm'\)/,
  /export async function enqueueShipmentConfirmation/,
  /export async function ensureShipmentConfirmationLifecycle/,
  /export async function processFulfillmentOutboxOnce/,
  /export async function processFulfillmentOutboxById/,
  /export async function confirmShipmentDirectNow/,
  /export async function cancelShipmentConfirmationsForVoid/,
  /hydrateMarketplaceConfirmationPayload/,
]);

const confirmationPayload = read('src/services/fulfillment/confirmation-payload.ts');
checkPatterns('confirmation payload owner hydrates marketplace identity without overwriting explicit payload fields', confirmationPayload, [
  /export function normalizeConfirmationProvider/,
  /export function buildMarketplaceConfirmationIdentity/,
  /export function hydrateMarketplaceConfirmationPayload/,
  /purchaseOrderId/,
  /ebayOrderId/,
  /lineItems/,
  /rawOrder/,
  /function isEmpty/,
  /if \(value !== undefined && isEmpty\(payload\[key\]\)\) payload\[key\] = value;/,
]);

const boundaryGuard = read('scripts/ps-285-marketplace-confirm-boundary-guard.ts');
checkIncludesAll('PS-285 boundary guard keeps marketplace confirmation dispatch outbox-owned', boundaryGuard, [
  'connector.confirmShipment is dispatched ONLY from the canonical outbox owner + resolver',
  'src/services/fulfillment/outbox.ts',
  'src/services/store-connector-orchestrator.ts',
  'confirmStoreShipment wrapper has ZERO callers outside its own file (no second confirm path)',
  'ssMarkOrderShippedV1 relay call sites are pinned to exactly the 3 allowed owners',
]);

const retryScript = read('scripts/retry-marketplace-confirmation.ts');
checkPatterns('marketplace retry script is gated, exact, dry-run safe, and outbox-owned', retryScript, [
  /--live-approved/,
  /--outbox-id/,
  /const dryRun = argv\.includes\('--dry-run'\) \|\| !liveApproved/,
  /Refusing retry: only Walmart marketplace confirmations are supported by this live command/,
  /processFulfillmentOutboxById\(\{/,
  /dryRun: true/,
  /dryRun: false/,
]);

const repairScript = read('scripts/repair-marketplace-confirmation.ts');
const repairCode = stripComments(repairScript);
checkPatterns('confirmation repair script is gated and delegates to lifecycle owner', repairScript, [
  /--apply requires --live-approved/,
  /ensureShipmentConfirmationLifecycle\(\{/,
  /dryRun: !apply/,
  /safe_to_buy_label/,
  /notify_marketplace/,
]);
check('confirmation repair script does not buy labels or postage',
  !/(createLabelV2|createCarrierLabel|buyLabel|purchaseLabel)/.test(repairCode));

const recoverScript = read('scripts/recover-missing-shipment-confirmations.ts');
const recoverCode = stripComments(recoverScript);
checkPatterns('missing confirmation recovery script is dry-run first and exact-id apply only', recoverScript, [
  /Dry-run by default/,
  /--apply requires exact --order-id and --shipment-id/,
  /Creates only fulfillment_outbox confirmation work for an existing active label/,
  /notifiesMarketplaceDirectly: false/,
  /enqueueMissingShipmentConfirmations\(\{/,
]);
check('missing confirmation recovery script does not buy labels or postage',
  !/(createLabelV2|createCarrierLabel|buyLabel|purchaseLabel)/.test(recoverCode));

const smokeScript = read('scripts/smoke-marketplace-confirm.ts');
checkPatterns('marketplace smoke inspector is read-only by default and refuses live processing', smokeScript, [
  /const READ_ONLY_BY_DEFAULT = true/,
  /--mock-process-once runs an in-memory fixture only; it never calls live marketplaces/,
  /if \(argv\.includes\('--process-once'\)\)/,
  /Refusing live processing/,
  /liveMarketplaceCalled: false/,
]);

const walmartConnector = read('src/connectors/store/walmart.ts');
checkPatterns('Walmart connector owns Walmart-specific payload translation and validates shippable lines', walmartConnector, [
  /export function buildWalmartShipmentConfirmationBody/,
  /orderShipment/,
  /purchaseOrderId/,
  /async confirmShipment\(input: ShipmentConfirmationInput\)/,
  /Walmart confirmation missing purchaseOrderId/,
  /missing Walmart order line numbers/,
  /marketplace\.walmartapis\.com\/v3\/orders/,
]);

const ebayConnector = read('src/connectors/store/ebay.ts');
checkPatterns('eBay connector owns eBay fulfillment payload and safe already-fulfilled handling', ebayConnector, [
  /function ebayLineItems/,
  /Array\.isArray\(payload\.lineItems\)/,
  /already|duplicate|maximum tracking|fulfilled/,
  /async confirmShipment\(input: ShipmentConfirmationInput\)/,
  /eBay confirmation missing line items/,
  /lineItems/,
]);

const shipstationConnector = read('src/connectors/store/shipstation.ts');
checkPatterns('ShipStation connector relays source confirmation through ShipStation mark-shipped API', shipstationConnector, [
  /async confirmShipment\(input: ShipmentConfirmationInput\)/,
  /ssMarkOrderShippedV1/,
  /trackingNumber/,
  /carrierCode/,
]);

if (failures > 0) {
  console.error(`PS-268 marketplace confirmation residual guard failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log('PS-268 marketplace confirmation residual guard passed.');
