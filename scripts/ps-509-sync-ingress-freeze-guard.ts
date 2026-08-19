import { readFileSync } from 'node:fs';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
  readFrozenCustomerShippingMoney,
} from '../src/services/customer-shipping-money-snapshot';
import { classifyCustomerShippingMoney } from '../src/services/customer-shipping-money-classification';

/**
 * PS-509 — the sync-ingress customer-money freeze.
 *
 * Everything provable by execution runs OFFLINE against the pure snapshot/classifier
 * modules (no database, no env — the PS-488 lane rule). Everything else is pinned against
 * source text, scoped to a single function body: a file-wide presence check silently
 * transfers its evidence to any newly added identical line elsewhere (five separate times
 * in PS-502), so every regex below is anchored inside the one construct it pins.
 */

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function functionBody(source: string, name: string): string {
  const needles = [
    `export async function ${name}(`,
    `export function ${name}(`,
    `async function ${name}(`,
    `function ${name}(`,
  ];
  const start = needles
    .map((needle) => source.indexOf(needle))
    .filter((n) => n !== -1)
    .reduce((best, n) => (best === -1 ? n : Math.min(best, n)), -1);
  if (start === -1) {
    throw new Error(`functionBody: ${name} not found — the check would silently pass on empty text`);
  }
  const boundary = /\n(?:export )?(?:async )?(?:function|const|type|let) /g;
  boundary.lastIndex = start + 1;
  const next = boundary.exec(source);
  return next ? source.slice(start, next.index) : source.slice(start);
}

// ── 1. THE TUPLE CONTRACT (behavioural, offline) ──────────────────────────────────────────

const v509 = {
  selectedRateCost: 10,
  cShippingRateAmount: 12,
  shippingMarginAmount: 2,
  shippingMarginPct: 16.7,
  rateCostSource: 'shipstation_sync_receipt_cost',
  customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion',
  customerRateSource: 'carrier_markup_customer_shipping_rate',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
  billingDescriptionSuffix: ' (20%)',
};
const v437 = {
  selectedRateCost: 10,
  cShippingRateAmount: 12,
  shippingMarginAmount: 2,
  shippingMarginPct: 16.7,
  rateCostSource: 'label_final_cost',
  customerRateSource: 'realized_customer_shipping_rate',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
};
const ALL = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;

check('the three policy versions are DISTINCT values (added, never edited)',
  new Set<string>(ALL).size === 3
  && CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION === 'ps-509-v1'
  && CUSTOMER_SHIPPING_MONEY_POLICY_VERSION === 'ps-437-v1'
  && CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND === 'ps-508-v1',
  JSON.stringify(ALL));

check('STAGING: a v509 tuple is INVISIBLE to the default (ps-437-only) reader',
  readFrozenCustomerShippingMoney(v509) === null);

check('a v509 tuple reads only under explicit acceptance, and returns the version it READ',
  readFrozenCustomerShippingMoney(v509, { accept: ALL })?.customerShippingMoneyPolicyVersion
    === CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION);

check('v509 REQUIRES the capture source (absent -> malformed, never normalized)',
  (() => {
    const { customerShippingMoneyCaptureSource: _omitted, ...rest } = v509;
    return readFrozenCustomerShippingMoney(rest, { accept: ALL }) === null
      && classifyCustomerShippingMoney(rest).kind === 'malformed_known_version';
  })());

check('v509 REQUIRES the sync receipt-cost source (label_final_cost -> malformed)',
  readFrozenCustomerShippingMoney(
    { ...v509, rateCostSource: 'label_final_cost' }, { accept: ALL }) === null);

check('v509 refuses house money (this ingress can never produce it)',
  readFrozenCustomerShippingMoney(
    { ...v509, customerRateSource: 'house_next_best_customer_rate' }, { accept: ALL }) === null);

check('v509 refuses the purchase-path realized formula (provenance is version-owned)',
  readFrozenCustomerShippingMoney(
    { ...v509, customerRateSource: 'realized_customer_shipping_rate' }, { accept: ALL }) === null);

check('v509 admits the HUGRAB override provenance',
  readFrozenCustomerShippingMoney(
    { ...v509, customerRateSource: 'hugrab_shipping_rate_override' }, { accept: ALL }) != null);

check('v437 keeps historical optionality — reads exactly as before',
  readFrozenCustomerShippingMoney(v437)?.cShippingRateAmount === 12);

