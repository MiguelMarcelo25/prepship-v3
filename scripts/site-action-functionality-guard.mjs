import { readFileSync, existsSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) {
    console.error(`site-action guard failed: ${message}`);
    process.exitCode = 1;
  }
}

const matrixPath = 'docs/site-action-functionality-matrix.md';
const specPath = 'web/e2e/site-actions.spec.js';
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = packageJson.scripts ?? {};

assert(existsSync(matrixPath), `${matrixPath} must exist`);
assert(existsSync(specPath), `${specPath} must exist`);
assert(typeof scripts['guard:site-actions'] === 'string', 'package.json missing guard:site-actions');
assert(typeof scripts['test:site-actions:browser'] === 'string', 'package.json missing test:site-actions:browser');
assert(typeof scripts['test:workflow-certification:browser'] === 'string', 'package.json missing test:workflow-certification:browser');
assert(typeof scripts['test:api-contracts'] === 'string', 'package.json missing test:api-contracts');
assert(typeof scripts['test:full-site-certification'] === 'string', 'package.json missing test:full-site-certification');

const matrix = existsSync(matrixPath) ? readFileSync(matrixPath, 'utf8') : '';
const spec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';

const requiredColumns = [
  'Page/view',
  'Button/action label',
  'Selector/test id',
  'Allowed role(s)',
  'Denied role(s)',
  'Fixture state before action',
  'Intended user outcome',
  'Backend/API dependency',
  'Expected HTTP method/path',
  'Required request payload fields',
  'Expected success response',
  'Expected UI loading state',
  'Expected UI success state',
  'Expected UI failure state',
  'Expected state transition',
  'Side-effect classification',
  'Test mode',
  'Covered by spec/test name',
  'Uncovered/manual reason',
];

for (const column of requiredColumns) {
  assert(matrix.includes(column), `matrix missing required PS-022 column: ${column}`);
}

for (const phrase of [
  'Print Label',
  'Reprint Label',
  'Send to Queue',
  'Print Queue',
  'batch print',
  'inventory receive',
  'package add/edit',
  'client selection/filter',
]) {
  assert(matrix.toLowerCase().includes(phrase.toLowerCase()), `matrix missing ${phrase}`);
}

assert(/mock/i.test(spec), 'site action spec must use mocked API behavior');
assert(/failure/i.test(spec), 'site action spec must cover failure states');
assert(/labelCreateShouldFail/.test(spec), 'site action spec must include a mocked label creation failure mode');
assert(/Provider label service timed out/.test(spec), 'site action spec must assert a readable label creation failure message');
assert(/await expect\(printAction\)\.toBeVisible/.test(spec), 'site action spec must require the Print Label action to be visible before clicking');
assert(/await expect\(queueAction\)\.toBeVisible/.test(spec), 'site action spec must require the Send to Queue action to be visible before clicking');
assert(!/if\s*\(\s*await\s+\w+\.count\(\)\s*\)/.test(spec), 'critical site action spec must not silently skip actions with if (await action.count())');
assert(/requestLedger/.test(spec), 'site action spec must record a request ledger');
assert(/expectRequest/.test(spec), 'site action spec must assert expected API requests');
assert(/forbiddenExternalHosts/.test(spec), 'site action spec must block forbidden live external provider hosts');
assert(/marketplace\.walmartapis\.com/.test(spec), 'site action spec must explicitly block Walmart live provider host');
assert(/api\.ebay\.com/.test(spec), 'site action spec must explicitly block eBay live provider host');
assert(/api\.shipstation\.com/.test(spec), 'site action spec must explicitly block ShipStation live provider host');
assert(/\\[object Object\\]|\[object Object\]/.test(spec), 'site action spec must assert label payloads do not contain [object Object]');
assert(/permission denied|scope/i.test(spec), 'site action spec must cover role/scope denial behavior');
assert(/shipped\/cancelled|shipped.*cancelled/i.test(spec), 'site action spec must cover shipped/cancelled protected controls');
assert(/Orders API failure|ordersApiShouldFail/.test(spec), 'site action spec must cover Orders API failure/retry behavior');
assert(/No real postage|no real postage|mocked only/i.test(spec + matrix), 'site action coverage must forbid real postage');
assert(!/live-approved|real-label/i.test(spec), 'site action spec must not include live-approved or real-label flows');

const docs = existsSync('docs/site-action-testing.md')
  ? readFileSync('docs/site-action-testing.md', 'utf8')
  : '';
for (const phrase of [
  'Full automated pass means',
  'Full automated pass does NOT mean',
  'request ledger',
  'mocked',
  'sandbox',
  'live-gated',
]) {
  assert(docs.includes(phrase), `docs/site-action-testing.md missing ${phrase}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log('site-action guard passed');
