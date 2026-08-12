/**
 * PS-488 M2 — real PostgreSQL 17 proof for the readiness command.
 *
 * The readiness command depends on behaviour PGlite cannot stand in for: RLS
 * enforcement, role capabilities (BYPASSRLS, ownership, FORCE), catalog metadata, and
 * READ ONLY transaction semantics. So this executes the ACTUAL command as a
 * subprocess against a real PostgreSQL 17 server.
 *
 * UNSKIPPABLE. Absent PS488_PG17_ADMIN_URL this FAILS. A gate suite that skips when
 * its database is missing reports green while proving nothing.
 *
 * Every dirty case is seeded by temporarily relaxing the 0092 constraint that
 * normally prevents it — which is exactly the drift the gates exist to detect. The
 * fixture itself carries the real 0092 contract, so "clean" means clean against the
 * production shape, not against a permissive stub.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { PS488_M2_READ_ONLY_CONFIRMATION } from './ps-488-m2-readiness.js';

const ADMIN_URL = process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'FAIL: PS488_PG17_ADMIN_URL is not set.\n' +
      'This proof is unskippable — a gate suite that skips proves nothing.',
  );
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  const ok = ['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host);
  if (!ok || /supabase|render\.com|rds\.amazonaws|neon\.tech|pooler/i.test(ADMIN_URL)) {
    console.error(`FAIL: refusing non-ephemeral host "${host}"`);
    process.exit(1);
  }
}

const COMMAND = 'scripts/ps-488-m2-readiness.ts';
let failures = 0;
let counter = 0;

/** The real 0092 contract. A permissive stub would make "clean" meaningless. */
const SCHEMA = `
  create table public.returns (id serial primary key, order_id integer);
  create table public.billing_line_items (
    id serial primary key, client_id integer not null, order_id integer,
    order_number text, shipment_id integer, ship_date timestamptz,
    billing_effective_date timestamptz, line_type text not null, description text not null,
    qty numeric(10,2) not null default '1', unit_cost numeric(10,2) not null,
    total_cost numeric(10,2) not null, package_id integer, storage_month text,
    invoiced boolean not null default false, return_id integer
  );
  alter table public.billing_line_items
    add constraint billing_line_items_return_id_returns_id_fk
    foreign key (return_id) references public.returns(id) on delete restrict;
  alter table public.billing_line_items
    add constraint billing_li_return_id_canonical_type_check
    check (return_id is null or line_type in ('return_postage','return_processing_fee'));
  create index billing_li_return_id_idx
    on public.billing_line_items (return_id) where return_id is not null;
  create unique index billing_li_return_identity_unq
    on public.billing_line_items (return_id, line_type) where return_id is not null;
  create unique index billing_li_order_unique_idx
    on public.billing_line_items (order_id, line_type, description) where order_id is not null;
  create unique index billing_li_shipment_unique_idx
    on public.billing_line_items (shipment_id, line_type, description) where shipment_id is not null;
  create unique index billing_li_storage_unique_idx
    on public.billing_line_items (client_id, storage_month) where storage_month is not null;
  insert into public.returns (id, order_id) values (25, 3074), (26, 3075);
  select setval('public.returns_id_seq', 100);
  insert into public.billing_line_items
    (client_id, order_id, order_number, ship_date, billing_effective_date,
     line_type, description, unit_cost, total_cost, return_id)
  values
    (17, 3074, '3074-RETURN', now(), now(), 'return_postage',        'postage',    '7.73','7.73', 25),
    (17, 3074, '3074-RETURN', now(), now(), 'return_processing_fee', 'processing', '3.00','3.00', 25),
    (17, 3074, '3074',        now(), now(), 'return_label',          'legacy',     '1.11','1.11', null),
    (17, 3074, '3074',        now(), now(), 'pick_pack',             'pick pack',  '2.50','2.50', null);
`;

const admin = () => postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });
const urlFor = (name: string) => {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  return u.toString();
};

