# Security hardening — chunked migration

The single-file migration (`0018_security_hardening.sql`) **timed out** in the
Supabase Dashboard SQL Editor (~60s gateway limit).

This folder splits it into **5 small pastes**, each one finishing in
seconds. Run them in order.

## Why it timed out

Supabase Dashboard SQL Editor has a **gateway timeout (~60 seconds)** that's
SHORTER than Postgres' own `statement_timeout` (~120s on Supabase). Running
28 DDL statements + a DO block + 3 index builds in one shot easily exceeds
the gateway timeout — even though each individual statement is fast.

The fix: smaller batches, run individually.

## Order of operations

| # | File | What it does | Approx time |
|---|---|---|---|
| 0 | `0018_status_check.sql` | Shows which tables already have RLS (some may have committed before the timeout) | <1s |
| 1 | `0018a_rls_batch1.sql` | RLS on 8 tables | ~1s |
| 2 | `0018b_rls_batch2.sql` | RLS on next 8 tables | ~1s |
| 3 | `0018c_rls_batch3.sql` | RLS on final 8 tables | ~1s |
| 4 | `0018d_primary_key.sql` | Adds PK to `client_package_prices` (with duplicate pre-check) | ~5s |
| 5 | `0018e_indexes.sql` | 3 indexes — **paste each statement individually** because of `CONCURRENTLY` | ~5–30s each |

## How to use

For each file:
1. Open Supabase Dashboard → SQL Editor → **+ New query**
2. Open the file in your editor, copy the contents
3. Paste into the editor
4. Click **Run**
5. Verify success (green check), then move to next file

For `0018e_indexes.sql`, you must paste and run each `CREATE INDEX
CONCURRENTLY` statement **separately** — the editor wraps multi-statement
pastes in an implicit transaction, and `CONCURRENTLY` is forbidden in
transactions.

## After all 5 are done

Re-open Security Advisor. The 24 critical RLS warnings should be cleared.

Then handle the dashboard-only items (no SQL needed):
- **Auth → Providers → Email** → enable "Leaked Password Protection"
- **Auth → Sessions** → enable "Absolute Connection Strategy"

## If a batch errors with "upstream timeout"

That batch is too big for your current connection / there's lock contention.
Run the statements one-at-a-time instead — open the file, copy a single
`ALTER TABLE` line, paste, run, repeat.

## If a specific ALTER TABLE hangs

Something is holding a lock on that table. Run this to find the blocker:

```sql
SELECT pid, usename, application_name, state, wait_event_type, wait_event,
       query_start, LEFT(query, 80) AS query
FROM pg_stat_activity
WHERE state != 'idle'
  AND pid != pg_backend_pid()
ORDER BY query_start;
```

Identify the blocking PID, then:
```sql
SELECT pg_terminate_backend(<pid>);
```

…then retry the failing ALTER TABLE.

## Alternative: run via `psql` directly (no gateway timeout)

Bypasses the dashboard entirely:

```bash
psql "postgresql://postgres.fdkseckgfuvdczzqmnac:<PASSWORD>@aws-1-us-west-1.pooler.supabase.com:5432/postgres" \
  -f drizzle/0018_security_hardening.sql
```

Note port **5432** (session pooler), not 6543 (transaction pooler — doesn't
support all DDL). Requires `psql` to be on PATH.
