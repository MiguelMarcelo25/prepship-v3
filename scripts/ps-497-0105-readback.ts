#!/usr/bin/env tsx
import 'dotenv/config';
import postgres from 'postgres';
import { readVerifiedMigration } from './ps-497-claim-status-migration-digest.js';

// PS-497 Slice 2 — INDEPENDENT post-apply readback for migration 0105. Read-only: it opens no write path,
// never applies anything, and is separate from the apply runner so it can attest the live catalog after an
// authorized 0105 apply. It verifies: the pinned digest; that the claim-check catalog is EXACTLY phase_0105
// (v2 + six-value status domain present, validated, with the exact PG17 definitions; both legacy checks
// gone); every existing claim status is in the domain; every claim satisfies the v2 quantity-state contract;
// and prints the frozen-range full-row checksum + status histogram for the operator to compare to the
// pre-apply capture in the 0105 runbook. Exit 0 = green; non-zero = an assertion failed.

const V2_CHECK = 'fulfillment_line_claims_quantity_state_v2_check';
const DOMAIN_CHECK = 'fulfillment_line_claims_status_domain_check';
const OLD_QTY_CHECK = 'fulfillment_line_claims_quantity_state_check';
const OLD_STATUS_CHECK = 'fulfillment_line_claims_status_check';
const KNOWN_STATUSES = ['pending', 'applied', 'superseded', 'reversed', 'review', 'not_applicable'];
const EXPECTED_DEF: Record<string, string> = {
  [V2_CHECK]:
    "CHECK ((((quantity IS NOT NULL) AND (quantity > 0)) OR ((quantity IS NULL) AND (status = ANY (ARRAY['review'::text, 'not_applicable'::text, 'superseded'::text])))))",
  [DOMAIN_CHECK]:
    "CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'superseded'::text, 'reversed'::text, 'review'::text, 'not_applicable'::text])))",
};

function normalizeDef(def: string): string {
  // pg_get_constraintdef appends ' NOT VALID' for an unvalidated constraint; validity is checked
  // separately (convalidated), so the definition comparison is over the CHECK expression alone.
  return def.replace(/\s+/g, ' ').replace(/\s*NOT VALID\s*$/i, '').trim();
}

async function main(): Promise<void> {
  const { digest } = readVerifiedMigration();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = postgres(databaseUrl, {
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: 'ps-497-0105-readback', search_path: 'public' },
  });
  const problems: string[] = [];
  try {
    console.log(`[ps-497-0105-readback] migration digest verified: ${digest}`);

    const conRow = async (name: string) => {
      const [row] = await client<{ contype: string; validated: boolean | null; def: string }[]>`
        select con.contype::text as contype, con.convalidated as validated, pg_get_constraintdef(con.oid) as def
        from pg_constraint con
        join pg_class r on r.oid = con.conrelid
        join pg_namespace n on n.oid = r.relnamespace
        where n.nspname = 'public' and r.relname = 'fulfillment_line_claims' and con.conname = ${name}`;
      return row;
    };

    for (const name of [V2_CHECK, DOMAIN_CHECK]) {
      const row = await conRow(name);
      if (!row) { problems.push(`${name}: ABSENT (expected present+validated)`); continue; }
      if (row.contype !== 'c') problems.push(`${name}: contype=${row.contype} (expected 'c')`);
      if (row.validated !== true) problems.push(`${name}: NOT VALIDATED`);
      const expected = EXPECTED_DEF[name];
      if (expected && normalizeDef(row.def) !== normalizeDef(expected)) problems.push(`${name}: definition mismatch -> ${row.def}`);
    }
    for (const name of [OLD_QTY_CHECK, OLD_STATUS_CHECK]) {
      if (await conRow(name)) problems.push(`${name}: STILL PRESENT (expected dropped by 0105)`);
    }

    const statusRows = await client<{ status: string }[]>`select distinct status from fulfillment_line_claims`;
    const unknown = statusRows.map((r) => r.status).filter((s) => !KNOWN_STATUSES.includes(s));
    if (unknown.length) problems.push(`unknown claim statuses present: ${unknown.join(', ')}`);

    const [badRow] = await client<{ bad: string }[]>`
      select count(*)::text as bad from fulfillment_line_claims
      where not ((quantity is not null and quantity > 0) or (quantity is null and status in ('review','not_applicable','superseded')))`;
    if (Number(badRow?.bad ?? '0') > 0) problems.push(`${badRow?.bad} row(s) violate the v2 quantity-state contract`);

    const [snap] = await client<{ claim_count: string; by_status: string; checksum_lo: string; checksum_hi: string }[]>`
      select
        (select count(*)::text from fulfillment_line_claims) as claim_count,
        (select coalesce(string_agg(s.status || '=' || s.n, ',' order by s.status), 'none')
           from (select status, count(*)::text n from fulfillment_line_claims group by status) s) as by_status,
        coalesce((select sum(('x' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint::numeric)::text from fulfillment_line_claims t), '0') as checksum_lo,
        coalesce((select sum(('x' || substr(md5(to_jsonb(t)::text), 17, 16))::bit(64)::bigint::numeric)::text from fulfillment_line_claims t), '0') as checksum_hi`;
    console.log(`[ps-497-0105-readback] claims=${snap?.claim_count} by_status=${snap?.by_status}`);
    console.log(`[ps-497-0105-readback] full_row_checksum_lo=${snap?.checksum_lo} checksum_hi=${snap?.checksum_hi}`);

    if (problems.length) {
      throw new Error(`0105 readback FAILED:\n  - ${problems.join('\n  - ')}`);
    }
    console.log('[ps-497-0105-readback] phase=0105 exact; v2+status_domain validated with exact defs; both legacy checks dropped; no unknown status; no v2 violation. GREEN.');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-497-0105-readback] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