check('UNKNOWN COMBINATION: a v437 tuple carrying a capture source is malformed, never normalized',
  readFrozenCustomerShippingMoney(
    { ...v437, customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion' }) === null
  && classifyCustomerShippingMoney(
    { ...v437, customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion' },
  ).kind === 'malformed_known_version');

check('UNKNOWN COMBINATION: a v437 tuple claiming the sync formula is malformed',
  readFrozenCustomerShippingMoney(
    { ...v437, customerRateSource: 'carrier_markup_customer_shipping_rate' }) === null);

check('the classifier reports valid_ps509 as its own kind',
  classifyCustomerShippingMoney(v509).kind === 'valid_ps509');

check('the classifier explains a v509 capture-source violation in version-aware terms',
  (() => {
    const { customerShippingMoneyCaptureSource: _omitted, ...rest } = v509;
    const c = classifyCustomerShippingMoney(rest);
    return c.kind === 'malformed_known_version' && /shipstation_sync_ingestion/.test(c.reason);
  })());

check('the v509 capture source round-trips, and v437 does not gain one',
  readFrozenCustomerShippingMoney(v509, { accept: ALL })?.customerShippingMoneyCaptureSource
    === 'shipstation_sync_ingestion'
  && !('customerShippingMoneyCaptureSource'
    in (readFrozenCustomerShippingMoney(v437) as object)));

// ── 2. THE CANONICAL WRITER (structural, function-scoped) ─────────────────────────────────

const ingressSrc = readFileSync('src/services/customer-shipping-money-sync-ingress.ts', 'utf8');
const freezeBody = stripComments(functionBody(ingressSrc, 'freezeSyncIngressCustomerShippingMoney'));

check('the writer stamps the SYNC-INGESTION version, capture source and receipt-cost basis',
  /customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION/.test(freezeBody)
  && /customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion'/.test(freezeBody)
  && /rateCostSource: 'shipstation_sync_receipt_cost'/.test(freezeBody));

check('the carrier-markup formula is provenance-mapped, and house provenance THROWS',
  /customerRateSource = 'carrier_markup_customer_shipping_rate'/.test(freezeBody)
  && /impossible provenance/.test(freezeBody));

// The house input must never be supplied: passing cShippingRateAmount is what SELECTS
// billing's house branch, and this ingress is house-never by contract.
{
  const decideStart = freezeBody.indexOf('decideCustomerShippingMoneyForRow(');
  const decideEnd = freezeBody.indexOf(');', decideStart);
  const decideCall = decideStart === -1 ? '' : freezeBody.slice(decideStart, decideEnd);
  check('the policy decision never supplies the house input (cShippingRateAmount)',
    decideStart !== -1 && !/cShippingRateAmount/.test(decideCall),
    decideCall.replace(/\s+/g, ' ').slice(0, 120));
}

check('the freeze is one-shot (key-presence predicate, never re-decides a versioned tuple)',
  /not \(coalesce\(/.test(freezeBody) && /customerShippingMoneyPolicyVersion'\)/.test(freezeBody));

check('the tuple carries the billing description suffix (line identity, not just amount)',
  /billingDescriptionSuffix: decision\.billingDescriptionSuffix/.test(freezeBody));

check('a tuple that does not read back THROWS (aborts) instead of returning review on a fresh insert',
  /did not read back/.test(freezeBody)
  && /throw new Error\([\s\S]{0,120}?did not read back/.test(freezeBody));

check('classification runs FIRST so replay reports frozen money and never re-decides it',
  freezeBody.indexOf('classifyCustomerShippingMoney(row.selectedRateJson)')
    < freezeBody.indexOf("skip('voided')")
  && /alreadyFrozen: true/.test(freezeBody));

check('malformed and unknown snapshots persist needs_review and never reach a write',
  /'malformed_known_version'/.test(freezeBody)
  && /'unknown_version'/.test(freezeBody)
  && freezeBody.indexOf("failureClassification: 'malformed_known_version'")
    < freezeBody.indexOf('.update(shipments)'));

// The durable-outcome writer never touches customer money: outcomes carry classification
// only, so a skip can never smuggle a money fact past the version-keyed reader.
const persistBody = stripComments(functionBody(ingressSrc, 'persistSyncIngressOutcome'));
check('the outcome writer never writes shipments or selected_rate_json',
  !/\.update\(shipments\)/.test(persistBody) && !/selectedRateJson/.test(persistBody)
  && /onConflictDoUpdate/.test(persistBody));

// ── 3. THE INSERT BOUNDARY (structural): freeze inside the tx, NO savepoint, NO catch ─────

const syncSrc = readFileSync('src/services/shipment-sync.ts', 'utf8');
const upsertBody = stripComments(functionBody(syncSrc, 'upsertShipmentsBatch'));

check('the INSERT boundary gates on migration-0103 readiness before any insert',
  /if \(toInsert\.length\) await ensureCustomerShippingMoneySyncSchema\(\);/.test(upsertBody));

{
  const txStart = upsertBody.indexOf('await db.transaction(async (tx) => {');
  const txEnd = upsertBody.indexOf('inserted += insertedRows.length');
  const txSlice = txStart !== -1 && txEnd > txStart ? upsertBody.slice(txStart, txEnd) : '';
  check('the freeze runs INSIDE the insert transaction, driven off insertedRows',
    txSlice.includes('for (const row of insertedRows)')
    && /freezeSyncIngressCustomerShippingMoney\(row\.id, \{\s*boundary: 'sync_insert',\s*exec: tx,/.test(txSlice),
    txSlice ? undefined : 'could not isolate the insert transaction');
  // THE REVERSED RULE. PS-508 savepoints; PS-509 must NOT: a savepoint commits the row
  // tuple-less, the UPDATE path never freezes, and the gap is permanent. No try/catch and
  // no nested transaction may exist anywhere in the insert transaction body.
  check('NO savepoint and NO try/catch anywhere in the insert transaction (failure ABORTS)',
    txSlice !== '' && !/\btry\s*\{/.test(txSlice)
    && (txSlice.match(/\.transaction\(/g) ?? []).length === 1,
    txSlice ? undefined : 'could not isolate the insert transaction');
}

// The correction hazard: sync UPDATE writes cost but must never write customer money.
const shipmentValuesBody = stripComments(functionBody(syncSrc, 'shipmentValues'));
check('CLOBBER GUARD: shipmentValues never writes selectedRateJson or selectedRateCost',
  !/selectedRateJson/.test(shipmentValuesBody) && !/selectedRateCost/.test(shipmentValuesBody));

{
  const preserveStart = upsertBody.indexOf('if (existing !== undefined)');
  const preserveEnd = upsertBody.indexOf('toUpdate.push(');
  const preserveSlice = preserveStart !== -1 && preserveEnd > preserveStart
    ? upsertBody.slice(preserveStart, preserveEnd)
    : '';
  check('CLOBBER GUARD: the UPDATE-branch preservation never touches selected rate fields',
    preserveSlice !== '' && !/selectedRate/.test(preserveSlice),
    preserveSlice ? undefined : 'could not isolate the update-preservation branch');
}

check('receipt-revision detection runs against every UPDATE batch',
  /detectReceiptRevisionsAfterFreeze\(toUpdate\.map\(\(u\) => u\.id\)\)/.test(upsertBody));

const syncShipmentsBody = stripComments(functionBody(syncSrc, 'syncShipments'));
check('the retry sweep runs once per sync run',
  /sweepSyncIngressFreezeRetries\(\)/.test(syncShipmentsBody));

// ── 4. THE LINK BOUNDARY (structural): link and freeze commit together ────────────────────

const orderSyncSrc = readFileSync('src/services/order-sync.ts', 'utf8');
const hydrateStart = orderSyncSrc.indexOf('let shipmentsLinked = 0;');
const hydrateEnd = orderSyncSrc.indexOf('return insertedRows.length;');
const hydrateSlice = hydrateStart !== -1 && hydrateEnd > hydrateStart
  ? stripComments(orderSyncSrc.slice(hydrateStart, hydrateEnd))
  : '';

check('the orphan link and its freeze share ONE transaction',
  hydrateSlice.includes('await db.transaction(async (tx) => {')
  && /\.update\(shipments\)/.test(hydrateSlice)
  && /freezeSyncIngressCustomerShippingMoney\(shipment\.id, \{\s*boundary: 'orphan_link',\s*exec: tx,/.test(hydrateSlice),
  hydrateSlice ? undefined : 'could not isolate the hydrate link region');

check('a failed link+freeze records the late_attributed failure classification durably',
  /recordSyncIngressFreezeRetry\(candidate\.id, \{/.test(hydrateSlice)
  && /failureClassification: 'late_attributed'/.test(hydrateSlice));

check('a lagging migration defers the link rather than linking without freezing',
  /linkFreezeReady = false/.test(hydrateSlice)
  && /if \(!linkFreezeReady\) continue;/.test(hydrateSlice));

// The link update inside the transaction must still be predicate-guarded on the orphan
// state, so a concurrent linker cannot double-link.
check('the transactional link keeps the isNull(orderId) predicate',
  /isNull\(shipments\.orderId\)/.test(hydrateSlice));

// ── 5. THE PACK: these guards must actually gate deploys ──────────────────────────────────

const pack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');
check('both PS-509 guards are wired into the mandatory SOT guard pack',
  pack.includes("'test:ps-509-sync-ingress-freeze'")
  && pack.includes("'test:ps-509-sync-ingress-freeze-integration'"));

if (failures > 0) {
  console.log(`\nFAIL PS-509 sync-ingress freeze guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPS-509 sync-ingress freeze guard passed.');
