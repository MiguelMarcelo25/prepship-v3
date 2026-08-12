/**
 * PS-488 recovery — real PostgreSQL 17 proof for migration 0092.
 *
 * Executes the ACTUAL runner as a subprocess against a real PostgreSQL 17 server.
 * The fast contract test proves the SQL says the right things; only this file proves
 * what the database actually does — exact catalog definitions, convalidated flags,
 * rollback, lock timeouts, RESTRICT enforcement and session cleanup.
 *
 * UNSKIPPABLE. If PS488_PG17_ADMIN_URL is absent this FAILS. A migration proof that
 * silently skips when its database is missing is worse than no proof, because CI
 * goes green while nothing was verified.
 *
 * EVERY CASE STARTS FROM THE 0089 PRODUCTION SHAPE — FK ON DELETE SET NULL, no raw
 * unique, no CHECK — so the suite genuinely proves reconciliation TO RESTRICT rather
 * than asserting against an already-correct schema.
 *
 * The `returns` table here is a clearly labelled MINIMAL EXTERNAL PREREQUISITE
 * fixture. `returns` is owned outside PrepShip's migration chain: it is declared in
 * src/db/schema/returns.ts and only ALTERed by 0088/0089, with no CREATE TABLE
 * anywhere in drizzle/. This fixture supplies that prerequisite so the FK has a
 * referent. It is NOT a claim that PrepShip owns that schema.
 *
 * Never points at production: the admin URL must be loopback or an explicit CI
 * service host, and every case creates and drops its own throwaway database.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  PS488_0092_EXPECTED_DIGEST,
  PS488_CHECK_NAME,
  PS488_FK_NAME,
  PS488_LOOKUP_INDEX,
  PS488_MIGRATION_FILE,
  PS488_PRESERVED_UNIQUE_INDEXES,
  PS488_RECOVERY_CONFIRMATION,
  PS488_UNIQUE_INDEX,
  assertDisposablePostgresUrl,
  loadAuthorisedMigration,
} from './ps-488-migration-contract.js';

const ADMIN_URL = process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'FAIL: PS488_PG17_ADMIN_URL is not set.\n' +
      'This proof is unskippable by design — a migration suite that skips when its\n' +
      'database is missing reports green while proving nothing. Provide an ephemeral\n' +
      'PostgreSQL 17 admin URL.',
  );
  process.exit(1);
}

// Fail-closed host gate. This suite CREATEs and DROPs databases and terminates
// sessions; "the variable is set" is not a safety property. Refused before any
// connection is opened.
try {
  assertDisposablePostgresUrl(ADMIN_URL);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

let failures = 0;
let caseCounter = 0;

const RUNNER = 'scripts/apply-ps-488-return-identity-reconciliation.ts';

/** The exact 0089 production shape, plus the external-prerequisite fixture. */
const SCHEMA_0089 = `
  -- MINIMAL EXTERNAL PREREQUISITE FIXTURE. Owned outside PrepShip's migration chain
  -- (src/db/schema/returns.ts); no CREATE TABLE for it exists in drizzle/. Supplied
  -- here only so the FK under test has a referent.
  CREATE TABLE public.returns (
    id serial PRIMARY KEY,
    order_id integer,
    status text NOT NULL DEFAULT 'requested'
  );

  CREATE TABLE public.billing_line_items (
    id serial PRIMARY KEY,
    client_id integer NOT NULL,
    order_id integer,
    order_number text,
    shipment_id integer,
    ship_date timestamptz,
    line_type text NOT NULL,
    description text NOT NULL,
    qty numeric(10,2) NOT NULL DEFAULT '1',
    unit_cost numeric(10,2) NOT NULL,
    total_cost numeric(10,2) NOT NULL,
    package_id integer,
    invoiced boolean NOT NULL DEFAULT false,
    storage_month text,
    -- 0089, exactly as applied to production.
    return_id integer
  );

  ALTER TABLE public.billing_line_items
    ADD CONSTRAINT ${PS488_FK_NAME}
    FOREIGN KEY (return_id) REFERENCES public.returns(id) ON DELETE SET NULL;

  CREATE INDEX ${PS488_LOOKUP_INDEX}
    ON public.billing_line_items (return_id) WHERE return_id IS NOT NULL;

  -- Description-based unique indexes that predate this work and must survive.
  CREATE UNIQUE INDEX ${PS488_PRESERVED_UNIQUE_INDEXES[0]}
    ON public.billing_line_items (order_id, line_type, description)
    WHERE order_id IS NOT NULL;
  CREATE UNIQUE INDEX ${PS488_PRESERVED_UNIQUE_INDEXES[1]}
    ON public.billing_line_items (shipment_id, line_type, description)
    WHERE shipment_id IS NOT NULL;
  CREATE UNIQUE INDEX ${PS488_PRESERVED_UNIQUE_INDEXES[2]}
    ON public.billing_line_items (client_id, storage_month)
    WHERE storage_month IS NOT NULL;
`;

