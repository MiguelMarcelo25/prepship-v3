# Master Regression Suite (PS-107)

One runner to execute PrepShip's many guard/smoke/certification scripts between
commits and after bug fixes — in **one report**, classified by coverage type, that
**continues past failures** instead of hiding later gates behind `&&`.

## Run it

```bash
npm run test:master:quick          # typecheck + critical static guards (fast, between commits)
npm run test:master                # quick + all safe non-browser guards/smokes
npm run test:master:shipping       # rates / labels / proof / print-queue / marketplace
npm run test:master:browser        # browser_e2e workflow tests
npm run test:master:all-safe       # everything safe (incl. browser + mocked smokes)
npm run test:master:manifest       # validate manifest ↔ package.json consistency
```

Flags (pass after `--`):

```bash
npm run test:master:quick -- --dry-run        # list what would run; run nothing
npm run test:master -- --fail-fast            # stop at first failure (default: continue)
npm run test:master -- --skip-browser
npm run test:master:all-safe -- --include-browser
npm run test:master -- --group rates-labels-proof
```

Artifacts are written to `test-results/master/`:
- `latest.json` / `latest.md` — most recent run
- `run-<stamp>.json` / `.md` — history

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
carrier enable/disable).

## Known pre-existing failure (surfaced, not caused by this runner)

- `test:ps-098-shipping-purchase-boundary` — fails on "frontend passes
  backend-issued selectedRateProof through label and queue payloads." This is a
  **pre-existing** failure in the locked selected-rate purchase-boundary area
  (documented as a known blocker in the PS-106 brief). It's a candidate fix for
  PS-105/PS-106 once the `unlock shipped data` override is granted — not a
  PS-107 (test-infra) change.
