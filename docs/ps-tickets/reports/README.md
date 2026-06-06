# PS Ticket — Truth Reports

Individual, evidence-grounded completion reports. "Truth" = each claim is backed
by an actual guard run (with check counts), a commit SHA, and deploy state — and
each report states explicitly **what it proves** and **what it does NOT prove**.

Generated 2026-06-06. All guards run offline (no live labels/postage/marketplace).

| Ticket | Report | Completion | Deployed SHA |
|---|---|---|---|
| PS-100 Architecture audit | [PS-100](./PS-100-truth-report.md) | 100% | `8cbd8d83` |
| PS-102 Best-Rate Workflow DTO | [PS-102](./PS-102-truth-report.md) | 100% | `4015b3a7` |
| PS-103 Remove frontend fingerprint authority | [PS-103](./PS-103-truth-report.md) | 100% | `cc5dd73b` |
| PS-104 Preserve proof through batch-send | [PS-104](./PS-104-truth-report.md) | 100% | `18415e32` |
| PS-105 Backend rate quote snapshot ID | [PS-105](./PS-105-truth-report.md) | 100% | `6f76c214` |
| PS-106 Configurable carrier eligibility | [PS-106](./PS-106-truth-report.md) | 100% | `1e4f6887` |
| PS-107 Master regression runner | [PS-107](./PS-107-truth-report.md) | 100% | `18415e32` |

## Cross-cutting truth statement
- Guards are **static/structural + pure-unit** checks. They prove code is **wired
  correctly** and **pure logic is right**; they do NOT exercise live
  ShipStation/marketplace I/O.
- **No real labels, postage, voids, marketplace notifications, or production
  shipped/cancelled mutations** occurred during verification.
- Shipped-data lockdown protections remain intact:
  `test:selected-rate-proof-boundary` (6/6),
  `test:ps-098-shipping-purchase-boundary` (10/10).
