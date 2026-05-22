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

const matrix = existsSync(matrixPath) ? readFileSync(matrixPath, 'utf8') : '';
const spec = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';

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
assert(/No real postage|no real postage|mocked only/i.test(spec + matrix), 'site action coverage must forbid real postage');
assert(!/live-approved|real-label|marketplace\.walmartapis\.com|api\.ebay\.com|ssapi\.shipstation\.com/i.test(spec), 'site action spec must not call live providers');

if (process.exitCode) process.exit(process.exitCode);
console.log('site-action guard passed');
