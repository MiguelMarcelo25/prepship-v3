/**
 * Slice 4 guard — marketplace + postage SUPPRESSION invariants.
 *
 * The harness must be structurally incapable of notifying a marketplace or
 * spending money. This guard proves the invariants that make that true, and
 * encodes a KNOWN constraint discovered during the build:
 *
 *   api/carriers/labels.ts infers the confirmation provider from the order's
 *   external_order_id ONLY (inferStoreProviderFromExternalId), defaulting a null
 *   id to 'shipstation' — a SUPPORTED confirmation provider. So source_provider
 *   ='internal' alone does NOT suppress confirmation on that handler's SQL enqueue
 *   path. The harness therefore drives createCarrierLabel + persist + print-queue
 *   directly (which is confirmation-free) and NEVER the handler's confirmation
 *   branch. This guard fails if that ever changes.
 *
 * Plan: ~/.claude/plans/zany-spinning-hennessy.md
 */
import { readFileSync } from 'node:fs';
import {
  buildCarrierTestOrderSeed,
  assertSeedIsSafe,
  CarrierTestOrderSafetyError,
  HARNESS_SOURCE,
  HARNESS_MARKER,
} from './lib/carrier-test-order-factory.js';
import {
  assertNoLivePostageOrMarketplace,
  CarrierTestModeSafetyError,
} from '../src/services/carrier-test-mode.js';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function throwsSafe(fn: () => void, Type: any): boolean {
  try { fn(); return false; } catch (e) { return e instanceof Type; }
}

// ── factory invariants: every harness order is structurally un-notifiable ──
for (const provider of ['easypost', 'shipp', 'ups', 'walmart_shipping']) {
  const seed = buildCarrierTestOrderSeed({ provider, serviceCode: 'svc_x' });
  check(`[${provider}] source is '${HARNESS_SOURCE}'`, seed.sourceProvider === HARNESS_SOURCE);
  check(`[${provider}] external_order_id is null (no marketplace prefix)`, seed.externalOrderId === null);
  check(`[${provider}] order_number carries the ${HARNESS_MARKER} cleanup marker`, seed.orderNumber.startsWith(HARNESS_MARKER));
  check(`[${provider}] SKU is TEST- (frontend isTestOrder gate)`, /^TEST-/.test(seed.sku));
  check(`[${provider}] seed passes the safety assertion`, !throwsSafe(() => assertSeedIsSafe(seed), CarrierTestOrderSafetyError));
}

// ── assertSeedIsSafe refuses every unsafe mutation ──
const base = buildCarrierTestOrderSeed({ provider: 'shipp', serviceCode: 'svc' });
check('refuses a marketplace external id', throwsSafe(() => assertSeedIsSafe({ ...base, externalOrderId: 'walmart-123' } as any), CarrierTestOrderSafetyError));
check('refuses a non-internal source', throwsSafe(() => assertSeedIsSafe({ ...base, sourceProvider: 'walmart' } as any), CarrierTestOrderSafetyError));
check('refuses an order_number without the marker', throwsSafe(() => assertSeedIsSafe({ ...base, orderNumber: 'X-1' } as any), CarrierTestOrderSafetyError));
check('refuses a non-TEST sku', throwsSafe(() => assertSeedIsSafe({ ...base, sku: 'REAL-1' } as any), CarrierTestOrderSafetyError));

// ── seam refuses real marketplace sources / live postage ──
process.env.CARRIER_TEST_MODE = '1';
for (const src of ['walmart', 'ebay', 'amazon', 'shipstation']) {
  check(`seam refuses '${src}' source`, throwsSafe(() => assertNoLivePostageOrMarketplace('shipp', { __sourceProvider: src } as any, 'replay'), CarrierTestModeSafetyError));
}
delete process.env.CARRIER_TEST_MODE;

// ── createCarrierLabel is CONFIRMATION-FREE (orchestrator never notifies) ──
const orch = readFileSync('src/services/carrier-connector-orchestrator.ts', 'utf8');
check('orchestrator does not enqueue/confirm any marketplace shipment',
  !/enqueueShipmentConfirmation|processFulfillmentOutbox|confirmStoreShipment|confirmWalmart/.test(orch));

// ── encode the KNOWN inference gap: null external id → 'shipstation' lives ONLY
//    in the handler, and the harness must NOT drive that confirmation path ──
const handler = readFileSync('api/carriers/labels.ts', 'utf8');
check('handler still defaults a null external id to shipstation (gap is documented, not silently changed)',
  /function inferStoreProviderFromExternalId[\s\S]*?if \(!externalOrderId\) return 'shipstation'/.test(handler));

const runner = readFileSync('scripts/carrier-harness-e2e.ts', 'utf8');
check('runner drives createCarrierLabel (confirmation-free), NOT the handler confirmation SQL',
  /createCarrierLabel\(/.test(runner) &&
    !/enqueueShipmentConfirmationSql|processOrderConfirmationNow|confirmWalmartSourceOrderAfterLabelSql/.test(runner));
check('runner asserts zero live outbox rows after an attempt (post-assert helper present)',
  /assertNoOutboxRows/.test(runner));

// ── cleanup never mutates shipped/cancelled (lockdown) ──
const factory = readFileSync('scripts/lib/carrier-test-order-factory.ts', 'utf8');
check('cleanup excludes shipped/cancelled orders (lockdown-safe)',
  /order_status NOT IN \('shipped', ?'cancelled'\)/.test(factory) &&
    /order_status NOT IN \('shipped','cancelled'\)/.test(factory));

if (failures > 0) {
  console.error(`\nFAIL carrier suppression guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS carrier suppression guard');
