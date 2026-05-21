type JsonObject = Record<string, unknown>;

type CheckResult = {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');
const jsonMode = args.has('--json');

const apiUrl = (
  process.env.PREPSHIP_API_URL ??
  'https://prepshipv4-api-l5xc.onrender.com'
).replace(/\/+$/, '');
const token = process.env.PREPSHIP_API_TOKEN ?? process.env.SUPABASE_ACCESS_TOKEN ?? '';
const sinceIso = process.env.PREPSHIP_SYNC_SINCE_ISO ?? '2026-05-21T06:00:00.000Z';

async function readJson(path: string, auth = false): Promise<{
  ok: boolean;
  status: number;
  data: unknown;
}> {
  const headers: Record<string, string> = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiUrl}${path}`, { headers });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    // Keep raw text for diagnostics.
  }
  return { ok: res.ok, status: res.status, data };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shortJson(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 180);
  return JSON.stringify(value).slice(0, 240);
}

function workerSummary(data: unknown): string {
  if (!isObject(data)) return shortJson(data);
  const worker = data.worker;
  if (!isObject(worker)) return shortJson(data);
  const status = worker.status;
  const stale = worker.stale;
  const heartbeatAgeSeconds = worker.heartbeatAgeSeconds;
  if (!isObject(status)) {
    return `worker status missing; stale=${String(stale)} heartbeatAgeSeconds=${String(heartbeatAgeSeconds)}`;
  }
  const jobs = isObject(status.jobs) ? status.jobs : {};
  const orderJob = jobs['prepship.sync.orders'] ?? jobs['orders sync'] ?? null;
  const shipmentJob = jobs['prepship.sync.shipments'] ?? jobs['shipments sync'] ?? null;
  const jobBits = [
    isObject(orderJob)
      ? `orders=${String(orderJob.status)}${orderJob.error ? ` error=${String(orderJob.error)}` : ''}`
      : 'orders=missing',
    isObject(shipmentJob)
      ? `shipments=${String(shipmentJob.status)}${shipmentJob.error ? ` error=${String(shipmentJob.error)}` : ''}`
      : 'shipments=missing',
  ];
  return [
    `mode=${String(status.mode)}`,
    `schedulerEnabled=${String(status.schedulerEnabled)}`,
    `placeholder=${String(status.placeholder)}`,
    `stale=${String(stale)}`,
    `heartbeatAgeSeconds=${String(heartbeatAgeSeconds)}`,
    ...jobBits,
  ].join(' ');
}

function syncSummary(data: unknown): string {
  if (!isObject(data)) return shortJson(data);
  const orders = isObject(data.orders) ? data.orders : data;
  const shipments = isObject(data.shipments) ? data.shipments : null;
  const worker = isObject(data.worker) ? data.worker : null;
  const bits = [
    `ordersLastSyncedAt=${String(orders.lastSyncedAt ?? data.lastSyncAt ?? 'unknown')}`,
  ];
  if (shipments) bits.push(`shipmentsLastSyncedAt=${String(shipments.lastSyncedAt ?? 'unknown')}`);
  if (worker) bits.push(workerSummary({ worker }));
  return bits.join(' ');
}

function ordersSummary(data: unknown): string {
  if (!isObject(data)) return shortJson(data);
  const total = data.total ?? data.count ?? data.totalCount ?? 'unknown';
  const orders = Array.isArray(data.orders)
    ? data.orders
    : Array.isArray(data.data)
      ? data.data
      : [];
  return `ordersSince=${sinceIso} total=${String(total)} returned=${orders.length}`;
}

async function main() {
  const results: CheckResult[] = [];

  try {
    const health = await readJson('/health');
    results.push({
      name: 'public health',
      status: health.ok && isObject(health.data) && health.data.status === 'ok' ? 'pass' : 'fail',
      detail: `HTTP ${health.status} ${shortJson(health.data)}`,
    });
  } catch (err) {
    results.push({
      name: 'public health',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (!token) {
    results.push({
      name: 'protected sync checks',
      status: 'warn',
      detail: 'Set PREPSHIP_API_TOKEN or SUPABASE_ACCESS_TOKEN to read /sync/status, /worker/status, and order freshness.',
    });
  } else {
    for (const check of [
      { name: 'sync status', path: '/sync/status', summarize: syncSummary },
      { name: 'worker status', path: '/worker/status', summarize: workerSummary },
      {
        name: 'orders since gap',
        path: `/orders?dateFrom=${encodeURIComponent(sinceIso)}&pageSize=1&page=1&includeTotal=true`,
        summarize: ordersSummary,
      },
    ]) {
      try {
        const res = await readJson(check.path, true);
        results.push({
          name: check.name,
          status: res.ok ? 'pass' : 'fail',
          detail: `HTTP ${res.status} ${check.summarize(res.data)}`,
        });
      } catch (err) {
        results.push({
          name: check.name,
          status: 'fail',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ apiUrl, sinceIso, results }, null, 2));
  } else {
    console.log('PrepShip Sync Status');
    console.log(`API: ${apiUrl}`);
    console.log(`Freshness threshold: ${sinceIso}`);
    for (const result of results) {
      console.log(`${result.status.toUpperCase().padEnd(4)} ${result.name}: ${result.detail}`);
    }
  }

  if (checkMode && results.some((result) => result.status === 'fail')) {
    process.exitCode = 1;
  }
}

void main();
