/**
 * PS-509 — migration 0103 runner: the sync-ingress customer-money durable schema.
 *
 * WHY A RUNNER AND NOT `npm run migrate`
 *
 * Production execution belongs to the operator lane, not a developer session. This runs
 * inside the Render environment that already holds the production DATABASE_URL, so no
 * local credential is needed, minted, or passed through a workstation. Same shape as the
 * PS-488/0092, PS-501/0095 and PS-502/0096-0101 lanes.
 *
 * WHAT THIS MIGRATION DOES
 *
 *   0103  creates customer_shipping_money_sync_outcomes (durable per-shipment eligibility
 *         outcomes; frozen-is-terminal trigger; no DELETE/TRUNCATE) and
 *         customer_shipping_money_receipt_revisions (receipt_revised_after_freeze review
 *         records; one OPEN row per shipment via partial unique index; durable evidence
 *         trigger). Purely additive: no existing relation is altered and no row touched.
 *
 * DEPLOY ORDER IS MANDATORY. The PS-509 writer refuses to insert sync shipments until
 * this schema exists (fail-closed, loud, retryable) — so this lane must run APPLY before
 * the PS-509 code deploy starts serving sync traffic, or shipment ingestion stalls until
 * it does. Nothing is lost during a stall (receipts are durable in ShipStation), but the
 * stall is real. Run inspect first, read the job log, then apply.
 *
 *   npx tsx scripts/apply-ps-509-sync-money-schema.ts --digest103=<sha>
 *   npx tsx scripts/apply-ps-509-sync-money-schema.ts --digest103=<sha> --apply --confirm=<token>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const SQL_0103 = 'drizzle/0103_ps509_customer_shipping_money_sync.sql';
const CONFIRM_TOKEN = 'APPLY-PS-509-SYNC-MONEY-SCHEMA';
const EXPECTED_0103 = '29840edd48b06ef030571531cb19cf0e4f5238ad52b1d933a8d0d51fa1f505d3';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
function argValue(name: string): string | null {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

/** LF-normalised so the digest is stable across checkout line-ending policies. */
function normalisedDigest(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

const OUTCOME_TRIGGERS = ['csm_sync_outcomes_mutation_guard', 'csm_sync_outcomes_no_truncate'];
const REVISION_TRIGGERS = ['csm_receipt_revisions_mutation_guard', 'csm_receipt_revisions_no_truncate'];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. This runner is for the operator lane.');

  // Pinned in this module AND supplied by the caller: the constant proves the reviewed
  // content, the argument proves the archive arrived untampered. Either mismatch stops
  // before a connection is opened.
  const actual = normalisedDigest(SQL_0103);
  if (actual !== EXPECTED_0103) {
    throw new Error(`STOP: ${SQL_0103} does not match the reviewed content.\n  actual:   ${actual}\n  expected: ${EXPECTED_0103}`);
  }
  const supplied = argValue('digest103');
  if (supplied && supplied !== EXPECTED_0103) {
    throw new Error(`STOP: --digest103 does not match.\n  supplied: ${supplied}\n  expected: ${EXPECTED_0103}`);
  }
  console.log(`ok   ${SQL_0103} matches the reviewed digest`);

  if (APPLY && argValue('confirm') !== CONFIRM_TOKEN) {
    throw new Error(`STOP: --apply requires --confirm=${CONFIRM_TOKEN}`);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    console.log(`     target host: ${new URL(databaseUrl).hostname}`);
    console.log(`     mode       : ${APPLY ? 'APPLY' : 'INSPECT (read-only)'}\n`);

    const state = async () => {
      const [tables] = await sql<{ outcomes: boolean; revisions: boolean }[]>`
        select to_regclass('public.customer_shipping_money_sync_outcomes') is not null as outcomes,
               to_regclass('public.customer_shipping_money_receipt_revisions') is not null as revisions`;
      const triggers = await sql<{ tgname: string }[]>`
        select tgname from pg_trigger
        where not tgisinternal and tgenabled <> 'D'
          and tgname = any(${[...OUTCOME_TRIGGERS, ...REVISION_TRIGGERS]})`;
      const indexes = await sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where schemaname = 'public'
          and indexname in ('csm_sync_outcomes_shipment_unq', 'csm_sync_outcomes_retryable_idx',
                            'csm_receipt_revisions_open_unq', 'csm_receipt_revisions_shipment_idx',
                            'csm_receipt_revisions_state_idx')`;
      const constraints = await sql<{ conname: string }[]>`
        select c.conname from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public'
          and c.conname in ('csm_sync_outcomes_outcome_chk', 'csm_sync_outcomes_boundary_chk',
                            'csm_sync_outcomes_policy_chk', 'csm_receipt_revisions_class_chk',
                            'csm_receipt_revisions_state_chk', 'csm_receipt_revisions_resolution_chk')`;
      return { tables, triggers, indexes, constraints };
    };

    const before = await state();
    console.log('BEFORE:');
    console.log(`  tables      : outcomes=${before.tables.outcomes} revisions=${before.tables.revisions}`);
    console.log(`  triggers    : ${before.triggers.map((t) => t.tgname).sort().join(', ') || '(none)'}`);
    console.log(`  indexes     : ${before.indexes.map((i) => i.indexname).sort().join(', ') || '(none)'}`);
    console.log(`  constraints : ${before.constraints.map((c) => c.conname).sort().join(', ') || '(none)'}`);

    if (!APPLY) {
      console.log('\nINSPECT complete — nothing was written. Dispatch apply with the exact token to create the schema.');
      return;
    }

    // ONE transaction: the tables, indexes, functions and triggers land together or not
    // at all. The SQL is idempotent (IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS),
    // so a replay against an already-applied database is a shape-verified no-op.
    const migrationSql = readFileSync(SQL_0103, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(migrationSql);
    });
    console.log('\nAPPLIED. Re-reading the shape…\n');

    const after = await state();
    const failures: string[] = [];
    if (!after.tables.outcomes) failures.push('customer_shipping_money_sync_outcomes missing');
    if (!after.tables.revisions) failures.push('customer_shipping_money_receipt_revisions missing');
    for (const trigger of [...OUTCOME_TRIGGERS, ...REVISION_TRIGGERS]) {
      if (!after.triggers.some((t) => t.tgname === trigger)) failures.push(`trigger ${trigger} missing`);
    }
    const openUnq = after.indexes.find((i) => i.indexname === 'csm_receipt_revisions_open_unq');
    if (!openUnq) failures.push('csm_receipt_revisions_open_unq missing');
    else if (!/UNIQUE/i.test(openUnq.indexdef) || !/WHERE/i.test(openUnq.indexdef)) {
      failures.push(`csm_receipt_revisions_open_unq is not a partial UNIQUE index: ${openUnq.indexdef}`);
    }
    const shipmentUnq = after.indexes.find((i) => i.indexname === 'csm_sync_outcomes_shipment_unq');
    if (!shipmentUnq || !/UNIQUE/i.test(shipmentUnq.indexdef)) {
      failures.push('csm_sync_outcomes_shipment_unq missing or not UNIQUE');
    }
    for (const constraint of ['csm_sync_outcomes_outcome_chk', 'csm_sync_outcomes_boundary_chk',
      'csm_sync_outcomes_policy_chk', 'csm_receipt_revisions_class_chk',
      'csm_receipt_revisions_state_chk', 'csm_receipt_revisions_resolution_chk']) {
      if (!after.constraints.some((c) => c.conname === constraint)) failures.push(`constraint ${constraint} missing`);
    }

    console.log('AFTER:');
    console.log(`  tables      : outcomes=${after.tables.outcomes} revisions=${after.tables.revisions}`);
    console.log(`  triggers    : ${after.triggers.map((t) => t.tgname).sort().join(', ')}`);
    console.log(`  indexes     : ${after.indexes.map((i) => i.indexname).sort().join(', ')}`);
    console.log(`  constraints : ${after.constraints.map((c) => c.conname).sort().join(', ')}`);

    if (failures.length) {
      throw new Error(`Shape read-back FAILED:\n  - ${failures.join('\n  - ')}`);
    }
    console.log('\nPS-509 0103 applied and shape-verified. The PS-509 deploy may now serve sync traffic.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
