#!/usr/bin/env node
// PS-061: official safe shipping roundtrip certification gate.
//
// This runner intentionally uses only static/offline, fixture, and mock paths:
// no real labels, no postage purchase, no live marketplace notification, and
// no production shipped/cancelled mutation.

import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const notifyDryRun = args.has('--notify-dry-run');
const npmCommand = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const npmPrefix = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm'] : [];
const certificationChildNodeOptions =
  process.env.PREPSHIP_CERTIFICATION_CHILD_NODE_OPTIONS ?? process.env.NODE_OPTIONS;

const suites = [
  {
    key: 'shipping-certification-guard',
    command: [npmCommand, ...npmPrefix, 'run', 'guard:shipping-certification'],
    safety: 'static/read-only',
  },
  {
    key: 'fixture-label-smoke',
    command: [npmCommand, ...npmPrefix, 'run', 'smoke:shipping:test-label', '--', '--fixture'],
    safety: 'fixture-only',
  },
  {
    key: 'mock-marketplace-confirm',
    command: [npmCommand, ...npmPrefix, 'run', 'smoke:marketplace-confirm', '--', '--mock-process-once'],
    safety: 'in-memory mock',
  },
  {
    key: 'offline-workflow-suites',
    packageScript: 'test:workflow-suites',
    command: [process.execPath, 'scripts/run-workflow-certification.mjs'],
    safety: 'offline guards',
  },
];

const storeMatrix = [
  {
    client: 'HUGRAB',
    storeClass: 'Shopify via source connector',
    carrierClass: 'CarrierConnector label/rate fixture',
    label: 'fixture-only',
    outbox: 'required',
    marketplace: 'StoreConnector confirmation required',
    certified: 'offline',
    blocker: 'none',
  },
  {
    client: 'Walmart - DJC',
    storeClass: 'Walmart StoreConnector',
    carrierClass: 'Walmart/ShipStation carrier fixture',
    label: 'fixture-only',
    outbox: 'required',
    marketplace: 'Walmart mock payload guard',
    certified: 'offline',
    blocker: 'none',
  },
  {
    client: 'Tran Agency',
    storeClass: 'classified source connector',
    carrierClass: 'CarrierConnector label/rate fixture',
    label: 'fixture-only',
    outbox: 'required',
    marketplace: 'connector-classified mock path',
    certified: 'offline',
    blocker: 'none',
  },
  {
    client: 'KF Goods',
    storeClass: 'classified source connector',
    carrierClass: 'CarrierConnector label/rate fixture',
    label: 'fixture-only',
    outbox: 'required',
    marketplace: 'connector-classified mock path',
    certified: 'offline',
    blocker: 'none',
  },
];

function runSuite(suite) {
  const started = Date.now();
  const result = spawnSync(suite.command[0], suite.command.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      // Render Starter shares 512 MiB across the nested npm/Node process tree.
      // Keep the build unconstrained and opt in to a lower limit only for suite children.
      ...(certificationChildNodeOptions
        ? { NODE_OPTIONS: certificationChildNodeOptions }
        : {}),
      // Offline children import the normal app config tree. Supply inert values
      // when CI or a clean checkout has no local .env; real configured values
      // still win, and SAFE_MODE keeps every suite fixture/mock/read-only.
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      VERCEL: process.env.VERCEL ?? '1',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'https://example.supabase.co',
      PREPSHIP_CERTIFICATION_SAFE_MODE: '1',
    },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim();
  const tail = output.split(/\r?\n/).slice(-12).join('\n');
  return {
    ...suite,
    ok: result.status === 0,
    status: result.status ?? 1,
    durationMs: Date.now() - started,
    tail,
  };
}

function printTable(results) {
  console.log('\n[shipping-roundtrip-certification] suite results');
  console.table(results.map((result) => ({
    suite: result.key,
    status: result.ok ? 'PASS' : 'FAIL',
    safety: result.safety,
    durationMs: result.durationMs,
  })));
}

function printMatrix() {
  console.log('\n[shipping-roundtrip-certification] sanitized client/store matrix');
  console.table(storeMatrix);
}

function buildNotificationPayload(results) {
  const failed = results.filter((result) => !result.ok);
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  return {
    title: failed.length
      ? 'PrepShip shipping roundtrip certification failed'
      : 'PrepShip shipping roundtrip certification passed',
    status: failed.length ? 'failed' : 'passed',
    branch: process.env.GITHUB_REF_NAME ?? process.env.RENDER_GIT_BRANCH ?? 'local',
    commit: (process.env.GITHUB_SHA ?? process.env.RENDER_GIT_COMMIT ?? 'local').slice(0, 12),
    runUrl,
    failedSuites: failed.map((result) => ({
      suite: result.key,
      status: result.status,
      tail: result.tail.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]'),
    })),
    matrix: storeMatrix,
    safety: 'fixture/mock/offline only; no labels, postage, live marketplace notifications, or production shipped/cancelled mutations',
  };
}

async function sendFailureNotification(payload) {
  if (payload.status !== 'failed') return;
  const url = process.env.PREPSHIP_CERTIFICATION_WEBHOOK_URL;
  if (!url) {
    console.log('\n[shipping-roundtrip-certification] PREPSHIP_CERTIFICATION_WEBHOOK_URL not set; failure notification skipped.');
    return;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`failure notification webhook returned HTTP ${response.status}`);
  }
  console.log('\n[shipping-roundtrip-certification] failure notification sent.');
}

const results = suites.map(runSuite);
printTable(results);
printMatrix();

for (const result of results.filter((entry) => !entry.ok)) {
  console.log(`\n[shipping-roundtrip-certification] ${result.key} failed tail:`);
  console.log(result.tail || '(no output)');
}

const payload = buildNotificationPayload(results);
if (notifyDryRun) {
  console.log('\n[shipping-roundtrip-certification] notify dry-run payload');
  console.log(JSON.stringify(payload, null, 2));
} else {
  await sendFailureNotification(payload);
}

if (results.some((result) => !result.ok)) {
  process.exit(1);
}

console.log('\nPASS shipping roundtrip certification');
