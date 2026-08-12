/**
 * PS-488 M2 — read-only return-identity readiness report.
 *
 * Answers one question: are the four relational-identity invariants currently true in
 * a given database, and is the system as a whole ready for RETURN_BILLING_ENABLED?
 *
 * TWO MODES, deliberately separate. Hermes's ruling: do not reuse the
 * disposable-database assertion for production inspection, because the two have
 * opposite safety needs.
 *
 *   --self-test
 *       Disposable host ONLY. Seeds fixtures, runs the report, and proves the report
 *       is read-only by asserting a byte-identical snapshot before and after.
 *
 *   --production-read-only --confirm=PS-488-M2-READ-ONLY-INSPECTION
 *       Displays the target host and database, runs SELECT/catalog queries only, and
 *       writes nothing. Requires the exact confirmation token. Production execution
 *       still belongs to the designated operator lane, not a developer session.
 *
 * With no flags it refuses and prints usage. There is no default that touches a
 * database.
 *
 * SYSTEM READINESS CANNOT BE CLAIMED HERE. This repository can only report on its own
 * writer and on database facts. The Client Portal is a second production writer of
 * canonical return rows whose schema has no `return_id` column at all
 * (client-portal-prepship src/services/billing.ts:776,797; its
 * src/db/schema/billing.ts has no returnId). Until CP-059's writer retirement is
 * deployed, system readiness is BLOCKED regardless of what the counts say — so this
 * command has no code path that can print SYSTEM: READY.
 */
import postgres from 'postgres';
import {
  CANONICAL_RETURN_WRITE_LINE_TYPES,
  LEGACY_RETURN_READ_ONLY_LINE_TYPES,
} from '../src/services/billing-return-event-contract.js';

const ARGS = process.argv.slice(2);
const SELF_TEST = ARGS.includes('--self-test');
const PRODUCTION_READ_ONLY = ARGS.includes('--production-read-only');
const argValue = (name: string): string | null => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

export const PS488_M2_READ_ONLY_CONFIRMATION = 'PS-488-M2-READ-ONLY-INSPECTION';

const canonical = CANONICAL_RETURN_WRITE_LINE_TYPES.map((t) => `'${t}'`).join(', ');
const legacyAndCanonical = [...LEGACY_RETURN_READ_ONLY_LINE_TYPES, ...CANONICAL_RETURN_WRITE_LINE_TYPES]
  .map((t) => `'${t}'`)
  .join(', ');

/**
 * The four zero-gates, as literal SELECT text.
 *
 * Frozen as strings so the static guard below can prove — without a database — that
 * the production path issues nothing but reads. Each mirrors the preflight inside
 * migration 0092, which Hermes reviewed and passed, so the readiness report and the
 * migration cannot drift into disagreeing about what "clean" means.
 */
export const PS488_M2_GATES: ReadonlyArray<{ key: string; label: string; sql: string }> = [
  {
    key: 'canonical_missing_identity',
    label: 'canonical return rows with return_id NULL',
    // lower(line_type) deliberately. This is the ONE gate with no database
    // constraint behind it: 0092's CHECK only fires when return_id is NOT NULL, so a
    // mixed-case canonical row can legally exist exactly in the population this gate
    // is meant to find, and a case-sensitive IN would miss it. Every writer in this
    // repo emits lowercase literals, so this is latent rather than active — but the
    // gate with no backstop is the wrong place to assume tidy data.
    sql: `select count(*)::text as n from public.billing_line_items
           where lower(line_type) in (${canonical}) and return_id is null`,
  },
  {
    key: 'noncanonical_with_identity',
    label: 'legacy/noncanonical return rows carrying return_id',
    sql: `select count(*)::text as n from public.billing_line_items
           where return_id is not null and line_type not in (${canonical})`,
  },
  {
    key: 'orphan_identity',
    label: 'return_id referencing a missing return',
    sql: `select count(*)::text as n from public.billing_line_items b
           left join public.returns r on r.id = b.return_id
          where b.return_id is not null and r.id is null`,
  },
  {
    key: 'duplicate_identity',
    label: 'duplicate (return_id, line_type)',
    sql: `select count(*)::text as n from (
            select return_id, line_type from public.billing_line_items
             where return_id is not null
             group by return_id, line_type having count(*) > 1) d`,
  },
];

