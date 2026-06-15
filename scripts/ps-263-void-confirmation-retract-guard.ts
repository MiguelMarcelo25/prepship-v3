/**
 * PS-263 guard — voiding a label retracts its marketplace confirmation.
 *
 * Before this, voidLabelV2 voided the carrier label and reset the order to
 * awaiting_shipment but NEVER touched fulfillment_outbox or shipments.confirmation_status.
 * A still-pending confirmation could then fire after the void (acking the marketplace with
 * the dead/voided tracking), and a re-labeled order enqueued a SECOND confirmation with a
 * different number. cancelShipmentConfirmationsForVoid is the single owner that stops the
 * pending sends and stamps the shipment lifecycle; voidLabelV2 calls it best-effort.
 *
 * This statically pins the owner, the unclaimable-after-cancel invariant, the lifecycle
 * stamp, the void-path wiring, and the PS-211 single-void-write invariant. The behavioral
 * DB test (real outbox rows cancelled / shipment stamped) is gated on DJ's canary.
 *
 *   npx tsx scripts/ps-263-void-confirmation-retract-guard.ts
 */
import { readFileSync } from 'node:fs';
import { cancelShipmentConfirmationsForVoid } from '../src/services/fulfillment/outbox';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── Owner exists & is exported ───────────────────────────────────────────────
check('cancelShipmentConfirmationsForVoid is exported', typeof cancelShipmentConfirmationsForVoid === 'function');

const outbox = read('src/services/fulfillment/outbox.ts');

// ── Cancels every NOT-yet-succeeded confirmation for the order/shipment ───────
check('cites the 2026-06-14 override',
  outbox.includes('Per user override unlock shipped data on 2026-06-14'));
check('targets only shipment_confirmation_requested rows',
  /cancelShipmentConfirmationsForVoid[\s\S]*event_type = 'shipment_confirmation_requested'/.test(outbox));
check('flips pending sends to status=cancelled',
  /SET status = 'cancelled', next_run_at = 'infinity'/.test(outbox));
check('NEVER touches a succeeded row (confirmation history preserved)',
  /cancelShipmentConfirmationsForVoid[\s\S]*status <> 'succeeded'/.test(outbox));

// ── Unclaimable-after-cancel invariant: the claimers only take pending/failed ─
const claimMatches = outbox.match(/status IN \('pending', 'failed'\)/g) ?? [];
check('both claimers gate on status IN (pending, failed) — a cancelled row can never fire',
  claimMatches.length >= 2);

// ── Lifecycle stamp on the voided shipment ───────────────────────────────────
check('already-confirmed shipment is stamped void_retract_pending',
  outbox.includes("'void_retract_pending'"));
check('not-yet-confirmed shipment is stamped cancelled (and both keep the IS NULL recovery sweep off it)',
  /UPDATE shipments[\s\S]*SET confirmation_status = \$\{alreadyConfirmed \? 'void_retract_pending' : 'cancelled'\}/.test(outbox));
check('alreadyConfirmed read from THIS shipment (succeeded or marketplace_confirmed_at)',
  /alreadyConfirmed[\s\S]*confirmation_status === 'succeeded'/.test(outbox)
  && outbox.includes('marketplace_confirmed_at'));

// ── Recovery sweep still requires confirmation_status IS NULL ─────────────────
// (so a stamped, voided shipment is never re-enqueued by the missing-confirmation backfill)
check('missing-confirmation recovery still filters confirmation_status IS NULL',
  /s\.confirmation_status IS NULL/.test(outbox));

// ── voidLabelV2 wiring ───────────────────────────────────────────────────────
const labels = read('src/services/labels.ts');
check('labels.ts imports cancelShipmentConfirmationsForVoid', labels.includes('cancelShipmentConfirmationsForVoid'));
check('voidLabelV2 calls the retract owner', /await cancelShipmentConfirmationsForVoid\(\{/.test(labels));
check('retract is best-effort (wrapped in try/catch, never thrown)',
  /try \{\s*await cancelShipmentConfirmationsForVoid[\s\S]*\} catch \(retractErr\)/.test(labels));

// Order matters: the retract must run AFTER the local void write (provider void already
// succeeded by then) — never before, so a failed provider void can't retract a live ack.
const voidWriteIdx = labels.indexOf('.set({ voided: true, updatedAt: now })');
const retractIdx = labels.indexOf('await cancelShipmentConfirmationsForVoid({');
check('retract runs AFTER the local void write', voidWriteIdx > -1 && retractIdx > voidWriteIdx);

// ── PS-211 single-void-write invariant preserved (retract adds NO voided write) ─
const voidWrites = (labels.match(/\.set\(\{ voided: true/g) ?? []).length;
check('PS-211 invariant: exactly one voided:true write remains in labels.ts', voidWrites === 1);

const pkg = read('package.json');
check('package.json wires test:ps-263-void-confirmation-retract',
  /test:ps-263-void-confirmation-retract/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-263 void-confirmation-retract guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-263 void-confirmation-retract guard');
