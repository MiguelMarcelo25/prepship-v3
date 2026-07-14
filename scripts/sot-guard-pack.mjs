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
  'test:ps-305-authority-drift',
  'test:rate-source-of-truth',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:ps-336-task-sot-gates',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-329-orders-wrapper-sot-cleanup',
  'test:ps-412-finalized-billing',
  'test:audit-orders-service-boundary',
  'test:audit-pg-boss-inventory-outbox',
  'test:audit-runtime-schema-readiness',
  'test:audit-imported-handler-boundary',
  'test:audit-print-queue-merge-durability',
];

const npmCli = process.env.npm_execpath;
const results = [];

for (const command of REQUIRED_GUARDS) {
  const startedAt = Date.now();
  console.log(`\n[sot-guard-pack] npm run ${command}`);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, 'run', command], {
        stdio: 'inherit',
        shell: false,
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
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
