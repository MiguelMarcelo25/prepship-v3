#!/usr/bin/env tsx
/* eslint-disable no-console */
// Migrates auth users from Tokyo Supabase → US-West Supabase, preserving
// UUIDs so existing references (e.g. orders.assigned_to_user_id) still work
// after cutover.
//
// Approach:
//   1. List all users from source via admin API.
//   2. For each user, INSERT into target's auth.users via service-role
//      Postgres connection with the same id, email, password_hash, role,
//      etc. (admin API doesn't accept arbitrary id, so we go direct.)
//   3. Validate by listing target users and confirming the count.
//
// Caveats:
//   - Users will have to use the SAME password they had on Tokyo (since
//     password_hash carries over). Magic-link / OAuth users need re-link
//     because identities are project-scoped.
//   - Refresh tokens DON'T carry over — every user must re-login after
//     cutover.
//
// Usage:
//   SOURCE_SUPABASE_URL=https://...tokyo.supabase.co \
//   SOURCE_SERVICE_ROLE_KEY=eyJ... \
//   TARGET_DATABASE_URL=postgresql://...uswest...:5432/postgres \
//   TARGET_SUPABASE_URL=https://...uswest.supabase.co \
//   TARGET_SERVICE_ROLE_KEY=eyJ... \
//   npx tsx scripts/migrate-supabase-auth.ts [--dry-run]

import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

const SRC_URL = process.env.SOURCE_SUPABASE_URL;
const SRC_SR = process.env.SOURCE_SERVICE_ROLE_KEY;
const TGT_URL = process.env.TARGET_SUPABASE_URL;
const TGT_SR = process.env.TARGET_SERVICE_ROLE_KEY;
const TGT_DB = process.env.TARGET_DATABASE_URL;

