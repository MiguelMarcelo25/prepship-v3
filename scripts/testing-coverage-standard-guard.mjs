import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const standard = readFileSync('docs/prepship-testing-coverage-standard.md', 'utf8');
const ps041 = readFileSync('docs/ps-041-shipstation-timezone-sync.md', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

for (const required of [
  'UI/operator workflow change',
  'Provider boundary change',
  'read-only live-path or dry-run reconciliation',
  'Dangerous live mutation',
  'explicit DJ approval',
  'Do not mark provider-boundary fixes complete using only typecheck',
]) {
  assert.match(standard, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.match(ps041, /Root Cause/);
assert.match(ps041, /America\/Los_Angeles/);
assert.match(ps041, /1042/);
assert.match(ps041, /shipstation:awaiting:reconcile/);
assert.match(pkg, /test:testing-coverage-standard/);

console.log('PASS PrepShip testing coverage standard guard');
