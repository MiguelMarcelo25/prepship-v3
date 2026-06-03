# PS-073 — Customer-name reference + Batch Manifest (incl. test orders)

**Status:** The PS-073 feature (recipient-name reference area on Print Queue
batch headers + a Batch Manifest page for large batches) was already shipped in
commits `728fb748` and `497c04ea`. This packet covers the follow-up ask —
**"see this in the test order too"** — which is now **certified working** with a
locked guard. No production code change was required.

---

## Finding — test orders already get the names/manifest

The recipient-name path is test-order-agnostic by construction:

- `loadBatchRecipientsByGroup` (in `src/services/print-queue.ts`) builds a
  `BatchRecipient` for **every** queued entry via a render-time, client-scoped
  join to `orders.shipToName` — there is no test/mock exclusion.
- `resolveRecipientDisplayName` falls back to `Order <orderNumber>` (or
  `Unnamed recipient`) when `shipToName` is blank, so a test order with no
  recipient name still contributes a line.
- `drawHeader` uses the mock/test flag **only** to stamp `TEST` on the header;
  the "Names in this batch (N)" section and the Batch Manifest render from
  `recipients` regardless of test status.
- The batch-merge loop (`runMergeJob` → `addGroupHeaderIfNeeded`) draws the
  header for mock/test labels the same as real ones (`isMockLabel` is passed
  through for the TEST stamp).

So a **test-order batch** shows the same header — item pick cards, `QTY:` line,
big `N ORDERS`, and the names reference — with a `TEST` stamp, using the real
recipient name when present or the `Order <num>` fallback otherwise.

---

## Certification (fake fixture names only)

`scripts/ps-073-test-order-names-cert.ts` renders the real batch-header renderer
in **test mode** (`isTest: true`) and decodes the emitted PDF:

| Case | Asserted | Result |
|---|---|---|
| Small TEST batch (3 orders) | header stamped `TEST`; `Names in this batch (3)`; recipient names listed (upper-cased); missing-name → `ORDER TEST-9003` fallback; item pick card (`Booster Gel` / `Booster-gel-001`) still present | ✅ |
| Large TEST batch (40 orders) | header does **not** cram 40 names; points to a Batch Manifest; manifest lists all 40 fake names; manifest stamped `TEST` | ✅ |

Threshold behaviour is unchanged from PS-073 (~30-order header limit, with a
fit-check that spills to the manifest if names would crush the `ORDERS` count).

---

## Files changed

- `scripts/ps-073-test-order-names-cert.ts` — **new** read-only, in-memory PDF
  certification proving test-order batches render names + manifest (fake names).
- `package.json` — `test:ps-073-test-order-names` script wired in.

(No `src/` changes — the feature already supported test orders.)

## Commands run — pass/fail

| Command | Result |
|---|---|
| `npm run test:ps-073-test-order-names` | ✅ PASS |
| `npm run typecheck` (backend + web) | ✅ PASS |
| `node scripts/print-queue-persistence-guard.mjs` | ✅ PASS |
| `node scripts/print-queue-durable-guard.mjs` | ✅ PASS |
| `node scripts/print-queue-invalid-label-guard.mjs` | ✅ PASS |
| `node scripts/print-queue-ownership-guard.mjs` | ✅ PASS |
| `node scripts/print-queue-client-store-scope-guard.mjs` | ✅ PASS |

## How to see it (operator)

Put one or more **test orders** in the Print Queue and run the batch print /
"send to printer" (the header is a *batch* feature — it appears on the merged
batch PDF, not on a single standalone label preview). The first page of each
group is the batch header with the `TEST` stamp and the "Names in this batch"
list; batches over ~30 orders get a separate Batch Manifest page.

## Safety confirmation

- **No real labels, postage, or marketplace notifications**; certification is
  in-memory PDF rendering only.
- **No shipped/cancelled mutation**, no schema change, no auth/scope/ownership
  change. The names path is a client-scoped read of `orders.shipToName` (the
  existing PS-073 override) — names can't cross client/store scope.
- **No PII** — fixtures use fake names; no addresses, emails, phones, tracking,
  label URLs, payloads, or secrets in the header/manifest/tests/logs.
