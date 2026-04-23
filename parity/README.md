# Parity pipeline

Line-by-line v2original → v4-stable parity verification.

## Run the pipeline

```bash
# Extract atoms from both repos (parallel)
node scripts/parity/extract.mjs ../v2orginal v2 > parity/v2-atoms.jsonl &
node scripts/parity/extract.mjs . v4 > parity/v4-atoms.jsonl &
wait

# Join + emit checklists
node scripts/parity/match.mjs
```

## Current status

| Metric | Count |
|---|---|
| Total v2 atoms | 487 |
| Matched in v4 | 324 |
| Missing in v4 | 163 |
| Needs behavior review | 0 |
| v4-only atoms | 542 |

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

Pipeline is complete when:

```bash
grep -R '\[MISSING\]\|\[PARTIAL\]' parity/*.md
```

returns zero matches, and every per-module file has a filled `Verified-by:` line.
