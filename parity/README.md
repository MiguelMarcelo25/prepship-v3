# Parity pipeline

Line-by-line v2original → v4-stable parity verification.

## Run the pipeline

```bash
# Extract atoms from both repos (parallel)
node scripts/parity/extract.mjs ../v2orginal v2 > parity/v2-atoms.jsonl &
node scripts/parity/extract.mjs . v4 > parity/v4-atoms.jsonl &
wait

# Join + emit checklists — ⚠ DESTRUCTIVE: regenerates per-module .md files
# from the JSONL snapshots and overwrites any manual edits (Classification:
# lines, ADJUDICATED flips, Verified-by: signatures). Only run when you
# want to reset the audit trail.
node scripts/parity/match.mjs
```

## Current status (after Pass F full-sweep + ShipStation Passes 1-3)

| Metric | Count | Notes |
|---|---|---|
| Total v2 atoms | 487 | unchanged |
| MATCH | 478 | +154 since initial auto-match (324 → 478) |
| MISSING (with classification) | 9 | all INTENTIONALLY_CHANGED or UNCERTAIN |
| Real missing | **0** | every gap is classified |
| v4-only atoms | 556 | was 542 — +14 for ShipStation pass helpers |
| v4-only NEEDS_HUMAN | 0 | all 5 adjudicated (520352b) |

### Commit history

| Commit | Phase | Summary |
|---|---|---|
| `8617048` | A-C | Pipeline tooling (extract/match/rules) + auto-match (324/487) |
| `3d7a926` | D | 5-agent verification promoted 139 atoms to MATCH |
| `82d862f` | F-B1 | Fix: BLOCKED_SERVICE_CODES + EXPEDITED_SERVICES |
| `bd749da` | E | Classified 24 MISSING + 542 V4_ONLY atoms |
| `b9cf1fd` | F | Full sweep: 13 remaining atoms ported (3 parallel batches) |
| `520352b` | E-adj | 5 NEEDS_HUMAN_SECOND_LOOK adjudicated |
| `9c33020` | SS-1 | ShipStation P0: timeout + 5xx retry + rate_source_client_id fallback |
| `3d1e951` | SS-2 | ShipStation P1: return-label path + V2 enrichment + residential helper + pageSize 500 |
| `8d670ce` | SS-3 | ShipStation P1: /v2/rates/estimate swap + 3-pass order sync |

## ShipStation parity — what landed

All v2original ShipStation integration logic now ported with exact wire-
protocol parity. See individual commit messages for per-fix detail.

| Gap | Resolution |
|---|---|
| No 5xx retry | ssRequest + ssV1Request retry 5xx with `min(4000, 2^n * 1000)` backoff up to maxRetries |
| No request timeout | 90s `AbortSignal.timeout` on every call, composable with caller's signal |
| Missing `rate_source_client_id` fallback | New `src/lib/shipstation/credentials.ts` cascades to source client's apiKeyV2 |
| Return-label wrong endpoint | `/v2/shipments/{se-id}/return-labels` → `/v2/shipments/{id}/returnlabel` |
| No residential gateway | New `src/lib/shipstation/residential.ts` (exposed, not auto-wired) |
| V2 shipment enrichment missing | `shipment-sync.ts` runs a V2 `/v2/shipments` pass after each V1 sync to populate `providerAccountId` |
| pageSize=250 (vs v2's 500) | Default pageSize=500 + 500ms inter-page delay in both syncs |
| `/v2/rates` batch endpoint | Swapped to `/v2/rates/estimate` per-carrier with v2's flat body (stamps_com city/state special case included) |
| Single-pass order sync | Split into 3 status-scoped passes: shipped (2hr), cancelled (2hr), awaiting_shipment (4hr) |

## Per-module files

- [`orders.md`](./orders.md)
- [`billing.md`](./billing.md)
- [`inventory.md`](./inventory.md)
- [`packages.md`](./packages.md)
- [`rates.md`](./rates.md)
- [`analysis.md`](./analysis.md)
- [`manifests.md`](./manifests.md)
- [`locations.md`](./locations.md)
- [`settings.md`](./settings.md)
- [`_config.md`](./_config.md)
- [`_shipstation.md`](./_shipstation.md)
- [`_worker-contracts.md`](./_worker-contracts.md)
- [`_v4-only.md`](./_v4-only.md)

## Success criterion

Audit trail is complete when:

- Every `[MISSING]` / `[PARTIAL]` line has a `Classification:` entry (achieved — Phases D+E).
- Every atom is either `[MATCH]`, `[INTENTIONALLY_CHANGED]`, or `[UNCERTAIN]` with a concrete reason.
- Every `_v4-only.md` atom has a classification (achieved — 520352b).

## Re-running extract only (safe)

If you want to refresh the JSONL snapshots without wiping the manual
checklists (e.g. after new code lands and you want to verify no drift):

```bash
# Safe — only touches atoms.jsonl files
node scripts/parity/extract.mjs ../v2orginal v2 > parity/v2-atoms.jsonl
node scripts/parity/extract.mjs . v4 > parity/v4-atoms.jsonl

# Then inspect the diff manually:
diff <(grep -oE '"id":"[^"]+"' parity/v4-atoms.jsonl | sort -u) \
     <(grep -oE '"id":"[^"]+"' parity/v4-atoms.jsonl.prev | sort -u)
```

## What triggers a full regeneration

Run the full `match.mjs` only when one of these is true:
- The atom extractor logic changed (new category, new rules) and you need to rebaseline.
- A large batch of atoms was added/removed and tracking the delta manually isn't practical.
- You're willing to re-do Phase D (subagent verification) and Phase E (classification) afterward.

Otherwise: edit the per-module .md files directly when promoting MISSING → MATCH.
