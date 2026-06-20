/**
 * PS-289 closeout checkpoint.
 *
 * Keeps the multi-package card honest after the planner + sidecar schema
 * foundation: workflow/UI/live-safety proof is still missing.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const packageJson = readFileSync('package.json', 'utf8');
const doc = readFileSync('docs/ps-tickets/ps-289-multi-package-status.md', 'utf8');
const planner = readFileSync('src/services/shipping-workflow/multi-package-shipment-plan.ts', 'utf8');
const schema = readFileSync('src/db/schema/shipment-groups.ts', 'utf8');
const mockFlow = readFileSync('src/services/shipping-workflow/multi-package-mock-label-flow.ts', 'utf8');
const orchestration = readFileSync('src/services/shipping-workflow/multi-package-mock-label-orchestration.ts', 'utf8');
const printQueuePlan = readFileSync('src/services/shipping-workflow/multi-package-print-queue-plan.ts', 'utf8');
const sourceGuard = readFileSync('scripts/ps-289-multi-package-shipment-plan-guard.ts', 'utf8');

check('package wires PS-289 planner guard',
  packageJson.includes('"test:ps-289-multi-package-plan"'));
check('package wires PS-289 schema guard',
  packageJson.includes('"test:ps-289-multi-package-schema"'));
check('package wires PS-289 mocked label flow guard',
  packageJson.includes('"test:ps-289-multi-package-mock-label-flow"'));
check('package wires PS-289 DB orchestration guard',
  packageJson.includes('"test:ps-289-multi-package-db-orchestration"'));
check('package wires PS-289 print queue plan guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-plan"'));
check('package wires PS-289 closeout guard',
  packageJson.includes('"test:ps-289-multi-package-closeout"'));
check('status doc lists planner guard',
  doc.includes('`test:ps-289-multi-package-plan`'));
check('status doc lists schema guard',
  doc.includes('`test:ps-289-multi-package-schema`'));
check('status doc lists mocked label flow guard',
  doc.includes('`test:ps-289-multi-package-mock-label-flow`'));
check('status doc lists DB orchestration guard',
  doc.includes('`test:ps-289-multi-package-db-orchestration`'));
check('status doc lists print queue plan guard',
  doc.includes('`test:ps-289-multi-package-print-queue-plan`'));
check('status doc lists closeout guard',
  doc.includes('`test:ps-289-multi-package-closeout`'));
check('status doc keeps PS-289 conservative at 51%',
  /PS-289 51%/.test(doc));
check('status doc explicitly blocks Final Review',
  /not Final Review-ready/.test(doc));
check('status doc says sidecar persistence foundation exists',
  /additive persistence\s+foundation, mocked/.test(doc));
check('status doc says mocked per-package label identity exists',
  /mocked per-package label identity workflow, and/.test(doc));
check('status doc says DB-backed mocked orchestration exists',
  /DB-backed mocked status orchestration\s+exist/.test(doc));
check('status doc says group-aware print queue planning exists',
  /Group-aware print queue planning also exists/.test(doc));
check('status doc lists real per-package purchase as missing',
  /Real idempotent per-package label purchase workflow/.test(doc));
check('status doc lists print queue persistence as missing',
  /print queue persistence\/integration/.test(doc));
check('status doc lists marketplace confirmation planner as missing',
  /Marketplace confirmation planner/.test(doc));
check('status doc requires mocked workflow before live postage',
  /End-to-end mocked workflow proof before any live postage/.test(doc));

check('planner exports buildMultiPackageShipmentPlan',
  /export function buildMultiPackageShipmentPlan/.test(planner));
check('planner exports multiPackageLabelIdempotencyKey',
  /export function multiPackageLabelIdempotencyKey/.test(planner));
check('planner exports buildMultiPackagePersistenceDraft',
  /export function buildMultiPackagePersistenceDraft/.test(planner));
check('planner remains pure and side-effect-free',
  /No label purchase, postage, queue, marketplace, or shipped\/cancelled mutation/.test(planner));
check('schema has additive group and package tables',
  /shipmentGroups = pgTable/.test(schema) && /shipmentGroupPackages = pgTable/.test(schema));
check('mocked flow exports buildMockedMultiPackageLabelFlow',
  /export function buildMockedMultiPackageLabelFlow/.test(mockFlow));
check('mocked flow remains non-live and zero-postage',
  /isLivePostage: false/.test(mockFlow) && /postageCost: 0/.test(mockFlow));
check('orchestration exports orchestrateMockedMultiPackageLabels',
  /export async function orchestrateMockedMultiPackageLabels/.test(orchestration));
check('orchestration remains mocked-only and sidecar-owned',
  /Mocked-only orchestration/.test(orchestration) &&
    orchestration.includes("from '../../db/schema/shipment-groups'"));
check('print queue planner exports buildMultiPackagePrintQueuePlan',
  /export function buildMultiPackagePrintQueuePlan/.test(printQueuePlan));
check('print queue planner stays pure and planned-only',
  /No real print queue writes/.test(printQueuePlan) &&
    !/from ['"].*(db|schema|print-queue|connector|labels|marketplace)/i.test(printQueuePlan));
check('source guard rejects duplicate package keys',
  sourceGuard.includes('duplicate package keys are rejected before any label purchase planning'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package closeout guard');
