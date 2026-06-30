/**
 * PS-358 - clean PS-340 rate-engine breadcrumbs and stale frontend-rate guards.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
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

const packageJson = read('package.json');
const ledger = read('docs/ps-tickets/ps-ledger.md');
const ps331Doc = read('docs/ps-tickets/ps-331-dead-code-inventory-safe-deletion-plan.md');
const ps331Guard = read('scripts/ps-331-dead-code-inventory-safe-deletion-plan-guard.ts');
const ps340Doc = read('docs/ps-tickets/ps-340-backend-rate-engine.md');
const ps340Guard = read('scripts/ps-340-backend-rate-engine-guard.ts');
const ledgerGuard = read('scripts/ps-ticket-ledger-guard.ts');
const ps358Doc = read('docs/ps-tickets/ps-358-ps340-cleanup.md');

check(
  'stale PS-340 frontend bridge audit package script is retired',
  !packageJson.includes('test:ps-340-ratebrowser-bridge-audit'),
);

check(
  'stale PS-340 frontend bridge audit doc and guard are removed from active repo evidence',
  !existsSync('docs/ps-tickets/ps-340-ratebrowser-bridge-audit.md') &&
    !existsSync('scripts/ps-340-ratebrowser-bridge-audit-guard.ts'),
);

check(
  'package keeps canonical PS-340 backend rate-engine guards and wires PS-358 cleanup guard',
  packageJson.includes('"test:ps-340-backend-rate-engine": "tsx scripts/ps-340-backend-rate-engine-guard.ts"') &&
    packageJson.includes('"test:ps-340-rate-engine-volume-proof": "tsx scripts/ps-340-rate-engine-volume-proof-guard.ts"') &&
    packageJson.includes('"test:ps-358-ps340-cleanup": "tsx scripts/ps-358-ps340-cleanup-guard.ts"'),
);

check(
  'PS ledger reserves PS-340 for backend rate-engine, not retired frontend bridge audit',
  ledger.includes('| PS-340 | Backend rate engine |') &&
    !ledger.includes('| PS-340 | Rate Browser frontend bridge audit |'),
);

check(
  'ledger guard enforces backend PS-340 and no longer requires stale bridge audit',
  ledgerGuard.includes('| PS-340 | Backend rate engine |') &&
    !ledgerGuard.includes('Rate Browser bridge audit'),
);

check(
  'PS-340 backend guard no longer preserves the retired bridge-audit collision',
  !ps340Guard.includes('ps-340-ratebrowser-bridge-audit') &&
    !ps340Guard.includes('without replacing the older bridge-audit guard'),
);

check(
  'PS-340 backend doc no longer documents a live number collision',
  !ps340Doc.includes('## PS-340 Number Collision') &&
    !ps340Doc.includes('Rate Browser frontend bridge audit'),
);

check(
  'PS-331 inventory points to current PS-340 backend evidence plus PS-341 through PS-344 cleanup guards',
  ps331Doc.includes('PS-340 backend rate-engine') &&
    ps331Doc.includes('PS-341, PS-342, PS-343, and PS-344') &&
    !ps331Doc.includes('PS-340 - Rate Browser frontend bridge audit') &&
    !ps331Doc.includes('PS-340 to PS-344 docs and guards'),
);

check(
  'PS-331 guard enforces the cleaned PS-340 inventory wording',
  ps331Guard.includes('PS-340 backend rate-engine') &&
    !ps331Guard.includes('PS-340 to PS-344 docs and guards'),
);

check(
  'PS-358 cleanup proof documents the retired artifact and safety boundary',
  ps358Doc.includes('Retired artifacts') &&
    ps358Doc.includes('No production rate code changed') &&
    ps358Doc.includes('rate-source-of-truth'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-358 PS-340 cleanup guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-358 PS-340 cleanup guard');
