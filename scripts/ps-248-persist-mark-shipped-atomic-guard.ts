/**
 * PS-248 (Card 3, slice 2) — label persist + mark-shipped commit atomically.
 *
 * createLabelV2 used to persist the shipment row and then flip the order to 'shipped' as TWO separate
 * DB calls; a crash between them orphaned a shipment while the order stayed awaiting (torn state). Now
 * both run inside ONE db.transaction (the tx threaded through persistCreatedLabel + lifecycle command),
 * so a mid-commit failure rolls back cleanly. The external label buy already happened upstream, so the
 * transaction is DB-only + short.
 *
 *   npx tsx scripts/ps-248-persist-mark-shipped-atomic-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const labels = readFileSync('src/services/labels.ts', 'utf8');

check('persistCreatedLabel accepts a tx handle', /tx\?: DbTx;/.test(labels));
check('persistCreatedLabel runs the shipment insert on the tx executor (not the bare pool)',
  /const exec = \(args\.tx \?\? db\) as DbTx;/.test(labels) &&
  /const \[row\] = await exec\s*\.insert\(shipments\)/.test(labels));
check('the label flow persists + applies lifecycle inside ONE db.transaction',
  /const localShipmentId = await db\.transaction\(async \(tx\) =>/.test(labels));
check('persistCreatedLabel is invoked WITH the tx inside that transaction',
  /insuredValue: options\.insuredValue,\s*tx,/.test(labels));
check('canonical lifecycle command is invoked WITH the tx and persisted shipment id',
  /applyOrderLifecycleCommandInTransaction\(tx, \{[\s\S]*shipmentId,[\s\S]*transition: 'shipped'/.test(labels));

check('package.json wires test:ps-248-persist-mark-shipped-atomic',
  /test:ps-248-persist-mark-shipped-atomic/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-248 persist+mark-shipped atomic guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-248 persist+mark-shipped atomic guard');