if (!SRC_URL || !SRC_SR || !TGT_URL || !TGT_SR || !TGT_DB) {
  console.error('Required env vars: SOURCE_SUPABASE_URL, SOURCE_SERVICE_ROLE_KEY, TARGET_SUPABASE_URL, TARGET_SERVICE_ROLE_KEY, TARGET_DATABASE_URL');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n=== Migrate auth users ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  const srcAdmin = createClient(SRC_URL, SRC_SR, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const tgtAdmin = createClient(TGT_URL, TGT_SR, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) List source users
  console.log('Reading source users…');
  const srcUsers: Array<{ id: string; email: string }> = [];
  let page = 1;
  while (true) {
    const { data, error } = await srcAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) {
      if (u.email) srcUsers.push({ id: u.id, email: u.email });
    }
    if (!data.users.length || data.users.length < 200) break;
    page += 1;
  }
  console.log(`  found ${srcUsers.length} source users`);

  // 2) Pre-check target — we need to bypass admin API and write to auth.users
  //    directly (admin.createUser doesn't honor `id`). Connect to target DB
  //    using the service-role-equivalent direct connection.
  const tgtPg = postgres(TGT_DB, { prepare: false, max: 3, idle_timeout: 10 });
  try {
    const existing = await tgtPg<{ id: string; email: string }[]>`
      select id::text as id, email from auth.users
    `;
    const existingIds = new Set(existing.map((r) => r.id));
    const existingEmails = new Set(existing.map((r) => r.email?.toLowerCase()));
    console.log(`  ${existing.length} users already in target`);

    // 3) Pull full row for each source user from source DB so we can copy
    //    password_hash, role, raw_user_meta_data, etc. We need the source DB
    //    URL too. Try to derive from SOURCE_DATABASE_URL env, otherwise we
    //    only get what listUsers returns (no password_hash → users must reset).
    const srcDbUrl = process.env.SOURCE_DATABASE_URL;
    if (!srcDbUrl) {
      console.error('SOURCE_DATABASE_URL not set — cannot copy password hashes; users will need to reset their password after cutover. Aborting to be safe; set SOURCE_DATABASE_URL and re-run.');
      process.exit(1);
    }

    const srcPg = postgres(srcDbUrl, { prepare: false, max: 3, idle_timeout: 10 });
    try {
      const srcRows = await srcPg<Array<{
        id: string;
        instance_id: string | null;
        email: string;
        encrypted_password: string | null;
        email_confirmed_at: string | null;
        invited_at: string | null;
        confirmation_token: string | null;
        confirmation_sent_at: string | null;
        recovery_token: string | null;
        recovery_sent_at: string | null;
        email_change_token_new: string | null;
        email_change: string | null;
        email_change_sent_at: string | null;
        last_sign_in_at: string | null;
        raw_app_meta_data: unknown;
        raw_user_meta_data: unknown;
        is_super_admin: boolean | null;
        created_at: string;
        updated_at: string;
        phone: string | null;
        phone_confirmed_at: string | null;
        phone_change: string | null;
        phone_change_token: string | null;
        phone_change_sent_at: string | null;
        confirmed_at: string | null;
        email_change_token_current: string | null;
        email_change_confirm_status: number | null;
        banned_until: string | null;
        reauthentication_token: string | null;
        reauthentication_sent_at: string | null;
        is_sso_user: boolean | null;
        deleted_at: string | null;
        is_anonymous: boolean | null;
      }>>`select * from auth.users`;

      let inserted = 0;
      let skipped = 0;
      for (const u of srcRows) {
        if (existingIds.has(u.id) || existingEmails.has(u.email?.toLowerCase())) {
          console.log(`  ↷ skip ${u.email} (already in target)`);
          skipped += 1;
          continue;
        }
        if (dryRun) {
          console.log(`  + would insert ${u.email} (id=${u.id})`);
          continue;
        }
        // Note: confirmed_at is a generated column in newer Supabase
        // projects (computed from email_confirmed_at / phone_confirmed_at) —
        // omit it from the INSERT or the engine errors out.
        await tgtPg`
          insert into auth.users (
            id, instance_id, email, encrypted_password, email_confirmed_at,
            invited_at, confirmation_token, confirmation_sent_at,
            recovery_token, recovery_sent_at,
            email_change_token_new, email_change, email_change_sent_at,
            last_sign_in_at, raw_app_meta_data, raw_user_meta_data,
            is_super_admin, created_at, updated_at,
            phone, phone_confirmed_at, phone_change, phone_change_token,
            phone_change_sent_at,
            email_change_token_current, email_change_confirm_status,
            banned_until, reauthentication_token, reauthentication_sent_at,
            is_sso_user, deleted_at, is_anonymous,
            aud, role
          ) values (
            ${u.id}::uuid, ${u.instance_id}::uuid, ${u.email},
            ${u.encrypted_password}, ${u.email_confirmed_at},
            ${u.invited_at}, ${u.confirmation_token}, ${u.confirmation_sent_at},
            ${u.recovery_token}, ${u.recovery_sent_at},
            ${u.email_change_token_new}, ${u.email_change}, ${u.email_change_sent_at},
            ${u.last_sign_in_at},
            ${u.raw_app_meta_data as object}::jsonb,
            ${u.raw_user_meta_data as object}::jsonb,
            ${u.is_super_admin}, ${u.created_at}, ${u.updated_at},
            ${u.phone}, ${u.phone_confirmed_at}, ${u.phone_change}, ${u.phone_change_token},
            ${u.phone_change_sent_at},
            ${u.email_change_token_current}, ${u.email_change_confirm_status},
            ${u.banned_until}, ${u.reauthentication_token}, ${u.reauthentication_sent_at},
            ${u.is_sso_user}, ${u.deleted_at}, ${u.is_anonymous},
            'authenticated', 'authenticated'
          )
        `;
        console.log(`  + inserted ${u.email} (id=${u.id})`);
        inserted += 1;
      }

      // Also copy auth.identities so the identity_data lookups don't break
      // (Supabase uses identities for the providers users signed in with).
      if (!dryRun) {
        try {
          const idents = await srcPg<Array<Record<string, unknown>>>`
            select * from auth.identities where user_id in ${srcPg(srcRows.map((u) => u.id))}
          `;
          for (const ident of idents) {
            try {
              const cols = Object.keys(ident);
              const values = cols.map((c) => ident[c]);
              await tgtPg.unsafe(
                `insert into auth.identities (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) on conflict do nothing`,
                values
              );
            } catch (err) {
              console.warn(`  identity copy warning: ${(err as Error).message}`);
            }
          }
          console.log(`  + copied ${idents.length} identity rows`);
        } catch (err) {
          console.warn(`  identities query skipped: ${(err as Error).message}`);
        }
      }

      console.log(`\nSummary: ${inserted} inserted, ${skipped} already in target.`);
    } finally {
      await srcPg.end({ timeout: 5 });
    }
  } finally {
    await tgtPg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
