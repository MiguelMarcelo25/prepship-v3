#!/usr/bin/env node
// PS-035 — Full-Workflow Certification offline core.
//
// Runs the offline (no live providers, no running web server, no real DB)
// workflow guards that prove PrepShip's critical operator flow — order
// ingestion -> rates -> label -> print queue -> shipment persistence ->
// marketplace confirmation -> inventory/billing side effects -> recovery ->
// RBAC/scope -> production health shape. Grouped by the coverage-matrix
// checkpoints in docs/full-workflow-certification-matrix.md.
//
// This runner is self-sufficient: `npm run test:workflow-suites` certifies the
// whole offline surface WITHOUT a browser/server, so it is usable in plain CI.
// The master `test:full-workflow-certification` layers the server-required
// browser specs (via test:full-site-certification) on top.
//
// HOW TO ADD A FUTURE CHECKPOINT: add (or extend) a group below with the new
// offline `test:*` script name. Keep live/DJ-supervised and browser-server
// suites OUT of this runner (see EXCLUDED note in the matrix doc).
//
// Continues on failure and prints a per-checkpoint summary; exits 1 if any
// suite fails so it can gate CI.

import { execSync } from 'node:child_process';

// Each script appears once; the first group it is listed under owns it.
const GROUPS = [
  {
    checkpoint: 'A/O/E — Rate shopping, package/dims/rate selection, label rules',
    scripts: [
      'test:rate-system-hardening',
      'test:shipp-rate-retry',
      'test:best-rate-dims',
      'test:test-order-queue-label',
      'test:shipstation-label-url',
      'test:direct-carrier-labels',
      'test:order-readiness-preflight',
    ],
  },
  {
    checkpoint: 'B/C/F — Carrier credentials, source sync, shipment persistence',
    scripts: [
      'test:credential-accounts',
      'test:shipstation-carrier-account-identity',
      'test:store-connector-source',
      'test:connector-registry',
      'test:connector-architecture',
      'test:ps-032-connector-boundary',
      'test:ps-032-connector-orchestrators',
      'test:rates-multi-cache',
      'test:rates-multi-durable-snapshot',
      'test:shipstation-awaiting-parity',
      'test:shipstation-sync-window',
      'test:sync-advisory-lock',
      'test:walmart-dual-dedupe',
      'test:label-shipment-scope-review',
    ],
  },
  {
    checkpoint: 'G/H — Print queue durability & shipped-label reprint',
    scripts: [
      'test:print-queue-durable',
      'test:print-queue-persistence',
      'test:print-queue-invalid-label',
      'test:print-queue-ownership',
      'test:print-queue-client-scope',
      'test:queue-label-diagnostics',
    ],
  },
  {
    checkpoint: 'I — Marketplace confirmation / fulfillment outbox',
    scripts: [
      'test:ebay-confirmation:mocked',
      'test:walmart-confirmation:payload',
      'test:marketplace-reconciliation',
      'test:marketplace-order-auth-cors',
    ],
  },
  {
    checkpoint: 'J — Inventory / WMS side effects',
    scripts: [
      'test:inventory-auto-deduct',
      'test:inventory-source-of-truth',
      'test:inventory-ledger-balance',
      'test:ps-414-inventory-ledger',
      'test:inventory-history-dedupe',
      'test:inventory-reconciliation-dry-run',
      'test:inventory-client-scope',
    ],
  },
  {
    checkpoint: 'K — Billing / cost capture',
    scripts: [
      'test:billing-formula',
      'test:billing-client-scope',
      'test:billing-detail-ps040',
      'test:billing-best-rate-ui:guard',
      'test:ps-416-billing-fail-closed',
    ],
  },
  {
    checkpoint: 'L — Order table post-shipment behavior & lockdown',
    scripts: [
      'test:orders-ux',
      'test:orders-query-round2',
      'test:orders-startup-requests',
      'test:orders-maintenance-startup',
      'test:order-editable-lockdown',
    ],
  },
  {
    checkpoint: 'M — Error / recovery states for critical buttons',
    scripts: [
      'test:frontend-failure-states',
      'test:raw-error-response-audit',
      'test:node-handler-response',
    ],
  },
  {
    checkpoint: 'N — Auth / RBAC / client-store scope inside workflows',
    scripts: [
      'test:rbac-permissions',
      'test:auth-coverage',
      'test:client-store-scope',
      'test:field-level-rbac',
      'test:field-level-rbac-extended',
      'test:jwt-session-policy',
      'test:auth-logout',
      'test:frontend-auth-cache',
      'test:dashboard-client-scope',
      'test:analysis-client-scope',
      'test:orders-manifests-scope',
      'test:secrets-governance',
      'test:client-redaction',
    ],
  },
  {
    checkpoint: 'P — Production / deploy health smoke (offline shape)',
    scripts: [
      'test:health-deep-readiness',
      'test:production-watchdog',
      'test:production-signoff',
      'test:status:carriers',
      'test:maintenance-page',
    ],
  },
  {
    checkpoint: 'Cross-cutting — API contracts & California-time integrity',
    scripts: [
      'test:api-contracts',
      'test:date-time-standard',
      'test:daily-stats-window',
      'test:daily-strip-progress',
    ],
  },
  {
    // PS-172 Phases 1-6: the backend-owned workflow DTO contracts (row state /
    // actions / display / routing / money / identity / defaults) + the Phase 6
    // FE-authority ratchet. CI-enforcing these is the precondition for deleting
    // the FE fallbacks: every deletion lands under a pinned contract.
    checkpoint: 'PS-172 — Backend-owned truth contracts & FE-authority ratchet',
    scripts: [
      'test:ps-173-order-row-workflow',
      'test:ps-174-quote-key-consolidation',
      'test:ps-175-strict-recalc-decision',
      'test:ps-176-queue-route-authority',
      'test:ps-177-queue-sku-identity',
      'test:ps-177-row-money-display',
      'test:ps-177-dims-defaults',
      'test:ps-196-cache-first-display',
      'test:ps-178-fe-authority-ratchet',
    ],
  },
  {
    // PS-254 (Card 9) + PS-255 (Card 10): perimeter hardening (mock-label/pick-list HTML escaping,
    // order-sync SQLi invariant, generic onError 5xx, FE-bundle secret scan) + the ops-confirm
    // dry-run/apply gate. The guards were green but NOT release-gated — only test:master:all-safe ran
    // them, which the Render CI gate (typecheck + build + this cert) does not. Wiring them here puts
    // them INSIDE the cert, so an escaping/secret-leak/ops-safety regression blocks deploy. All three
    // are offline static guards (no shipped/cancelled mutation, no live DB).
    checkpoint: 'PS-254/255 — Perimeter hardening + ops-confirmation gate',
    scripts: [
      'test:ps-254-perimeter-hardening',
      'test:ps-254-secret-scan',
      'test:ps-255-ops-confirm-gate',
    ],
  },
];

const seen = new Set();
const results = [];
let failed = 0;

for (const group of GROUPS) {
  console.log(`\n=== ${group.checkpoint} ===`);
  for (const script of group.scripts) {
    if (seen.has(script)) continue;
    seen.add(script);
    const started = process.hrtime.bigint();
    try {
      execSync(`npm run ${script}`, { stdio: 'pipe', encoding: 'utf8' });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`  PASS  ${script}  (${ms.toFixed(0)}ms)`);
      results.push({ script, ok: true });
    } catch (err) {
      failed += 1;
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n');
      console.log(`  FAIL  ${script}`);
      if (out) console.log(out.split('\n').map((l) => `        ${l}`).join('\n'));
      results.push({ script, ok: false });
    }
  }
}

const total = results.length;
const passed = total - failed;
console.log(`\n=== Workflow certification offline core: ${passed}/${total} suites passed ===`);
if (failed > 0) {
  console.log('FAILED suites:');
  for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.script}`);
  process.exit(1);
}
console.log('PASS full-workflow-certification offline core');
