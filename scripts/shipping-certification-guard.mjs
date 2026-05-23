import { readFileSync, existsSync } from 'node:fs';

const requiredFiles = [
  'docs/prepship-shipping-production-audit.md',
  'docs/shipping-certification-harness.md',
  'scripts/inspect-shipping-order.ts',
  'scripts/smoke-shipping-preflight.ts',
  'scripts/smoke-shipping-test-label.ts',
  'scripts/smoke-shipping-real-label.ts',
  'scripts/smoke-marketplace-confirm.ts',
  'scripts/retry-marketplace-confirmation.ts',
  'scripts/walmart-confirmation-payload-guard.ts',
];

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = packageJson.scripts ?? {};

function assert(condition, message) {
  if (!condition) {
    console.error(`shipping-certification guard failed: ${message}`);
    process.exitCode = 1;
  }
}

for (const file of requiredFiles) {
  assert(existsSync(file), `${file} must exist`);
}

for (const name of [
  'inspect:shipping-order',
  'smoke:shipping:preflight',
  'smoke:shipping:test-label',
  'smoke:shipping:real-label',
  'smoke:marketplace-confirm',
  'marketplace:confirm:retry',
  'test:walmart-confirmation:payload',
  'guard:shipping-certification',
]) {
  assert(typeof scripts[name] === 'string', `package.json missing ${name}`);
}

const inspector = existsSync('scripts/inspect-shipping-order.ts')
  ? readFileSync('scripts/inspect-shipping-order.ts', 'utf8')
  : '';
const preflight = existsSync('scripts/smoke-shipping-preflight.ts')
  ? readFileSync('scripts/smoke-shipping-preflight.ts', 'utf8')
  : '';
const testLabel = existsSync('scripts/smoke-shipping-test-label.ts')
  ? readFileSync('scripts/smoke-shipping-test-label.ts', 'utf8')
  : '';
const realLabel = existsSync('scripts/smoke-shipping-real-label.ts')
  ? readFileSync('scripts/smoke-shipping-real-label.ts', 'utf8')
  : '';
const confirm = existsSync('scripts/smoke-marketplace-confirm.ts')
  ? readFileSync('scripts/smoke-marketplace-confirm.ts', 'utf8')
  : '';
const retryConfirm = existsSync('scripts/retry-marketplace-confirmation.ts')
  ? readFileSync('scripts/retry-marketplace-confirmation.ts', 'utf8')
  : '';
const docs = existsSync('docs/shipping-certification-harness.md')
  ? readFileSync('docs/shipping-certification-harness.md', 'utf8')
  : '';

assert(inspector.includes('READ_ONLY_INSPECTOR'), 'inspector must declare read-only mode');
assert(preflight.includes('READ_ONLY_PREFLIGHT'), 'preflight must declare read-only mode');
assert(!/fetch\s*\(\s*['"`]https?:\/\/(api\.shipstation|ssapi\.shipstation|api\.ebay|marketplace\.walmartapis)/i.test(preflight), 'preflight must not call external carrier or marketplace APIs');
assert(testLabel.includes('--fixture'), 'test-label smoke must require fixture mode');
assert(testLabel.includes('refuses to create real labels'), 'test-label smoke must explicitly refuse real labels');
assert(realLabel.includes('--live-approved'), 'real-label smoke must require --live-approved');
assert(realLabel.includes('LIVE_LABEL_APPROVAL_REQUIRED'), 'real-label smoke must declare live approval gating');
assert(realLabel.includes('Cannot create label for shipped/cancelled order'), 'real-label smoke must refuse shipped/cancelled orders');
assert(realLabel.includes('Label already exists for this order'), 'real-label smoke must refuse duplicate active labels');
assert(realLabel.includes('No secrets, PII, raw labels, or provider payloads are printed'), 'real-label smoke must document output redaction');
assert(confirm.includes('READ_ONLY_BY_DEFAULT'), 'marketplace confirm smoke must be read-only by default');
assert(confirm.includes('--mock-process-once'), 'marketplace confirm processing must be mock-gated only');
assert(retryConfirm.includes('--live-approved'), 'live marketplace confirmation retry must require --live-approved');
assert(retryConfirm.includes('--outbox-id'), 'live marketplace confirmation retry must require exact --outbox-id');
assert(retryConfirm.includes("provider !== 'walmart'"), 'live marketplace confirmation retry must be scoped to Walmart');
assert(retryConfirm.includes('dryRun'), 'live marketplace confirmation retry must support dry-run inspection');
assert(/No automated test may create real labels/i.test(docs), 'docs must state no real labels');
assert(/smoke:shipping:real-label/i.test(docs), 'docs must document the real-label certification command');
assert(/static guards are not enough/i.test(docs), 'docs must explain static guards are not enough');
assert(/duplicate active/i.test(inspector + preflight + docs), 'harness must mention duplicate active label protection');
assert(/shipped|cancelled/i.test(preflight + testLabel), 'harness must check shipped/cancelled protection');

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('shipping-certification guard passed');
