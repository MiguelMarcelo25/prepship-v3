import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIRECT_LABEL_CARRIERS,
  DIRECT_CARRIER_PROVIDER_ID_OFFSET,
  DIRECT_STORE_PROVIDER_ID_OFFSET,
  buildCompatibilityMatrix,
  certifyCombo,
  classifyLabelEndpointById,
} from '../src/connectors/compatibility-matrix';

// PS-078 — store-source × carrier-provider compatibility certification.
// Asserts the matrix composes the two independent connector boundaries and
// blocks every unsupported/rates-only/store-account combo BEFORE postage, then
// prints the certification table for the ticket evidence.

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── (1) PS-209 re-anchor: the legacy Vercel /carriers/labels endpoint is a
// retired no-import 410 — there is no second purchase whitelist to drift
// from anymore. The matrix's label-capable set now answers to the ONE owner:
// v4 createLabelV2 → labels-direct.ts, which dispatches generically through
// createCarrierLabel(provider, input) — so the matrix itself (already
// cross-checked against connector capabilities below) is the acceptance set.
const labelsSrc = readFileSync('api/carriers/labels.ts', 'utf8');
const directLabelsSvc = readFileSync('src/services/labels-direct.ts', 'utf8');
check(
  'legacy /carriers/labels is the retired 410 stub (no purchase whitelist remains)',
  labelsSrc.includes('LEGACY_LABEL_ENDPOINT_RETIRED') &&
    !labelsSrc.includes('LABEL_CREATE_CONNECTOR_CAPABILITIES'),
);
check(
  `v4 direct-label owner dispatches every matrix carrier generically (matrix=[${[...DIRECT_LABEL_CARRIERS].sort()}])`,
  [...DIRECT_LABEL_CARRIERS].length > 0 &&
    directLabelsSvc.includes('createCarrierLabel(provider, input)'),
);

// ── (2) Key matrix rows ────────────────────────────────────────────────────
// ShipStation source + ShipStation carrier → supported, confirm via ShipStation.
{
  const r = certifyCombo('shipstation', 'shipstation');
  check('SS source + SS carrier: supported', r.certified && r.labelEndpoint === 'shipstation_render' && r.confirmationOwner === 'shipstation' && r.confirmationState === 'pending');
}
// ShipStation source + EVERY direct carrier → supported, Vercel label, confirm via ShipStation.
for (const carrier of ['ups', 'easypost', 'shipp', 'walmart_shipping'] as const) {
  const r = certifyCombo('shipstation', carrier);
  check(`SS source + direct ${carrier}: supported, Vercel label, confirm via shipstation`,
    r.certified && r.labelEndpoint === 'carrier_vercel' && r.confirmationOwner === 'shipstation' && r.confirmationState === 'pending');
}
// Direct Walmart source composes with direct carriers AND ShipStation carrier, confirm via Walmart.
for (const carrier of ['walmart_shipping', 'ups', 'easypost', 'shipp', 'shipstation'] as const) {
  const r = certifyCombo('walmart', carrier);
  check(`Walmart source + ${carrier}: supported, confirm via walmart`,
    r.certified && r.confirmationOwner === 'walmart' && r.confirmationState === 'pending');
}
// Direct eBay source composes with direct carriers AND ShipStation carrier, confirm via eBay.
for (const carrier of ['ups', 'easypost', 'shipp', 'shipstation'] as const) {
  const r = certifyCombo('ebay', carrier);
  check(`eBay source + ${carrier}: supported, confirm via ebay`,
    r.certified && r.confirmationOwner === 'ebay' && r.confirmationState === 'pending');
}
// Manual / no-marketplace order → label OK, confirmation not_required (never null).
{
  const r = certifyCombo('manual', 'ups');
  check('manual source: not_required confirmation', r.certified && r.confirmationState === 'not_required');
}
// Rates-only carriers → blocked before postage regardless of source.
for (const carrier of ['fedex', 'usps', 'shipengine', 'ebay_shipping', 'amazon_shipping'] as const) {
  const r = certifyCombo('shipstation', carrier);
  check(`rates-only ${carrier}: blocked before postage`,
    !r.certified && r.labelEndpoint === 'none' && /rates-only/.test(r.reason));
}
// Registered-but-stub store source → label OK but confirmation explicit not_supported (never null).
{
  const r = certifyCombo('shopify', 'ups');
  check('shopify source: live confirmation remains certified',
    r.certified && r.confirmationState === 'pending' && r.labelEndpoint === 'carrier_vercel');
}
{
  const r = certifyCombo('amazon', 'ups');
  check('amazon source (stub): confirmation not_supported, not null',
    !r.certified && r.confirmationState === 'not_supported' && r.labelEndpoint === 'carrier_vercel');
}

