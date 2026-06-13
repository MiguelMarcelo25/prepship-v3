/**
 * PS-232 guard — low-severity hardening bundle (items 2-6; item 1 is a Supabase
 * dashboard toggle verified by DJ).
 *
 *   npx tsx scripts/ps-232-hardening-bundle-guard.ts
 */
import { readFileSync } from 'node:fs';

const env = readFileSync('src/lib/env.ts', 'utf8');
const worker = readFileSync('src/worker.ts', 'utf8');
const orders = readFileSync('src/routes/orders.ts', 'utf8');
const cron = readFileSync('src/routes/cron.ts', 'utf8');
const migration = (() => { try { return readFileSync('drizzle/0046_pgboss_search_path.sql', 'utf8'); } catch { return ''; } })();
const doc = (() => { try { return readFileSync('docs/engineering/ps-232-hardening.md', 'utf8'); } catch { return ''; } })();
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// Item 3 — env error no longer echoes the missing-var names to the client.
check('serverless env error does not echo var names',
  !/throw new Error\(`Invalid environment variables: \$\{JSON\.stringify/.test(env));
check('serverless env error is generic', /Server misconfigured: required environment variables are missing/.test(env));

// Item 4 — worker stack traces gated behind a debug flag.
check('worker gates full stacks behind WORKER_DEBUG_STACKS',
  (worker.split("WORKER_DEBUG_STACKS === '1'").length - 1) >= 2);
check('worker no longer prints stack unconditionally',
  !/\.stack\) console\.error\((reason|err)\.stack\)/.test(worker));

// Item 5 — /distinct-skus is zod-validated.
check('/distinct-skus uses zValidator(query)',
  /app\.get\('\/distinct-skus', zValidator\('query', distinctSkusQuery\)/.test(orders));
check('distinct-skus schema defined', orders.includes('const distinctSkusQuery = z.object('));

// Item 6 — cron sync body is size-capped before parse.
check('cron sync body has a size cap', cron.includes('CRON_SYNC_MAX_BODY_BYTES'));
check('cron caps before parsing', /Buffer\.byteLength\(raw[\s\S]*?CRON_SYNC_MAX_BODY_BYTES/.test(cron));

// Item 2 — pgboss search_path migration.
check('pgboss search_path migration exists', migration.length > 0);
check('migration pins search_path on pgboss functions',
  /ALTER FUNCTION pgboss/i.test(migration) && /search_path = pgboss/i.test(migration));
check('migration is no-op when pgboss schema absent', /nspname = 'pgboss'/.test(migration));

// Item 1 — documented as a DJ Supabase toggle.
check('doc records the leaked-password DJ toggle',
  /leaked password protection/i.test(doc) && /DJ/.test(doc));

// Self-wiring.
check('package.json exposes test:ps-232-hardening-bundle', /test:ps-232-hardening-bundle/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-232 hardening bundle guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-232 hardening bundle guard');