const SEED = `
  INSERT INTO public.returns (id, order_id) VALUES (25, 3074), (26, 3075);
  SELECT setval('public.returns_id_seq', 100);
  INSERT INTO public.billing_line_items
    (client_id, order_id, order_number, line_type, description, unit_cost, total_cost, return_id)
  VALUES
    -- canonical return-identified rows
    (17, 3074, '3074-RETURN', 'return_postage',        'return postage',    '7.73', '7.73', 25),
    (17, 3074, '3074-RETURN', 'return_processing_fee', 'return processing', '3.00', '3.00', 25),
    -- legacy aliases with return_id NULL: must remain readable
    (17, 3074, '3074', 'return_label',      'legacy label',      '1.11', '1.11', NULL),
    (17, 3074, '3074', 'return_processing', 'legacy processing', '2.22', '2.22', NULL),
    -- ordinary outbound row
    (17, 3074, '3074', 'pick_pack', 'Pick & Pack', '2.50', '2.50', NULL);
`;

function adminSql(): postgres.Sql {
  return postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });
}

function dbUrl(name: string): string {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Fresh throwaway database preloaded with the 0089 shape. */
async function freshDatabase(seed = true): Promise<{ name: string; url: string }> {
  caseCounter += 1;
  const name = `ps488_recovery_${process.pid}_${caseCounter}`;
  const admin = adminSql();
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = dbUrl(name);
  const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await db.unsafe(SCHEMA_0089);
    if (seed) await db.unsafe(SEED);
  } finally {
    await db.end({ timeout: 5 });
  }
  return { name, url };
}