// ── (3) Direct selected-rate provider-id routing ───────────────────────────
check('carrier_accounts id → Vercel', classifyLabelEndpointById(DIRECT_CARRIER_PROVIDER_ID_OFFSET + 5) === 'carrier_vercel');
check('store_accounts id → blocked (never ShipStation se-20000xxx)', classifyLabelEndpointById(DIRECT_STORE_PROVIDER_ID_OFFSET + 5) === 'store_account_blocked');
check('plain ShipStation id → Render', classifyLabelEndpointById(7381) === 'shipstation_render');
check('null provider id → Render', classifyLabelEndpointById(null) === 'shipstation_render');

// ── (4) Frontend wiring — PS-202: ONE label owner. createLabel posts ONLY to
// v4 /labels; the Vercel /carriers/labels branch is deleted. The PS-078
// store-account protection moved to the BACKEND structure: synthetic 10M+/20M+
// ids resolve through labels-direct (scope-asserted via PS-083), and a
// non-label-capable provider is rejected by the connector registry
// (missingCarrierConnector) BEFORE any postage — store accounts can never
// reach ShipStation as bogus se-20000xxx ids because directRef intercepts them.
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const createLabelStart = apiClient.indexOf('createLabel(payload: unknown)');
const createLabelBlock = apiClient.slice(createLabelStart, apiClient.indexOf('retrieveLabel(', createLabelStart));
check('v2-apiClient createLabel posts ONLY to v4 /labels (no Vercel branch)',
  createLabelStart >= 0 &&
  /api\.post<any>\('\/labels', payload\)/.test(createLabelBlock) &&
  !/carriers\/labels/.test(createLabelBlock) &&
  !/callVercelFunction/.test(createLabelBlock));
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
const labelsDirect = readFileSync('src/services/labels-direct.ts', 'utf8');
check('backend createLabelV2 intercepts synthetic direct ids before the ShipStation call',
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/.test(labelsService) &&
  /carrierFamily: 'direct'/.test(labelsService));
check('store_accounts ids resolve through the scope-asserted direct loader (never ShipStation)',
  /DIRECT_STORE_PROVIDER_ID_OFFSET/.test(labelsDirect) &&
  /sourceTable: 'store_accounts'/.test(labelsDirect) &&
  /DIRECT_CARRIER_NOT_ASSIGNED/.test(labelsDirect));

// ── (5) Exact-rate: non-test label payload must NOT pull stale order.bestRate ──
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const labelPayloadBlock = ordersView.slice(
  ordersView.indexOf('const payload: CreateLabelRequestDto = {'),
  ordersView.indexOf('const labelPopup = mode ='),
);
check('label payload exists', labelPayloadBlock.length > 0);
check('non-test label name/type do NOT fall back to order.bestRate (no stale rate in payload)',
  !/order\.bestRate\?\.serviceName|order\.bestRate\?\.serviceType/.test(labelPayloadBlock));
check('label payload selected tuple comes from panel (account.code / panelForm.serviceCode / shippingProviderId)',
  /carrierCode: isTest \? testCarrierCode : account!?\.code/.test(labelPayloadBlock) &&
  /serviceCode: isTest \? testServiceCode : panelForm\.serviceCode/.test(labelPayloadBlock));

// PS-078 req 4 — the "proceed with current operator selection" decision (no
// stale-rate hard block) must stay documented at the label payload, so the
// rationale (safe BECAUSE the charged tuple is the operator's current selection,
// not a saved/cached rate) isn't silently lost or reverted.
check('req-4 "proceed with current operator selection" decision is documented at the label payload',
  /PS-078 req 4 — DECISION[\s\S]{0,400}?proceed with current operator/.test(labelPayloadBlock));

