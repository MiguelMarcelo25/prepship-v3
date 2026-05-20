import { readFileSync } from 'node:fs';

const checks = [];

function read(path) {
  return readFileSync(path, 'utf8');
}

function expect(name, condition) {
  checks.push({ name, condition: Boolean(condition) });
}

const packageJson = read('package.json');
const main = read('src/main.ts');
const route = read('src/routes/observability.ts');
const metrics = read('src/lib/http/api-metrics.ts');
const settingsView = read('web/src/components/Views/SettingsView.tsx');
const devTasks = read('DEV_TASKS_README.md');
const enterprise = read('ENTERPRISE_READINESS_AUDIT.md');
const observability = read('OBSERVABILITY_ALERTING_PLAN.md');

expect(
  'package exposes api observability metrics guard',
  packageJson.includes('"test:api-observability-metrics"')
);

expect(
  'main observes every API request timing',
  main.includes("import { observeApiTiming }") && main.includes('observeApiTiming({')
);

expect(
  'observability route is auth-protected',
  main.includes("'/observability'") &&
    main.includes("app.use('/observability', requireAdmin)") &&
    main.includes("app.use('/observability/*', requireAdmin)")
);

expect(
  'observability route is mounted',
  main.includes("import observabilityRoute") &&
    main.includes("app.route('/observability', observabilityRoute)")
);

expect(
  'api timing route exposes snapshot endpoint',
  route.includes("app.get('/api-timing'") &&
    route.includes('getApiTimingSnapshot()')
);

expect(
  'observability route exposes admin status endpoint',
  route.includes("app.get('/status'") &&
    route.includes('runSyncScheduler') &&
    route.includes('hotRoutes') &&
    route.includes('heapUsedBytes')
);

expect(
  'settings exposes system status panel backed by observability status',
  settingsView.includes("label: 'System Status'") &&
    settingsView.includes("'/observability/status'") &&
    settingsView.includes('systemStatus') &&
    settingsView.includes('Hot API Routes') &&
    settingsView.includes('Runtime Flags')
);

expect(
  'api timing snapshot includes p95 and p99 route stats',
  metrics.includes('p95Ms') &&
    metrics.includes('p99Ms') &&
    metrics.includes('recentSamples') &&
    metrics.includes('MAX_RECENT_DURATIONS') &&
    metrics.includes('MAX_BUCKETS')
);

expect(
  'phase tracker references api timing endpoint',
  devTasks.includes('/observability/api-timing') &&
    devTasks.includes('/observability/status') &&
    devTasks.includes('Settings System Status') &&
    devTasks.includes('test:api-observability-metrics')
);

expect(
  'enterprise audit references api timing endpoint',
  enterprise.includes('/observability/api-timing') &&
    enterprise.includes('/observability/status') &&
    enterprise.includes('test:api-observability-metrics')
);

expect(
  'observability plan references api timing endpoint',
  observability.includes('/observability/api-timing') &&
    observability.includes('/observability/status') &&
    observability.includes('Settings System Status')
);

const failed = checks.filter((check) => !check.condition);
if (failed.length) {
  console.error('API observability metrics guard failed:');
  for (const check of failed) console.error(`- ${check.name}`);
  process.exit(1);
}

console.log(`API observability metrics guard passed (${checks.length} checks).`);
