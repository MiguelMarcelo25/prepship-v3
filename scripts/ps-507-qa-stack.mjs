/**
 * PS-507 — the disposable QA stack.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The existing Playwright suite boots `dev:web` and mocks every request through
 * `page.route`, with a dummy anon key and a hand-seeded session. That proves frontend
 * BEHAVIOUR and nothing else: it cannot show that an authenticated workflow committed
 * the right PostgreSQL row, avoided a forbidden sidecar write, or survived a real API
 * round trip. PS-499 Step 12 and PS-488 M3 both need exactly that evidence, and today
 * it is produced by a human following docs/ps-499-step12-qa-runbook.md by hand.
 *
 * This provisions the real thing, disposably:
 *
 *   database  isolated PGlite behind a loopback PostgreSQL socket, migrated with the
 *             repo's own drizzle migrations. Dropped on teardown by ending the process —
 *             there is no long-lived database to clean rows out of.
 *   auth      a per-run RANDOM SUPABASE_JWT_SECRET plus HS256 tokens minted against it.
 *   api       the real src/main.ts, on its own port, pointed at the disposable database.
 *   frontend  the real Vite app, on its own port, pointed at the disposable API.
 *
 * WHY NOT A REAL SUPABASE AUTH PROJECT
 *
 * The card names "throwaway Supabase Auth project" as the canonical truth. The API
 * verifies HS256 bearer tokens against SUPABASE_JWT_SECRET
 * (src/lib/auth/verify-supabase-jwt.ts:75-82, tried first for HS* tokens), so a token
 * minted here traverses the identical verification path a Supabase-issued one would.
 * Provisioning a real project per run would add cost, latency and a credential to
 * manage while testing Supabase's issuer rather than OUR boundary.
 *
 * What that does NOT cover, stated so nobody over-claims it: Supabase's own token
 * issuance, refresh and JWKS rotation. Those are the vendor's boundary, not the one
 * PS-499 and PS-488 need proven. Everything downstream of "a valid bearer arrives" is
 * exercised for real.
 *
 * FAIL-CLOSED
 *
 * Refuses to run unless NODE_ENV=test. Refuses any DATABASE_URL that is not loopback,
 * and rejects outright anything naming a managed provider or a production host. Ports
 * are dedicated and deliberately NOT 5177 — that port is contended by other agents'
 * env-less vite servers, and borrowing it is how an e2e run silently tests the wrong app.
 * Secrets are redacted from anything this prints.
 *
 *   node scripts/ps-507-qa-stack.mjs --print-env     # provision, print env, keep running
 *   node scripts/ps-507-qa-stack.mjs -- npx playwright test web/e2e/ps-507-*.spec.js
 */
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const HOST = '127.0.0.1';
// Dedicated, and deliberately not 5177. See the header.
const PG_PORT = Number(process.env.PS507_PG_PORT ?? 55507);
const API_PORT = Number(process.env.PS507_API_PORT ?? 45507);
const WEB_PORT = Number(process.env.PS507_WEB_PORT ?? 35507);
const QUERY_PORT = Number(process.env.PS507_QUERY_PORT ?? 25507);

// ── Fail-closed gates ────────────────────────────────────────────────────────

/** Anything that smells of a managed provider or a real deployment is refused outright. */
const BANNED_HOST_MARKERS = [
  'supabase.co', 'supabase.com', 'pooler', 'render.com', 'onrender.com',
  'vercel.app', 'rds.amazonaws', 'neon.tech', 'azure', 'planetscale',
];

export function assertDisposableTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('STOP: QA target is not a valid URL');
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback) {
    throw new Error(
      `STOP: refusing host "${host}". The QA stack provisions and destroys a database and ` +
        'authenticates real API calls; only loopback is permitted.',
    );
  }
  for (const marker of BANNED_HOST_MARKERS) {
    if (url.toLowerCase().includes(marker)) {
      throw new Error(`STOP: QA target mentions "${marker}"; this must be a disposable local stack.`);
    }
  }
}

export function assertTestEnvironment(envValue) {
  if (envValue !== 'test') {
    throw new Error(`STOP: NODE_ENV must be "test" to provision the QA stack (got "${envValue ?? 'unset'}").`);
  }
}