async function freshDatabase(): Promise<{ name: string; url: string }> {
  counter += 1;
  const name = `ps488_m2_${process.pid}_${counter}`;
  const a = admin();
  try {
    await a.unsafe(`drop database if exists ${name}`);
    await a.unsafe(`create database ${name}`);
  } finally {
    await a.end({ timeout: 5 });
  }
  const url = urlFor(name);
  const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await db.unsafe(SCHEMA);
  } finally {
    await db.end({ timeout: 5 });
  }
  return { name, url };
}

async function dropDatabase(name: string): Promise<void> {
  const a = admin();
  try {
    await a.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname='${name}' and pid <> pg_backend_pid()`,
    );
    await a.unsafe(`drop database if exists ${name}`);
  } finally {
    await a.end({ timeout: 5 });
  }
}

function run(url: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', COMMAND, ...args], {
    env: { ...process.env, DATABASE_URL: url, ...env },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const PROD = ['--production-read-only', `--confirm=${PS488_M2_READ_ONLY_CONFIRMATION}`];

async function currentDatabase(db: postgres.Sql): Promise<string> {
  const [row] = await db<{ name: string }[]>`select current_database()::text as name`;
  return row!.name;
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

/** Seeds a dirty state by relaxing the constraint that normally prevents it. */
async function withDirty(mutate: (db: postgres.Sql) => Promise<void>, fn: (url: string) => Promise<void>) {
  const { name, url } = await freshDatabase();
  try {
    const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await mutate(db);
    } finally {
      await db.end({ timeout: 5 });
    }
    await fn(url);
  } finally {
    await dropDatabase(name);
  }
}

async function main(): Promise<void> {
  console.log('PS-488 M2 readiness — real PostgreSQL 17 proof\n');

  const [{ ro }] = await (async () => {
    const a = admin();
    try {
      return await a<{ ro: string }[]>`show server_version`.then((r) => [{ ro: r[0]!.server_version }]);
    } finally {
      await a.end({ timeout: 5 });
    }
  })();
  await check('the server under test really is PostgreSQL 17', async () => {
    assert.match(ro, /^17\./, `expected PostgreSQL 17, got ${ro}`);
  });

  await check('clean fixture: all four gates zero, exit 0', () =>
    withDirty(async () => {}, async (url) => {
      const { code, out } = run(url, PROD);
      assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
      assert.match(out, /transaction_read_only = on/);
      assert.match(out, /RLS proof: role=/);
      assert.doesNotMatch(out, /SYSTEM: READY/, 'the command must never claim system readiness');
      assert.match(out, /SYSTEM READINESS: BLOCKED/);
    }),
  );

  await check('self-test mode runs against its own fixture and proves read-only', () =>
    withDirty(async () => {}, async (url) => {
      const { code, out } = run(url, ['--self-test']);
      assert.equal(code, 0, `self-test must run and exit 0\n${out}`);
      assert.match(out, /full-column snapshots identical before\/after/);
      assert.match(out, /transaction_read_only = on/);
    }),
  );

  await check('gate 1 dirty: canonical row with return_id NULL exits nonzero', () =>
    withDirty(
      async (db) => {
        // Legal under 0092 — the CHECK only fires when return_id is NOT NULL. This is
        // the one gate with no database backstop.
        await db`insert into public.billing_line_items
          (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost)
          values (17, 4001, now(), now(), 'return_postage', 'no identity', '5.00','5.00')`;
      },
      async (url) => {
        const { code, out } = run(url, PROD);
        assert.notEqual(code, 0, 'a dirty gate must exit nonzero');
        assert.match(out, /canonical return rows with return_id NULL/);
        assert.match(out, /FAIL: one or more relational-identity gates is non-zero/);
      },
    ),
  );

  await check('gate 1 dirty: MIXED-CASE canonical row with return_id NULL is detected', () =>
    withDirty(
      async (db) => {
        await db`insert into public.billing_line_items
          (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost)
          values (17, 4002, now(), now(), 'RETURN_POSTAGE', 'mixed case', '5.00','5.00')`;
      },
      async (url) => {
        const { code, out } = run(url, PROD);
        assert.notEqual(code, 0, 'a case-sensitive gate would have missed this');
        assert.match(out, /FAIL: one or more relational-identity gates is non-zero/);
      },
    ),
  );

  await check('gate 2 dirty: noncanonical type carrying return_id exits nonzero', () =>
    withDirty(
      async (db) => {
        // Requires dropping the CHECK — this is precisely what it prevents.
        await db.unsafe(
          `alter table public.billing_line_items drop constraint billing_li_return_id_canonical_type_check`,
        );
        await db`insert into public.billing_line_items
          (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost, return_id)
          values (17, 4003, now(), now(), 'return_label', 'legacy with identity', '1.00','1.00', 26)`;
      },
      async (url) => {
        const { code, out } = run(url, PROD);
        assert.notEqual(code, 0);
        assert.match(out, /legacy\/noncanonical return rows carrying return_id/);
      },
    ),
  );

  await check('gate 3 dirty: orphan return_id exits nonzero', () =>
    withDirty(
      async (db) => {
        await db.unsafe(
          `alter table public.billing_line_items drop constraint billing_line_items_return_id_returns_id_fk`,
        );
        await db`insert into public.billing_line_items
          (client_id, order_id, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost, return_id)
          values (17, 4004, now(), now(), 'return_postage', 'orphan', '1.00','1.00', 9999)`;
      },
      async (url) => {
        const { code, out } = run(url, PROD);
        assert.notEqual(code, 0);
        assert.match(out, /return_id referencing a missing return/);
      },
    ),
  );

  await check('gate 4 dirty: duplicate (return_id, line_type) exits nonzero', () =>
    withDirty(
      async (db) => {
        await db.unsafe(`drop index public.billing_li_return_identity_unq`);
        await db`insert into public.billing_line_items
          (client_id, order_id, order_number, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost, return_id)
          values (17, 3074, '3074-RETURN', now(), now(), 'return_postage', 'second postage', '9.99','9.99', 25)`;
      },
      async (url) => {
        const { code, out } = run(url, PROD);
        assert.notEqual(code, 0);
        assert.match(out, /duplicate \(return_id, line_type\)/);
      },
    ),
  );

  await check('a write inside the report transaction is refused by PostgreSQL', () =>
    withDirty(async () => {}, async (url) => {
      // Proves the READ ONLY transaction is a real barrier, not a keyword scan.
      const db = postgres(url, { max: 1, prepare: false });
      try {
        await assert.rejects(
          db.begin('read only', async (tx) => {
            await (tx as unknown as postgres.Sql)`update public.billing_line_items set total_cost = '0.01'`;
          }),
          /read-only transaction/i,
        );
      } finally {
        await db.end({ timeout: 5 });
      }
    }),
  );

  await check('inadequate RLS visibility FAILS CLOSED rather than reporting zeros', () =>
    withDirty(
      async (db) => {
        // A role that can SELECT but cannot bypass RLS. Under deny-all RLS it would
        // read four zeros and look perfectly clean.
        await db.unsafe(`
          drop role if exists ps488_rls_probe;
          create role ps488_rls_probe login password 'probe';
        `);
        await db.unsafe(`
          grant connect on database ${await currentDatabase(db)} to ps488_rls_probe;
          grant usage on schema public to ps488_rls_probe;
          grant select on public.billing_line_items to ps488_rls_probe;
          grant select on public.returns to ps488_rls_probe;
          alter table public.billing_line_items enable row level security;
          alter table public.billing_line_items force row level security;
        `);
      },
      async (url) => {
        const probeUrl = new URL(url);
        probeUrl.username = 'ps488_rls_probe';
        probeUrl.password = 'probe';
        const { code, out } = run(probeUrl.toString(), PROD);
        assert.notEqual(code, 0, 'a non-bypassing role must be refused, not reported as clean');
        assert.match(out, /cannot legitimately see protected rows/);
        assert.doesNotMatch(out, /all zero/, 'it must not print a clean verdict');
      },
    ),
  );

  if (failures) {
    console.error(`\nFAIL ps-488 M2 readiness PG17 proof (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS ps-488 M2 readiness PG17 proof');
}

await main();
