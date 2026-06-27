/**
 * PS-330 guard - controlled live/canary certification for guarded shipping and
 * rate workflows.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, no production data mutation, and no
 * shipped/cancelled mutation. This guard certifies the certification plan and
 * live gates; it must not execute any canary itself.
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

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

const packageJson = read('package.json');
const ps330DocPath = 'docs/ps-tickets/ps-330-controlled-live-canary-certification.md';
const ps330Doc = read(ps330DocPath);

check('PS-330 controlled live/canary certification doc exists', existsSync(ps330DocPath));
check('package wires PS-330 controlled canary certification guard',
  /"test:ps-330-controlled-canary-certification"\s*:\s*"tsx scripts\/ps-330-controlled-canary-certification-guard\.ts"/.test(packageJson));

checkIncludesAll('PS-330 doc names the certification layers and matrix columns', ps330Doc, [
  'Static/guard',
  'Mocked/offline',
  'Read-only',
  'Canary plan',
  'Live canary result',
  'Path name',
  'Current guard/offline proof command',
  'Live/staging preconditions',
  'Side effect risk',
  'Required DJ approval text',
  'Exact command or browser workflow',
  'Expected result',
  'Pass/fail/blocker',
  'Recovery plan',
  'Follow-up card needed',
]);

checkIncludesAll('PS-330 doc covers every requested guarded workflow path', ps330Doc, [
  'strict snapshot-only selected-rate proof enforcement',
  'Browse Rates / Apply Best Rate / Recalculate / Create Label / Print Queue proof pass-through',
  'PRINT_QUEUE_BACKEND_ORCHESTRATION default-off backend orchestration path',
  'marketplace/source confirmation lifecycle',
  'real provider boundary readiness',
  'HUGRAB insurance-aware next-best/customer-rate and selected-rate proof behavior',
]);

checkIncludesAll('PS-330 doc records canonical owners instead of creating a new owner', ps330Doc, [
  'PS-330 does not create a new shipping, rate, label, queue, or marketplace owner',
  'src/services/rates-combined.ts',
  'src/services/rates.ts',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/shipping-workflow/rate-fingerprint.ts',
  'src/services/labels.ts#createLabelV2',
  'src/services/print-queue.ts',
  'src/routes/print-queue.ts',
  'src/services/fulfillment/outbox.ts',
  'src/services/fulfillment/confirmation-payload.ts',
]);

checkIncludesAll('PS-330 doc records predecessor guard evidence', ps330Doc, [
  'test:rate-source-of-truth',
  'test:ps-318-shipping-workflow-certification',
  'test:ps-319-rate-convergence-certification',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-326-carrier-account-identity-certification',
  'test:ps-327-hugrab-margin-policy',
  'test:ps-333-hugrab-current-rate-sot',
  'test:ps-334-house-rate-column',
  'test:print-to-queue-selected-rate-proof',
  'test:ps-303-print-queue-authority',
  'test:ps-285-marketplace-confirm-boundary',
  'test:walmart-confirmation:payload',
  'test:ebay-confirmation:mocked',
  'test:shipping-roundtrip-certification',
]);

checkIncludesAll('PS-330 doc blocks live side effects without exact approval', ps330Doc, [
  'No real labels',
  'No postage',
  'No voids',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
  'No billing/inventory mutations',
  'exact order/provider/action',
  'DJ approves PS-330 canary',
  'Side effects executed: none',
]);

checkIncludesAll('PS-330 doc classifies live and dry-run commands safely', ps330Doc, [
  'preflight:print-queue',
  'smoke:shipping:preflight',
  'shipstation:recover:dry-run',
  'shipstation:external-shipped:dry-run',
  'smoke:shipping:real-label',
  'smoke:carrier-harness:real-label',
  'smoke:marketplace-confirm',
  'marketplace:confirm:retry',
  'marketplace:confirmation:repair',
  'shipment-confirmation:recover:apply',
  'shipstation:recover:apply',
  'shipstation:external-shipped:apply',
]);

const envText = read('src/lib/env.ts');
check('PRINT_QUEUE_BACKEND_ORCHESTRATION remains declared as a default-off flag',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));

const printQueueRoute = read('src/routes/print-queue.ts');
checkPatterns('backend route-plan remains gated by PRINT_QUEUE_BACKEND_ORCHESTRATION', printQueueRoute, [
  /PRINT_QUEUE_BACKEND_ORCHESTRATION is ON/,
  /if \(!env\.PRINT_QUEUE_BACKEND_ORCHESTRATION\)/,
  /FEATURE_DISABLED/,
  /503,/,
]);

const quoteStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check('strict snapshot hard blocks remain before carried-proof fallback',
  (() => {
    const blockIndex = quoteStore.indexOf("resolved.reason === 'snapshot_not_final' || resolved.reason === 'selected_rate_not_best'");
    const throwIndex = quoteStore.indexOf('throw new SelectedRateProofError', blockIndex);
    const fallbackIndex = quoteStore.indexOf('FALL BACK to the legacy carried proof', throwIndex);
    return blockIndex >= 0 && throwIndex > blockIndex && fallbackIndex > throwIndex;
  })());

const outbox = read('src/services/fulfillment/outbox.ts');
checkIncludesAll('fulfillment outbox owner exposes explicit marketplace/source lifecycle states', outbox, [
  "plannedAction: 'mark_not_required'",
  "plannedAction: 'mark_not_supported'",
  "plannedAction: 'create_outbox_pending'",
  'processFulfillmentOutboxOnce',
  'succeeded',
  'failed',
]);

const realLabelSmoke = read('scripts/smoke-shipping-real-label.ts');
const carrierHarness = read('scripts/carrier-harness-e2e.ts');
const retryConfirm = read('scripts/retry-marketplace-confirmation.ts');
const repairConfirm = read('scripts/repair-marketplace-confirmation.ts');
checkIncludesAll('mutating live/canary scripts keep explicit live approval gates', realLabelSmoke + carrierHarness + retryConfirm + repairConfirm, [
  '--live-approved',
  'LIVE_LABEL_APPROVAL_REQUIRED',
  'order-id',
  'outbox-id',
  '--apply requires --live-approved',
]);

const shippingHarness = read('docs/shipping-certification-harness.md');
checkIncludesAll('shipping certification harness remains explicit about live safety', shippingHarness, [
  'No automated test may create real labels',
  'smoke:shipping:real-label',
  'Requires `--live-approved`',
  'explicitly approved test order',
]);

if (failures > 0) {
  process.exit(1);
}

console.log('PS-330 controlled live/canary certification guard passed');
