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
  /confirmShipmentDirectNow\(/.test(markExt) && !DISPATCH_CALL.test(markExt));

check('package.json wires test:ps-285-marketplace-confirm-boundary',
  /test:ps-285-marketplace-confirm-boundary/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-285 marketplace-confirm boundary guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-285 marketplace-confirm boundary guard');
