/**
 * PS-285 (phase 8) — marketplace confirmation is OUTBOX-ONLY.
 *
 * connector.confirmShipment(...) is the money-path step that tells a marketplace (Walmart / eBay /
 * Amazon / Shopify) an order shipped. It MUST flow only through the canonical owner
 * (src/services/fulfillment/outbox.ts — processOutboxRow + confirmShipmentDirectNow) and the connector
 * RESOLVER (src/services/store-connector-orchestrator.ts). A dispatch from anywhere else would bypass
 * the idempotency + retract + dedupe guards that make confirmation safe (PS-253 idempotent confirm +
 * lease reclaim, PS-263 void-retract, the dedupe_key on enqueue) and risk a DOUBLE or ZOMBIE
 * confirmation. PS-253 already consolidated this; this static guard REGRESSION-PROOFS it.
 *
 * STATIC ARCHITECTURE GUARD (PS-270 pattern). It changes no runtime behavior and sends no
 * notification — it only fails the build if a NEW marketplace-confirm dispatch appears outside the
 * canonical owner.
 *
 * It also hardens two adjacent confirm legs (added 2026-06-17):
 *  - confirmStoreShipment (the connector resolve+dispatch wrapper) must have ZERO callers outside its
 *    own file. After PS-209 retired api/carriers/labels.ts to a 410 stub, its old direct-label Walmart
 *    confirm via this wrapper is gone, leaving no live caller; a new one would be a second dispatch path.
 *  - ssMarkOrderShippedV1 (the ShipStation relay leg) call sites are pinned to exactly three owners
 *    (the ShipStation store connector, mark-shipped-externally, and the admin retry route); a new call
 *    site means a new place asking ShipStation to notify a marketplace.
 *
 *   npx tsx scripts/ps-285-marketplace-confirm-boundary-guard.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// The ONLY files allowed to dispatch connector.confirmShipment: the canonical outbox owner + the
// connector resolve+dispatch wrapper it delegates to.
const ALLOWED_DISPATCH = new Set([
  'src/services/fulfillment/outbox.ts',
  'src/services/store-connector-orchestrator.ts',
]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) { if (name !== 'node_modules') out.push(...walkTs(full)); }
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// A CALL to .confirmShipment( — not a method definition (`async confirmShipment(`) or interface type.
const DISPATCH_CALL = /\.confirmShipment\(/;
const offenders: string[] = [];
for (const file of [...walkTs('src'), ...walkTs('api')]) {
  const rel = file.replace(/\\/g, '/');
  if (!DISPATCH_CALL.test(readFileSync(file, 'utf8'))) continue;
  if (!ALLOWED_DISPATCH.has(rel)) offenders.push(rel);
}
check('connector.confirmShipment is dispatched ONLY from the canonical outbox owner + resolver', offenders.length === 0);
if (offenders.length) console.error('  unexpected marketplace-confirm dispatch sites:', offenders.join(', '));

const outbox = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
check('the single enqueue entry point exists (enqueueShipmentConfirmation)',
  /export async function enqueueShipmentConfirmation\(/.test(outbox));
check('the direct/external-marked confirmation entry is defined in the owner (confirmShipmentDirectNow)',
  /export async function confirmShipmentDirectNow\(/.test(outbox));
check('the owner keeps the pre-dispatch idempotency guard (already-confirmed -> settle, no re-notify)',
  /marketplace_confirmed_at/.test(outbox) && /confirmation_status/.test(outbox));
check('the void-retract owner stops pending confirmations (PS-263, no zombie confirm)',
  /cancelShipmentConfirmationsForVoid/.test(outbox));

// The operator non-label external path delegates to the OWNER, never a raw connector dispatch.
const markExt = readFileSync('src/services/fulfillment/mark-shipped-externally.ts', 'utf8');
check('mark-shipped-externally delegates to the owner confirmShipmentDirectNow (not a raw dispatch)',
  /const confirmDirect = dependencies\.confirmDirect \?\? confirmShipmentDirectNow;/.test(markExt) &&
  /notify = await confirmDirect\(\{/.test(markExt) &&
  !DISPATCH_CALL.test(markExt));

// confirmStoreShipment is the connector RESOLVE+DISPATCH wrapper. It must be reachable only from its
// own file. After PS-209 retired api/carriers/labels.ts to a 410 stub (its old direct-label immediate
// Walmart confirm via confirmStoreShipment is GONE), the wrapper has no live caller — the canonical
// outbox owner dispatches connector.confirmShipment directly. A NEW external caller would resurrect a
// second marketplace-confirm dispatch path outside the outbox idempotency/retract guards. FAIL on one.
const CONFIRM_STORE_WRAPPER_CALL = /confirmStoreShipment\(/;
const confirmStoreCallers: string[] = [];
for (const file of [...walkTs('src'), ...walkTs('api')]) {
  const rel = file.replace(/\\/g, '/');
  if (rel === 'src/services/store-connector-orchestrator.ts') continue; // the file that DEFINES it
  if (CONFIRM_STORE_WRAPPER_CALL.test(readFileSync(file, 'utf8'))) confirmStoreCallers.push(rel);
}
check('confirmStoreShipment wrapper has ZERO callers outside its own file (no second confirm path)',
  confirmStoreCallers.length === 0);
if (confirmStoreCallers.length) console.error('  unexpected confirmStoreShipment callers:', confirmStoreCallers.join(', '));

// ssMarkOrderShippedV1 is the ShipStation V1 "mark shipped -> ShipStation relays to the marketplace"
// call. It is the ShipStation relay leg of marketplace confirmation. Pin its CALL sites (not the
// definition, not imports) within src/+api/ to exactly the three allowed owners. A NEW call site means
// a new place asking ShipStation to notify a marketplace, outside the audited confirm/recover surfaces.
const SS_RELAY_CALL = /ssMarkOrderShippedV1\(/;
const ALLOWED_SS_RELAY = new Set([
  'src/connectors/store/shipstation.ts',
  'src/services/fulfillment/mark-shipped-externally.ts',
  'src/routes/admin.ts',
]);
const ssRelayDefiner = 'src/lib/shipstation/labels.ts'; // exports the function; not a call site
const ssRelayOffenders: string[] = [];
for (const file of [...walkTs('src'), ...walkTs('api')]) {
  const rel = file.replace(/\\/g, '/');
  if (rel === ssRelayDefiner) continue; // the low-level wrapper that DEFINES it
  if (!SS_RELAY_CALL.test(readFileSync(file, 'utf8'))) continue;
  if (!ALLOWED_SS_RELAY.has(rel)) ssRelayOffenders.push(rel);
}
check('ssMarkOrderShippedV1 relay call sites are pinned to exactly the 3 allowed owners',
  ssRelayOffenders.length === 0);
if (ssRelayOffenders.length) console.error('  unexpected ssMarkOrderShippedV1 call sites:', ssRelayOffenders.join(', '));

check('package.json wires test:ps-285-marketplace-confirm-boundary',
  /test:ps-285-marketplace-confirm-boundary/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-285 marketplace-confirm boundary guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-285 marketplace-confirm boundary guard');