/**
 * Canary evidence. Read-only.
 *
 * The period key is `coalesce(billing_effective_date, ship_date)` at UTC, NOT bare
 * ship_date. That is not cosmetic: billingLineEffectiveDaySql
 * (src/services/billing-calendar-policy.ts:202-207) is the canonical owner of which
 * day a persisted billing line belongs to, and the repo's only month idiom buckets
 * `at time zone 'UTC'` (src/db/schema/billing.ts:127). Bare date_trunc on a
 * timestamptz resolves in the session TimeZone, so a report written that way would
 * silently attribute rows to the wrong month on any connection whose TimeZone is not
 * UTC — and PS-434 exists precisely because billing days are not naive calendar days.
 */
export const PS488_M2_CANARY_SQL = `
  select coalesce(
           to_char(
             date_trunc('month', coalesce(billing_effective_date, ship_date) at time zone 'UTC'),
             'YYYY-MM'),
           'unknown') as period,
         client_id::text as client_id,
         count(*)::text as canonical_rows,
         count(distinct return_id)::text as distinct_returns
    from public.billing_line_items
   where line_type in (${canonical})
   group by 1, 2
   order by 1 desc, 2`;

/** Legacy history, for context. Never a failure — frozen rows are expected. */
export const PS488_M2_LEGACY_SQL = `
  select line_type, count(*)::text as n
    from public.billing_line_items
   where line_type in (${legacyAndCanonical})
   group by line_type order by line_type`;

/**
 * Static proof that the production path is read-only.
 *
 * Every statement this command can issue against a production database lives in the
 * frozen constants above. This scans them for anything that writes. It runs before a
 * connection is opened, so a DML statement introduced by a later edit fails the
 * command rather than reaching the database.
 */
const FORBIDDEN = /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|call|do|merge)\b/i;

export function assertProductionQueriesAreReadOnly(): void {
  const statements = [
    ...PS488_M2_GATES.map((g) => g.sql),
    PS488_M2_CANARY_SQL,
    PS488_M2_LEGACY_SQL,
  ];
  for (const statement of statements) {
    const normalised = statement.trim().toLowerCase();
    if (!normalised.startsWith('select')) {
      throw new Error(`STOP: a production-mode statement does not begin with SELECT: ${statement.slice(0, 60)}`);
    }
    if (FORBIDDEN.test(statement)) {
      throw new Error(`STOP: a production-mode statement contains a write keyword: ${statement.slice(0, 60)}`);
    }
  }
}

/** Loopback or an explicitly disposable database name. Self-test only. */
export function assertDisposableHost(rawUrl: string): void {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  const database = url.pathname.replace(/^\//, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback) {
    throw new Error(`STOP: --self-test seeds fixtures and requires a loopback host; got ${host}`);
  }
  if (!/ps488|qa|test|disposable|scratch/i.test(database)) {
    throw new Error(`STOP: --self-test database "${database}" carries no disposable marker`);
  }
  for (const banned of ['supabase', 'render.com', 'rds.amazonaws', 'neon.tech', 'pooler']) {
    if (rawUrl.toLowerCase().includes(banned)) {
      throw new Error(`STOP: refusing a managed-provider URL in --self-test (${banned})`);
    }
  }
}

type GateResult = { key: string; label: string; count: number };

/**
 * RLS visibility proof — fail closed, not warn and continue.
 *
 * billing_line_items has RLS enabled with NO policies
 * (drizzle/0018_security_hardening.sql:42), which is deny-all for any role that does
 * not bypass it. A non-bypassing session therefore reads four zeros and looks
 * perfectly healthy. Zeros produced by insufficient privilege are indistinguishable
 * from zeros produced by clean data, so the command must prove it can legitimately
 * see the protected rows before it reports on them.
 *
 * Legitimate visibility is either BYPASSRLS, or table ownership while the table is
 * not FORCE'd. Anything else is a refusal.
 */
