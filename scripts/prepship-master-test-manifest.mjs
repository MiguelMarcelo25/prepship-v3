// PS-107 — Master regression manifest.
//
// Single source of truth for which package.json scripts the master runner knows
// about, how each is classified (coverage type + safety level), which master
// profiles include it, and which bug/regression it protects.
//
// The manifest is DERIVED from package.json (so it can never silently drift out
// of sync), then refined by the explicit rules below. Dangerous/live-mutating
// commands are always classified `manual_live_gated` and are NEVER part of a
// default profile.
//
// Coverage types: static_guard | unit_or_logic | mocked_smoke | browser_e2e |
//                 workflow_certification | manual_live_gated
// Safety levels:  safe_offline | safe_mocked | browser_mocked |
//                 dry_run_db_read | manual_live_approval_required

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadPackageScripts() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

// ── Live / mutating commands — NEVER run by default. Marked manual_live_gated. ──
// (Buy postage, create real labels, void, notify marketplaces, or write live DB.)
export const DANGEROUS_COMMANDS = new Set([
  'db:migrate',
  'marketplace:reconcile:apply',
  'marketplace:confirmation:repair',
  'shipment-confirmation:recover:apply',
  'shipstation:awaiting:reconcile:apply',
  'shipstation:recover:apply',
  'shipstation:orphans:apply',
  'shipstation:orphans:link-only',
  'shipstation:fulfillments:apply',
  'shipstation:external-shipped:apply',
  'best-rate:dims:apply',
  'smoke:shipping:real-label',
  'smoke:carrier-harness:real-label',
  'test:inventory-repair-plan',
  'billing:repair-shipment-linkage',
  'shipstation:timestamps:repair',
]);

// Heuristic danger detector for anything new that matches a mutation pattern.
export function isDangerous(command, script = '') {
  if (DANGEROUS_COMMANDS.has(command)) return true;
  if (/(:apply\b|real-label|:repair\b|:recover:apply|:reconcile:apply|prod:)/i.test(command)) return true;
  if (/\b(UPDATE|DELETE|DROP|TRUNCATE)\s/i.test(script)) return true;
  return false;
}

const BROWSER_COMMANDS = new Set([
  'test:billing-best-rate-ui', 'test:billing-summary-total-alignment',
  'test:orders-combo-package:browser', 'test:maintenance-gate:browser',
  'test:orders-ux:browser', 'test:orders-column-integrity:browser',
  'test:orders-expedited:browser', 'test:orders-daily-strip:browser',
  'test:inventory-ux:browser', 'test:site-actions:browser',
  'test:workflow-certification:browser', 'test:rate-browser-carrier-account-click',
  'test:rate-browser-dynamic-service-selection', 'test:rate-browser-manual-selection-table-sync',
  'test:carrier-print-to-queue:browser',
]);

const CERTIFICATION_COMMANDS = new Set([
  'test:shipping-roundtrip-certification', 'test:full-site-certification',
  'test:full-workflow-certification', 'test:ps-056-external-label-certification',
  'certify:external-shipped', 'guard:shipping-certification',
]);

const PROFILE_EXCLUDED_COMMANDS = new Set([
  // The runner scripts are entrypoints, not runnable children. Including them
  // in any profile lets `test:master` recursively spawn itself.
  'test:master',
  'test:master:quick',
  'test:master:manifest',
  'test:master:shipping',
  'test:master:browser',
  'test:master:all-safe',
  // PS-110 — read-only audit/triage entrypoint over the latest master run
  // (test-results/master/latest.json). A test:master* runner, not a leaf child:
  // keep it manually callable (`npm run test:master:audit`) but never auto-selected
  // into a default profile, or the manifest guard's anti-recursion rule fails.
  'test:master:audit',
  // Requires --order-id or --mock-process-once. Keep it manually callable, but
  // do not run the bare smoke command from default profiles.
  'smoke:marketplace-confirm',
]);

// PS-110 — Nested AGGREGATE commands chain many other npm scripts (often the
// whole suite, incl. typecheck/build/browser). Running them inside a default
// master profile duplicates large portions of the run and re-introduces browser
// + recursion through the back door. They stay DOCUMENTED in the manifest but are
// modelled as profiles/groups, never as leaf children of a default profile.
const NESTED_AGGREGATE_COMMANDS = new Set([
  'test:full-site-certification',
  'test:full-workflow-certification',
]);

// A script that chains 3+ `npm run` invocations is treated as a nested aggregate
// even if it is not in the explicit set above (auto-catches future aggregates).
export function isNestedAggregate(command, script = '') {
  if (NESTED_AGGREGATE_COMMANDS.has(command)) return true;
  const chained = (String(script).match(/\bnpm run\b/g) ?? []).length;
  return chained >= 3;
}

