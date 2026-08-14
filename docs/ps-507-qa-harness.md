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

**Connections are capped, and the cap matters.** `PGLiteSocketServer` defaults to
`maxConnections: 1`, and the API is emphatically not a one-connection client: the main
Drizzle pool, the health probe pool (`src/routes/health.ts:22`, `max: 3`), the advisory
lock, the sync job queue, the lane lock, the stuck-job reaper and worker-status each
construct their own `postgres()` client. At the default, the refused connections tore
down the *active* socket, which surfaced as `read ECONNRESET`, a 503 `/health/ready`, the
web app rendering the maintenance page instead of the shell, and bulk-import `PATCH`es
failing intermittently with a driver-level `Failed query`.

The working configuration is `maxConnections: 6` against `DB_POOL_MAX=1` — enough sockets
for the health pool to connect, while the app's own queries stay serialised on one. Three
things had to be true together, each established by measurement rather than reasoning:

- **Raising the cap alone made things worse.** PGlite is single-threaded WASM PostgreSQL.
  At `maxConnections: 32` plain `GET /clients` returned 500 and connects timed out; at
  `4` with `DB_POOL_MAX=2`, unrelated endpoints failed in bursts.
- **Background cadence had to go.** `SHIPMENT_SYNC_WATCHDOG_ENABLED=false`,
  `RUN_ORDERS_PERFORMANCE_MAINTENANCE=false`, `RUN_SYNC_SCHEDULER=false`. Two independent
  reasons, either sufficient: a tick can mutate the very fixtures a spec asserts on, and
  each worker builds its own client. This took the suite from 3.9 minutes with failures to
  roughly 8 seconds.
- **The query endpoint goes over the socket, not in-process.** It originally called
  `pg.query()` on the PGlite handle directly, which interleaved with queries the socket
  server was serving: a spec's own read-back could knock over an unrelated request the
  browser had just issued. That was a 1-in-5 flake which always landed on the UI spec and
  never on the spec that caused it. Routing it through the socket puts every reader behind
  one queue — five consecutive full-suite runs clean at ~8.1s.

Do not "fix" a future flake here by adding retries. This stack's failure mode is
*unattributable* — it lands on whatever request was in flight, not on the cause — so a
retry turns a visible provisioning fault into a slow, silent one.

Remaining consequences, all deliberate:

- The stack proves **persistence and authorisation, not concurrency**. Anything needing
  real parallelism or real background cadence belongs on a PostgreSQL service container.
- Playwright runs `workers: 1`.
- Seeders run **before** the API boots.
- Assertions go through the query endpoint rather than a direct connection.

**Readiness must be green, and specs depend on it.** `ServiceAvailabilityGate` polls
`/health/ready` and renders `MaintenanceModePage` instead of the app shell on 503, so a
UI spec against a mis-provisioned stack fails at whatever it clicked first rather than
saying what is wrong. `gotoApp()` therefore waits for `/health/ready` to return 200
before navigating (pools connect lazily, so the first seconds after boot can be 503
legitimately) and throws a named error if the maintenance page appears anyway. The
`Continue to app` bypass is deliberately **not** used — it would let a broken stack look
healthy. `ps-507-persistence-proof.spec.js` asserts readiness is fully green.

**`drizzle-kit migrate` cannot build this schema.** `drizzle/meta/_journal.json` holds 16
entries against 104 `.sql` files — it stops at `0015`. The stack applies all 104 in
filename order and tolerates six by name, each with a stated reason (index concurrency,
Supabase-only roles, missing `pg_trgm`, RLS on a table this repo does not own). A
migration failing for a *new* reason is fatal.

**`returns` is Client-Portal-owned.** Nothing here migrates it, so the stack bootstraps
it in its pre-`0088` shape and lets `0088`, `0089` and `0092` apply for real. The QA
database reaches the reconciled return-identity contract by the same path production did.

## Where it runs

Registered in **two** places, and they must be changed together:

- `.github/workflows/ci.yml` — job `ps-507-qa-stack-proofs`
- `.github/workflows/render-auto-deploy.yml` — last step of the `gate` job

