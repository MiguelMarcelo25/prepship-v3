# PS-507 — disposable QA harness

Proves that an **authenticated browser action committed the correct PostgreSQL row**,
and that forbidden sidecar or duplicate rows are absent.

The rest of `web/e2e` boots `dev:web`, seeds a placeholder `access_token` and mocks every
response with `page.route`. That proves rendering. It cannot show that a workflow
persisted anything, which is the evidence PS-499 Step 12 and PS-488 M3 actually need.

## Run it

```bash
npm run test:ps-507              # everything, with the Step 12 fixture seeded
npm run test:ps-507-persistence  # harness self-proof only, no fixture
npm run test:ps-507-step12       # PS-499 Step 12 scenarios only
npm run test:ps-507-qa-harness   # the offline guard (in the SOT pack)
```

Nothing else is required — no Docker, no local PostgreSQL, no Supabase project, no
credentials. `NODE_ENV` is defaulted by the CLI because npm scripts run under `cmd.exe`
on Windows where the POSIX prefix is a syntax error.

To poke at a stack by hand:

```bash
npm run qa:ps-507-stack -- --seed-ps499-step12   # prints endpoints, Ctrl-C tears down
```

## What it provisions

| | |
|---|---|
| database | isolated PGlite behind a loopback socket, full schema, disposable |
| auth | per-run random `SUPABASE_JWT_SECRET`, HS256 tokens minted against it |
| api | the real `src/main.ts` on its own port |
| frontend | the real Vite app pointed at that API |
| query | loopback, token-gated SQL endpoint for assertions |

Consumers receive `PS507_API_URL`, `PS507_WEB_URL`, `PS507_DATABASE_URL`,
`PS507_JWT_SECRET`, `PS507_QUERY_URL`, `PS507_QUERY_TOKEN`, `PS507_RUN_ID`, and
`PS499_STEP12_RUN_ID` when seeded.

## Writing a spec

```js
import { qaApiFetch, expectExactlyOneRow, expectNoRows, signInAsQaUser } from './support/ps-507-harness.js'

await signInAsQaUser(page, { permissions: ['financials:write'] })  // a REAL bearer
const res = await qaApiFetch('/billing/details/42', { method: 'PATCH', permissions, body })

await expectExactlyOneRow('select … where order_id = $1', [42], 'billing row')
await expectNoRows('select 1 from billing_manual_overrides where order_id = $1', [42], 'sidecar')
```

**The rule:** never `page.route` over the request whose persistence you are claiming.
Mocking a carrier quote or a marketplace callback is fine; mocking the thing under test
turns the spec into theatre. The guard enforces this.

**Permissions default to empty.** A spec needing `financials:write` says so, so an
authorisation regression fails loudly instead of hiding behind a blanket admin token.

## Cleanup

Teardown *is* the cleanup. The database is in-memory and dies with the process, so there
is no cleanup step that can half-succeed and leave a polluted database behind.

## Safety

Refuses to provision unless every target is loopback, and rejects anything naming a
managed provider — the Supabase pooler, `onrender.com`, `vercel.app`, RDS, Neon. Verified
against this repo's real production URLs in the guard. Secrets are redacted from all
output. Ports are dedicated and deliberately **not 5177**, which is contended by other
agents' env-less Vite servers.

## Known constraints — read before debugging

**One concurrent connection.** PGlite serves a single client, so the API pool is pinned
to 1. Consequences, all deliberate:

- The stack proves **persistence and authorisation, not concurrency**. Anything needing
  real parallelism belongs on a PostgreSQL service container.
- Playwright runs `workers: 1`.
- Seeders run **before** the API boots. Seeding while it is up dies with `ECONNRESET`.
- Assertions go through the query endpoint, because a test process cannot open its own
  connection.

**`/health/ready` returns 503 while `/health` returns 200.** Not a bug.
`src/routes/health.ts:22` builds `healthSql` as a *separate* pool by design, so a
saturated main pool cannot hide behind health checks — and PGlite has no second
connection to give it. `db` and `dbWrite` fail; `mainPool` and `eventLoop` pass. The app
is right; the database is the constraint. Readiness is therefore **not a usable gate
here**, provisioning waits on `/health`, and the exact shape of that 503 is asserted by
`ps-507-persistence-proof.spec.js` so it can never absorb a real regression.

**`drizzle-kit migrate` cannot build this schema.** `drizzle/meta/_journal.json` holds 16
entries against 104 `.sql` files — it stops at `0015`. The stack applies all 104 in
filename order and tolerates six by name, each with a stated reason (index concurrency,
Supabase-only roles, missing `pg_trgm`, RLS on a table this repo does not own). A
migration failing for a *new* reason is fatal.

**`returns` is Client-Portal-owned.** Nothing here migrates it, so the stack bootstraps
it in its pre-`0088` shape and lets `0088`, `0089` and `0092` apply for real. The QA
database reaches the reconciled return-identity contract by the same path production did.

## Scope today

Automated: the API → persistence half of PS-499 Step 12, including scenario D's four
facts (two of them absences) and F1's sparse-payload omission.

Not yet automated: driving the bulk-import paste through the browser UI. Request-shape
checks are asserted by *sending* that shape, not by observing what the UI produced. That
is the next slice, and PS-488 M3 is the second intended consumer.
