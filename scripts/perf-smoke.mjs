import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || process.env.PERF_DRY_RUN === '1';
const jsonOnly = args.has('--json');
const allowFailures = args.has('--allow-failures') || process.env.PERF_ALLOW_FAILURES === '1';
const baseUrl = normalizeBaseUrl(process.env.PERF_BASE_URL || 'http://127.0.0.1:4173');
const timeoutMs = parsePositiveInt(process.env.PERF_TIMEOUT_MS, 10_000);
const warnMs = parsePositiveInt(process.env.PERF_WARN_MS, 2_500);
const outputJson = process.env.PERF_OUTPUT_JSON || path.join('reports', 'perf-smoke-current.json');

const routes = [
  {
    id: 'root-login-shell',
    path: '/',
    owner: 'public app shell',
    note: 'Root/login shell should return the app without credentials.',
  },
  {
    id: 'orders-awaiting',
    path: '/orders/awaiting_shipment',
    owner: 'orders',
    note: 'Protected route may return app shell or auth redirect; 5xx is a failure.',
  },
  {
    id: 'orders-shipped',
    path: '/orders/shipped',
    owner: 'orders',
    note: 'Protected route may return app shell or auth redirect; 5xx is a failure.',
  },
  {
    id: 'inventory-stock-levels',
    path: '/inventory/stock-levels',
    owner: 'inventory',
    note: 'Inventory stock page shell smoke check.',
  },
  {
    id: 'dashboard',
    path: '/dashboard',
    owner: 'dashboard',
    note: 'Dashboard shell smoke check.',
  },
  {
    id: 'settings',
    path: '/settings',
    owner: 'settings',
    note: 'Settings shell smoke check.',
  },
  {
    id: 'billing',
    path: '/billing',
    owner: 'billing',
    note: 'Billing shell smoke check.',
  },
  {
    id: 'manifest',
    path: '/manifest',
    owner: 'manifests',
    note: 'Manifest page shell smoke check.',
  },
];

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function routeUrl(route) {
  return `${baseUrl}${route.path === '/' ? '/' : route.path}`;
}

function classifyStatus(status) {
  if (status >= 500) return 'fail';
  if ([401, 403].includes(status)) return 'auth-gated';
  if (status >= 200 && status < 400) return 'pass';
  if (status >= 400) return 'warn';
  return 'warn';
}

function safeHeaders(headers) {
  return {
    contentType: headers.get('content-type') || null,
    cacheControl: headers.get('cache-control') || null,
    serverTiming: headers.get('server-timing') || null,
  };
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'prepship-perf-smoke/1.0',
      },
    });
    const durationMs = Math.round(performance.now() - started);
    const body = await response.text();
    const bodySample = body.slice(0, 120).replace(/\s+/g, ' ').trim();
    return {
      status: response.status,
      finalUrl: response.url,
      durationMs,
      bytes: Buffer.byteLength(body),
      headers: safeHeaders(response.headers),
      bodyKind: body.includes('<div id="root"') ? 'vite-app-shell' : response.headers.get('content-type') || 'unknown',
      bodySample,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    return {
      status: null,
      finalUrl: url,
      durationMs,
      bytes: 0,
      headers: {},
      bodyKind: 'network-error',
      error: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function smokeRoute(route) {
  const url = routeUrl(route);
  const result = await fetchWithTimeout(url);
  const statusClass = result.status == null ? 'fail' : classifyStatus(result.status);
  const durationClass = result.durationMs > warnMs ? 'slow' : 'ok';
  return {
    ...route,
    url,
    checkedAt: new Date().toISOString(),
    result: statusClass === 'pass' && durationClass === 'slow' ? 'warn' : statusClass,
    durationClass,
    ...result,
  };
}

function summarize(results) {
  const counts = {
    pass: results.filter((entry) => entry.result === 'pass').length,
    warn: results.filter((entry) => entry.result === 'warn').length,
    authGated: results.filter((entry) => entry.result === 'auth-gated').length,
    fail: results.filter((entry) => entry.result === 'fail').length,
    slow: results.filter((entry) => entry.durationClass === 'slow').length,
  };
  const durations = results
    .map((entry) => entry.durationMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    baseUrl,
    routeCount: results.length,
    timeoutMs,
    warnMs,
    counts,
    maxDurationMs: durations.at(-1) || 0,
    avgDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    generatedAt: new Date().toISOString(),
  };
}

function printHuman(report) {
  console.log('PrepShip production performance smoke');
  console.log(`Base URL: ${report.summary.baseUrl}`);
  console.log(`Routes: ${report.summary.routeCount}`);
  console.log(`Timeout: ${report.summary.timeoutMs}ms`);
  console.log(`Slow warning: >${report.summary.warnMs}ms`);
  console.log('');

  for (const entry of report.routes) {
    const status = entry.status == null ? 'ERR' : entry.status;
    const marker = entry.result === 'fail' ? 'FAIL' : entry.result === 'warn' ? 'WARN' : 'OK';
    console.log(
      `${marker.padEnd(4)} ${entry.id.padEnd(24)} ${String(status).padEnd(4)} ${String(entry.durationMs).padStart(5)}ms ${entry.path}`,
    );
    if (entry.error) console.log(`     error: ${entry.error}`);
    if (entry.durationClass === 'slow') console.log(`     warning: route exceeded ${report.summary.warnMs}ms`);
  }

  console.log('');
  console.log(
    `Summary: pass=${report.summary.counts.pass} auth-gated=${report.summary.counts.authGated} warn=${report.summary.counts.warn} fail=${report.summary.counts.fail} slow=${report.summary.counts.slow}`,
  );
  console.log(`Average duration: ${report.summary.avgDurationMs}ms`);
  console.log(`Max duration: ${report.summary.maxDurationMs}ms`);
  if (report.outputJson) console.log(`JSON artifact: ${report.outputJson}`);
}

function writeJsonArtifact(report) {
  if (!outputJson || outputJson === '0' || outputJson.toLowerCase() === 'false') return null;
  const outputPath = path.isAbsolute(outputJson) ? outputJson : path.join(root, outputJson);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return path.relative(root, outputPath);
}

if (dryRun) {
  const report = {
    mode: 'dry-run',
    summary: {
      baseUrl,
      routeCount: routes.length,
      timeoutMs,
      warnMs,
      generatedAt: new Date().toISOString(),
    },
    routes: routes.map((route) => ({ ...route, url: routeUrl(route) })),
    outputJson: null,
  };
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('PrepShip production performance smoke dry run');
    console.log(`Base URL: ${baseUrl}`);
    for (const route of report.routes) {
      console.log(`- ${route.id}: ${route.url}`);
    }
    console.log('No network requests were made. Start a preview server for a full smoke run.');
  }
  process.exit(0);
}

const routesReport = [];
for (const route of routes) {
  routesReport.push(await smokeRoute(route));
}

const report = {
  mode: 'http-smoke',
  summary: summarize(routesReport),
  routes: routesReport,
  outputJson: null,
};
report.outputJson = writeJsonArtifact(report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

if (!allowFailures && report.summary.counts.fail > 0) {
  process.exitCode = 1;
}

if (report.summary.counts.fail > 0 && process.env.PERF_ALLOW_FAILURES !== '1') {
  process.exit(1);
}
