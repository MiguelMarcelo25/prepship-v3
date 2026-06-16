/**
 * PS-249 (Card 4, slice 2) guard — the storage-fee idempotency migration is dup-safe + gated,
 * and the billing storage insert keeps the try/catch that makes the unique index a safe backstop.
 *
 *   npx tsx scripts/ps-249-storage-atomicity-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const mig = readFileSync('scripts/migrate-billing-storage-unique.ts', 'utf8');

// dry-run-gated (Card 10) — never mutates the money table without --apply
check('migration is gated by opsMayMutate (dry run default)',
  /import \{ opsMayMutate \} from '\.\.\/src\/lib\/ops-confirm'/.test(mig) && /const apply = opsMayMutate\(\)/.test(mig));
check('migration reports duplicate storage groups before any change',
  /having count\(\*\) > 1/.test(mig) && /Duplicate storage groups/.test(mig));
check('dry run returns before mutating', /if \(!apply\)[\s\S]*return;/.test(mig));

// dup-safe: dedups BEFORE creating the unique index (else CREATE UNIQUE INDEX would fail)
const dedupIdx = mig.indexOf('delete from billing_line_items a');
const createIdx = mig.indexOf('create unique index');
check('dedups before creating the index', dedupIdx > 0 && createIdx > dedupIdx);
check('dedup keeps the lowest id per (client_id, ship_date) storage group',
  /a\.client_id = b\.client_id and a\.ship_date = b\.ship_date[\s\S]*a\.id > b\.id/.test(mig));

// the index is the right partial unique index
check('partial unique index on (client_id, ship_date) for null-order storage rows',
  /create unique index if not exists billing_line_items_storage_unique[\s\S]*\(client_id, ship_date\)[\s\S]*where order_id is null and line_type = 'storage'/.test(mig));

// the index is a safe BACKSTOP only because the existing storage insert swallows the violation
const billing = readFileSync('src/services/billing.ts', 'utf8');
const storageBlock = billing.slice(billing.indexOf('Storage fees (once per client'));
check('billing storage insert keeps its try/catch (unique violation -> skipped, not a crash)',
  /lineType: 'storage'/.test(storageBlock) && /catch \{\s*\n\s*skipped \+= 1;/.test(storageBlock));

const pkg = readFileSync('package.json', 'utf8');
check('package.json wires migrate:billing-storage-unique (deliberate, NOT test:*)', /"migrate:billing-storage-unique":/.test(pkg));
check('package.json wires test:ps-249-storage-atomicity', /test:ps-249-storage-atomicity/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-249 storage atomicity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-249 storage atomicity guard');
