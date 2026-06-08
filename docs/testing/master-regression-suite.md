# Master Regression Suite (PS-107 / PS-110 v2)

One runner to execute PrepShip's many guard/smoke/certification scripts between
commits and after bug fixes — in **one report**, classified by coverage type, that
**continues past failures** instead of hiding later gates behind `&&`. PS-110 made
it a reliable certification gate: **leaf-only** profiles (no recursion, no nested
aggregates), a **lock-aware parallel scheduler**, **live-test isolation**, and
**durable shard reports** that survive failures and interrupts.

## Tiered profiles

| Profile | What it runs | Use when |
|---|---|---|
| `test:master:quick` | typecheck + critical static/source-of-truth/proof/print-queue guards. **Target < 5 min.** No browser/provider/live/nested work. | Between commits — fast local gate. |
| `test:master` | Default confidence gate: all safe non-browser leaf guards/smokes. No recursion, no nested aggregate duplication, no live mutation. | Pre-push / PR confidence. |
| `test:master:shipping` | Rates / labels / proof / print-queue / marketplace-confirmation critical path. Mocked/offline/sandbox only — no real label purchase or marketplace notification. | Shipping-area changes. |
| `test:master:browser` | Browser / workflow E2E only, safe fixtures. Uses a `browser` resource-lock so dev-server/E2E runs don't collide. | UI/workflow changes. |
| `test:master:all-safe` | The full safe suite incl. browser + mocked smokes. Slower; nightly / pre-release. Still no live mutation. | Release candidate. |
| `test:master:live-readonly` | **Opt-in only.** Real configured DB/provider **read-only** certification (e.g. `certify:external-shipped`). Never part of any default gate. | Deliberate live verification. |
| `test:master:manifest` | Validates manifest ↔ package.json: no recursion, no nested aggregates, no live/order/provider command in a default gate. | CI preflight (non-recursive). |

## Run it

```bash
npm run test:master:quick -- --concurrency 8     # fast local gate (< 5 min target)
npm run test:master -- --concurrency 8           # default confidence gate
npm run test:master:shipping -- --concurrency 4
npm run test:master:browser
npm run test:master:all-safe
npm run test:master:manifest                     # consistency/safety guard
```

Flags (pass after `--`):

```bash
--concurrency <n>     # max parallel commands (default: min(8, cpus-2))
--dry-run             # list what would run (with lock/args/live tags); run nothing
--fail-fast           # stop launching new commands after the first failure
--skip-browser        # drop browser_e2e commands
--include-browser     # add browser_e2e commands even if the profile excludes them
--group <name>        # only commands in that domain group
```

## Parallel scheduler + live isolation

Commands run through a **lock-aware worker pool**. Each manifest entry carries
scheduling metadata: `concurrencySafe`, `resourceLocks`, `estimatedMs`, and
`requiresLiveData` / `requiresProviderAccess` / `requiresOrderId`.

- Static/offline guards run fully in parallel up to `--concurrency`.
- Commands sharing a `resourceLock` are **serialised** against each other:
  `browser` (dev-server/E2E), `build` (typecheck / `build:web`), `db` (read-only
  live-DB). So browser specs never fight over the dev server, and the slow build
  lock doesn't block the fast guards.
- Slowest/locked work is launched first so the long tail starts early.
- **Manual/live-mutating commands are never scheduled** — a hard safety net filters
  `manual_live_gated` out even if a profile ever listed one.

### What can / cannot be certified without real orders

Default gates (`quick`/`master`/`shipping`/`browser`/`all-safe`) are **fully
offline/mocked** — they certify static contracts, unit/logic, mocked smokes, and
browser workflows against fixtures. They **cannot** certify a real shipped order,
a live provider account, or live DB state. Those require `live-readonly` (read-only)
or the manual, approval-gated `:apply` commands — run separately, never through a
default gate. The report's coverage column tells you which kind of green you got.

## Reports

Artifacts are written to `test-results/master/`:
- `latest.json` / `latest.md` — most recent run (profile summary by group, slowest
  commands, per-command coverage/safety/locks/runtime, and a failure section).
- `run-<stamp>.json` / `.md` — history.
- `run-<stamp>/shards/<command>.json` — **one isolated shard per command**, written
  the moment it finishes. Parallel workers never clobber each other or `latest.*`.

Reports are **always written** — after passing runs, after failing runs, and (best
effort) on `SIGINT` interrupt — because the aggregator runs in a finalize step
before the nonzero exit, and shards are flushed incrementally. The `quick` profile
warns if its wall time drifts over the 5-minute target.

The runner **exits nonzero** if any executed command failed, but only **after**
running them all (so you see every failure, not just the first).

## What runs (and what never does)

The manifest (`scripts/prepship-master-test-manifest.mjs`) is **derived from
package.json** so it can't drift. Each command is classified:

- **coverage type:** `static_guard | unit_or_logic | mocked_smoke | browser_e2e |
  workflow_certification | manual_live_gated`
- **safety level:** `safe_offline | safe_mocked | browser_mocked |
  dry_run_db_read | manual_live_approval_required`

**Live / mutating commands are NEVER run by default.** Anything that could buy
postage, create a real label, void, notify a marketplace, or write live DB
(`:apply`, `real-label`, `:repair`, `:reconcile:apply`, `db:migrate`, …) is
classified `manual_live_gated`, documented in the manifest, and excluded from
every profile. The runner has a hard safety net that filters them out even if a
profile ever lists one. Run those manually, with approval, never through master.

## Coverage-type discipline (why this exists)

"Static guards passing" has repeatedly been mistaken for "the workflow works."
The report shows the coverage **type** of every result so you know whether a
green check is only a static guard, a mocked smoke, a real browser workflow, or
a live/manual-gated check that wasn't run.

## Bug-capture policy

**Every bug fix adds or updates a regression entry.** A bug isn't done unless its
regression test **fails before the fix** (when practical) and **passes after**.

1. Add a `scripts/<name>-guard.ts` (or `.mjs`) and a `test:<name>` package script.
2. If it protects a PS ticket or named bug, add it to the `PROTECTS` map in
   `scripts/prepship-master-test-manifest.mjs`.
3. `npm run test:master:manifest` verifies every manifest command exists in
   package.json and that no live-gated command leaks into a default profile.

Recent regressions already seeded: PS-103 (frontend fingerprint authority),
PS-104 (`/print-queue/batch-send` proof forwarding), selected-rate purchase
boundary, best-rate workflow DTO, plus this branch's UI/data fixes
(eBay no-SKU title, batch-header package size, daily-trend count + total line,
single-SKU qty scope, awaiting carrier nickname, inventory-history pagination,
carrier enable/disable, saved best-rate display metadata).

## Reading failures honestly (PS-110)

When a default gate is red, classify each failure rather than hiding it. The report
groups by domain and shows coverage type so you can triage:

- **test-infra / profile issue** — a command that needs args/mocks it didn't get,
  or a wrongly-classified command. Fix the manifest, not the product. The manifest
  guard (`test:master:manifest`) now fails the build for recursion, nested
  aggregates, or a live/order/provider command leaking into a default gate, so these
  should be caught before a run.
- **real code regression** — a static guard / mocked smoke / browser workflow that
  fails because behavior actually broke. Owned by the relevant feature/PS ticket.
- **live/order/provider required** — moved out of default gates into
  `live-readonly` or the manual `:apply` commands; never run by a default gate.

Failures are **reclassified, never deleted** from all profiles to make the suite
green. A command that needs a real order/provider/DB is moved to `live-readonly` or
given a safe-args wrapper (e.g. `smoke:shipping:test-label --fixture`) — it is not
silently dropped.