/** Never print a secret. Used for every line this module emits. */
export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

// ── Throwaway auth ───────────────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Mint an HS256 bearer the API will genuinely verify.
 *
 * Deliberately a real signature over real claims, not a stub the app is taught to
 * accept: the point of PS-507 is that nothing on the persistence path is mocked. A
 * wrong secret here produces a 401 from the real middleware, which is the correct
 * failure and worth having.
 */
export function mintQaToken({
  secret, sub, email, role = 'admin', permissions = [], ttlSeconds = 3600, extraClaims = {},
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub, email, role,
    // Role and permissions ride in app_metadata because that is where the real
    // middleware looks first (auth.ts:111-131). Permissions default to EMPTY, not to an
    // admin set: a spec that needs financials:write must say so, which keeps QA users
    // least-privilege and makes an authorisation regression fail loudly instead of being
    // masked by a blanket token.
    app_metadata: { role, permissions },
    aud: 'authenticated',
    iat: now,
    exp: now + ttlSeconds,
    ...extraClaims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

// ── Provisioning ─────────────────────────────────────────────────────────────

// ── Schema construction ──────────────────────────────────────────────────────

/**
 * Tables PrepShip READS but does not own, so no migration in this repo creates them.
 *
 * `returns` and `return_activity_events` belong to the Client Portal repo
 * (src/db/schema/returns.ts:12-18 states the ownership explicitly). On production they
 * already exist; on a fresh disposable database nothing would create them, and their
 * absence cascades — 0088 and 0089 fail, and 0092 then refuses because the 0089 shape
 * is not present.
 *
 * Deliberately created in their PRE-0088 shape, WITHOUT the billing-date-override
 * columns. That lets 0088 add them, 0089 add return_id, and 0092 reconcile the identity
 * contract exactly as they did in production, so the QA database exercises the real
 * migration path instead of being hand-assembled into its final state.
 */
export async function bootstrapForeignOwnedTables(pg, log = console.log) {
  await pg.exec(`
    create table if not exists returns (
      id serial primary key,
      order_id integer not null,
      client_id integer,
      return_shipment_id integer,
      return_to_location_id integer,
      status text not null,
      initiated_by text not null,
      initiated_by_email text,
      reason text,
      admin_override boolean not null default false,
      admin_override_by text,
      admin_override_reason text,
      requested_at timestamptz not null default now(),
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      delivery_method text,
      delivery_status text,
      delivery_error text,
      return_reference text,
      return_customer_shipping_rate numeric(10,2),
      return_recipient_name text
    );
    create table if not exists return_activity_events (
      id serial primary key,
      return_id integer not null,
      shipment_id integer,
      event_type text not null,
      status text,
      detail text,
      actor_type text not null,
      actor_email text,
      event_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    );
  `);
  log('[ps-507] bootstrapped Client-Portal-owned tables (returns, return_activity_events)');
}

/**
 * Migrations this repo cannot apply to PGlite, each tolerated for a NAMED reason.
 *
 * An explicit allowlist rather than a pattern match: a migration that starts failing for
 * a new reason must be fatal, not absorbed. None of these affect the correctness this
 * harness proves — they are index concurrency, Supabase-only roles, an unavailable
 * extension, and RLS on tables this repo does not own.
 */
const TOLERATED_MIGRATION_FAILURES = new Map([
  ['0018e_indexes.sql', {
    reason: 'CREATE INDEX CONCURRENTLY cannot run in PGlite\'s implicit transaction; indexes are performance, not correctness',
    expect: /CONCURRENTLY cannot run inside a transaction block/i,
  }],
  ['0039_fk_covering_indexes.sql', {
    reason: 'same CONCURRENTLY constraint',
    expect: /CONCURRENTLY cannot run inside a transaction block/i,
  }],
  ['0037_rls_reporting_metrics_inbound.sql', {
    reason: 'RLS over inbound_shipments, a table this repo does not own',
    expect: /relation "public.inbound_shipments" does not exist/i,
  }],
  ['0045_revoke_public_api_grants.sql', {
    reason: 'revokes from the Supabase `anon` role, which does not exist on PGlite',
    expect: /role "anon" does not exist/i,
  }],
  ['0069_public_billing_rls_hardening.sql', {
    reason: 'same Supabase-only role',
    expect: /role "anon" does not exist/i,
  }],
  ['0058_search_trgm_indexes.sql', {
    reason: 'pg_trgm extension is not available in PGlite',
    expect: /could not open extension control file|extension "pg_trgm" is not available/i,
  }],
  ['0094_pin_function_search_path.sql', {
    // pg-boss creates its own schema and functions at RUNTIME, from the library, not from
    // any migration in this repo. The QA stack never starts the worker
    // (RUN_SYNC_SCHEDULER=false), so the schema legitimately does not exist and there is
    // nothing to pin. Nothing this harness proves touches pg-boss.
    reason: 'pgboss schema is created by the pg-boss library at runtime; the QA stack never starts the worker',
    expect: /schema "pgboss" does not exist/i,
  }],
]);

/**
 * 0104/0105 split their non-transactional tail (CREATE INDEX CONCURRENTLY, ADD CONSTRAINT
 * ... NOT VALID, VALIDATE CONSTRAINT) across a transaction boundary in production. PGlite runs
 * each `exec` in one implicit transaction and cannot take that split, but — unlike the
 * tolerated-and-skipped performance indexes of 0018e/0039 — the API this stack boots asserts
 * every one of these objects at readiness (the occurrence table/columns, its 5 indexes, and the
 * two claim CHECKs), so they cannot be skipped. On this fresh, empty in-memory database a plain
 * CREATE INDEX and an immediately-validated CHECK are outcome-identical to the concurrent/deferred
 * production forms, and the now-redundant standalone VALIDATE has nothing to do — so rewrite
 * exactly those two named files (and no others) to their transaction-safe equivalent.
 */
const PGLITE_TXN_SAFE_REWRITES = new Set([
  '0104_ps497_fulfillment_occurrences.sql',
  '0105_ps497_claim_not_applicable_status.sql',
]);

function toPgliteTransactionSafe(file, sql) {
  if (!PGLITE_TXN_SAFE_REWRITES.has(file)) return sql;
  return sql
    .replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/gi, 'CREATE $1INDEX')
    .replace(/\s+NOT\s+VALID\b/gi, '')
    .replace(/ALTER\s+TABLE[^;]*?\bVALIDATE\s+CONSTRAINT\b[^;]*?;/gi, '');
}

/**
 * Apply every migration in ./drizzle, in filename order.
 *
 * NOT the drizzle migrator. The journal (drizzle/meta/_journal.json) holds 16 entries
 * against 104 .sql files on disk — it stops at 0015 — so `drizzle-kit migrate` builds
 * only a fraction of the schema and the API then refuses to boot with a long
 * missing-relation list. Everything from 0016 on is applied to production by other
 * means, which is also why 0092 needed its own operator runner rather than db:migrate.
 *
 * Fail-closed: anything failing for a reason not in the allowlist aborts provisioning.
 */
export async function applyAllMigrations(pg, log = console.log) {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  const tolerated = [];

  for (const file of files) {
    const sql = readFileSync(`drizzle/${file}`, 'utf8');
    try {
      await pg.exec(toPgliteTransactionSafe(file, sql).replace(/-->\s*statement-breakpoint/g, ';'));
      applied.push(file);
    } catch (error) {
      const entry = TOLERATED_MIGRATION_FAILURES.get(file);
      const message = String(error && error.message || error).split('\n')[0];
      if (process.env.PS507_DUMP_MIGRATION_ERRORS) log(`[ps-507] tolerated? ${file} :: ${message}`);
      if (!entry) {
        throw new Error(`STOP: migration ${file} failed for an untolerated reason:\n  ${message}`);
      }
      // The allowlist matches the REASON as well as the name. Name-only tolerance would
      // absorb a migration that starts failing for a new cause — precisely the case the
      // allowlist exists to catch — so a known file failing an unknown way is still fatal.
      if (!entry.expect.test(message)) {
        throw new Error(
          `STOP: migration ${file} is tolerated, but failed for a DIFFERENT reason than the ` +
            `one on record.\n  expected: ${entry.expect}\n  actual  : ${message}`,
        );
      }
      tolerated.push({ file, reason: entry.reason });
    }
  }

  log(`[ps-507] migrations: ${applied.length} applied, ${tolerated.length} tolerated`);
  for (const t of tolerated) log(`[ps-507]   skipped ${t.file} — ${t.reason}`);
  return { applied: applied.length, tolerated };
}

/**
 * A loopback, test-only SQL endpoint over the in-process database.
 *
 * WHY THIS EXISTS. PGlite's socket serves ONE connection and the API holds it, so a
 * Playwright process cannot open its own connection to assert what was committed. Without
 * this, "did the row land" could only be inferred from the UI — which is precisely the
 * inference PS-507 exists to stop tests making.
 *
 * The surface is deliberately small and gated four ways: bound to 127.0.0.1 only, the
 * remote address is re-checked per request, a per-run random token is required, and the
 * whole thing only ever runs under NODE_ENV=test against an in-memory database that dies
 * with the process. It is never reachable from another host and there is nothing durable
 * behind it.
 */
export function startQueryEndpoint(queryClient, { port, token, log = console.log }) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const remote = req.socket.remoteAddress ?? '';
      if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) {
        return reply(403, { error: 'loopback only' });
      }
      if (req.headers['x-ps507-token'] !== token) {
        return reply(401, { error: 'bad or missing x-ps507-token' });
      }
      if (req.method !== 'POST' || !req.url.startsWith('/query')) {
        return reply(404, { error: 'POST /query only' });
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try {
        const { sql, params } = JSON.parse(raw || '{}');
        if (typeof sql !== 'string' || !sql.trim()) return reply(400, { error: 'sql required' });
        // Over the SOCKET, deliberately, rather than the in-process PGlite handle.
        //
        // PGlite is single-threaded. An in-process pg.query() interleaving with queries
        // the socket server is serving produced rare, unattributable failures in whatever
        // request happened to be in flight — a spec's own read-back could knock over an
        // unrelated GET the browser had just issued. Routing through the socket puts every
        // reader behind the same queue, at the cost of one connection.
        // `prepare: true` is load-bearing, not a tuning knob.
        //
        // postgres.js defaults unsafe() to prepare:false, which uses the UNNAMED prepared
        // statement (""). PGlite serves every socket connection from one instance and that
        // unnamed slot is shared across them, so a concurrent query from the API's own
        // pool overwrites this one between parse and bind. On CI that surfaced as
        // `bind message supplies 1 parameters, but prepared statement "" requires 8` —
        // the 8 belonging to a completely unrelated API query. A named statement gets its
        // own slot. With no parameters postgres.js uses the simple protocol and never
        // binds at all, so that path is unaffected either way.
        const rows = await queryClient.unsafe(sql, params ?? [], { prepare: true });
        reply(200, { rows: Array.from(rows) });
      } catch (error) {
        reply(500, { error: String(error && error.message || error).split('\n')[0] });
      }
    });
    server.listen(port, HOST, () => {
      log(`[ps-507] query     : http://${HOST}:${port}/query (loopback, token-gated)`);
      resolve(server);
    });
  });
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401 || res.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`STOP: ${label} did not become reachable at ${url} within ${timeoutMs}ms`);
}

