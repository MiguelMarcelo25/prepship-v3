/**
 * PS-243 guard — direct-label local shipment id can never be a provider id.
 *
 * shipments.labelShipmentId is integer() and means "ShipStation shipment id".
 * A direct provider id (Walmart 382006979895) overflowed it → INSERT failed
 * ("out of range for type integer"), breaking Print to Queue / Create Label for
 * all Walmart/direct labels. The direct path now ALWAYS synthesizes a negative,
 * int4-safe, collision-proof local id (resolveDirectLabelShipmentRef) and keeps
 * the provider id in labelId. This guard pins that invariant across the exact
 * problem inputs + many random draws, and that the schema was NOT widened to bigint.
 *
 *   npx tsx scripts/ps-243-direct-label-shipment-id-namespace-guard.ts
 */
import { readFileSync } from 'node:fs';
import { resolveDirectLabelShipmentRef } from '../src/services/direct-label-shipment-id';

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// The exact cases the ticket requires: overflow, collision-fit, non-numeric, null.
const cases: Array<{ label: string; providerShipmentId: string | null }> = [
  { label: 'overflow (Walmart 382006979895)', providerShipmentId: '382006979895' },
  { label: 'collision-fit (50000000)', providerShipmentId: '50000000' },
  { label: 'non-numeric string', providerShipmentId: 'wmt-abc-123' },
  { label: 'null', providerShipmentId: null },
];

for (const c of cases) {
  const r = resolveDirectLabelShipmentRef({
    providerShipmentId: c.providerShipmentId,
    providerLabelId: null,
    fallbackLabelId: 'walmart_shipping-1Z999',
  });
  check(`${c.label}: shipmentId is negative/synthetic`, r.shipmentId < 0);
  check(`${c.label}: shipmentId is an integer`, Number.isInteger(r.shipmentId));
  check(`${c.label}: shipmentId is int4-safe`, r.shipmentId >= INT4_MIN && r.shipmentId <= INT4_MAX);
  check(`${c.label}: shipmentId is NOT the provider id`,
    c.providerShipmentId == null || r.shipmentId !== Number(c.providerShipmentId));
  // Provider id is preserved in labelId (falls back to provider shipment id when no labelId).
  const expectedLabelId = c.providerShipmentId ?? 'walmart_shipping-1Z999';
  check(`${c.label}: provider id preserved in labelId`, r.labelId === expectedLabelId);
}

// A separate provider labelId wins for labelId (and shipmentId still synthetic).
const withLabelId = resolveDirectLabelShipmentRef({
  providerShipmentId: '382006979895', providerLabelId: 'WMT-LABEL-9', fallbackLabelId: 'x-y',
});
check('explicit provider labelId is kept', withLabelId.labelId === 'WMT-LABEL-9' && withLabelId.shipmentId < 0);

// Random-draw invariant: never positive, always int4-safe (generateFakeShipmentId is random).
let allNegInt4 = true;
for (let i = 0; i < 5000; i += 1) {
  const r = resolveDirectLabelShipmentRef({ providerShipmentId: '382006979895', providerLabelId: null, fallbackLabelId: 'x' });
  if (!(r.shipmentId < 0 && r.shipmentId >= INT4_MIN && Number.isInteger(r.shipmentId))) { allNegInt4 = false; break; }
}
check('5000 draws: every synthetic id is negative + int4-safe', allNegInt4);

// Static: the direct path uses the helper and dropped the provider-id adoption.
const direct = read('src/services/labels-direct.ts');
check('labels-direct.ts uses resolveDirectLabelShipmentRef', direct.includes('resolveDirectLabelShipmentRef('));
check('labels-direct.ts no longer adopts the provider numeric id',
  !/numericShipmentId\s*>\s*0/.test(direct) && !/Math\.trunc\(numericShipmentId\)/.test(direct));

// Static: schema NOT widened to bigint (the column means "ShipStation shipment id").
const schema = read('src/db/schema/shipments.ts');
check('labelShipmentId stays integer() (not widened to bigint)',
  /labelShipmentId:\s*integer\(/.test(schema) && !/labelShipmentId:\s*bigint\(/.test(schema));

const pkg = read('package.json');
check('package.json wires test:ps-243-direct-label-shipment-id-namespace',
  /test:ps-243-direct-label-shipment-id-namespace/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-243 direct-label shipment-id namespace guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-243 direct-label shipment-id namespace guard');
