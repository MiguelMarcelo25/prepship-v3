/**
 * PS-118 — Architecture source-of-truth certification check.
 *
 * Reads docs/engineering/source-of-truth-canonical-fields.json and verifies that every
 * canonical field / owner / guard still lives at its authoritative file, and that no
 * forbidden alternate-truth pattern is present. FAILS (exit 1) if any canonical
 * identifier disappears from its owner — so a refactor that quietly removes a
 * source-of-truth field or routes truth through a UI fallback is caught in CI.
 *
 * Pure: no DB, no network. Token matching: plain substring, or 're:<regex>' for regex.
 *
 *   npx tsx scripts/check-source-of-truth-canonical-fields.ts
 *   npm run check:architecture-source-of-truth
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type Check = {
  id: string;
  workflow: string;
  owner: string;
  severity: 'P0' | 'P1';
  mustContain?: string[];
  mustNotContain?: string[];
};
type Manifest = { version: string; checks: Check[] };

function matches(src: string, token: string): boolean {
  if (token.startsWith('re:')) {
    try {
      return new RegExp(token.slice(3)).test(src);
    } catch {
      return false;
    }
  }
  return src.includes(token);
}

const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'docs/engineering/source-of-truth-canonical-fields.json'), 'utf8'),
) as Manifest;

let p0Failures = 0;
let p1Failures = 0;
const fileCache = new Map<string, string | null>();
function readOwner(owner: string): string | null {
  if (fileCache.has(owner)) return fileCache.get(owner)!;
  const path = join(repoRoot, owner);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : null;
  fileCache.set(owner, content);
  return content;
}

console.log(`PS-118 source-of-truth certification — manifest ${manifest.version}\n`);

for (const check of manifest.checks) {
  const src = readOwner(check.owner);
  const missing: string[] = [];
  const forbidden: string[] = [];
  if (src == null) {
    missing.push(`(owner file not found: ${check.owner})`);
  } else {
    for (const token of check.mustContain ?? []) {
      if (!matches(src, token)) missing.push(token);
    }
    for (const token of check.mustNotContain ?? []) {
      if (matches(src, token)) forbidden.push(token);
    }
  }
  const ok = missing.length === 0 && forbidden.length === 0;
  if (ok) {
    console.log(`ok   [${check.severity}] ${check.id} — ${check.workflow}`);
  } else {
    if (check.severity === 'P0') p0Failures += 1; else p1Failures += 1;
    console.error(`FAIL [${check.severity}] ${check.id} — ${check.workflow} (${check.owner})`);
    if (missing.length) console.error(`        missing canonical token(s): ${missing.join(', ')}`);
    if (forbidden.length) console.error(`        forbidden alternate-truth token(s): ${forbidden.join(', ')}`);
  }
}

console.log(
  `\n${manifest.checks.length} checks · P0 failures: ${p0Failures} · P1 failures: ${p1Failures}`,
);

if (p0Failures > 0) {
  console.error('\nFAIL PS-118 source-of-truth certification (P0 source-of-truth regression)');
  process.exit(1);
}
if (p1Failures > 0) {
  console.error('\nFAIL PS-118 source-of-truth certification (P1 canonical-field regression)');
  process.exit(1);
}
console.log('\nPASS PS-118 source-of-truth certification — canonical owners intact');
