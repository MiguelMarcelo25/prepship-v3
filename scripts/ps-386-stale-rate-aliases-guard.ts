import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const staleAliasPattern =
  /\b(?:houseCustomerRate|house_customer_rate|houseRateAmount|house_rate_amount|customerRateAmount|customer_rate_amount|rateCostAmount|rate_cost_amount|actualLabelCost|actual_label_cost)\b/g;

const runtimeRoots = ['src/services', 'src/routes', 'web/src'];
const approvedRuntimeFiles = new Set([
  path.normalize('src/services/shipping-workflow/shipping-rate-money-normalizer.ts'),
]);

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function matchesIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const matches = new Set<string>();
  for (const match of source.matchAll(staleAliasPattern)) {
    matches.add(match[0]);
  }
  return [...matches].sort();
}

const violations: Array<{ file: string; aliases: string[] }> = [];
for (const root of runtimeRoots) {
  if (!existsSync(root) || !statSync(root).isDirectory()) continue;
  for (const file of walk(root)) {
    const normalized = path.normalize(file);
    if (approvedRuntimeFiles.has(normalized)) continue;
    const aliases = matchesIn(file);
    if (aliases.length) violations.push({ file: normalized, aliases });
  }
}

assert.deepEqual(
  violations,
  [],
  [
    'PS-386 stale rate-money aliases leaked into runtime code.',
    'Allowed runtime compatibility boundary:',
    ...[...approvedRuntimeFiles].map((file) => `- ${file}`),
    'Violations:',
    ...violations.map((hit) => `- ${hit.file}: ${hit.aliases.join(', ')}`),
  ].join('\n'),
);

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
assert.equal(
  packageJson.scripts?.['test:ps-386-stale-rate-aliases'],
  'tsx scripts/ps-386-stale-rate-aliases-guard.ts',
  'package.json must expose PS-386 stale alias guard',
);

console.log('PASS PS-386 stale rate alias guard');
