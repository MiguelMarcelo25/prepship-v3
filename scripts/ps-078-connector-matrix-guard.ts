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

// ── (1) The direct label-capable set must equal the Vercel endpoint whitelist ──
// so the matrix can never claim a carrier buys labels that /carriers/labels
// rejects (or vice-versa).
const labelsSrc = readFileSync('api/carriers/labels.ts', 'utf8');
const whitelistBlock = labelsSrc.slice(
  labelsSrc.indexOf('LABEL_CREATE_CONNECTOR_CAPABILITIES'),
  labelsSrc.indexOf('function labelCreateConnectorCapabilities'),
);
const whitelistKeys = [...whitelistBlock.matchAll(/^\s{2}([a-z_]+):\s*\[/gm)].map((m) => m[1]);
check(
  'Vercel /carriers/labels whitelist found',
  whitelistKeys.length > 0,
);
check(
  `DIRECT_LABEL_CARRIERS matches Vercel whitelist (matrix=[${[...DIRECT_LABEL_CARRIERS].sort()}], endpoint=[${[...whitelistKeys].sort()}])`,
  [...DIRECT_LABEL_CARRIERS].sort().join(',') === [...whitelistKeys].sort().join(','),
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
for (const source of ['shopify', 'amazon'] as const) {
  const r = certifyCombo(source, 'ups');
  check(`${source} source (stub): confirmation not_supported, not null`,
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
  /carrierCode: isTest \? testCarrierCode : account\.code/.test(labelPayloadBlock) &&
  /serviceCode: isTest \? testServiceCode : panelForm\.serviceCode/.test(labelPayloadBlock));

// PS-078 req 4 — the "proceed with current operator selection" decision (no
// stale-rate hard block) must stay documented at the label payload, so the
// rationale (safe BECAUSE the charged tuple is the operator's current selection,
// not a saved/cached rate) isn't silently lost or reverted.
check('req-4 "proceed with current operator selection" decision is documented at the label payload',
  /PS-078 req 4 — DECISION[\s\S]{0,400}?proceed with current operator/.test(labelPayloadBlock));

// ── (6) Direct-carrier label must PROCESS the source confirmation in-request ──
// Vercel freezes the function after the response, so a Shipp/UPS/EasyPost label
// on a ShipStation- or eBay-sourced order must process the confirmation outbox
// synchronously (like ShipStation's Render path) — not merely enqueue it — or the
// marketplace is never notified.
check('direct-carrier labels function loads the outbox processor (deferred)',
  /processFulfillmentOutboxOnce = \(await import\('\.\.\/\.\.\/src\/services\/fulfillment\/outbox\.js'\)\)/.test(labelsSrc));
check('direct-carrier labels function defines an in-request confirmation processor',
  /async function processOrderConfirmationNow\(/.test(labelsSrc) && /processFulfillmentOutboxOnce\(\{ orderId/.test(labelsSrc));
check('all 3 direct return paths (shipp / walmart_shipping / ups+easypost) fire confirmation processing',
  (labelsSrc.match(/await processOrderConfirmationNow\(orderId\)/g) ?? []).length >= 3);

// ── (7) Self-healing backstop: the 1-minute outbox worker must stay wired ────
// The direct-carrier label fires confirmation in-request, but the proven safety
// net (delivers + auto-recovers any missed confirmation without manual action)
// is the scheduler tick. Lock it so it can't be silently removed.
const scheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
check('scheduler runs the fulfillment outbox on a 1-minute interval',
  /FULFILLMENT_OUTBOX_INTERVAL_MS\s*=\s*60\s*\*\s*1000/.test(scheduler) &&
  /setInterval\([\s\S]{0,80}?runFulfillmentOutboxTick[\s\S]{0,40}?FULFILLMENT_OUTBOX_INTERVAL_MS/.test(scheduler));
check('outbox tick both auto-recovers missing confirmations AND processes the outbox',
  /enqueueMissingShipmentConfirmations\(\{ limit: 25 \}\)/.test(scheduler) &&
  /processFulfillmentOutboxOnce\(\{ limit: 25 \}\)/.test(scheduler));

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