// PS-110 — commands that need a real order id / live provider account / live DB
// state. These are NEVER part of a default fast gate. requiresOrderId commands are
// parameter-required (the bare command can't run safely); requiresLiveData (read
// only) commands belong to the opt-in `live-readonly` profile.
const REQUIRES_ORDER_ID = new Set([
  'smoke:marketplace-confirm',
  'smoke:shipping:preflight',
]);
const REQUIRES_PROVIDER_ACCESS = new Set([
  'smoke:shipping:preflight',
]);
const REQUIRES_LIVE_DATA = new Set([
  'certify:external-shipped',
  'smoke:shipping:preflight',
]);

// PS-110 — safe args that turn a parameter-required command into a default-safe,
// offline/mocked run (the "safe wrapper" path). The runner appends them as
// `npm run <command> -- <args...>`.
const SAFE_ARGS = {
  // Offline fixture-only label smoke (refuses real labels / postage / provider).
  'smoke:shipping:test-label': ['--fixture'],
};

// PS-110 — resource locks: commands sharing a lock are serialised against each
// other (everything else runs in parallel up to --concurrency).
function resourceLocksFor(command, coverage, script = '') {
  if (coverage === 'browser_e2e') return ['browser'];
  if (coverage === 'workflow_certification') return ['browser', 'build'];
  if (REQUIRES_LIVE_DATA.has(command)) return ['db'];
  if (command === 'typecheck' || command === 'build:web' || command.startsWith('build')
      || /\bnpm run build:web\b|\bvite build\b/.test(script)) return ['build'];
  return [];
}

// Coarse runtime estimate (ms) used to schedule slow/locked work first and to
// warn when a `quick` selection drifts over its 5-minute target.
function estimatedMsFor(command, coverage) {
  if (coverage === 'workflow_certification') return 180_000;
  if (coverage === 'browser_e2e') return 40_000;
  if (command === 'typecheck') return 35_000;
  if (command === 'build:web' || command.startsWith('build')) return 15_000;
  if (coverage === 'mocked_smoke') return 8_000;
  return 3_000; // static_guard / unit_or_logic leaf
}

// Curated fast set for between-commit runs (typecheck + critical static guards).
export const QUICK_COMMANDS = new Set([
  'typecheck',
  'test:selected-rate-proof-boundary',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-103-remove-frontend-fingerprint-authority',
  'test:batch-send-proof-forwarding',
  'test:print-to-queue-selected-rate-proof',
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
  'test:carrier-test-mode-seam',
  'test:carrier-suppression',
]);

// Bug/regression IDs each command protects (seeds the bug-capture policy).
const PROTECTS = {
  'test:ps-103-remove-frontend-fingerprint-authority': ['PS-103'],
  'test:batch-send-proof-forwarding': ['PS-104'],
  'test:print-to-queue-selected-rate-proof': ['PS-104', 'print-queue-proof-loop'],
  'test:selected-rate-proof-boundary': ['PS-098', 'purchase-boundary'],
  'test:ps-098-shipping-purchase-boundary': ['PS-098'],
  'test:ps-094-rate-selection-proof': ['PS-094'],
  'test:ps-095-selected-rate-proof-pass-through': ['PS-095'],
  'test:ps-102-best-rate-workflow-dto': ['PS-102'],
  'test:ebay-nosku-title-fallback-grouping': ['ebay-nosku-title'],
  'test:batch-header-package-size': ['batch-header-package-size'],
  'test:daily-orders-trend-count': ['daily-trend-count'],
  'test:daily-orders-trend-total-line': ['daily-trend-total-line'],
  'test:single-sku-default-qty-scope': ['single-sku-qty-scope'],
  'test:awaiting-carrier-badge-nickname-fallback': ['awaiting-carrier-nickname'],
  'test:inventory-history-table-pagination': ['inventory-history-pagination'],
  'test:inventory-history-date-range-total': ['inventory-history-date-range-total'],
  'test:multi-sku-product-dims-rate-fallback': ['multi-sku-product-dims-rate-fallback'],
  'test:best-rate-saved-display-contract': ['best-rate-saved-display-contract'],
  'test:carrier-enable-disable-label': ['carrier-enable-disable'],
  'test:carrier-test-mode-seam': ['carrier-harness', 'carrier-test-mode-seam'],
  'test:carrier-harness': ['carrier-harness'],
  'test:carrier-fixture-schema': ['carrier-harness', 'carrier-fixture-replay'],
  'test:carrier-suppression': ['carrier-harness', 'carrier-marketplace-suppression'],
};

function classifyCoverage(command, script) {
  if (isDangerous(command, script)) return 'manual_live_gated';
  if (BROWSER_COMMANDS.has(command) || command.endsWith(':browser')) return 'browser_e2e';
  if (CERTIFICATION_COMMANDS.has(command)) return 'workflow_certification';
  if (command.startsWith('smoke:')) return 'mocked_smoke';
  if (command === 'typecheck' || command === 'build:web' || command.startsWith('build')) return 'unit_or_logic';
  return 'static_guard';
}

function classifySafety(command, script, coverage) {
  if (coverage === 'manual_live_gated') return 'manual_live_approval_required';
  if (coverage === 'browser_e2e') return 'browser_mocked';
  if (coverage === 'mocked_smoke') return 'safe_mocked';
  return 'safe_offline';
}