The duplication is deliberate. Despite its name, "Render Auto-Deploy (CI-gated)" does not
wait on the CI workflow's conclusion; it re-runs its own inline gate list. That workflow's
comment records what happened when the two lists diverged — the SOT pack was copied into it
after "a red PS-464 could and did reach production while the general CI was failing." A
schema or persistence regression is exactly what a typecheck and a frontend build cannot
see, and the deploy gate's path filter (`src/**`, `drizzle/**`) selects for precisely that.
`test:ps-507-qa-harness` asserts both registrations exist.

**It must run on a clean checkout, and that is not the same as running on a dev box.**
The Step 12 fixture imports `src/db/client`, hence `src/lib/env.ts`, which hard-requires
the four `SUPABASE_*` values off-serverless and calls `process.exit(1)` without them. The
stack passed them to the API child only, and the seeder survived on a developer machine
purely because an untracked repo-root `.env` was there for `dotenv/config` to find. On CI
the seeder exited 1 before a single spec ran. They now come from one shared
`qaSupabaseEnv` object used by both spawns, so the two cannot drift apart again.

To reproduce a clean checkout without deleting your `.env`:

```bash
env -u SUPABASE_URL -u SUPABASE_ANON_KEY -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_JWT_SECRET DOTENV_CONFIG_PATH=/nonexistent npm run test:ps-507
```

Tolerated migrations pin the **expected error**, not just the filename — a known file
failing a new way is still fatal. `PS507_DUMP_MIGRATION_ERRORS=1` prints the real message
for each, which is how those patterns were captured rather than guessed. `0094` is
tolerated because `pgboss` is created by the pg-boss library at runtime and the QA stack
never starts the worker.

## Scope today

**PS-499 Step 12** — both halves. The API → persistence leg covers scenario D's four
facts (two of them absences) and F1's sparse-payload omission. The browser leg
(`ps-507-ps499-step12-ui.spec.js`) drives the real bulk-import paste in a real browser and
captures the outgoing `PATCH` off the wire, which is the one thing the API leg cannot do:
it asserts the request shape by *sending* it, which is an assumption about the frontend
dressed as a test. The browser leg checks `hasOwnProperty('shipping')` rather than the
value, because `shipping: 0` and an absent `shipping` are different instructions to the
route — one clears the fee, the other leaves it alone — and `toBeUndefined()` passes for
both. Verified by mutation: making the UI send `shipping: 0` for a blank cell turns the
spec red on that assertion, quoting the payload.

**PS-488 M3** — the return-identity contract
(`ps-507-ps488-m3-return-identity.spec.js`, fixture `--seed-ps488-m3`). Two returns
against one order, billed asymmetrically — every bucket, every per-return total and the
merged total are distinct numbers, so a merge cannot hide behind a plausible sum.

Two layers, because they fail independently:

- *Storage.* Migration 0092's constraints are attacked with real `INSERT`s, and the
  rejections are matched on the constraint NAMES (`billing_li_return_identity_unq`,
  `billing_li_return_id_canonical_type_check`) so a write failing for an unrelated reason
  cannot be mistaken for the constraint holding. A guard can prove the migration text
  declares a `NOT VALID` CHECK; only the engine proves it was ever `VALIDATE`d.
- *Projection.* The DTO `/billing/details` actually returns is asserted: three rows for
  one order (one `Outbound`, two `Return`), each return keyed on its own `returnId`, with
  per-return buckets, `lineTypes`, outbound money at zero on return rows, and the client
  total counting return money exactly once. This layer is not redundant — mutating the SOT
  row key to `return:<orderId>` merges the two returns into a single row while **every
  storage assertion still passes**, so without it a per-order grouping regression would
  ship green.

`displayReference` is asserted as distinct and reference-bearing, not as an exact format:
AC-1's wording describes `#1234-RETURN` while the read model emits `#<returnReference>`.
Which is intended is a product question, and pinning either reading would turn a guess
into a verified fact.

`RETURN_BILLING_ENABLED` stays **false** here. The generator is PS-487's boundary and
flipping the flag is a deliberate operator decision; the fixture writes the rows that pass
would have produced, so the identity and read half is exercised without enabling the
writer.

Not automated: the return-billing generator itself, Supabase's own token issuance and
refresh, and anything needing real concurrency or background cadence.
