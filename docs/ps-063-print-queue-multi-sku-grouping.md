# PS-063 - Fix Print Queue Multi-SKU Grouping, SKU Qty Lines, and Batch Header Borders

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: `prepshipv4-stable`
Status: Replacement v2. Supersedes the earlier PS-063 draft. This full description is the source of truth.

## Copy/Paste Codex Prompt

You are working in `drprepperusa-org/prepship-v4` on branch `prepshipv4-stable`.

Implement PS-063: fix Print Queue multi-SKU grouping/display so each SKU and its quantity is shown clearly, multi-SKU queue groups are keyed by the full normalized SKU+qty combination instead of only the first SKU, and the Batch Header visually distinguishes multi-SKU orders with separate bordered SKU+qty chips/blocks.

## Context

A real Print Queue UI issue was observed on order `#1149`.

Actual order contents:

```text
Booster-gel-001 x1
HU-10 x1
```

Bad/unsafe display pattern:

```text
Booster-gel-001 - Booster Gel
1 ORDER · QTY 2 EA
```

This reads like 2 units of Booster Gel, when it is actually 1 Booster Gel plus 1 HU-10. This can cause warehouse pick/pack mistakes.

DJ also clarified the Batch Header requirement:

- If the batch/header is single-SKU, no special per-SKU border is necessary.
- If it is multi-SKU, every SKU+qty pair must be visually separated in its own bordered chip/block.
- A `MULTI-SKU` title alone is not enough. Operators need to see the multi-SKU nature visually.
- If there are 2 SKUs, there should be 2 bordered SKU+qty blocks.
- If there are 3 SKUs, there should be 3 bordered SKU+qty blocks.

Example multi-SKU Batch Header display:

```text
MULTI-SKU
[ Booster-gel-001 x1 ]
[ HU-10 x1 ]
QTY: 2 per order
```

Single-SKU header can remain visually simpler:

```text
Booster-gel-001 x2
QTY: 2 per order
```

No extra border is required for single-SKU because there is no ambiguity.

## Code Path Observed During Review

Inspect first:

- `web/src/components/Views/orders-parity.ts`
- `web/src/components/Views/OrdersView.tsx`
- `web/src/lib/v2-apiClient.ts`
- Print Queue route/service DTOs that return queue entries
- Existing print queue tests/guards

Search terms:

- `groupPrintQueueEntries`
- `PrintQueueEntryDto`
- `sku_group_id`
- `multi_sku_data`
- `primary_sku`
- `Print Group`
- `SKU Groups`
- `BATCH HEADER`
- `MULTI-SKU`

Previously observed risky pattern:

```ts
const primarySku = activeItems.length === 1
  ? toStringValue(activeItems[0]?.sku)
  : toStringValue(activeItems[0]?.sku)
sku_group_id: primarySku ? `SKU:${primarySku}` : `ORDER:${order.orderId}`
```

Then grouping uses first SKU plus total quantity, allowing this collision risk:

```text
Booster-gel-001 x2
```

incorrectly appearing/grouping like:

```text
Booster-gel-001 x1 + HU-10 x1
```

## Implementation Requirements

1. Fix group identity for multi-SKU orders.

Single-SKU entries may continue to group by SKU plus per-order qty.

Multi-SKU entries must group by normalized full SKU+qty combo.

Example stable normalized key:

```text
COMBO:booster-gel-001:1|hu-10:1
```

Do not allow `Booster-gel-001 x2` to group with `Booster-gel-001 x1 + HU-10 x1`.

2. Render each SKU and qty on its own visible line.

For order `#1149`, Print Queue must visibly show:

```text
Booster-gel-001 x1
HU-10 x1
```

It must not only show:

```text
Booster-gel-001
Qty 2 ea
```

If item names are available, show them in secondary text without hiding SKU or qty:

```text
Booster-gel-001 x1 - Booster Gel
HU-10 x1 - Leeds Line V2
```

or:

```text
Booster-gel-001 x1
  Booster Gel
HU-10 x1
  Leeds Line V2
```

3. Add multi-SKU Batch Header border/chip styling.

Batch Header visual rule:

- Single-SKU: no special border required.
- Multi-SKU: each SKU+qty pair must be inside its own clearly visible border/chip/block.
- Number of visible borders must equal number of unique displayed SKU lines after duplicate SKU collapse.

Examples:

```text
Single-SKU order:
Booster-gel-001 x2
No extra per-SKU border required.

Two-SKU order:
[ Booster-gel-001 x1 ]
[ HU-10 x1 ]
Two visible bordered SKU+qty blocks required.

Three-SKU order:
[ SKU-A x1 ]
[ SKU-B x2 ]
[ SKU-C x1 ]
Three visible bordered SKU+qty blocks required.
```

Do not rely only on `MULTI-SKU` title text. The SKU+qty blocks themselves must make multi-SKU obvious at a glance.

4. Collapse duplicate SKU lines before key/display/header.

Example input:

```text
Booster-gel-001 x2
Booster-gel-001 x1
HU-10 x1
```

Expected key/display/header:

```text
Booster-gel-001 x3
HU-10 x1
```

For Batch Header, this should render as 2 bordered blocks, not 3, because there are 2 unique SKU lines after collapse.

5. Existing queued entries must render correctly.

