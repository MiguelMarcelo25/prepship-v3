/**
 * PS-257 (Card 12) — @ts-nocheck ratchet.
 *
 * `npm run typecheck` reports a FALSE green: ~94 files under web/src open with `// @ts-nocheck`,
 * so tsc skips them entirely. This guard can't fix those files, but it freezes the count at a
 * CEILING that may only go DOWN: removing a @ts-nocheck (and fixing the file's types) lowers it;
 * ADDING a new @ts-nocheck fails the build. The debt can shrink, never grow.
 *
 * When you remove @ts-nocheck files, LOWER `CEILING` to the new count in the SAME PR. Never raise it.
 *
 *   npx tsx scripts/ts-nocheck-ratchet-guard.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Baseline count on 2026-06-16. Lower this with every file you de-nocheck; never raise it.
const CEILING = 94;

const ROOT = 'web/src';
const EXTS = ['.ts', '.tsx'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXTS.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const files = walk(ROOT)
  .filter((f) => readFileSync(f, 'utf8').includes('@ts-nocheck'))
  .sort();
const count = files.length;

console.log(`@ts-nocheck files under ${ROOT}: ${count} (ceiling ${CEILING})`);

if (count > CEILING) {
  console.error(`\nFAIL @ts-nocheck ratchet: ${count} > ${CEILING}.`);
  console.error('A new @ts-nocheck file was added. Type the file properly instead, or — if truly');
  console.error('unavoidable — justify it; the ceiling only moves DOWN. Current @ts-nocheck files:');
  for (const f of files) console.error(`  ${f}`);
  process.exit(1);
}

if (count < CEILING) {
  console.log(`\nNOTE: count dropped to ${count}. Lower CEILING to ${count} in this PR to lock the gain.`);
}

console.log('\nPASS @ts-nocheck ratchet');
