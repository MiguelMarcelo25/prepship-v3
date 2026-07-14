import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRateBackfillDiagnosticBuffers,
  normalizeRateBackfillDiagnosticSamples,
  recordRateBackfillDiagnostic,
} from '../src/services/rate-backfill-diagnostics';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const diagnostics = createRateBackfillDiagnosticBuffers();
for (let index = 1; index <= 7; index += 1) {
  recordRateBackfillDiagnostic(diagnostics, 'skip', `skip ${index}`);
  recordRateBackfillDiagnostic(diagnostics, 'failure', `failure ${index}`);
}
assert.deepEqual(
  diagnostics.skipSamples,
  ['skip 1', 'skip 2', 'skip 3', 'skip 4', 'skip 5'],
  'skip samples have their own five-entry capacity',
);
assert.deepEqual(
  diagnostics.failureSamples,
  ['failure 1', 'failure 2', 'failure 3', 'failure 4', 'failure 5'],
  'failure samples have their own five-entry capacity',
);

assert.deepEqual(
  normalizeRateBackfillDiagnosticSamples({ failureSamples: ['legacy failure'] }),
  { skipSamples: [], failureSamples: ['legacy failure'] },
  'old durable snapshots remain readable without skipSamples',
);

const service = read('src/services/rates-backfill.ts');
const ratesRoute = read('src/routes/rates.ts');
const ordersRoute = read('src/routes/orders.ts');
const doc = read('docs/ps-tickets/audit-4.8-backfill-diagnostics.md');
const audit = read('AUDIT-2026-07-13.md');

assert.match(service, /skipSamples: string\[\]/);
assert.match(service, /skipSamples: \[\.\.\.job\.skipSamples\]/);
assert.match(service, /normalizeRateBackfillDiagnosticSamples\(parsed\)/);
assert.equal(
  (service.match(/recordRateBackfillDiagnostic\(\s*job,\s*'skip'/g) ?? []).length,
  3,
  'all three expected skip branches use the skip buffer',
);
assert.equal(
  (service.match(/recordRateBackfillDiagnostic\(\s*job,\s*'failure'/g) ?? []).length,
  1,
  'the exception branch alone uses the failure buffer',
);
assert.doesNotMatch(
  service,
  /job\.failureSamples\.push/,
  'backfill workflow never writes samples directly into the failure buffer',
);
assert.match(ratesRoute, /skipSamples: durableJob\.skipSamples/);
assert.match(ordersRoute, /skipSamples: rateJob\.skipSamples/);
assert.match(audit, /- \[x\] 4\.8 \*\*Backfill diagnostics complete\*\*/);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}

console.log('PASS Audit 4.8 backfill diagnostic buffer guard');