// ── (6) PS-209 re-anchor: confirmation processing lives at the v4 owner ──
// The old pin held the Vercel function's in-request confirmation (Vercel
// freezes after the response). Direct labels now run on Render through the
// SAME shared persist tail as ShipStation labels (PS-202), where the outbox
// fires per-order — and the 1-minute scheduler tick below remains the
// self-healing net.
const v4LabelsSvc = readFileSync('src/services/labels.ts', 'utf8');
check('v4 label owner fires the per-order outbox processor in the shared tail',
  /processFulfillmentOutboxOnce\(\{ orderId/.test(v4LabelsSvc));
check('legacy label endpoint carries NO confirmation machinery',
  !labelsSrc.includes('processFulfillmentOutboxOnce') &&
    !labelsSrc.includes('processOrderConfirmationNow'));

// ── (7) Self-healing backstop: the 1-minute outbox worker must stay wired ────
// The direct-carrier label fires confirmation in-request, but the proven safety
// net (delivers + auto-recovers any missed confirmation without manual action)
// is the scheduler tick. Lock it so it can't be silently removed.
const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8');
check('pg-boss runs the fulfillment outbox on a durable 1-minute schedule',
  /const FULFILLMENT_OUTBOX_INTERVAL_MS = SYNC_CADENCE_MS\.fulfillmentOutbox/.test(queue) &&
  /JOBS\.fulfillmentOutbox,[\s\S]*SCHEDULE_CRON\.everyMinute/.test(queue));
// Repointed 2026-08-05. This required `processFulfillmentOutboxOnce({ limit: 25 })`
// literally. The batch limit is now a named constant, FULFILLMENT_OUTBOX_BATCH_LIMIT,
// and it was deliberately dropped from 25 to 1 on 2026-07-18: one marketplace
// confirmation may use its full two-minute provider timeout, so claiming 25 per tick
// could hold the shared lane for the best part of an hour and starve order refresh past
// its three-minute freshness budget. The minute cadence drains the backlog instead.
//
// So pinning 25 would demand restoring lane starvation. The batch size is a tuning
// decision owned at the scheduler; what PS-078 owns is that ONE tick both recovers
// missing confirmations and drains the outbox. Assert that, inside the tick body, in
// that order -- recover first so anything just re-enqueued can drain in the same pass --
// and that the limit stays a bounded named constant rather than becoming unbounded.
const outboxTick = (() => {
  const start = scheduler.indexOf('export async function runFulfillmentOutboxTick');
  if (start < 0) return '';
  const end = scheduler.indexOf('\nexport ', start + 1);
  return scheduler.slice(start, end > start ? end : start + 3_000);
})();
const recoverIdx = outboxTick.indexOf('enqueueMissingShipmentConfirmations({');
const processIdx = outboxTick.indexOf('processFulfillmentOutboxOnce({');
check('outbox tick both auto-recovers missing confirmations AND processes the outbox',
  outboxTick !== '' && recoverIdx >= 0 && processIdx > recoverIdx &&
  /processFulfillmentOutboxOnce\(\{\s*limit: FULFILLMENT_OUTBOX_BATCH_LIMIT,?\s*\}\)/.test(outboxTick));
check('the outbox batch limit stays a bounded positive constant',
  /export const FULFILLMENT_OUTBOX_BATCH_LIMIT = ([1-9]\d{0,2});/.test(scheduler));

// ── Print the certification table ──────────────────────────────────────────
const rows = buildCompatibilityMatrix();
const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
console.log('\nPS-078 STORE × CARRIER COMPATIBILITY MATRIX');
console.log(
  pad('Store/source', 38) + pad('Carrier', 26) + pad('Label endpoint', 22) +
  pad('Confirm owner', 16) + pad('Confirm state', 15) + 'Certified',
);
console.log('-'.repeat(125));
for (const r of rows) {
  console.log(
    pad(r.storeSource, 38) + pad(r.carrierProvider, 26) + pad(r.labelEndpoint, 22) +
    pad(r.confirmationOwner, 16) + pad(r.confirmationState, 15) + (r.certified ? 'YES' : 'BLOCKED'),
  );
}

if (failures > 0) {
  console.error(`\nFAIL PS-078 connector matrix certification (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-078 connector matrix certification');