Existing queue rows may have stale `sku_group_id` values that only include the first SKU. If `multi_sku_data` is present, prefer it to reconstruct the combo display/key client-side. If backend changes are needed for durable correctness, add them safely without breaking existing entries.

6. Search must include all SKUs.

Print Queue search must match every SKU in the combo, not just `primary_sku`. Searching `HU-10` should find an order/group containing `HU-10` even if Booster is the first/primary SKU.

7. Print behavior must remain unchanged except corrected grouping.

- Print Group still prints labels in that group.
- Print All still prints all queued labels in active scope.
- Confirm Printed behavior remains unchanged.
- Do not mark orders printed/shipped merely because display grouping changed.

8. Queue scope behavior must remain intact.

Do not regress All Clients vs Current Client queue scope. Badge counts, drawer contents, Clear, Print All, Print Group, and Confirm Printed must match the visible scope.

## Guardrails / Forbidden Changes

- Do not buy postage, create real labels, send marketplace confirmations, or mutate live orders in tests.
- Do not weaken Print Queue persistence, queue ownership/client scope, RBAC, auth, or shipped/cancelled protections.
- Do not expose raw label URLs, full customer PII, raw provider payloads, tokens, secrets, carrier credentials, or internal costs.
- Do not hide SKU or qty behind hover-only text; operators must see it directly.
- Do not group by item name alone; SKU plus qty combo is the source of truth.
- Do not rely on first SKU for multi-SKU identity.
- Do not add borders to single-SKU headers just for visual consistency; DJ specifically wants borders to signal multi-SKU only.

## Testing Applicability

This affects a real warehouse packing workflow, so it needs focused logic tests plus UI/render verification. No live provider/postage tests are needed.

Required layers:

- Unit/guard tests for `groupPrintQueueEntries` or equivalent grouping helper
- Component/browser/render verification for Print Queue header and Batch Header
- Existing print queue safety/scope tests
- Typecheck/build

## Required Test Cases

Add/verify focused tests for at least:

- Single-SKU order: `Booster-gel-001 x2`
  - Expected: one SKU line, groups with identical single-SKU orders, Batch Header has no required per-SKU border/chip treatment.
- Multi-SKU order: `Booster-gel-001 x1`, `HU-10 x1`
  - Expected: two visible SKU+qty lines, two separate bordered SKU+qty blocks in the Batch Header, does not collapse into only Booster.
- Three-SKU order: `SKU-A x1`, `SKU-B x2`, `SKU-C x1`
  - Expected: three visible SKU+qty lines and three separate bordered SKU+qty blocks in the Batch Header.
- Distinct combos do not merge:
  - `Booster-gel-001 x2` must not group with `Booster-gel-001 x1 + HU-10 x1`.
- Identical combos do merge:
  - Two orders with `Booster-gel-001 x1 + HU-10 x1` group together.
- Duplicate SKU lines collapse:
  - `Booster-gel-001 x2 + Booster-gel-001 x1 + HU-10 x1` becomes `Booster-gel-001 x3 + HU-10 x1`, and Batch Header shows 2 bordered blocks.
- Search matches all SKUs:
  - Searching `HU-10` finds the group/order even when `primary_sku` is Booster.
- Existing stale queue entry recovery:
  - Given stale `sku_group_id: SKU:Booster-gel-001` but valid `multi_sku_data`, display/key/header use `multi_sku_data` and show all SKU lines/borders.

## Verification Commands

Run the new focused test first, then surrounding suites. At minimum run and report:

```bash
npm run typecheck
npm run test:print-queue-durable
npm run test:print-queue-persistence
npm run test:print-queue-ownership
npm run test:print-queue-client-scope
npm run test:print-queue-invalid-label
npm run test:queue-label-diagnostics
```

Also add/run a PS-063-specific test, for example:

```bash
npm run test:print-queue-sku-grouping
```

If browser/component coverage exists or is added, run the relevant UI command and report it. If browser coverage is not added, explicitly explain why and provide lower-level render/test evidence.

## Definition Of Done

- Print Queue no longer identifies multi-SKU groups by first SKU only.
- Each SKU and qty appears on its own visible line for multi-SKU queued labels.
- Multi-SKU Batch Header renders each SKU+qty pair in its own bordered chip/block.
- Single-SKU Batch Header does not require special per-SKU borders.
- Number of multi-SKU Batch Header borders equals number of unique SKU lines after duplicate collapse.
- `Booster-gel-001 x2` is not grouped/displayed as equivalent to `Booster-gel-001 x1 + HU-10 x1`.
- Existing queued rows with `multi_sku_data` render correctly even if stored `sku_group_id` is stale.
- Print Queue search finds all SKUs in a combo.
- Print Group, Print All, Confirm Printed, queue scope, and queue persistence remain intact.
- Required tests pass.
- No live labels/postage/provider mutations were performed.

## Return Format

Reply with:

- Summary of the grouping/display/header fix.
- Before/after example for order `#1149`.
- Screenshot or clear textual evidence that multi-SKU Batch Header uses one bordered block per SKU+qty.
- Evidence that single-SKU Batch Header does not get unnecessary per-SKU borders.
- Files changed.
- Exact tests/commands run with pass/fail results.
- Evidence that single-SKU and multi-SKU groups no longer collide.
- Any remaining risk or follow-up needed.
