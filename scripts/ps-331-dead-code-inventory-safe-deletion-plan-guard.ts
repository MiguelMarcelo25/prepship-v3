/**
 * PS-331 - blocked dead-code inventory + safe deletion plan.
 *
 * Offline only: no DB, no network, no labels, no queue mutation.
 * This guard pins PS-331 as an inventory-and-gates ticket. It must not become
 * a broad deletion PR without the source-of-truth cleanup sequence proving the
 * relevant code is truly safe to remove.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const docPath = 'docs/ps-tickets/ps-331-dead-code-inventory-safe-deletion-plan.md';
const doc = read(docPath);
const ledger = read('docs/ps-tickets/ps-ledger.md');
const packageJson = read('package.json');
const ps200 = read('docs/ps-200-legacy-api-decommission.md');
const ps153 = read('scripts/ps-153-dead-symbols-guard.ts');
const labels = read('src/services/labels.ts');
const ps261 = read('scripts/ps-261-hugrab-label-purchase-gate-guard.ts');

check('PS-331 inventory doc exists',
  existsSync(docPath));

check('PS-331 doc marks the ticket BLOCKED and forbids deletion in this slice',
  /PS-331/.test(doc) &&
  /BLOCKED/.test(doc) &&
  /No deletion in PS-331/.test(doc));

check('PS-331 doc records Trello connector as unavailable, not silently verified',
  /Trello connector unavailable/.test(doc));

check('PS-331 doc anchors cleanup sequence PS-340 through PS-344',
  ['PS-340', 'PS-341', 'PS-342', 'PS-343', 'PS-344'].every((ticket) => doc.includes(ticket)));

check('PS-331 doc carries forward PS-200 legacy api deletion gate',
  /PS-200/.test(doc) &&
  /api\//.test(doc) &&
  /zero Vercel function invocations over a full business day/.test(doc));

check('PS-331 doc carries forward PS-153 dead-but-retained schema rule',
  /PS-153/.test(doc) &&
  /skuQtyDims/.test(doc) &&
  /syncMeta/.test(doc) &&
  /do not delete/i.test(doc));

check('PS-331 doc carries forward PS-225 and PS-261 label safety constraints',
  /PS-225/.test(doc) &&
  /PS-261/.test(doc) &&
  /src\/services\/labels\.ts#createLabelFromShipment/.test(doc));

check('PS-331 doc excludes untracked scratch files from deletion planning',
  /untracked scratch files/.test(doc) &&
  /apps\//.test(doc));

check('PS-331 package script is wired',
  packageJson.includes('"test:ps-331-dead-code-inventory-safe-deletion-plan"'));

check('PS-331 ledger row is reserved',
  ledger.includes('| PS-331 | PrepShip dead-code inventory + safe deletion plan |'));

check('PS-200 doc still requires zero Vercel function invocations over a business day before api deletion',
  /zero Vercel function invocations over a business day/.test(ps200) &&
  /S8[\s\S]*delete `api\/`/.test(ps200));

check('PS-153 guard still retains dead schema definitions to avoid destructive DROP generation',
  /skuQtyDims/.test(ps153) &&
  /syncMeta/.test(ps153) &&
  /RETAINED ON PURPOSE[\s\S]*DROP/.test(ps153));

check('legacy createLabelFromShipment remains pinned as a HUGRAB-unsafe revival landmine',
  /PS-072 \/ dead-code note/.test(labels) &&
  /export async function createLabelFromShipment/.test(labels) &&
  /PS-261[\s\S]*preflight/.test(labels));

check('PS-261 guard still audits the createLabelFromShipment dead-code warning',
  /createLabelFromShipment dead-code note warns it is ungated for HUGRAB/.test(ps261));

if (failures > 0) {
  console.error(`\nFAIL PS-331 dead-code inventory safe deletion plan guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-331 dead-code inventory safe deletion plan guard');
