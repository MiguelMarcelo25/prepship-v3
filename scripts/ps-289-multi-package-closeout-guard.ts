/**
 * PS-289 closeout checkpoint.
 *
 * Keeps the multi-package card honest after the first pure planner slice:
 * the foundation is present, but schema/workflow/UI/live-safety proof is still
 * missing.
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
const sourceGuard = readFileSync('scripts/ps-289-multi-package-shipment-plan-guard.ts', 'utf8');

check('package wires PS-289 planner guard',
  packageJson.includes('"test:ps-289-multi-package-plan"'));
check('package wires PS-289 closeout guard',
  packageJson.includes('"test:ps-289-multi-package-closeout"'));
check('status doc lists planner guard',
  doc.includes('`test:ps-289-multi-package-plan`'));
check('status doc lists closeout guard',
  doc.includes('`test:ps-289-multi-package-closeout`'));
check('status doc keeps PS-289 conservative at 18%',
  /PS-289 18%/.test(doc));
check('status doc explicitly blocks Final Review',
  /not Final Review-ready/.test(doc));
check('status doc lists schema/persistence as missing',
  /Shipment group and package-plan persistence model/.test(doc));
check('status doc lists per-package purchase as missing',
  /Idempotent per-package label purchase workflow/.test(doc));
check('status doc lists marketplace confirmation planner as missing',
  /Marketplace confirmation planner/.test(doc));
check('status doc requires mocked workflow before live postage',
  /Mocked end-to-end workflow proof before any live postage/.test(doc));

check('planner exports buildMultiPackageShipmentPlan',
  /export function buildMultiPackageShipmentPlan/.test(planner));
check('planner exports multiPackageLabelIdempotencyKey',
  /export function multiPackageLabelIdempotencyKey/.test(planner));
check('planner remains pure and side-effect-free',
  /No label purchase, postage, queue, marketplace, or shipped\/cancelled mutation/.test(planner));
check('source guard rejects duplicate package keys',
  sourceGuard.includes('duplicate package keys are rejected before any label purchase planning'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package closeout guard');
