import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'OBSERVABILITY_ALERTING_PLAN.md';
const plan = fs.readFileSync(path.join(root, planPath), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const ordersRoute = fs.readFileSync(path.join(root, 'src/routes/orders.ts'), 'utf8');
const browserApi = fs.readFileSync(path.join(root, 'web/src/lib/api.ts'), 'utf8');
const corsHelper = fs.readFileSync(path.join(root, 'src/lib/http/cors.ts'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const requiredHeadings = [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Signal Matrix',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredSignals = [
  'API 5xx rate',
  'API latency',
  'API 499/timeouts',
  'Slow DB queries',
  'Supabase pool pressure',
  'Worker heartbeat',
  'Sync jobs',
  'Rate calls',
  'Label creation',
  'Billing generation',
  'Inventory/reporting refresh',
  'Frontend runtime errors',
];

for (const signal of requiredSignals) {
  assert(plan.includes(signal), `${planPath} tracks ${signal}`);
}

const requiredControls = [
  'request IDs',
  'structured logs',
  'provider/account',
  'p95/p99',
  'response-size',
  'alert thresholds',
  'runbook',
  'release/build version',
  'notify-only',
  'No alert should include secrets',
];

for (const control of requiredControls) {
  assert(plan.toLowerCase().includes(control.toLowerCase()), `${planPath} covers ${control}`);
}

assert(
  packageJson.scripts?.['test:observability-alerting'] ===
    'node scripts/observability-alerting-guard.mjs',
  'package exposes observability alerting guard'
);

assert(main.includes('X-Request-Id'), 'API returns X-Request-Id response header');
assert(main.includes('normalizeRequestId'), 'API normalizes incoming request IDs');
assert(main.includes("c.get('requestId')"), 'API timing/error logs include request ID');
assert(main.includes('exposeHeaders'), 'API exposes request/timing headers to browsers');
assert(main.includes("'[api:error]'"), 'API has structured error log marker');
assert(main.includes("'[api:timing]'"), 'API has structured timing log marker');
assert(ordersRoute.includes('requestIdFromContext'), 'orders list timing logs read request ID');
assert(ordersRoute.includes("'[orders:list] completed'"), 'orders list has structured completed log marker');
assert(ordersRoute.includes("'[orders:list] failed'"), 'orders list has structured failed log marker');
assert(ordersRoute.includes('requestId: requestId'), 'orders list logs include request ID');
assert(browserApi.includes('class ApiRequestError'), 'browser API errors preserve request IDs');
assert(browserApi.includes("finalHeaders['X-Request-Id']"), 'browser API sends X-Request-Id');
assert(browserApi.includes("res.headers.get('x-request-id')"), 'browser API reads response request ID');
assert(corsHelper.includes('X-Request-Id'), 'shared CORS helper allows request ID header');
assert(corsHelper.includes('Access-Control-Expose-Headers'), 'shared CORS helper exposes response request ID header');