async function assertRlsVisibility(sql: postgres.Sql): Promise<string> {
  const [row] = await sql<
    {
      current_role_name: string;
      is_superuser: boolean;
      has_bypassrls: boolean;
      is_owner: boolean;
      rls_enabled: boolean;
      rls_forced: boolean;
    }[]
  >`
    select current_user::text                                as current_role_name,
           r.rolsuper                                        as is_superuser,
           r.rolbypassrls                                    as has_bypassrls,
           (c.relowner = r.oid)                              as is_owner,
           c.relrowsecurity                                  as rls_enabled,
           c.relforcerowsecurity                             as rls_forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.rolname = current_user
     where n.nspname = 'public' and c.relname = 'billing_line_items'`;

  if (!row) throw new Error('STOP: public.billing_line_items not found');

  const bypasses = row.is_superuser || row.has_bypassrls;
  const ownerUnforced = row.is_owner && !row.rls_forced;
  const visible = !row.rls_enabled || bypasses || ownerUnforced;

  const proof =
    `role=${row.current_role_name} superuser=${row.is_superuser} ` +
    `bypassrls=${row.has_bypassrls} owner=${row.is_owner} ` +
    `rls_enabled=${row.rls_enabled} rls_forced=${row.rls_forced}`;

  if (!visible) {
    throw new Error(
      `STOP: this session cannot legitimately see protected rows, so every count ` +
        `would read 0 for the wrong reason.\n  ${proof}\n` +
        '  Connect as the service role, a BYPASSRLS role, or the table owner.',
    );
  }
  return proof;
}

/** Proof the session really is in a PostgreSQL READ ONLY transaction. */
async function assertReadOnlyTransaction(tx: postgres.Sql): Promise<void> {
  const [row] = await tx<{ ro: string }[]>`show transaction_read_only`;
  if (row?.ro !== 'on') {
    throw new Error(`STOP: transaction_read_only is '${row?.ro}', expected 'on'`);
  }
}

async function runReport(sql: postgres.Sql): Promise<{ gates: GateResult[]; clean: boolean }> {
  const gates: GateResult[] = [];
  for (const gate of PS488_M2_GATES) {
    const rows = await sql.unsafe<{ n: string }[]>(gate.sql);
    gates.push({ key: gate.key, label: gate.label, count: Number(rows[0]?.n ?? 0) });
  }

  console.log('\n  Relational identity gates (all must be 0):');
  for (const gate of gates) {
    console.log(`    ${gate.count === 0 ? 'ok  ' : 'FAIL'} ${String(gate.count).padStart(6)}  ${gate.label}`);
  }

  const legacy = await sql.unsafe<{ line_type: string; n: string }[]>(PS488_M2_LEGACY_SQL);
  console.log('\n  Return line types present (legacy rows are expected, not failures):');
  if (!legacy.length) console.log('    (none)');
  for (const row of legacy) console.log(`    ${row.n.padStart(8)}  ${row.line_type}`);

  const canary = await sql.unsafe<
    { period: string; client_id: string; canonical_rows: string; distinct_returns: string }[]
  >(PS488_M2_CANARY_SQL);
  console.log('\n  Canonical rows by period/client (canary evidence):');
  if (!canary.length) console.log('    (none)');
  for (const row of canary) {
    console.log(
      `    ${row.period}  client ${row.client_id.padStart(5)}  ` +
        `${row.canonical_rows.padStart(6)} rows  ${row.distinct_returns.padStart(5)} returns`,
    );
  }

  return { gates, clean: gates.every((g) => g.count === 0) };
}

/**
 * Repo-local writer status. Deliberately scoped: this repository can prove what IT
 * writes, and nothing about another deployment.
 */
function reportWriterStatus(clean: boolean): void {
  console.log('\n  PrepShip-local writer status:');
  console.log('    sole repo-local canonical writer : the RETURN_BILLING_ENABLED pass in');
  console.log('                                       src/services/billing.ts');
  console.log('    canonical write vocabulary       : ' + CANONICAL_RETURN_WRITE_LINE_TYPES.join(', '));
  console.log('    legacy read-only vocabulary      : ' + LEGACY_RETURN_READ_ONLY_LINE_TYPES.join(', '));
  console.log(`    database gates                   : ${clean ? 'all zero' : 'NOT CLEAN — see above'}`);

  console.log('\n  SYSTEM READINESS: BLOCKED');
  console.log('    The Client Portal is a second production writer of canonical return');
  console.log('    rows and its schema has no return_id column, so it cannot attach');
  console.log('    relational identity. Clean gates here reflect the regeneration freeze,');
  console.log('    not a safe system. CP-059 writer retirement must be deployed before');
  console.log('    RETURN_BILLING_ENABLED or any freeze-lift decision.');
  console.log('    This command cannot report SYSTEM: READY — it cannot verify another');
  console.log('    repository is deployed. That acceptance belongs to Hermes.');
}

