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
const sourceGuard = readFileSync('scripts/ps-289-multi-package-shipment-plan-guard.ts', 'utf8');

check('package wires PS-289 planner guard',
  packageJson.includes('"test:ps-289-multi-package-plan"'));
check('package wires PS-289 schema guard',
  packageJson.includes('"test:ps-289-multi-package-schema"'));
check('package wires PS-289 mocked label flow guard',
  packageJson.includes('"test:ps-289-multi-package-mock-label-flow"'));
check('package wires PS-289 closeout guard',
  packageJson.includes('"test:ps-289-multi-package-closeout"'));
check('status doc lists planner guard',
  doc.includes('`test:ps-289-multi-package-plan`'));
check('status doc lists schema guard',
  doc.includes('`test:ps-289-multi-package-schema`'));
check('status doc lists mocked label flow guard',
  doc.includes('`test:ps-289-multi-package-mock-label-flow`'));
check('status doc lists closeout guard',
  doc.includes('`test:ps-289-multi-package-closeout`'));
check('status doc keeps PS-289 conservative at 35%',
  /PS-289 35%/.test(doc));
check('status doc explicitly blocks Final Review',
  /not Final Review-ready/.test(doc));
check('status doc says sidecar persistence foundation exists',
  /additive persistence\s+foundation, and/.test(doc));
check('status doc says mocked per-package label identity exists',
  /mocked per-package label identity workflow exist/.test(doc));
check('status doc lists DB-backed orchestration as missing',
  /DB-backed orchestration/.test(doc));
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
check('source guard rejects duplicate package keys',
  sourceGuard.includes('duplicate package keys are rejected before any label purchase planning'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package closeout guard');
