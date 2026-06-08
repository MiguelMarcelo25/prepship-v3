// PS-107 — Manifest consistency guard (test:master:manifest).
//
// Verifies the master manifest is internally consistent and safe:
//  - every manifest command exists in package.json
//  - dangerous/live-mutating commands are classified manual_live_gated and are
//    NEVER part of any default profile
//  - the known bug-capture regression entries are present and protected
//  - profiles resolve to non-empty safe command sets

import { buildManifest, loadPackageScripts, DANGEROUS_COMMANDS, PROFILES, isNestedAggregate } from './prepship-master-test-manifest.mjs';

// PS-110 — the default fast/safe gates. `live-readonly` is opt-in and may contain
// live-DB read-only commands, so it is NOT a default profile.
const DEFAULT_PROFILES = ['quick', 'master', 'shipping', 'browser', 'all-safe'];

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

// 4b. Runner scripts must remain manually callable but never selected by the
// runner profiles themselves, otherwise `test:master` can recursively spawn
// `test:master` / `test:master:quick` / etc. and never certify.
for (const entry of manifest.filter((e) => /^test:master(?::|$)/.test(e.command))) {
  check(`runner command "${entry.command}" is in NO default profile`, entry.profiles.length === 0);
}

const marketplaceSmoke = byCommand.get('smoke:marketplace-confirm');
check(
  'parameter-required marketplace smoke is excluded from default profiles',
  Boolean(marketplaceSmoke && marketplaceSmoke.profiles.length === 0),
);

// ── PS-110 — leaf-only, no-recursion, no-nested-aggregate, live-isolation ─────
for (const profile of DEFAULT_PROFILES) {
  const inProfile = manifest.filter((e) => e.profiles.includes(profile));

  // (a) No runner command (test:master*) may appear in a default profile.
  const recursive = inProfile.filter((e) => /^test:master(?::|$)/.test(e.command)).map((e) => e.command);
  check(`profile "${profile}" has NO recursive test:master* command`, recursive.length === 0);
  if (recursive.length) console.error('   recursive:', recursive.join(', '));

  // (b) No nested AGGREGATE (full-site / full-workflow / 3+ npm-run chains).
  const nested = inProfile.filter((e) => e.isNestedAggregate || isNestedAggregate(e.command, e.script)).map((e) => e.command);
  check(`profile "${profile}" has NO nested aggregate command`, nested.length === 0);
  if (nested.length) console.error('   nested aggregates:', nested.join(', '));

  // (c) No live/order/provider-dependent command runs in a default gate unless a
  // safe-args wrapper makes it offline.
  const live = inProfile
    .filter((e) => (e.requiresLiveData || e.requiresOrderId || e.requiresProviderAccess) && (!e.args || e.args.length === 0))
    .map((e) => e.command);
  check(`profile "${profile}" has NO live/order/provider-dependent command`, live.length === 0);
  if (live.length) console.error('   live-dependent:', live.join(', '));
}

// (d) A parameter-required command (order/provider) is default-safe ONLY when it
// carries safe args; otherwise it must be in NO default profile.
const paramRequiredLeaked = manifest.filter(
  (e) => (e.requiresOrderId || e.requiresProviderAccess)
    && (!e.args || e.args.length === 0)
    && DEFAULT_PROFILES.some((p) => e.profiles.includes(p)),
);
check('no parameter-required command is default-safe without safe args', paramRequiredLeaked.length === 0);

// (e) live-readonly commands never leak into a default profile.
const liveReadonlyLeaked = manifest.filter(
  (e) => e.profiles.includes('live-readonly') && DEFAULT_PROFILES.some((p) => e.profiles.includes(p)),
);
check('live-readonly commands are excluded from every default profile', liveReadonlyLeaked.length === 0);

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
