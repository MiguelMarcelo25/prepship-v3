/**
 * PS-468 store-scope + PS-467 unattributed-insert guard.
 *
 * Offline/static: pure functions only. No DB, no provider, no postage.
 *
 * NOTE ON SCOPE: this pins the two owners. The assertion that
 * `shipment-sync.ts` actually CONSUMES them is deliberately not here yet --
 * that file writes the `shipments` table and is inside the AGENTS.md/CLAUDE.md
 * lockdown, so its patch needs an explicit `unlock shipped data` override. The
 * consumption pin lands in the same commit as that patch, so this guard is
 * green at every step rather than red while waiting.
 */
import assert from 'node:assert/strict';
import { EXCLUDED_STORE_IDS } from '../src/config/prepship';
import { partitionShipmentsByStoreScope } from '../src/services/shipment-sync-store-scope';
import {
  classifyUnattributedShipment,
  reportUnattributedShipments,
} from '../src/services/shipment-sync-unattributed';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const ship = (shipmentId: number, storeId: number | null | undefined) => ({
  shipmentId,
  advancedOptions: storeId === undefined ? null : { storeId },
});

// ── PS-468: store scope ──────────────────────────────────────────────────────
// The four excluded stores are dead (DJ, 2026-07-29). Every one of them must be
// dropped before any DB write, or its shipments orphan by construction.
const excludedSample = EXCLUDED_STORE_IDS.map((storeId, i) => ship(100 + i, storeId));
const live = [ship(1, 378060), ship(2, 376661), ship(3, 9000001)];

const partitioned = partitionShipmentsByStoreScope([...live, ...excludedSample]);
check(
  'every excluded store is dropped',
  partitioned.excluded.length === EXCLUDED_STORE_IDS.length,
  { excluded: partitioned.excluded.length, expected: EXCLUDED_STORE_IDS.length },
);
check(
  'live stores survive untouched',
  partitioned.inScope.length === live.length
    && partitioned.inScope.every((s) => live.some((l) => l.shipmentId === s.shipmentId)),
);
check(
  'HUGRAB (378060) is never excluded -- it is the active hazmat store',
  partitioned.inScope.some((s) => s.advancedOptions?.storeId === 378060),
);
check(
  'excluded store ids are reported for the summary log',
  partitioned.excludedStoreIds.length === new Set(EXCLUDED_STORE_IDS).size,
);

// Missing storeId must NOT be excluded. Excluding on absent data would silently
// drop live-store shipments whenever the provider omits advancedOptions -- a
// worse failure than the orphan this fixes.
for (const [label, shipment] of [
  ['null advancedOptions', ship(10, undefined)],
  ['null storeId', ship(11, null)],
] as const) {
  const result = partitionShipmentsByStoreScope([shipment]);
  check(`unknown store is treated as IN SCOPE (${label})`, result.inScope.length === 1);
}

check('empty page is safe', partitionShipmentsByStoreScope([]).inScope.length === 0);

// ── PS-467: unattributed classification ──────────────────────────────────────
check('missing order number classifies as blank', classifyUnattributedShipment({}) === 'blank_order_number');
check('empty order number classifies as blank',
  classifyUnattributedShipment({ orderNumber: '' }) === 'blank_order_number');
check('whitespace-only order number classifies as blank',
  classifyUnattributedShipment({ orderNumber: '   ' }) === 'blank_order_number');
check('null order number classifies as blank',
  classifyUnattributedShipment({ orderNumber: null }) === 'blank_order_number');
check('a real order number classifies as not-found',
  classifyUnattributedShipment({ orderNumber: 'SEAuto-QnABbYG3E0uF8mcrkgjWow' }) === 'order_not_found');
check("PrepShip's own operation key is not-found, not blank",
  classifyUnattributedShipment({ orderNumber: 'psop_7ebc4ee9dfe76f327d84245348e3dec2' }) === 'order_not_found');

// The report must stay silent when there is nothing to say, or a healthy sync
// emits a warn line on every page and the signal is worthless.
const logged: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { logged.push(String(args[0])); };
try {
  reportUnattributedShipments([], { account: 'test' });
} finally {
  console.log = originalLog;
}
check('no unattributed rows emits no log line', logged.length === 0, logged);

if (failures > 0) {
  console.error(`\nFAIL PS-467/468 shipment scope guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-467/468 shipment scope guard');
