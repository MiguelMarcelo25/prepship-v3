/**
 * PS-499 Step 10 — shared harness for the socket-backed route suite.
 *
 * Proves the REAL path, per Hermes's Option 2 ruling:
 *
 *   HTTP JSON -> Zod -> auth/permission middleware -> real billing route
 *     -> production postgres-js/Drizzle singleton -> PGlite socket -> transaction
 *     -> persisted lines, sidecars and audit rows
 *
 * `db` is NOT mocked. The production singleton in src/db/client.ts is used
 * unchanged; only DATABASE_URL is pointed at a loopback PGlite socket, so the
 * exact driver and transaction code that runs in production runs here.
 *
 * Safety: loopback-only, NODE_ENV=test, a fresh in-memory PGlite per run, obviously
 * fake Supabase values, and hard assertions below that refuse anything else. No
 * carrier call, no billing generation, no invoice mutation, no production access.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import type { Hono } from 'hono';

export type Harness = {
  app: Hono;
  /** Raw SQL against the same PGlite instance the route writes to. */
  query: <T = Record<string, unknown>>(text: string) => Promise<T[]>;
  close: () => Promise<void>;
};

export const TEST_ACTOR = {
  userId: 'ps499-test-actor',
  email: 'ps499@test.invalid',
  role: 'admin',
} as const;

/** Bounded so a leaked pool or socket fails visibly instead of hanging the suite. */
const CONNECT_TIMEOUT_SECONDS = 15;

/**
 * Split on semicolons that are not inside a $$-quoted body, so the audit_log
 * append-only trigger function survives intact.
 */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    // These migrations open with long prose comments that contain semicolons
    // ("...the shipment actually used; persistent operator review resolutions").
    // Splitting on those cuts the CREATE TABLE that follows in half.
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (!inDollar && ch === '-' && text[i + 1] === '-') {
      inLineComment = true;
      current += '--';
      i += 1;
      continue;
    }
    if (!inDollar && ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    // Dollar quoting can be tagged ($function$, $body$), not just $$.
    const dollarTag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 24));
    if (dollarTag) {
      inDollar = !inDollar;
      current += dollarTag[0];
      i += dollarTag[0].length - 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) out.push(current);
  return out;
}

/** Statements that describe production posture, not behaviour — PGlite has no roles/RLS. */
const POSTURE_ONLY = /^\s*(ALTER\s+TABLE[\s\S]*ROW LEVEL SECURITY|CREATE\s+POLICY|DROP\s+POLICY|GRANT|REVOKE|CREATE\s+EXTENSION)/i;

/**
 * Build the schema from the REAL migrations rather than hand-written CREATE TABLEs,
 * so constraints that matter to behaviour — upsert uniqueness, NOT NULL line
 * descriptions, numeric money columns, the append-only audit trigger — are the
 * production ones. Statements are executed individually: pg.exec() wraps a whole
 * file in one implicit transaction, so a single unsupported statement would
 * otherwise roll back every table that file creates.
 */
