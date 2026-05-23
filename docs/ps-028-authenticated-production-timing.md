# PS-028 Authenticated Production Timing + Supabase Pool Capture

Status: ready to run during real operations.

This is a read-only diagnostic follow-up to PS-027. It captures production health, protected API timing snapshots, worker/sync status, and Supabase/Postgres pool/slow-query evidence without creating labels, buying postage, mutating orders, or sending marketplace notifications.

## Command

```bash
npm run diagnose:production-timing
```

## Required Environment

For full capture, set:

```bash
PREPSHIP_API_TOKEN=<admin bearer token>
DATABASE_URL=<Supabase/Postgres connection string>
```

Accepted token env names:

- `PREPSHIP_API_TOKEN`
- `SUPABASE_ACCESS_TOKEN`
- `PROD_ADMIN_BEARER_TOKEN`

Optional overrides:

```bash
PREPSHIP_WEB_BASE_URL=https://prepshipv4.vercel.app
PREPSHIP_API_BASE_URL=https://prepshipv4-api-l5xc.onrender.com
PS028_OUTPUT_JSON=reports/ps-028-production-timing.json
```

If token or DB URL is missing, the script still captures public health and clearly marks protected/DB sections as skipped.

## What It Captures

- Vercel app shell.
- Vercel `/api/health` rewrite.
- Render `/health`, `/health/ready`, `/health/deep`.
- Authenticated Render `/observability/status`.
- Authenticated Render `/observability/api-timing`.
- Authenticated Render `/sync/status`.
- Authenticated Render `/worker/status`.
- Supabase/Postgres `pg_stat_activity` aggregate.
- Supabase/Postgres lock aggregate.
- `pg_stat_statements` slow query shapes when available.

## Safety

- Read-only HTTP GETs only.
- Read-only SQL selects only.
- Does not print secrets.
- Does not dump raw customer rows.
- Sanitizes SQL text by stripping string literals and long numbers.
- Does not create labels, buy postage, mutate orders, or notify marketplaces.

## When To Run

Run during:

- normal ops baseline,
- while Orders is slow,
- while Print Queue is slow,
- while label/rate calls feel hung,
- after Render/Supabase plan changes.

Keep at least two artifacts:

- one healthy baseline,
- one slow/hung incident capture.

## Output

Default output path:

```text
reports/ps-028-production-timing-<timestamp>.json
```

The `reports/` folder is diagnostic output and should be reviewed before committing. Do not commit artifacts if they contain anything unexpected.
