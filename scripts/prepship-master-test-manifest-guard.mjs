// PS-107 — Manifest consistency guard (test:master:manifest).
//
// Verifies the master manifest is internally consistent and safe:
//  - every manifest command exists in package.json
//  - dangerous/live-mutating commands are classified manual_live_gated and are
//    NEVER part of any default profile
//  - the known bug-capture regression entries are present and protected
//  - profiles resolve to non-empty safe command sets

import { buildManifest, loadPackageScripts, DANGEROUS_COMMANDS, PROFILES } from './prepship-master-test-manifest.mjs';

let failures = 0;
function check(name, condition) {
  if (!condition) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const scripts = loadPackageScripts();
const manifest = buildManifest();
const byCommand = new Map(manifest.map((e) => [e.command, e]));

// 1. Every manifest command must exist in package.json.
const missing = manifest.filter((e) => !(e.command in scripts)).map((e) => e.command);
check('every manifest command exists in package.json', missing.length === 0);
if (missing.length) console.error('   missing:', missing.join(', '));

// 2. Dangerous commands: classified manual_live_gated AND excluded from all profiles.
for (const cmd of DANGEROUS_COMMANDS) {
  if (!(cmd in scripts)) continue; // not present on this branch — skip
  const e = byCommand.get(cmd);
  check(`dangerous "${cmd}" is in manifest`, !!e);
  if (e) {
    check(`dangerous "${cmd}" is manual_live_gated`, e.coverage === 'manual_live_gated');
    check(`dangerous "${cmd}" is in NO default profile`, e.profiles.length === 0);
  }
}

// 3. No manual_live_gated command may appear in any profile.
const leaked = manifest.filter((e) => e.coverage === 'manual_live_gated' && e.profiles.length > 0);
check('no live-gated command is in a default profile', leaked.length === 0);

// 4. Profiles resolve to non-empty command sets (quick/master/shipping at least).
for (const profile of ['quick', 'master', 'shipping']) {
  const n = manifest.filter((e) => e.profiles.includes(profile)).length;
  check(`profile "${profile}" has commands`, n > 0);
}

// 5. Bug-capture policy: recent regression guards are present + protected.
const requiredRegressions = [
  'test:batch-send-proof-forwarding',               // PS-104
  'test:ps-103-remove-frontend-fingerprint-authority',
  'test:selected-rate-proof-boundary',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-102-best-rate-workflow-dto',
  'test:ebay-nosku-title-fallback-grouping',
  'test:batch-header-package-size',
  'test:daily-orders-trend-count',
  'test:daily-orders-trend-total-line',
  'test:single-sku-default-qty-scope',
  'test:awaiting-carrier-badge-nickname-fallback',
  'test:inventory-history-table-pagination',
  'test:inventory-history-date-range-total',
  'test:multi-sku-product-dims-rate-fallback',
  'test:best-rate-saved-display-contract',
  'test:carrier-enable-disable-label',
];
for (const cmd of requiredRegressions) {
  check(`regression "${cmd}" is in the manifest`, byCommand.has(cmd));
}

// 6. master:* runner scripts exist in package.json.
for (const s of ['test:master:quick', 'test:master', 'test:master:shipping', 'test:master:browser', 'test:master:all-safe', 'test:master:manifest']) {
  check(`package script "${s}" exists`, s in scripts);
}

console.log(`\nManifest: ${manifest.length} commands across ${new Set(manifest.map((e) => e.group)).size} groups; profiles: ${PROFILES.join(', ')}.`);
if (failures > 0) {
  console.error(`\nFAIL master manifest guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS master manifest guard');