async function dropDatabase(name: string): Promise<void> {
  const admin = adminSql();
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Runs the REAL runner as a subprocess. */
function runRunner(url: string, args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const result = spawnSync('npx', ['tsx', RUNNER, ...args], {
    env: { ...process.env, DATABASE_URL: url, ...extraEnv },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const APPLY_ARGS = ['--apply', `--confirm=${PS488_RECOVERY_CONFIRMATION}`];

type Facts = {
  deleteAction: string | null;
  checkValidated: boolean | null;
  uniqueDef: string | null;
  lookupPresent: boolean;
  preserved: number;
  rows: string;
  total: string;
  checksum: string;
  sessions: number;
};

async function facts(url: string): Promise<Facts> {
  const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [fk] = await db<{ confdeltype: string }[]>`
      select confdeltype from pg_constraint where conname = ${PS488_FK_NAME}`;
    const [chk] = await db<{ convalidated: boolean }[]>`
      select convalidated from pg_constraint where conname = ${PS488_CHECK_NAME}`;
    const [uniq] = await db<{ def: string }[]>`
      select pg_get_indexdef(indexrelid) as def from pg_index i
      join pg_class c on c.oid = i.indexrelid where c.relname = ${PS488_UNIQUE_INDEX}`;
    const [lookup] = await db<{ n: string }[]>`
      select count(*)::text as n from pg_class where relname = ${PS488_LOOKUP_INDEX}`;
    const [pres] = await db<{ n: string }[]>`
      select count(*)::text as n from pg_class
      where relname in ${db(PS488_PRESERVED_UNIQUE_INDEXES as unknown as string[])}`;
    const [snap] = await db<{ rows: string; total: string; checksum: string }[]>`
      select count(*)::text as rows,
             coalesce(sum(total_cost),0)::text as total,
             coalesce(md5(string_agg(id::text||':'||total_cost::text||':'||coalesce(return_id::text,'-'), ',' order by id)),'e') as checksum
      from public.billing_line_items`;
    const [sess] = await db<{ n: string }[]>`
      select count(*)::text as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()`;

    return {
      deleteAction: fk?.confdeltype ?? null,
      checkValidated: chk?.convalidated ?? null,
      uniqueDef: uniq?.def ?? null,
      lookupPresent: Number(lookup?.n ?? 0) > 0,
      preserved: Number(pres?.n ?? 0),
      rows: snap!.rows,
      total: snap!.total,
      checksum: snap!.checksum,
      sessions: Number(sess?.n ?? 0),
    };
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function withDatabase(fn: (url: string) => Promise<void>, seed = true): Promise<void> {
  const { name, url } = await freshDatabase(seed);
  try {
    await fn(url);
  } finally {
    await dropDatabase(name);
  }
}

async function main(): Promise<void> {
  console.log('PS-488 recovery — real PostgreSQL 17 proof\n');

  await check('the 0089 starting shape really is SET NULL, so reconciliation is genuine', () =>
    withDatabase(async (url) => {
      const before = await facts(url);
      assert.equal(before.deleteAction, 'n', 'fixture must start at ON DELETE SET NULL');
      assert.equal(before.uniqueDef, null, 'fixture must start without the raw unique index');
      assert.equal(before.checkValidated, null, 'fixture must start without the CHECK');
    }),
  );

  await check('inspection is read-only and changes no catalog object', () =>
    withDatabase(async (url) => {
      const before = await facts(url);
      const { code } = runRunner(url, []);
      const after = await facts(url);
      assert.equal(code, 0, 'inspection must succeed');
      assert.equal(after.deleteAction, before.deleteAction, 'inspection must not repair the FK');
      assert.equal(after.uniqueDef, null);
      assert.equal(after.checksum, before.checksum);
    }),
  );

  await check('--apply without the exact confirmation is a no-op', () =>
    withDatabase(async (url) => {
      const before = await facts(url);
      const wrong = runRunner(url, ['--apply', '--confirm=APPLY-PS-488-RETURN-ID']);
      const missing = runRunner(url, ['--apply']);
      const after = await facts(url);
      assert.notEqual(wrong.code, 0, 'a stale 0089-style token must be refused');
      assert.notEqual(missing.code, 0, 'a missing token must be refused');
      assert.equal(after.deleteAction, 'n', 'nothing may be written without confirmation');
      assert.equal(after.checksum, before.checksum);
    }),
  );

  await check('a digest mismatch refuses to apply', () =>
    withDatabase(async (url) => {
      const { code, out } = runRunner(url, [...APPLY_ARGS, '--digest=deadbeef']);
      const after = await facts(url);
      assert.notEqual(code, 0);
      assert.match(out, /digest/i);
      assert.equal(after.deleteAction, 'n', 'a mismatched digest must write nothing');
    }),
  );

  await check('exact apply reconciles the 0089 shape to the governed contract', () =>
    withDatabase(async (url) => {
      const before = await facts(url);
      const { code, out } = runRunner(url, APPLY_ARGS);
      assert.equal(code, 0, `apply must succeed: ${out}`);
      const after = await facts(url);

      assert.equal(after.deleteAction, 'r', 'FK must become RESTRICT');
      assert.equal(after.checkValidated, true, 'CHECK must exist and be validated');
      assert.ok(after.uniqueDef, 'raw partial unique index must exist');
      assert.match(after.uniqueDef!, /UNIQUE/i);
      assert.match(after.uniqueDef!, /return_id/);
      assert.match(after.uniqueDef!, /line_type/);
      assert.match(after.uniqueDef!, /WHERE .*return_id IS NOT NULL/i);
      assert.ok(after.lookupPresent, '0089 lookup index must survive');
      assert.equal(after.preserved, PS488_PRESERVED_UNIQUE_INDEXES.length, 'description indexes must survive');

      assert.equal(after.rows, before.rows, 'row count must not move');
      assert.equal(after.total, before.total, 'money must not move');
      assert.equal(after.checksum, before.checksum, 'per-row checksum must not change');
    }),
  );

  await check('a rerun is idempotent', () =>
    withDatabase(async (url) => {
      assert.equal(runRunner(url, APPLY_ARGS).code, 0, 'first apply');
      const once = await facts(url);
      const second = runRunner(url, APPLY_ARGS);
      const twice = await facts(url);
      assert.equal(second.code, 0, `rerun must succeed: ${second.out}`);
      assert.equal(twice.deleteAction, 'r');
      assert.equal(twice.checksum, once.checksum);
    }),
  );

  await check('legacy aliases with return_id NULL remain readable after apply', () =>
    withDatabase(async (url) => {
      assert.equal(runRunner(url, APPLY_ARGS).code, 0);
      const db = postgres(url, { max: 1, prepare: false });
      try {
        const legacy = await db<{ n: string }[]>`
          select count(*)::text as n from public.billing_line_items
          where line_type in ('return_label','return_processing') and return_id is null`;
        assert.equal(legacy[0]!.n, '2', 'both legacy alias rows must still be readable');
      } finally {
        await db.end({ timeout: 5 });
      }
    }),
  );

  for (const legacyType of ['return_label', 'return_processing']) {
    await check(`a legacy alias '${legacyType}' with a non-null return_id is rejected`, () =>
      withDatabase(async (url) => {
        assert.equal(runRunner(url, APPLY_ARGS).code, 0);
        const db = postgres(url, { max: 1, prepare: false });
        try {
          await assert.rejects(
            db`insert into public.billing_line_items
                 (client_id, line_type, description, unit_cost, total_cost, return_id)
               values (17, ${legacyType}, 'x', '1.00', '1.00', 26)`,
            /billing_li_return_id_canonical_type_check|violates check/i,
          );
        } finally {
          await db.end({ timeout: 5 });
        }
      }),
    );
  }

  await check('a duplicate (return_id, line_type) is rejected', () =>
    withDatabase(async (url) => {
      assert.equal(runRunner(url, APPLY_ARGS).code, 0);
      const db = postgres(url, { max: 1, prepare: false });
      try {
        await assert.rejects(
          db`insert into public.billing_line_items
               (client_id, line_type, description, unit_cost, total_cost, return_id)
             values (17, 'return_postage', 'second postage row', '1.00', '1.00', 25)`,
          /billing_li_return_identity_unq|duplicate key/i,
        );
      } finally {
        await db.end({ timeout: 5 });
      }
    }),
  );

  await check('deleting a referenced return is RESTRICTED, not silently nulled', () =>
    withDatabase(async (url) => {
      assert.equal(runRunner(url, APPLY_ARGS).code, 0);
      const db = postgres(url, { max: 1, prepare: false });
      try {
        await assert.rejects(
          db`delete from public.returns where id = 25`,
          /violates foreign key|still referenced/i,
        );
        const [row] = await db<{ n: string }[]>`
          select count(*)::text as n from public.billing_line_items where return_id = 25`;
        assert.equal(row!.n, '2', 'the billing rows must still be attached to their return');
      } finally {
        await db.end({ timeout: 5 });
      }
    }),
  );

  await check('pre-existing drift rolls the whole reconciliation back', () =>
    withDatabase(async (url) => {
      const db = postgres(url, { max: 1, prepare: false });
      try {
        // A legacy alias illegally attached to a return: the CHECK could never validate.
        await db`insert into public.billing_line_items
                   (client_id, line_type, description, unit_cost, total_cost, return_id)
                 values (17, 'return_label', 'illegal', '1.00', '1.00', 26)`;
      } finally {
        await db.end({ timeout: 5 });
      }

      const before = await facts(url);
      const { code } = runRunner(url, APPLY_ARGS);
      const after = await facts(url);

      assert.notEqual(code, 0, 'drift must abort the apply');
      assert.equal(after.deleteAction, 'n', 'the FK must remain unrepaired after rollback');
      assert.equal(after.uniqueDef, null, 'no index may survive a rolled-back apply');
      assert.equal(after.checkValidated, null, 'no CHECK may survive a rolled-back apply');
      assert.equal(after.checksum, before.checksum, 'data must be untouched');
    }),
  );

  await check('a duplicate canonical pair present beforehand aborts the apply', () =>
    withDatabase(async (url) => {
      const db = postgres(url, { max: 1, prepare: false });
      try {
        await db`insert into public.billing_line_items
                   (client_id, line_type, description, unit_cost, total_cost, return_id)
                 values (17, 'return_postage', 'duplicate postage', '9.99', '9.99', 25)`;
      } finally {
        await db.end({ timeout: 5 });
      }
      const { code } = runRunner(url, APPLY_ARGS);
      const after = await facts(url);
      assert.notEqual(code, 0, 'a pre-existing duplicate must abort');
      assert.equal(after.uniqueDef, null, 'the unique index must not exist after rollback');
      assert.equal(after.deleteAction, 'n');
    }),
  );

  await check('a lock conflict times out and rolls back rather than waiting', () =>
    withDatabase(async (url) => {
      const blocker = postgres(url, { max: 1, prepare: false });
      let applied: { code: number; out: string };
      try {
        // Hold ACCESS EXCLUSIVE so the migration cannot take its lock within 5s.
        await blocker.unsafe('BEGIN');
        await blocker.unsafe('LOCK TABLE public.billing_line_items IN ACCESS EXCLUSIVE MODE');
        applied = runRunner(url, APPLY_ARGS);
        await blocker.unsafe('ROLLBACK');
      } finally {
        await blocker.end({ timeout: 5 });
      }
      const after = await facts(url);
      assert.notEqual(applied.code, 0, 'the apply must fail rather than block indefinitely');
      assert.match(applied.out, /lock|timeout/i);
      assert.equal(after.deleteAction, 'n', 'a timed-out apply must leave the FK unrepaired');
      assert.equal(after.uniqueDef, null);
    }),
  );

  await check('the runner leaks no application session', () =>
    withDatabase(async (url) => {
      assert.equal(runRunner(url, APPLY_ARGS).code, 0);
      const after = await facts(url);
      assert.equal(after.sessions, 0, `runner left ${after.sessions} session(s) open`);
    }),
  );

  await check('a failure AFTER successful DDL and verification rolls everything back', () =>
    withDatabase(async (url) => {
      const before = await facts(url);
      // Injected at the very end of the transaction, after the DDL has succeeded and
      // the catalog has verified exactly. Proves the rollback covers otherwise-valid
      // attempted DDL, not merely early refusals.
      const { code, out } = runRunner(url, APPLY_ARGS, {
        NODE_ENV: 'test',
        PS488_FORCE_POST_VERIFY_FAILURE: '1',
      });
      const after = await facts(url);

      assert.notEqual(code, 0, 'the injected failure must abort the apply');
      assert.match(out, /post-verification failure/i);
      assert.equal(after.deleteAction, 'n', 'the FK repair must be rolled back');
      assert.equal(after.uniqueDef, null, 'the unique index must not survive');
      assert.equal(after.checkValidated, null, 'the CHECK must not survive');
      assert.equal(after.checksum, before.checksum);
    }),
  );

  await check('the post-verification injection is refused outside NODE_ENV=test', () =>
    withDatabase(async (url) => {
      const { code, out } = runRunner(url, APPLY_ARGS, {
        NODE_ENV: 'production',
        PS488_FORCE_POST_VERIFY_FAILURE: '1',
      });
      assert.notEqual(code, 0);
      assert.match(out, /test-only/i, 'the injection must refuse to run outside tests');
      const after = await facts(url);
      assert.equal(after.deleteAction, 'n', 'nothing may commit when the injection is refused');
    }),
  );

  await check('an orphan return_id is refused by preflight and nothing is written', () =>
    withDatabase(async (url) => {
      const db = postgres(url, { max: 1, prepare: false });
      try {
        // A true orphan cannot be inserted while the 0089 FK is enforced, so the FK
        // is briefly dropped and re-added NOT VALID — reproducing a database that
        // drifted before this migration ran.
        await db.unsafe(`ALTER TABLE public.billing_line_items DROP CONSTRAINT ${PS488_FK_NAME}`);
        await db`insert into public.billing_line_items
                   (client_id, line_type, description, unit_cost, total_cost, return_id)
                 values (17, 'return_postage', 'orphan', '1.00', '1.00', 9999)`;
        await db.unsafe(
          `ALTER TABLE public.billing_line_items ADD CONSTRAINT ${PS488_FK_NAME} ` +
            'FOREIGN KEY (return_id) REFERENCES public.returns(id) ON DELETE SET NULL NOT VALID',
        );
      } finally {
        await db.end({ timeout: 5 });
      }

      const before = await facts(url);
      const { code, out } = runRunner(url, APPLY_ARGS);
      const after = await facts(url);

      assert.notEqual(code, 0, 'an orphan must abort the apply');
      assert.match(out, /missing return|orphan/i);
      assert.equal(after.uniqueDef, null);
      assert.equal(after.checkValidated, null);
      assert.equal(after.checksum, before.checksum);
    }),
  );

  await check('a malformed pre-existing catalog object refuses and rolls back', () =>
    withDatabase(async (url) => {
      const db = postgres(url, { max: 1, prepare: false });
      try {
        // Same NAME, wrong DEFINITION: not partial, and keyed the wrong way round.
        // CREATE UNIQUE INDEX IF NOT EXISTS then becomes a silent no-op, so only an
        // EXACT definition check catches it. A presence check would pass here.
        await db.unsafe(
          `CREATE UNIQUE INDEX ${PS488_UNIQUE_INDEX} ` +
            'ON public.billing_line_items (line_type, return_id)',
        );
      } finally {
        await db.end({ timeout: 5 });
      }

      const before = await facts(url);
      const { code, out } = runRunner(url, APPLY_ARGS);
      const after = await facts(url);

      assert.notEqual(code, 0, 'exact-definition drift must abort the apply');
      assert.match(out, /definition does not match|keys are/i);
      assert.equal(after.deleteAction, 'n', 'the FK repair must be rolled back');
      assert.equal(after.checkValidated, null, 'the CHECK must not survive');
      assert.equal(after.checksum, before.checksum);
    }),
  );

  await check('a tampered 0092 is refused even without --digest', () =>
    withDatabase(async (url) => {
      const original = readFileSync(PS488_MIGRATION_FILE, 'utf8');
      let code = 0;
      let out = '';
      try {
        writeFileSync(PS488_MIGRATION_FILE, original.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE'));
        ({ code, out } = runRunner(url, APPLY_ARGS));
      } finally {
        writeFileSync(PS488_MIGRATION_FILE, original);
      }
      const after = await facts(url);

      assert.notEqual(code, 0, 'a tampered migration must be refused');
      assert.match(out, /not the reviewed SQL/i);
      assert.equal(after.deleteAction, 'n', 'nothing may be written from tampered SQL');
      assert.equal(
        loadAuthorisedMigration().digest,
        PS488_0092_EXPECTED_DIGEST,
        'the migration file must be restored exactly',
      );
    }),
  );

  await check('the reviewed SQL digest is stable across reads', () => {
    const a = loadAuthorisedMigration().digest;
    const b = loadAuthorisedMigration().digest;
    assert.equal(a, b);
    assert.equal(a, PS488_0092_EXPECTED_DIGEST);
    return Promise.resolve();
  });

  if (failures) {
    console.error(`\nFAIL ps-488 PG17 proof (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS ps-488 PG17 proof');
}

await main();