async function applyMigrations(pg: PGlite): Promise<void> {
  const files = readdirSync('drizzle')
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  for (const file of files) {
    // `returns` is defined in src/db/schema/returns.ts but has no CREATE TABLE
    // migration — later migrations only ALTER it, and the runtime readiness guard
    // demands it. Create it just before the first migration that touches it, so
    // those ALTERs land and verifyRuntimeSchema passes.
    if (file.startsWith('0088_')) {
      await pg
        .exec(`CREATE TABLE IF NOT EXISTS returns (
          id serial PRIMARY KEY,
          order_id integer NOT NULL REFERENCES orders(id),
          client_id integer,
          return_shipment_id integer,
          return_to_location_id integer,
          status text NOT NULL,
          initiated_by text NOT NULL,
          initiated_by_email text,
          reason text,
          admin_override boolean NOT NULL DEFAULT false,
          admin_override_by text,
          admin_override_reason text,
          requested_at timestamptz NOT NULL DEFAULT now(),
          closed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          delivery_method text,
          delivery_status text,
          delivery_error text,
          return_reference text,
          return_customer_shipping_rate numeric(10,2),
          return_recipient_name text
        );`)
        .catch(() => {});
    }

    const text = readFileSync(`drizzle/${file}`, 'utf8').replace(/CONCURRENTLY/gi, '');
    for (const statement of splitStatements(text)) {
      // Every migration opens with a comment block, and splitting on ';' leaves it
      // attached to the statement that follows. Strip only the LEADING comment
      // lines — comments inside a $$ body must survive.
      let code = statement.trim();
      while (code.startsWith('--')) {
        const newline = code.indexOf('\n');
        if (newline === -1) {
          code = '';
          break;
        }
        code = code.slice(newline + 1).trim();
      }
      if (!code) continue;
      if (POSTURE_ONLY.test(code)) continue;
      try {
        await pg.exec(`${code};`);
      } catch {
        // Migrations for subsystems this suite does not touch (trgm indexes,
        // returns, store_accounts) are allowed to fail. A table this suite
        // actually needs is asserted present below, so a real gap still fails.
      }
    }
  }

  const required = [
    'billing_line_items',
    'billing_box_resolutions',
    'billing_manual_overrides',
    'billing_fee_waivers',
    'billing_order_descriptions',
    'billing_config',
    'client_package_prices',
    'audit_log',
    'packages',
    'clients',
    'orders',
    'shipments',
  ];
  const present = await pg.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema='public'`,
  );
  const names = new Set(present.rows.map((r) => r.table_name));
  const missing = required.filter((t) => !names.has(t));
  if (missing.length) {
    // Setup failure, never permission to stub the owner.
    throw new Error(`Harness schema incomplete, missing: ${missing.join(', ')}`);
  }
}

export async function startHarness(): Promise<Harness> {
  const pg = new PGlite();
  await pg.waitReady;
  await applyMigrations(pg);

  // Port 0 lets the OS assign a free one; bind loopback only, never 0.0.0.0.
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' });
  await server.start();
  const address = (server as unknown as { server?: { address?: () => { port: number } | null } }).server?.address?.();
  const port = address?.port;
  if (!port) throw new Error('PGLiteSocketServer did not report a bound port');

  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

  // ─── Set env BEFORE importing the route tree: src/db/client.ts builds the
  // postgres-js singleton at module import time from env.DATABASE_URL. ─────────
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databaseUrl;
  process.env.DB_POOL_MAX = '1';
  process.env.VERCEL = '1';
  // Obviously fake. Never load real secrets into this suite.
  process.env.SUPABASE_URL ??= 'https://ps499-test.supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'ps499-test-service-role-key';
  process.env.SUPABASE_ANON_KEY ??= 'ps499-test-anon-key';
  process.env.SESSION_SECRET ??= 'ps499-test-session-secret-value-not-real';

  assertLoopbackOnly(process.env.DATABASE_URL);
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV must be test');

  const { Hono } = await import('hono');
  const billingRoute = (await import('../src/routes/billing.js')).default;

  const app = new Hono();
  // Test-only: seed the ALREADY-VERIFIED auth context the production middleware
  // would have set after validating a JWT. The billing route's own requireAdmin /
  // requirePermission middleware still runs and still consumes this context — the
  // authorization decision is not bypassed, only the token exchange is.
  app.use('/billing/*', async (c, next) => {
    c.set('userId' as never, TEST_ACTOR.userId as never);
    c.set('email' as never, TEST_ACTOR.email as never);
    c.set('role' as never, TEST_ACTOR.role as never);
    c.set('permissions' as never, ['financials:read', 'financials:write'] as never);
    c.set('clientIds' as never, [] as never);
    c.set('storeIds' as never, [] as never);
    await next();
  });
  app.route('/billing', billingRoute);

  const query = async <T = Record<string, unknown>>(text: string): Promise<T[]> => {
    const result = await pg.query<T>(text);
    return result.rows;
  };

  const close = async () => {
    try {
      const { sql } = await import('../src/db/client.js');
      await (sql as unknown as { end: (o?: { timeout?: number }) => Promise<void> }).end({ timeout: 5 });
    } catch {
      // The singleton may not expose a shutdown path; the socket/PGlite close below
      // still releases everything this process owns.
    }
    await server.stop();
    await pg.close();
  };

  return { app, query, close };
}

function assertLoopbackOnly(url: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`Refusing to run: DATABASE_URL host ${host} is not loopback`);
  }
}

export { CONNECT_TIMEOUT_SECONDS };