function usage(): void {
  console.log('PS-488 M2 readiness — read-only return-identity report\n');
  console.log('  npm run test:ps-488-m2-readiness -- --self-test');
  console.log('      disposable loopback database only; seeds fixtures and proves the');
  console.log('      report is read-only via a byte-identical before/after snapshot\n');
  console.log('  npm run test:ps-488-m2-readiness -- --production-read-only \\');
  console.log(`      --confirm=${PS488_M2_READ_ONLY_CONFIRMATION}`);
  console.log('      SELECT/catalog only; writes nothing; operator lane\n');
  console.log('Refusing to run: no mode selected.');
}

async function main(): Promise<void> {
  // Before any connection: prove the production statement set cannot write.
  assertProductionQueriesAreReadOnly();

  if (!SELF_TEST && !PRODUCTION_READ_ONLY) {
    usage();
    process.exit(1);
  }
  if (SELF_TEST && PRODUCTION_READ_ONLY) {
    throw new Error('STOP: choose one mode, not both');
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const parsed = new URL(url);

  if (PRODUCTION_READ_ONLY) {
    if (argValue('confirm') !== PS488_M2_READ_ONLY_CONFIRMATION) {
      throw new Error(`STOP: --production-read-only requires --confirm=${PS488_M2_READ_ONLY_CONFIRMATION}`);
    }
    // Show the operator exactly what they are pointed at, before doing anything.
    console.log('PS-488 M2 readiness — PRODUCTION READ-ONLY');
    console.log(`  host     : ${parsed.hostname}:${parsed.port || '5432'}`);
    console.log(`  database : ${parsed.pathname.replace(/^\//, '')}`);
    console.log(`  user     : ${parsed.username}`);
    console.log('  mode     : SELECT and catalog reads only; nothing is written');
    // billing_line_items has RLS enabled with NO policies (drizzle/0018_security_hardening.sql:42).
    // That is deny-all for any role that does not bypass RLS, so a non-service-role
    // connection would report four zeros and look perfectly clean. Zeros from the
    // wrong role are indistinguishable from zeros from a healthy database.
    console.log('  NOTE     : billing_line_items has RLS enabled with no policies.');
    console.log('             Connect as the service role, or every count reads 0');
    console.log('             regardless of the real data.');
  } else {
    assertDisposableHost(url);
    console.log('PS-488 M2 readiness — SELF-TEST');
    console.log(`  host     : ${parsed.hostname}  database: ${parsed.pathname.replace(/^\//, '')}`);
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  let clean = false;
  try {
    if (SELF_TEST) await seedSelfTestFixture(sql);

    const rlsProof = await assertRlsVisibility(sql);
    console.log(`  RLS proof: ${rlsProof}`);

    const before = SELF_TEST ? await snapshotForReadOnlyProof(sql) : null;

    // The real mutation barrier is PostgreSQL, not the keyword scanner. Everything
    // the report issues runs inside a READ ONLY transaction, and the session is
    // asked to confirm it — a SELECT calling a mutating function fails here, which
    // static scanning cannot catch.
    clean = await sql.begin('read only', async (tx) => {
      const t = tx as unknown as postgres.Sql;
      await assertReadOnlyTransaction(t);
      console.log('  transaction: READ ONLY confirmed (transaction_read_only = on)');
      const result = await runReport(t);
      return result.clean;
    }) as unknown as boolean;

    if (SELF_TEST) {
      const after = await snapshotForReadOnlyProof(sql);
      if (before !== after) {
        throw new Error('STOP: the report mutated data — before/after snapshots differ');
      }
      console.log('\n  read-only proof: full-column snapshots identical before/after  ok');
    }

    reportWriterStatus(clean);
  } finally {
    await sql.end({ timeout: 5 });
  }

  // A dirty gate is a failure, not a note. Counts are printed above either way.
  if (!clean) {
    console.error('\nFAIL: one or more relational-identity gates is non-zero.');
    process.exit(1);
  }
}

/**
 * Self-test fixture. Models the REAL 0092 catalog contract, not merely enough
 * columns for the queries to parse — otherwise the self-test proves the SQL is
 * syntactically valid and nothing about the invariants it exists to check.
 *
 * Reproduced from drizzle/0092_ps488_return_identity_reconciliation.sql:
 *   FK ON DELETE RESTRICT, validated canonical-type CHECK, partial UNIQUE
 *   (return_id, line_type), the 0089 lookup index, and the description-based
 *   survivor indexes.
 *
 * `billing_effective_date` is present because the canary buckets on
 * coalesce(billing_effective_date, ship_date); the first version of this fixture
 * omitted it and the self-test could not run at all.
 *
 * Self-test only. The mode check gates it — production mode never reaches here.
 */
async function seedSelfTestFixture(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    drop table if exists public.billing_line_items cascade;
    drop table if exists public.returns cascade;

    create table public.returns (id serial primary key, order_id integer);

    create table public.billing_line_items (
      id serial primary key,
      client_id integer not null,
      order_id integer,
      order_number text,
      shipment_id integer,
      ship_date timestamptz,
      billing_effective_date timestamptz,
      line_type text not null,
      description text not null,
      qty numeric(10,2) not null default '1',
      unit_cost numeric(10,2) not null,
      total_cost numeric(10,2) not null,
      package_id integer,
      storage_month text,
      invoiced boolean not null default false,
      return_id integer
    );

    -- The 0092 contract, as applied.
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
    -- Survivor indexes 0092 must preserve.
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
      (17, 3074, '3074-RETURN', now(), now(), 'return_postage',        'postage',    '7.73', '7.73', 25),
      (17, 3074, '3074-RETURN', now(), now(), 'return_processing_fee', 'processing', '3.00', '3.00', 25),
      (17, 3074, '3074',        now(), now(), 'return_label',          'legacy',     '1.11', '1.11', null),
      (17, 3074, '3074',        now(), now(), 'pick_pack',             'pick pack',  '2.50', '2.50', null);
  `);
}

/**
 * Full-column mutation snapshot across BOTH tables the report reads.
 *
 * The earlier version hashed only id/line_type/total_cost/return_id, so it would have
 * missed a change to client, order, dates, description, unit cost or invoiced state,
 * and missed any change to `returns` entirely — while the output claimed
 * "byte-identical". The READ ONLY transaction is the real barrier; this is the
 * corroborating evidence, and it now covers what it claims to.
 */
async function snapshotForReadOnlyProof(sql: postgres.Sql): Promise<string> {
  const [lines] = await sql<{ digest: string }[]>`
    select coalesce(md5(string_agg(
      concat_ws('|', id::text, client_id::text, coalesce(order_id::text,'-'),
        coalesce(order_number,'-'), coalesce(shipment_id::text,'-'),
        coalesce(ship_date::text,'-'), coalesce(billing_effective_date::text,'-'),
        line_type, description, qty::text, unit_cost::text, total_cost::text,
        coalesce(package_id::text,'-'), coalesce(storage_month,'-'),
        invoiced::text, coalesce(return_id::text,'-')),
      ',' order by id)), 'empty') as digest
    from public.billing_line_items`;
  const [returnsRows] = await sql<{ digest: string }[]>`
    select coalesce(md5(string_agg(
      concat_ws('|', id::text, coalesce(order_id::text,'-')), ',' order by id)), 'empty') as digest
    from public.returns`;
  return `${lines!.digest}:${returnsRows!.digest}`;
}

// Exact basename, not a substring. `includes('ps-488-m2-readiness')` also matched
// ps-488-m2-readiness-pg17.ts, so merely IMPORTING the confirmation token from this
// module made the PG17 suite execute the readiness command instead of its own tests.
const invokedAs = (process.argv[1] ?? '').replace(/\\/g, '/').split('/').pop();
if (invokedAs === 'ps-488-m2-readiness.ts') {
  await main();
}