/**
 * Run a seeder over the socket BEFORE the API boots.
 *
 * Seeding BEFORE the API boots keeps the fixtures honest: they run UNMODIFIED, interlocks
 * and all, against a database nothing else is touching, instead of being forked into
 * QA-only variants that could drift from what their runbooks describe. It also means a
 * fixture's own uniqueness and FK errors surface as fixture output rather than as
 * mid-suite API failures.
 */
async function runSeeder({ label, argv, databaseUrl, env = {}, log }) {
  // ASYNC spawn, never spawnSync.
  //
  // The PGLite socket server runs in THIS process's event loop. spawnSync blocks that
  // loop for the child's whole lifetime, so the server cannot accept the connection the
  // child is opening — the seeder then dies with CONNECT_TIMEOUT against a socket that
  // is up and healthy. A self-inflicted deadlock that reads exactly like a database
  // fault, which is why it is called out here.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli(), ...argv], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`STOP: seeder ${label} exited ${code}\n${(stderr || stdout).slice(-800)}`));
        return;
      }
      log(`[ps-507] seeded    : ${label}`);
      resolve(stdout);
    });
  });
}

export async function provisionQaStack({ withFrontend = true, seeders = [], log = console.log } = {}) {
  assertTestEnvironment(process.env.NODE_ENV);

  // The advertised database NAME carries a disposable marker on purpose.
  //
  // scripts/ps-499-step12-qa-fixture.ts refuses to --apply unless the name matches
  // ps499 / qa / test / disposable / scratch, alongside loopback, NODE_ENV=test and a
  // confirmation token. That guard exists so nobody seeds fixtures into a real or a
  // developer's valuable database. This name is accurate rather than a way around it:
  // the database is in-memory and dies with the process.
  //
  // PGlite's socket serves the same instance whatever dbname is requested — verified —
  // so this is purely how the stack DECLARES what it is, and it lets the real Step 12
  // seeder run unmodified instead of being forked for QA.
  const databaseUrl = `postgres://postgres:postgres@${HOST}:${PG_PORT}/prepship_ps507_qa`;
  const apiUrl = `http://${HOST}:${API_PORT}`;
  const webUrl = `http://${HOST}:${WEB_PORT}`;
  assertDisposableTarget(databaseUrl);
  assertDisposableTarget(apiUrl);
  assertDisposableTarget(webUrl);

  // Per-run secret. Regenerated every provision so a leaked value from one run cannot
  // authenticate against another, and so nothing here is ever a committed constant.
  const jwtSecret = randomBytes(48).toString('hex');
  const runId = `ps507-${randomBytes(4).toString('hex')}`;

  log(`[ps-507] run ${runId}`);
  log(`[ps-507] jwt secret : ${redact(jwtSecret)}`);

  const pg = await PGlite.create();

  // Schema is built IN-PROCESS, before the socket server starts.
  //
  // Not a style choice: it keeps provisioning failures legible. A migration fault raises
  // here, with the failing statement, instead of surfacing later as a socket-level
  // `read ECONNRESET` inside verifyRuntimeSchema — which reads like a database fault
  // rather than a provisioning one.
  await bootstrapForeignOwnedTables(pg, log);
  const migrationReport = await applyAllMigrations(pg, log);

  // maxConnections defaults to 1, and the API is not a single-connection client: the main
  // Drizzle pool, the health probe pool (`max: 3`), the advisory lock, the sync queue, the
  // lane lock, the stuck-job reaper and worker-status each construct their own postgres()
  // client. At the default the second connection is refused, which tore down the active
  // socket mid-request — `/health/ready` answered 503, the app rendered the maintenance
  // page instead of the shell, and bulk-import PATCHes failed intermittently with a
  // driver-level "Failed query". The pool sizes are the real budget; this only has to be
  // above their sum. Queries are queued per-query, so extra connections idle cheaply.
  const pgServer = new PGLiteSocketServer({ db: pg, port: PG_PORT, host: HOST, maxConnections: 6 });
  await pgServer.start();
  log(`[ps-507] database  : ${databaseUrl} (disposable, in-memory)`);

  // Per-run token, so a stray local process cannot query the QA database even on loopback.
  const queryToken = randomBytes(24).toString('hex');
  const queryUrl = `http://${HOST}:${QUERY_PORT}/query`;
  assertDisposableTarget(queryUrl);
  const queryClient = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const queryServer = await startQueryEndpoint(queryClient, { port: QUERY_PORT, token: queryToken, log });

  const children = [];
  const stop = async () => {
    for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
    try { queryServer.close(); } catch { /* already closed */ }
    try { await queryClient.end({ timeout: 5 }); } catch { /* already ended */ }
    try { await pgServer.stop(); } catch { /* already stopped */ }
    // Teardown IS the cleanup. The database is in-memory, so closing it destroys every
    // fixture row deterministically — there is nothing left to delete, and therefore no
    // cleanup step that can half-succeed and leave a polluted database behind.
    try { await pg.close(); } catch { /* already closed */ }
  };

  try {
    // Seeders run here — after the socket is up, before the API claims the connection.
    // Every child that loads src/lib/env.ts needs these, not just the API.
    //
    // env.ts hard-requires the four SUPABASE_* values whenever the host is not serverless
    // (env.ts:35-45 — `renderOnlySecret` is only optional under VERCEL / AWS_LAMBDA_* /
    // AWS_REGION), and exits 1 on a parse failure. The ps-499-step12 fixture imports
    // src/db/client, which imports env.ts, so it is bound by that contract exactly as the
    // API is. Passing them to the API spawn alone worked ONLY because a developer machine
    // has an untracked repo-root .env that `import 'dotenv/config'` picks up. On a clean
    // checkout — CI, or a new clone — the seeder exits 1 and provisioning dies before a
    // single spec runs.
    //
    // Shared here rather than repeated so the two spawns cannot satisfy the same contract
    // independently and drift apart again, which is the actual root cause.
    const qaSupabaseEnv = {
      SUPABASE_URL: 'https://qa.invalid',
      SUPABASE_ANON_KEY: 'qa-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'qa-service',
      SUPABASE_JWT_SECRET: jwtSecret,
    };

    const seedOutput = {};
    for (const seeder of seeders) {
      seedOutput[seeder.label] = await runSeeder({ ...seeder, databaseUrl, env: qaSupabaseEnv, log });
    }

    const apiEnv = {
      NODE_ENV: 'test',
      PORT: String(API_PORT),
      DATABASE_URL: databaseUrl,
      ...qaSupabaseEnv,
      // The QA stack must never reach a carrier, marketplace or mailbox.
      INVENTORY_AUTO_DEDUCT: 'off',
      RETURN_BILLING_ENABLED: 'false',
      // No background cadence on the QA stack. Two independent reasons, either sufficient:
      // a watchdog tick can mutate the very fixtures a spec is asserting on, and each
      // background service constructs its OWN postgres() client, so the ticks add
      // connection churn against a database that has a hard connection ceiling.
      SHIPMENT_SYNC_WATCHDOG_ENABLED: 'false',
      RUN_ORDERS_PERFORMANCE_MAINTENANCE: 'false',
      RUN_SYNC_SCHEDULER: 'false',
      // Kept modest so the pool sizes stay well inside the socket server's
      // maxConnections budget above, with room for the other postgres() clients.
      DB_POOL_MAX: '1',
      DB_IDLE_TIMEOUT_SECONDS: '120',
      DB_MAX_LIFETIME_SECONDS: '3600',
    };
    const api = spawn(process.execPath, [tsxCli(), 'src/main.ts'], {
      stdio: 'inherit', env: { ...process.env, ...apiEnv },
    });
    children.push(api);
    await waitForHttp(`${apiUrl}/health`, 60_000, 'QA API');
    log(`[ps-507] api       : ${apiUrl}`);

    if (withFrontend) {
      const web = spawn(process.execPath, [viteCli(), '--host', HOST, '--port', String(WEB_PORT), '--strictPort'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          VITE_API_URL: apiUrl,
          // A syntactically valid but non-resolving project ref: the app derives its
          // localStorage auth key from it, and the harness writes a REAL token there.
          // No Supabase network call is made or needed.
          VITE_SUPABASE_URL: 'https://qaqaqaqaqaqaqaqaqaqa.supabase.co',
          VITE_SUPABASE_ANON_KEY: 'qa-anon-not-a-real-secret',
        },
      });
      children.push(web);
      await waitForHttp(webUrl, 90_000, 'QA frontend');
      log(`[ps-507] frontend  : ${webUrl}`);
    }

    return { runId, databaseUrl, apiUrl, webUrl, queryUrl, queryToken, jwtSecret, pg, migrationReport, seedOutput, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function tsxCli() {
  return new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}
function viteCli() {
  return new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function run(cmd, args, extraEnv, log, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit', shell: process.platform === 'win32',
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', (code) => {
      if (code === 0) { log(`[ps-507] ${label} ok`); resolve(); }
      else reject(new Error(`STOP: ${label} exited ${code}`));
    });
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && process.argv[1].includes('ps-507-qa-stack');
if (invokedDirectly) {
  // DEFAULT NODE_ENV, do not override it. npm scripts run under cmd.exe on Windows,
  // where the POSIX `NODE_ENV=test node …` prefix is a syntax error, and this repo has
  // no cross-env — so requiring the caller to set it would make the npm script
  // platform-specific. Defaulting keeps `npm run test:ps-507` working everywhere while
  // an explicit NODE_ENV=production still refuses, which is the case the gate is for.
  //
  // The substantive protection is the loopback + banned-host check on every target: this
  // CLI can only ever provision 127.0.0.1, whatever NODE_ENV says.
  process.env.NODE_ENV ??= 'test';
  const sep = process.argv.indexOf('--');
  const command = sep === -1 ? [] : process.argv.slice(sep + 1);

  // --seed-ps499-step12 runs the REAL Step 12 fixture, unmodified, so the QA database
  // holds exactly the orders docs/ps-499-step12-qa-runbook.md describes.
  const wantsStep12 = process.argv.includes('--seed-ps499-step12');
  // --seed-ps488-m3 adds the return-identity fixture: one order carrying TWO returns, so
  // migration 0092's partial unique index and line-type CHECK can be attacked directly.
  const wantsM3 = process.argv.includes('--seed-ps488-m3');
  const seeders = [
    ...(wantsStep12 ? [{
      label: 'ps-499-step12',
      argv: ['scripts/ps-499-step12-qa-fixture.ts', '--apply', '--confirm=PS499-STEP12-DISPOSABLE'],
    }] : []),
    ...(wantsM3 ? [{
      label: 'ps-488-m3',
      argv: ['scripts/ps-488-m3-qa-fixture.ts', '--apply', '--confirm=PS488-M3-DISPOSABLE'],
    }] : []),
  ];

  const stack = await provisionQaStack({ seeders });

  // The fixture prints its run id and every order is PS499-QA-<runId>-<n>; consumers key
  // their assertions on it, so it is lifted out here rather than re-derived by parsing
  // the same output in each spec.
  const step12RunId = (stack.seedOutput?.['ps-499-step12'] ?? '').match(/run id\s*:\s*(\S+)/)?.[1] ?? '';
  if (wantsStep12) console.log(`[ps-507] step12 run id: ${step12RunId}`);
  const m3RunId = (stack.seedOutput?.['ps-488-m3'] ?? '').match(/run id\s*:\s*(\S+)/)?.[1] ?? '';
  if (wantsM3) console.log(`[ps-507] ps-488 m3 run id: ${m3RunId}`);

  if (!command.length) {
    console.log('\n[ps-507] stack is up. Env for a consumer:');
    console.log(`  PS507_API_URL=${stack.apiUrl}`);
    console.log(`  PS507_WEB_URL=${stack.webUrl}`);
    console.log(`  PS507_DATABASE_URL=${stack.databaseUrl}`);
    console.log(`  PS507_JWT_SECRET=${redact(stack.jwtSecret)}  (real value passed via env only)`);
    console.log('\nCtrl-C to tear down.');
    process.on('SIGINT', async () => { await stack.stop(); process.exit(0); });
  } else {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit', shell: process.platform === 'win32',
      env: {
        ...process.env,
        PS507_RUN_ID: stack.runId,
        PS507_API_URL: stack.apiUrl,
        PS507_WEB_URL: stack.webUrl,
        PS507_DATABASE_URL: stack.databaseUrl,
        PS507_JWT_SECRET: stack.jwtSecret,
        PS507_QUERY_URL: stack.queryUrl,
        PS507_QUERY_TOKEN: stack.queryToken,
        PS499_STEP12_RUN_ID: step12RunId,
        PS488_M3_RUN_ID: m3RunId,
      },
    });
    const code = await new Promise((r) => child.on('exit', r));
    await stack.stop();
    process.exit(code ?? 1);
  }
}
