#!/usr/bin/env node
/**
 * Mandatory SOT/backend-truth/no-wrapper guard pack.
 *
 * PS-335: this is CI/Hermes review wiring only. The commands below are
 * offline/static guards and must stay free of provider calls, DB writes, label
 * creation, marketplace notifications, and shipped/cancelled mutations.
 */
import { spawnSync } from 'node:child_process';

const REQUIRED_GUARDS = [
  'test:ps-464-architecture-boundaries',
  'test:ps-305-authority-drift',
  'test:rate-source-of-truth',
  'test:ps-466-automation-controls',
  // PS-465 hazmat. These existed and passed but nothing ran them -- not this
  // pack, not test:master:shipping -- so the whole dangerous-goods compliance
  // surface could rot undetected during an unrelated refactor, which is exactly
  // how non-cert guards have been lost before. They are hermetic: the migration
  // integration guard uses PGlite in-process, the rest read files and modules,
  // and all three were verified under this runner's OFFLINE_GUARD_ENV (which
  // forces an unreachable DATABASE_URL) before being added here.
  'test:ps-465-hazmat',
  'test:mock-hazmat-label',
  'test:ps-465-466-migration-rollout',
  // PS-467/468 shipment attribution. Both tickets require this in the pack, for
  // the reason the tickets exist: a shipment that could not be attributed used
  // to be persisted with a bare NULL order_id and no signal, which is how a
  // dangerous-goods label became invisible to every order-scoped query. Six of
  // its twenty checks are CONSUMPTION pins -- an owner nothing calls is not a
  // fix, and shipment-sync losing those call sites must fail here.
  'test:ps-467-468-shipment-scope',
  'test:ps-421-method-capability-matrix',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:ps-336-task-sot-gates',
  'test:ps-426-awaiting-cursor-manual-sync',
  'test:ps-427-inventory-reconciliation',
  'test:ps-428-durable-worker-execution',
  'test:ps-429-final-review-closure',
  'test:ps-430-print-queue-worker-health',
  'test:ps-431-production-self-healing',
  'test:ps-432-sync-fulfillment-resilience',
  'test:ps-433-frontend-source-of-truth',
  'test:ps-441-sot-migration',
  'test:ps-436-sync-starvation',
  'test:ps-439-session-advisory-locks',
  'test:ps-450-inventory-outbox',
  'test:sync-continuous-self-healing',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-329-orders-wrapper-sot-cleanup',
  'test:ps-412-finalized-billing',
  'test:ps-449-billing-finalization',
  'test:audit-money-rounding',
  'test:audit-orders-service-boundary',
  'test:audit-pg-boss-inventory-outbox',
  'test:sync-job-admission',
  'test:audit-runtime-schema-readiness',
  'test:ps-455-runtime-schema-migration',
  'test:audit-imported-handler-boundary',
  'test:audit-print-queue-merge-durability',
  'test:audit-structured-money-logging',
  'test:audit-orders-bulk-snapshot',
  'test:audit-order-editable-write',
  'test:ps-451-order-editable-write',
  'test:audit-print-queue-lifecycle',
  'test:ps-452-print-queue-lifecycle',
  'test:audit-sync-watchdog-lifecycle',
  'test:audit-billing-cross-period-reconciliation',
  'test:audit-dead-code-cleanup',
  'test:audit-limiter-fingerprint-hygiene',
  'test:audit-sync-cursor-webhook-hygiene',
  'test:audit-frontend-cache-bundle-hygiene',
  'test:ps-458-query-cache-unification',
  'test:audit-billing-small-fixes',
  'test:audit-api-process-lifecycle',
  'test:audit-print-queue-small-fixes',
  'test:audit-backfill-diagnostics',
  'test:audit-rate-on-ingest',
  'test:audit-local-tariff-calibration',
  'test:audit-multi-instance-readiness',
  'test:audit-orders-raw-payload-policy',
  'test:audit-billing-close-workflow-ux',
  'test:audit-po-box-eligibility',
  'test:audit-table-virtualization',
];

const npmCli = process.env.npm_execpath;
const results = [];
// Enforce the pack's offline contract even when a developer shell has live DB credentials.
const OFFLINE_GUARD_ENV = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://sot_guard:offline@127.0.0.1:1/sot_guard',
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'offline',
  SUPABASE_SERVICE_ROLE_KEY: 'offline',
  SUPABASE_JWT_SECRET: 'offline',
};

for (const command of REQUIRED_GUARDS) {
  const startedAt = Date.now();
  console.log(`\n[sot-guard-pack] npm run ${command}`);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, 'run', command], {
        stdio: 'inherit',
        shell: false,
        env: OFFLINE_GUARD_ENV,
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: OFFLINE_GUARD_ENV,
      });
  const durationMs = Date.now() - startedAt;
  results.push({
    command,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    durationMs,
  });
  if (result.status !== 0) {
    console.table(results);
    console.error(`[sot-guard-pack] failed at ${command}`);
    process.exit(1);
  }
}

console.table(results);
console.log('[sot-guard-pack] passed');