function classifyGroup(command) {
  const c = command;
  if (/billing/.test(c)) return 'billing';
  if (/inventory/.test(c)) return 'inventory';
  if (/print-queue|queue|batch-header|batch-pdf|signed-pdf|sku-grouping/.test(c)) return 'print-queue';
  if (/rate|label|carrier|ship|proof|hugrab|walmart|best-rate|direct-carrier|fingerprint/.test(c)) return 'rates-labels-proof';
  if (/marketplace|confirmation|ebay|fulfillment|outbox|connector|store/.test(c)) return 'connectors-marketplace';
  if (/orders|sku|combo|package|manifest|status|expedited|daily-strip/.test(c)) return 'orders-packages-status';
  if (/dashboard|analysis|trend|reporting/.test(c)) return 'dashboard-reporting';
  if (/auth|redaction|scope|governance|security|credential|rbac/.test(c)) return 'security-scope';
  if (/frontend|ux|tailwind|bundle|first-paint|failure-states|maintenance|column-integrity|hover/.test(c)) return 'frontend-ux';
  if (/observability|durable|ops|watchdog|startup|runtime|vercel/.test(c)) return 'ops-observability';
  if (/typecheck|build|contract|import/.test(c)) return 'build-platform';
  return 'misc';
}

function profilesFor(command, coverage, script = '') {
  if (PROFILE_EXCLUDED_COMMANDS.has(command)) return [];
  if (coverage === 'manual_live_gated') return []; // never default
  // PS-110 — nested aggregates duplicate the suite; never a leaf of a default profile.
  if (isNestedAggregate(command, script)) return [];
  // PS-110 — order-required commands cannot run safely without a real order id
  // UNLESS a safe-args wrapper makes them offline. Keep them out of default gates.
  if ((REQUIRES_ORDER_ID.has(command) || REQUIRES_PROVIDER_ACCESS.has(command)) && !SAFE_ARGS[command]) {
    return [];
  }
  // PS-110 — read-only live-DB commands belong ONLY to the opt-in live-readonly
  // profile, never to a default fast gate.
  if (REQUIRES_LIVE_DATA.has(command) && !SAFE_ARGS[command]) {
    return ['live-readonly'];
  }
  const profiles = ['all-safe'];
  const isBrowser = coverage === 'browser_e2e';
  if (!isBrowser) profiles.push('master'); // master = safe non-browser
  if (isBrowser) profiles.push('browser');
  if (QUICK_COMMANDS.has(command)) profiles.push('quick');
  if (classifyGroup(command) === 'rates-labels-proof' || classifyGroup(command) === 'print-queue'
      || classifyGroup(command) === 'connectors-marketplace') {
    if (!isBrowser) profiles.push('shipping');
  }
  return profiles;
}

// `live-readonly` is OPT-IN only — it runs real configured DB/provider read-only
// certification and is never part of the default master gate.
export const PROFILES = ['quick', 'master', 'shipping', 'browser', 'all-safe', 'live-readonly'];

export function buildManifest() {
  const scripts = loadPackageScripts();
  const entries = [];
  for (const [command, script] of Object.entries(scripts)) {
    // Include test/guard/smoke/certify/status + typecheck + build:web, AND any
    // dangerous/live-mutating command (so it is DOCUMENTED in the manifest as
    // manual_live_gated and provably excluded from every default profile — never
    // silently runnable).
    const isTestish = /^(test:|guard:|smoke:|certify:|status:)/.test(command)
      || command === 'typecheck' || command === 'build:web';
    if (!isTestish && !isDangerous(command, script)) continue;
    const coverage = classifyCoverage(command, script);
    const safety = classifySafety(command, script, coverage);
    const resourceLocks = resourceLocksFor(command, coverage, script);
    entries.push({
      command,
      script,
      group: classifyGroup(command),
      coverage,
      safety,
      profiles: profilesFor(command, coverage, script),
      protects: PROTECTS[command] ?? [],
      // PS-110 scheduler/classification metadata.
      args: SAFE_ARGS[command] ?? [],
      resourceLocks,
      concurrencySafe: resourceLocks.length === 0 && coverage !== 'browser_e2e' && coverage !== 'workflow_certification',
      estimatedMs: estimatedMsFor(command, coverage),
      requiresLiveData: REQUIRES_LIVE_DATA.has(command) && !SAFE_ARGS[command],
      requiresProviderAccess: REQUIRES_PROVIDER_ACCESS.has(command) && !SAFE_ARGS[command],
      requiresOrderId: REQUIRES_ORDER_ID.has(command) && !SAFE_ARGS[command],
      isNestedAggregate: isNestedAggregate(command, script),
    });
  }
  entries.sort((a, b) => a.group.localeCompare(b.group) || a.command.localeCompare(b.command));
  return entries;
}

export function manifestForProfile(profile) {
  return buildManifest().filter((e) => e.profiles.includes(profile));
}
