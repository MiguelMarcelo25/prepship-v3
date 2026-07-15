import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const watchdogPath = 'scripts/production-watchdog.mjs';
const operationalRunbookPath = 'OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md';
const observabilityPlanPath = 'OBSERVABILITY_ALERTING_PLAN.md';
const healthRoutePath = 'src/routes/health.ts';
const workflowPath = '.github/workflows/production-watchdog.yml';

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const operationalRunbook = fs.readFileSync(path.join(root, operationalRunbookPath), 'utf8');
const observabilityPlan = fs.readFileSync(path.join(root, observabilityPlanPath), 'utf8');
const watchdog = fs.existsSync(path.join(root, watchdogPath))
  ? fs.readFileSync(path.join(root, watchdogPath), 'utf8')
  : '';
const healthRoute = fs.existsSync(path.join(root, healthRoutePath))
  ? fs.readFileSync(path.join(root, healthRoutePath), 'utf8')
  : '';
const workflow = fs.existsSync(path.join(root, workflowPath))
  ? fs.readFileSync(path.join(root, workflowPath), 'utf8')
  : '';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

assert(watchdog.length > 0, `${watchdogPath} exists`);
assert(healthRoute.length > 0, `${healthRoutePath} exists`);

const requiredWatchdogTokens = [
  'VERCEL_SHELL_URL',
  'RENDER_BASE_URL',
  '/health',
  '/health/ready',
  '/health/deep',
  'WATCHDOG_ALERT_WEBHOOK_URL',
  'WATCHDOG_ALERT_COOLDOWN_MS',
  'WATCHDOG_SYNC_STATUS_URL',
  'WATCHDOG_CRON_SECRET',
  'WATCHDOG_FAILURE_THRESHOLD',
  'WATCHDOG_RESTART_COOLDOWN_MS',
  'WATCHDOG_MAX_RESTARTS_PER_HOUR',
  'WATCHDOG_STATE_FILE',
  'RENDER_DEPLOY_HOOK_URL',
  'RENDER_API_KEY',
  'RENDER_SERVICE_ID',
  'alert-only',
  'consecutiveFailures',
  'cooldown',
  'maxRestartsPerHour',
  'redact',
  'lastAlertsByState',
  'Shipment sync freshness',
];

for (const token of requiredWatchdogTokens) {
  assert(watchdog.includes(token), `${watchdogPath} includes ${token}`);
}

assert(
  watchdog.includes('WATCHDOG_ALLOW_RESTARTS') || watchdog.includes('WATCHDOG_RESTART_MODE'),
  `${watchdogPath} requires an explicit restart/redeploy env gate`
);

assert(
  /const DEFAULT_TIMEOUT_MS = 15_000/.test(watchdog),
  `${watchdogPath} default timeout must exceed the 12s deep-health component timeout`
);

assert(
  /check\.name !== 'Render \/health\/deep'/.test(watchdog),
  `${watchdogPath} requires /health/ready while keeping /health/deep diagnostic`
);

assert(
  /cron: '\*\/5 \* \* \* \*'/.test(workflow) &&
    workflow.includes('actions/cache/restore@v4') &&
    workflow.includes('actions/cache/save@v4'),
  `${workflowPath} runs every five minutes with persistent cooldown state`
);

assert(
  /max:\s*[3-9]/.test(healthRoute),
  `${healthRoutePath} health SQL pool must allow concurrent db/orders/printQueue checks`
);

assert(
  watchdog.includes('process.env') && !watchdog.includes('console.log(process.env'),
  `${watchdogPath} does not dump process.env`
);

assert(
  packageJson.scripts?.['watchdog:production'] === 'node scripts/production-watchdog.mjs',
  'package exposes production watchdog runner'
);

assert(
  packageJson.scripts?.['test:production-watchdog'] === 'node scripts/production-watchdog-guard.mjs',
  'package exposes production watchdog guard'
);

const requiredDocTokens = [
  'Production Watchdog',
  'Render dashboard restart',
  'deploy hook',
  'Render API',
  'alert-only',
  'consecutive failure',
  'cooldown',
  'max restarts per hour',
  'manual fallback',
  'no secrets',
];

for (const token of requiredDocTokens) {
  assert(
    operationalRunbook.toLowerCase().includes(token.toLowerCase()) ||
      observabilityPlan.toLowerCase().includes(token.toLowerCase()),
    `docs cover ${token}`
  );
}
