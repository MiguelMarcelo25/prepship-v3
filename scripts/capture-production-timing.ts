import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';

type ProbeResult = {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  sizeBytes?: number;
  error?: string;
  bodySummary?: unknown;
};

type DbReport = {
  ok: boolean;
  error?: string;
  activeConnections?: unknown[];
  lockSummary?: unknown[];
  slowStatements?: unknown[];
};

const apiBase = normalizeBaseUrl(
  process.env.PREPSHIP_API_BASE_URL ||
    process.env.RENDER_BASE_URL ||
    'https://prepshipv4-api-l5xc.onrender.com'
);
const webBase = normalizeBaseUrl(
  process.env.PREPSHIP_WEB_BASE_URL ||
    process.env.VERCEL_SHELL_URL ||
    'https://prepshipv4.vercel.app'
);
const token =
  process.env.PREPSHIP_API_TOKEN ||
  process.env.SUPABASE_ACCESS_TOKEN ||
  process.env.PROD_ADMIN_BEARER_TOKEN ||
  '';
const dbUrl = process.env.DATABASE_URL || '';
const outputPath =
  process.env.PS028_OUTPUT_JSON ||
  path.join('reports', `ps-028-production-timing-${timestampForFile()}.json`);

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function joinUrl(base: string, route: string): string {
  return `${base}${route.startsWith('/') ? route : `/${route}`}`;
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(token, '[redacted]') : String(error);
}

function summarizeBody(text: string): unknown {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return sanitizeJson(parsed);
  } catch {
    return text.slice(0, 160);
  }
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 10).map(sanitizeJson);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('credential') ||
      lower.includes('authorization') ||
      lower.includes('label') ||
      lower.includes('address') ||
      lower.includes('email') ||
      lower.includes('phone')
    ) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = sanitizeJson(raw);
  }
  return result;
}

function sanitizeSqlText(value: unknown): string {
  return String(value ?? '')
    .replace(/'([^']|'')*'/g, "'?'")
    .replace(/\b\d{4,}\b/g, '?')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

async function probe(name: string, url: string, auth = false): Promise<ProbeResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: auth && token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return {
      name,
      url,
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      sizeBytes: Buffer.byteLength(text),
      bodySummary: summarizeBody(text),
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: sanitizeError(error),
    };
  }
}

async function captureDb(): Promise<DbReport> {
  if (!dbUrl) {
    return { ok: false, error: 'DATABASE_URL not set; Supabase DB capture skipped.' };
  }

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    connection: { statement_timeout: 10_000 },
  });

  try {
    const [activeConnections, lockSummary, statementExtension] = await Promise.all([
      sql`
        select
          state,
          wait_event_type,
          wait_event,
          count(*)::int as count,
          max(extract(epoch from (now() - query_start)))::int as max_age_seconds
        from pg_stat_activity
        where datname = current_database()
        group by state, wait_event_type, wait_event
        order by count desc
        limit 25
      `,
      sql`
        select locktype, mode, granted, count(*)::int as count
        from pg_locks
        group by locktype, mode, granted
        order by count desc
        limit 25
      `,
      sql`
        select exists (
          select 1
          from pg_extension
          where extname = 'pg_stat_statements'
        ) as available
      `,
    ]);

    let slowStatements: unknown[] = [];
    if (statementExtension[0]?.available) {
      const rows = await sql`
        select
          calls::int as calls,
          round(total_exec_time::numeric, 2)::text as total_exec_time_ms,
          round(mean_exec_time::numeric, 2)::text as mean_exec_time_ms,
          round(max_exec_time::numeric, 2)::text as max_exec_time_ms,
          query
        from pg_stat_statements
        order by total_exec_time desc
        limit 20
      `;
      slowStatements = rows.map((row) => ({
        calls: row.calls,
        totalExecTimeMs: row.total_exec_time_ms,
        meanExecTimeMs: row.mean_exec_time_ms,
        maxExecTimeMs: row.max_exec_time_ms,
        queryShape: sanitizeSqlText(row.query),
      }));
    } else {
      slowStatements = [{ note: 'pg_stat_statements extension is not available.' }];
    }

    return {
      ok: true,
      activeConnections,
      lockSummary,
      slowStatements,
    };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const publicProbes = await Promise.all([
    probe('Vercel shell', joinUrl(webBase, '/')),
    probe('Vercel /api/health rewrite', joinUrl(webBase, '/api/health')),
    probe('Render /health', joinUrl(apiBase, '/health')),
    probe('Render /health/ready', joinUrl(apiBase, '/health/ready')),
    probe('Render /health/deep', joinUrl(apiBase, '/health/deep')),
  ]);

  const protectedProbes = token
    ? await Promise.all([
        probe('Render /observability/status', joinUrl(apiBase, '/observability/status'), true),
        probe('Render /observability/api-timing', joinUrl(apiBase, '/observability/api-timing'), true),
        probe('Render /sync/status', joinUrl(apiBase, '/sync/status'), true),
        probe('Render /worker/status', joinUrl(apiBase, '/worker/status'), true),
      ])
    : [
        {
          name: 'protected API probes',
          url: apiBase,
          ok: false,
          durationMs: 0,
          error:
            'Admin bearer token missing; set PREPSHIP_API_TOKEN, SUPABASE_ACCESS_TOKEN, or PROD_ADMIN_BEARER_TOKEN.',
        },
      ];

  const db = await captureDb();
  const report = {
    task: 'PS-028 authenticated production timing + Supabase pool capture',
    generatedAt: new Date().toISOString(),
    startedAt,
    bases: { webBase, apiBase },
    tokenPresent: Boolean(token),
    databaseUrlPresent: Boolean(dbUrl),
    publicProbes,
    protectedProbes,
    db,
    safety: {
      readOnly: true,
      noLiveLabels: true,
      noMarketplaceNotifications: true,
      secretsRedacted: true,
    },
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`PS-028 capture written to ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        publicOk: publicProbes.every((result) => result.ok),
        protectedOk: protectedProbes.every((result) => result.ok),
        dbOk: db.ok,
        tokenPresent: Boolean(token),
        databaseUrlPresent: Boolean(dbUrl),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('PS-028 capture failed:', sanitizeError(error));
  process.exit(1);
});
