/**
 * PS-225 guard — superseded packaging/label code stays deleted, and the
 * architecture invariant it carried is re-anchored onto the LIVE owner.
 *
 * Per user override unlock shipped data on 2026-06-13. PS-209 retired the legacy
 * label endpoint to a 410, which orphaned src/services/direct-label-persistence.ts
 * (persistDirectCarrierLabel — zero callers). The caller-trace confirmed every
 * other PS-225 candidate was already removed by earlier tickets (the OrdersView
 * /products/by-sku fallback + deriveShipmentDimsFromProductDefaults by PS-178; the
 * billing.ts package cascade by PS-207) or never existed (the ±0.15" tolerance).
 *
 * This guard pins the deletion so the dead path cannot be resurrected, and proves
 * the shipped-data protection was NOT weakened: connector-architecture-guard now
 * asserts the canonical shipment provider-lineage columns against their live
 * owners (labels.ts + fulfillment/outbox.ts) instead of the deleted file.
 *
 *   npx tsx scripts/ps-225-superseded-packaging-removed-guard.ts
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// 1. The dead file is gone (and stays gone).
check('src/services/direct-label-persistence.ts is deleted',
  !existsSync('src/services/direct-label-persistence.ts'));

// 2. No live code calls persistDirectCarrierLabel. The ONLY allowed mentions are
//    defensive guards that BAN it (ps-209 legacy-stub guard, vercel-import guard)
//    and this guard's own prose — never a call shape in a real source file.
const liveOwners = [
  'src/services/labels.ts',
  'api/carriers/labels.ts',
  'api/carriers/rates.ts',
  'src/routes/print-queue.ts',
  'src/services/print-queue.ts',
  'src/services/fulfillment/outbox.ts',
];
for (const file of liveOwners) {
  check(`${file} does not call persistDirectCarrierLabel`,
    !/persistDirectCarrierLabel\s*\(/.test(read(file)));
}

// 3. The PS-205 final part stays deleted in OrdersView (PS-178 removed it).
const ordersView = read('web/src/components/Views/OrdersView.tsx');
check('OrdersView has no live deriveShipmentDimsFromProductDefaults call',
  !/deriveShipmentDimsFromProductDefaults\s*\(/.test(ordersView));

// 4. The architecture invariant is re-anchored onto the LIVE owners, not the
//    deleted file — shipped-data protection preserved, not weakened.
const archGuard = read('scripts/connector-architecture-guard.mjs');
check('architecture guard no longer reads the deleted persistence file',
  !archGuard.includes("read('src/services/direct-label-persistence.ts')"));
check('architecture guard re-anchored onto labels.ts (live direct-label owner)',
  archGuard.includes("read('src/services/labels.ts')")
  && /labelsService\.includes\(field\)/.test(archGuard));
check('architecture guard still pins confirmation_status on the live outbox owner',
  /fulfillmentOutbox\.includes\('confirmation_status'\)/.test(archGuard));
check('architecture guard documents label_provider_key as a dead column',
  archGuard.includes('label_provider_key has NO live writer'));

// 5. The live label package resolver (PS-221) is intact — this cleanup did not
//    touch the resolution source of truth.
const labels = read('src/services/labels.ts');
check('labels.ts still delegates to the unified resolver (PS-221 intact)',
  labels.includes('return resolveOrderLabelPackageId(args)'));

// Self-wiring.
const pkg = read('package.json');
check('package.json wires test:ps-225-superseded-packaging-removed',
  /test:ps-225-superseded-packaging-removed/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-225 superseded-packaging-removed guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-225 superseded-packaging-removed guard');
