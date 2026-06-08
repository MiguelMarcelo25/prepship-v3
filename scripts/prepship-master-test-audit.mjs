// PS-110 — Master test-run audit summary.
//
// Reads test-results/master/latest.json (produced by the runner) and classifies each
// FAILURE so a human can triage fast: test-infra/profile issue vs real code regression
// vs live/order/provider-data required vs browser/E2E. Groups by domain and prints a
// focused rerun command per failure. Read-only — runs NO tests itself.
//
//   node scripts/prepship-master-test-audit.mjs            # reads latest.json
//   node scripts/prepship-master-test-audit.mjs <path.json>
//   npm run test:master:audit

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const reportPath = arg
  ? (isAbsolute(arg) ? arg : join(repoRoot, arg))
  : join(repoRoot, 'test-results', 'master', 'latest.json');

if (!existsSync(reportPath)) {
  console.error(`No master report at ${reportPath}. Run a master profile first (e.g. npm run test:master:quick).`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const results = Array.isArray(report.results) ? report.results : [];
const failures = results.filter((r) => r && r.passed === false);

// Classify a failure into a triage bucket.
function classify(r) {
  if (r.requiresLiveData || r.requiresProviderAccess || r.requiresOrderId) return 'live/order/provider-data required';
  if (r.coverage === 'browser_e2e') return 'browser/E2E (needs dev server + fixtures)';
  if (r.coverage === 'workflow_certification') return 'workflow certification (often nested/test-infra)';
  if (/exceeded|maxBuffer|ETIMEDOUT|spawn|ENOENT|module not found|cannot find/i.test(r.outputTail ?? r.error ?? '')) {
    return 'test-infra / profile issue';
  }
  return 'real code regression candidate';
}

console.log(`PS-110 master-run audit — profile=${report.profile} (${report.startedAt})`);
console.log(`commands=${results.length} · passed=${report.summary?.passed ?? '?'} · failed=${failures.length}\n`);

if (!failures.length) {
  console.log('No failures to triage. ✅');
  process.exit(0);
}

// Group failures by triage bucket, then by domain group.
const byBucket = new Map();
for (const r of failures) {
  const bucket = classify(r);
  if (!byBucket.has(bucket)) byBucket.set(bucket, []);
  byBucket.get(bucket).push(r);
}

const bucketOrder = [
  'real code regression candidate',
  'test-infra / profile issue',
  'browser/E2E (needs dev server + fixtures)',
  'live/order/provider-data required',
  'workflow certification (often nested/test-infra)',
];
const sortedBuckets = [...byBucket.keys()].sort(
  (a, b) => (bucketOrder.indexOf(a) + 1 || 99) - (bucketOrder.indexOf(b) + 1 || 99),
);

for (const bucket of sortedBuckets) {
  const items = byBucket.get(bucket);
  console.log(`\n## ${bucket}  (${items.length})`);
  const byGroup = new Map();
  for (const r of items) {
    const g = r.group ?? 'misc';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  for (const [group, rows] of [...byGroup.entries()].sort()) {
    console.log(`  ${group}:`);
    for (const r of rows) {
      console.log(`    ✗ ${r.command} (exit ${r.exitCode})  →  rerun: npm run ${r.command}`);
    }
  }
}

console.log('\nTriage hint: start with "real code regression candidate"; "test-infra / profile issue" usually means a manifest/args fix, not a product bug.');
