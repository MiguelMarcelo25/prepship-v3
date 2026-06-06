# PS-107 — Master Regression Runner + Bug-Capture Manifest — Truth Report

**Completion: 100%** ✅
**Deployed SHA:** `18415e32` — origin + mirror
**Report date:** 2026-06-06

## Claim
A master test runner derives a manifest from package.json, classifies every
command by coverage type + safety, runs a chosen profile continuing past
failures, and excludes dangerous/live commands from default profiles.

## Evidence (verified)
- `npm run test:master:quick` → **15/15 PASS** (run 2026-06-06):
  typecheck, ebay-nosku grouping, inventory-history pagination, daily-orders
  trend (count + total line), single-sku default qty scope, batch header package
  size, print-to-queue selected-rate proof, awaiting carrier badge fallback,
  batch-send proof forwarding, carrier enable/disable label,
  ps-098 purchase boundary, ps-102 DTO, ps-103 fingerprint, selected-rate proof.
- Files present + tracked: `scripts/prepship-master-test.mjs`,
  `docs/testing/master-regression-suite.md`, `docs/ps-tickets/README.md`.
- Profiles available: `test:master:manifest`, `:quick`, `test:master`,
  `:shipping`, `:browser`, `:all-safe`.
- Commit `18415e32` — on origin + mirror.

## What this proves
- The runner selects a safe subset, runs them, continues past failures, and
  prints a roll-up + writes `test-results/master/latest.md`.
- Dangerous commands (`:apply`, real-label, live) are classified and **excluded
  by design** from default profiles (the run prints this explicitly).

## What it does NOT prove
- `master:quick` covers the **safe 15-command subset only**. Full live shipping
  and browser profiles are gated and were **not** executed in this report.
- Coverage = the listed guards; commands without a guard are documented as
  manual/live-gated, not auto-verified.

## Known minor debt
- Runner emits Node `DEP0190` (child process spawned with `shell: true`).
  Harmless for offline guards; minor hardening item if it ever shells out with
  untrusted args.

## Lockdown compliance
Runner never executes live label/postage/marketplace commands in default
profiles. No shipped/cancelled mutation occurred.
