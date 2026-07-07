# Batch Print Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create + Print chains the two existing backend print-queue jobs (buy → merge → one PDF) behind a default-OFF flag, and the merge job's label fetch gains a bounded prefetch pool behind a default-1 knob.

**Architecture:** Track 1 recomposes existing frontend functions — a pure chain module orchestrates proof pre-pass → `POST /print-queue/batch-send` → fade → `POST /print-queue/print` — with zero new backend job surface; every purchase stays inside `createLabelV2`. Track 2 adds a pure prefetch-pool module consumed by `runMergeJob` with all error branches preserved byte-for-byte.

**Tech Stack:** TypeScript strict (two tsconfig projects), Hono backend, React FE, tsx guard scripts as tests, Playwright e2e, pdf-lib.

**Spec:** `docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md`

## Global Constraints

- **Lockdown:** only Task 10 touches `src/services/print-queue.ts`. DJ typed `unlock shipped data` on 2026-07-07 for this design. Every edit in that file carries a comment starting `Per user override unlock shipped data on 2026-07-07:` and Task 10's commit message contains that phrase verbatim.
- **Money path:** the flag-ON Create+Print path must contain NO `apiClient.createLabel(` call. Never auto-repurchase (PS-191): failures surface reasons; the operator re-clicks.
- **Legacy loop byte-identical:** the existing `mode === 'print'` sequential loop in `OrdersView.tsx` is not modified this ship (deleted in a later, DJ-confirmed follow-up).
- **Flags:** `BATCH_PRINT_VIA_QUEUE: booleanFlag(false)`; `PRINT_QUEUE_MERGE_FETCH_CONCURRENCY` int default `1` (clamped 1–8). OFF/1 = byte-identical behavior.
- **Verification bar:** `npm run typecheck` (no NEW errors vs Task 0 baseline), `npm run test:rate-source-of-truth` passes, `npm run test:master:all-safe` shows zero NEW reds vs Task 0 baseline (mine ⊆ base).
- **Git:** commit locally after each task. Do NOT push — DJ confirms the ship separately (lockdown rule).
- **Style:** new functions in new small files; match surrounding comment density; TS strict on both projects.

---

### Task 0: Capture baselines

**Files:** none modified.

- [ ] **Step 0.1: Capture the all-safe baseline** (audit script — exits 0, lists failures)

Run:
```bash
cd "X:/Private/prepship-final/prepship-v4-stable"
npm run test:master:all-safe > "$SCRATCHPAD/all-safe-baseline.txt" 2>&1 || true
grep -c "FAIL\|✗\|✖" "$SCRATCHPAD/all-safe-baseline.txt" || true
```
Expected: file written; note the failure count (pre-existing reds are allowed to persist, not grow).

- [ ] **Step 0.2: Capture the typecheck baseline**

Run: `npm run typecheck > "$SCRATCHPAD/typecheck-baseline.txt" 2>&1 || true`
Expected: file written. If it currently fails from unrelated in-flight work, later tasks require "no NEW errors", not "zero errors".

---

### Task 1: Backend flag plumbing

**Files:**
- Modify: `src/lib/env.ts` (after `PRINT_QUEUE_DIRECT_VIA_BACKEND: booleanFlag(false),` ~line 173)
- Modify: `src/routes/users.ts` (inside the `/me` JSON, after `printQueueFeDelegation` ~line 92)

**Interfaces:**
- Produces: `env.BATCH_PRINT_VIA_QUEUE: boolean`; `/users/me` response field `batchPrintViaQueue: boolean`.

- [ ] **Step 1.1: Add the env flag**

In `src/lib/env.ts`, insert immediately after the `PRINT_QUEUE_DIRECT_VIA_BACKEND: booleanFlag(false),` line:

```ts
  // Batch-print pipeline (docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md):
  // default-OFF. When ON, the FE "Create + Print Label" batch action chains the two existing
  // backend queue jobs (POST /print-queue/batch-send buys/recovers, then POST /print-queue/print
  // merges one PDF) instead of the legacy sequential per-order FE loop. Purchase authority is
  // unchanged — createLabelV2 owns every buy on both paths; this flag only moves FE
  // orchestration. OFF is byte-identical. DJ flips on Render after a test-client canary.
  BATCH_PRINT_VIA_QUEUE: booleanFlag(false),
```

- [ ] **Step 1.2: Expose it on /users/me**

In `src/routes/users.ts`, insert after the `printQueueFeDelegation: env.PRINT_QUEUE_FE_DELEGATION === true,` line:

```ts
    // Batch-print pipeline: FE gate for chaining "Create + Print Label" through the backend
    // queue jobs (BATCH_PRINT_VIA_QUEUE in src/lib/env.ts). Default OFF; DJ flips on Render.
    batchPrintViaQueue: env.BATCH_PRINT_VIA_QUEUE === true,
```

- [ ] **Step 1.3: Typecheck backend project**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors vs baseline.

- [ ] **Step 1.4: Commit**

```bash
git add src/lib/env.ts src/routes/users.ts
git commit -m "Add BATCH_PRINT_VIA_QUEUE flag plumbing (default OFF)"
```

---

### Task 2: FE flag state + persistent-job kind

**Files:**
- Modify: `web/src/components/Views/orders-persistent-queue-job.ts:12`
- Modify: `web/src/components/Views/OrdersView.tsx:593-604`

**Interfaces:**
- Produces: `PersistentQueueJobKind` includes `'create-print'`; OrdersView state `batchPrintViaQueue: boolean`.

- [ ] **Step 2.1: Widen the job kind union**

In `orders-persistent-queue-job.ts` replace:
```ts
export type PersistentQueueJobKind = 'existing-labels' | 'batch-queue'
```
with:
```ts
export type PersistentQueueJobKind = 'existing-labels' | 'batch-queue' | 'create-print'
```

- [ ] **Step 2.2: Read the flag from /users/me**

In `OrdersView.tsx`, replace the identity effect block:
```ts
  const [printQueueFeDelegation, setPrintQueueFeDelegation] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api.get<{ id: string | null; email: string | null; isAdmin: boolean; printQueueFeDelegation?: boolean }>('/users/me')
      .then((res) => {
        if (cancelled) return
        setCallerIsAdmin(res.isAdmin === true)
        setPrintQueueFeDelegation(res.printQueueFeDelegation === true)
      })
      .catch((err) => console.warn('[orders] failed to load caller identity:', err))
    return () => { cancelled = true }
  }, [])
```
with:
```ts
  const [printQueueFeDelegation, setPrintQueueFeDelegation] = useState(false)
  // Batch-print pipeline: backend-owned gate (BATCH_PRINT_VIA_QUEUE) for chaining
  // "Create + Print Label" through the backend queue jobs. Default OFF.
  const [batchPrintViaQueue, setBatchPrintViaQueue] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api.get<{ id: string | null; email: string | null; isAdmin: boolean; printQueueFeDelegation?: boolean; batchPrintViaQueue?: boolean }>('/users/me')
      .then((res) => {
        if (cancelled) return
        setCallerIsAdmin(res.isAdmin === true)
        setPrintQueueFeDelegation(res.printQueueFeDelegation === true)
        setBatchPrintViaQueue(res.batchPrintViaQueue === true)
      })
      .catch((err) => console.warn('[orders] failed to load caller identity:', err))
    return () => { cancelled = true }
  }, [])
```

- [ ] **Step 2.3: Typecheck web project**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: the only acceptable NEW diagnostic is an unused `batchPrintViaQueue` local (Task 6 consumes it — do not silence it with a `void` hack); anything else must be fixed before committing.

- [ ] **Step 2.4: Commit**

```bash
git add web/src/components/Views/orders-persistent-queue-job.ts web/src/components/Views/OrdersView.tsx
git commit -m "Add create-print job kind and batchPrintViaQueue FE flag state"
```

---

### Task 3: Chain module (TDD — guard first)

**Files:**
- Create: `web/src/components/Views/batch-create-print-chain.ts`
- Create: `scripts/batch-print-via-queue-guard.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces:
  - `collectBatchPrintProofOverrides<TOrder extends { orderId: number }>(orders, deps: ProofPassDeps<TOrder>): Promise<ProofPassResult>`
  - `runCreatePrintChain<TOrder extends ChainOrder>(orders, deps: CreatePrintChainDeps<TOrder>): Promise<CreatePrintChainOutcome>`
  - Types: `ProofPassDeps`, `ProofPassResult`, `QueueSendOutcome`, `CreatePrintChainDeps`, `CreatePrintChainOutcome`, `ChainOrder`
- Consumes: nothing from OrdersView (pure; all effects injected).

- [ ] **Step 3.1: Write the failing guard (behavioral half)**

Create `scripts/batch-print-via-queue-guard.ts`:

```ts
/**
 * Guard: batch-print pipeline (Create + Print via chained backend queue jobs).
 *
 * Behavioral half — exercises the pure chain module with injected fakes:
 *   - proof pre-pass only re-rates orders that need an override
 *   - recalc/override failures are collected, and those orders are EXCLUDED
 *     from the queue-send call (never sent to the purchase boundary broken)
 *   - fade callback fires per successfully bought order
 *   - the print tail runs only when the send job queued entries
 *
 * Wiring half (appended by a later task) — source-asserts the OrdersView
 * flag-ON branch chains the two backend jobs and never buys from the FE.
 */
import assert from 'node:assert/strict';
import {
  collectBatchPrintProofOverrides,
  runCreatePrintChain,
} from '../web/src/components/Views/batch-create-print-chain';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((err) => {
      failures += 1;
      console.error(`FAIL ${name}:`, err instanceof Error ? err.message : err);
    });
}

const sequentialPool = async <T>(items: T[], worker: (item: T) => Promise<void>) => {
  for (const item of items) await worker(item);
};

async function main() {
  await check('proof pass re-rates only orders needing an override', async () => {
    const recalculated: number[] = [];
    const result = await collectBatchPrintProofOverrides(
      [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }],
      {
        needsOverride: (order) => order.orderId === 2,
        recalculate: async (order) => {
          recalculated.push(order.orderId);
          return { ok: true as const, rate: { amount: 9.86 } };
        },
        buildOverride: () => ({ serviceCode: 'ups_ground' }),
        runPool: sequentialPool,
      },
    );
    assert.deepEqual(recalculated, [2]);
    assert.deepEqual([...result.overrides.keys()], [2]);
    assert.equal(result.failures.length, 0);
  });

  await check('recalc failure and null override become failures, not overrides', async () => {
    const result = await collectBatchPrintProofOverrides(
      [{ orderId: 1 }, { orderId: 2 }],
      {
        needsOverride: () => true,
        recalculate: async (order) =>
          order.orderId === 1
            ? { ok: false as const, message: 'rate expired' }
            : { ok: true as const, rate: {} },
        buildOverride: () => null,
        runPool: sequentialPool,
      },
    );
    assert.equal(result.overrides.size, 0);
    assert.equal(result.failures.length, 2);
    assert.equal(result.failures[0]!.message, 'rate expired');
    assert.match(result.failures[1]!.message, /could not be proven/);
  });

  await check('chain excludes proof-failed orders from the send and sequences fade + print', async () => {
    const sentOrderIds: number[] = [];
    const faded: number[] = [];
    let printedWith: string[] | null = null;
    const outcome = await runCreatePrintChain(
      [
        { orderId: 1, orderNumber: 'A-1' },
        { orderId: 2, orderNumber: 'A-2' },
      ],
      {
        needsOverride: (order) => order.orderId === 2,
        recalculate: async () => ({ ok: false as const, message: 'rate expired' }),
        buildOverride: () => null,
        runPool: sequentialPool,
        sendToQueue: async (orders) => {
          sentOrderIds.push(...orders.map((order) => order.orderId));
          return {
            queued: 1,
            failed: 0,
            queuedEntryIds: ['entry-1'],
            successOrderIds: new Set([1]),
            skippedErrors: [],
          };
        },
        printEntries: async (entryIds) => {
          printedWith = entryIds;
          return true;
        },
        markShipped: (orderId) => faded.push(orderId),
      },
    );
    assert.deepEqual(sentOrderIds, [1]);
    assert.deepEqual(faded, [1]);
    assert.deepEqual(printedWith, ['entry-1']);
    assert.equal(outcome.queued, 1);
    assert.equal(outcome.failed, 1); // the proof-failed order counts as failed
    assert.equal(outcome.printed, true);
    assert.equal(outcome.printAttempted, true);
    assert.match(outcome.errors[0]!, /^A-2: rate expired$/);
  });

  await check('chain skips the print tail when nothing queued', async () => {
    let printCalled = false;
    const outcome = await runCreatePrintChain(
      [{ orderId: 5, orderNumber: 'B-5' }],
      {
        needsOverride: () => false,
        recalculate: async () => ({ ok: true as const, rate: {} }),
        buildOverride: () => ({}),
        runPool: sequentialPool,
        sendToQueue: async () => ({
          queued: 0,
          failed: 1,
          queuedEntryIds: [],
          successOrderIds: new Set<number>(),
          skippedErrors: ['Order B-5: Missing label payload'],
        }),
        printEntries: async () => {
          printCalled = true;
          return true;
        },
        markShipped: () => {},
      },
    );
    assert.equal(printCalled, false);
    assert.equal(outcome.printed, false);
    assert.equal(outcome.printAttempted, false);
    assert.deepEqual(outcome.errors, ['Order B-5: Missing label payload']);
  });

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll batch-print-via-queue behavioral checks passed.');
}

void main();
```

Register in `package.json` scripts (alongside the other `test:*` entries):
```json
"test:batch-print-via-queue": "tsx scripts/batch-print-via-queue-guard.ts",
```

- [ ] **Step 3.2: Run guard — verify it fails**

Run: `npm run test:batch-print-via-queue`
Expected: FAIL (cannot resolve `batch-create-print-chain` module).

- [ ] **Step 3.3: Implement the chain module**

Create `web/src/components/Views/batch-create-print-chain.ts`:

```ts
// Batch-print pipeline (docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md):
// pure orchestration for the flag-ON "Create + Print Label" chain. No React, no api client,
// no window — every effect is injected, so scripts/batch-print-via-queue-guard.ts can
// exercise the sequencing with fakes.
//
// Chain: proof pre-pass (strict re-rate the orders whose saved rate cannot serve as current
// proof) → backend queue-send job (buys under createLabelV2's full gate ladder) → fade the
// bought rows → print the job's queued entries as ONE merged PDF. The FE buys nothing here;
// it sequences the two existing backend jobs.

export type ChainOrder = { orderId: number; orderNumber?: string | null }

export type ProofPassDeps<TOrder> = {
  needsOverride: (order: TOrder) => boolean
  recalculate: (order: TOrder) => Promise<{ ok: true; rate: unknown } | { ok: false; message: string }>
  buildOverride: (order: TOrder, freshRate: unknown) => Record<string, unknown> | null
  runPool: (orders: TOrder[], worker: (order: TOrder) => Promise<void>) => Promise<void>
}

export type ProofPassResult = {
  overrides: Map<number, Record<string, unknown>>
  failures: Array<{ orderId: number; message: string }>
}

export async function collectBatchPrintProofOverrides<TOrder extends { orderId: number }>(
  orders: TOrder[],
  deps: ProofPassDeps<TOrder>,
): Promise<ProofPassResult> {
  const overrides = new Map<number, Record<string, unknown>>()
  const failures: Array<{ orderId: number; message: string }> = []
  const pending = orders.filter((order) => deps.needsOverride(order))
  await deps.runPool(pending, async (order) => {
    try {
      const result = await deps.recalculate(order)
      if (!result.ok) {
        failures.push({ orderId: order.orderId, message: result.message })
        return
      }
      const payload = deps.buildOverride(order, result.rate)
      if (!payload) {
        failures.push({
          orderId: order.orderId,
          message: 'Current best rate could not be proven before label purchase',
        })
        return
      }
      overrides.set(order.orderId, payload)
    } catch (err) {
      failures.push({
        orderId: order.orderId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return { overrides, failures }
}

export type QueueSendOutcome = {
  queued: number
  failed: number
  queuedEntryIds: string[]
  successOrderIds: Set<number>
  skippedErrors: string[]
}

export type CreatePrintChainDeps<TOrder extends ChainOrder> = ProofPassDeps<TOrder> & {
  sendToQueue: (orders: TOrder[], overrides: Map<number, Record<string, unknown>>) => Promise<QueueSendOutcome>
  printEntries: (entryIds: string[]) => Promise<boolean>
  markShipped: (orderId: number) => void
}

export type CreatePrintChainOutcome = {
  queued: number
  failed: number
  printed: boolean
  printAttempted: boolean
  errors: string[]
}

export async function runCreatePrintChain<TOrder extends ChainOrder>(
  orders: TOrder[],
  deps: CreatePrintChainDeps<TOrder>,
): Promise<CreatePrintChainOutcome> {
  const proofPass = await collectBatchPrintProofOverrides(orders, deps)
  const proofFailedIds = new Set(proofPass.failures.map((failure) => failure.orderId))
  const sendable = orders.filter((order) => !proofFailedIds.has(order.orderId))
  const outcome: QueueSendOutcome = sendable.length > 0
    ? await deps.sendToQueue(sendable, proofPass.overrides)
    : { queued: 0, failed: 0, queuedEntryIds: [], successOrderIds: new Set<number>(), skippedErrors: [] }
  for (const orderId of outcome.successOrderIds) deps.markShipped(orderId)
  let printed = false
  const printAttempted = outcome.queuedEntryIds.length > 0
  if (printAttempted) printed = await deps.printEntries(outcome.queuedEntryIds)
  const byId = new Map(orders.map((order) => [order.orderId, order]))
  const errors = [
    ...proofPass.failures.map((failure) => {
      const order = byId.get(failure.orderId)
      return `${order?.orderNumber ?? failure.orderId}: ${failure.message}`
    }),
    ...outcome.skippedErrors,
  ]
  return {
    queued: outcome.queued,
    failed: outcome.failed + proofPass.failures.length,
    printed,
    printAttempted,
    errors,
  }
}
```

- [ ] **Step 3.4: Run guard — verify it passes**

Run: `npm run test:batch-print-via-queue`
Expected: `All batch-print-via-queue behavioral checks passed.` exit 0.

- [ ] **Step 3.5: Commit**

```bash
git add web/src/components/Views/batch-create-print-chain.ts scripts/batch-print-via-queue-guard.ts package.json
git commit -m "Add pure Create+Print chain module with behavioral guard"
```

---

### Task 4: Extend sendOrdersToQueueBackend

**Files:**
- Modify: `web/src/components/Views/OrdersView.tsx:2883-3077` (`sendOrdersToQueueBackend`)

**Interfaces:**
- Consumes: `finalStatus.queued_entry_ids` (route already returns it: `src/routes/print-queue.ts` `/batch-send/status/:jobId`).
- Produces: options gains `deferOrdersRefetch?: boolean`; return gains `queuedEntryIds: string[]` and `successOrderIds: Set<number>` (structurally satisfies `QueueSendOutcome`).

- [ ] **Step 4.1: Add the option to the signature**

Replace:
```ts
    options: {
      kind: PersistentQueueJobKind
      label?: string
      batchTestMode?: boolean
      existingLabelOnly?: boolean
      labelPayloadOverrides?: Map<number, Record<string, unknown>>
    },
```
with:
```ts
    options: {
      kind: PersistentQueueJobKind
      label?: string
      batchTestMode?: boolean
      existingLabelOnly?: boolean
      labelPayloadOverrides?: Map<number, Record<string, unknown>>
      // Batch-print pipeline: the create-print chain owns refetch timing (fade
      // first, refetch per-row after the 30s transition) — it passes true here.
      deferOrdersRefetch?: boolean
    },
```

- [ ] **Step 4.2: Make the immediate refetch conditional**

Replace:
```ts
      await refetchOrders()
    } finally {
```
with:
```ts
      if (!options.deferOrdersRefetch) await refetchOrders()
    } finally {
```

- [ ] **Step 4.3: Expose entry ids + success ids in the return**

Replace:
```ts
    return {
      // Direct-carrier orders bought + queued via the Vercel path count too.
      queued: directQueued + (toNumberValue(finalStatus?.queued) ?? 0),
```
with:
```ts
    return {
      // Batch-print pipeline: the create-print chain prints exactly the entries
      // THIS job queued, and fades exactly the orders the backend reported bought.
      queuedEntryIds: Array.isArray(finalStatus?.queued_entry_ids)
        ? (finalStatus.queued_entry_ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : [],
      successOrderIds,
      // Direct-carrier orders bought + queued via the Vercel path count too.
      queued: directQueued + (toNumberValue(finalStatus?.queued) ?? 0),
```

- [ ] **Step 4.4: Typecheck web project**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: no NEW errors (Task 2's unused-flag error may persist until Task 6).

- [ ] **Step 4.5: Commit**

```bash
git add web/src/components/Views/OrdersView.tsx
git commit -m "sendOrdersToQueueBackend: optional deferred refetch, expose queuedEntryIds/successOrderIds"
```

---

### Task 5: printQueueEntries accepts a pre-opened window and reports pdfOpened

**Files:**
- Modify: `web/src/components/Views/OrdersView.tsx:4887-4974` (`printQueueEntries`)

**Interfaces:**
- Produces: `printQueueEntries(entryIds: string[], options?: { printWindow?: Window | null }): Promise<boolean>` (returns `pdfOpened`). Existing callers ignore the return — no change needed at their call sites.

- [ ] **Step 5.1: Widen the signature and window source**

Replace:
```ts
  async function printQueueEntries(entryIds: string[]) {
    if (entryIds.length === 0) return

    const printWindow = openQueuePrintWindow()
```
with:
```ts
  async function printQueueEntries(entryIds: string[], options: { printWindow?: Window | null } = {}) {
    if (entryIds.length === 0) return false

    // Batch-print pipeline: the create-print chain opens its window at click time
    // (popup-blocker safety) and hands it in; drawer callers keep the old behavior.
    const printWindow = options.printWindow ?? openQueuePrintWindow()
```

- [ ] **Step 5.2: Return pdfOpened**

Replace the function tail:
```ts
    } finally {
      setQueuePrintInFlight(false)
      setQueuePrintMessage(null)
      setQueuePrintProgress(null)
    }
  }
```
with:
```ts
    } finally {
      setQueuePrintInFlight(false)
      setQueuePrintMessage(null)
      setQueuePrintProgress(null)
    }
    return pdfOpened
  }
```
(Note: the `catch` block inside the function already swallows the error after toasting, so execution reaches the final `return pdfOpened` with `false` on failure.)

- [ ] **Step 5.3: Typecheck web project**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: no NEW errors.

- [ ] **Step 5.4: Commit**

```bash
git add web/src/components/Views/OrdersView.tsx
git commit -m "printQueueEntries: accept pre-opened window, return pdfOpened"
```

---

### Task 6: Wire the flag-ON Create+Print branch

**Files:**
- Modify: `web/src/components/Views/OrdersView.tsx` — import block (~line 103 area), after `resolveOrderShippingProviderId` (~line 2881), before `handleBatchAction` (~line 5050), and inside `handleBatchAction` after the `mode === 'queue'` block (~line 5085).

**Interfaces:**
- Consumes: `runCreatePrintChain` (Task 3), `sendOrdersToQueueBackend` extensions (Task 4), `printQueueEntries` options (Task 5), `batchPrintViaQueue` (Task 2), plus existing OrdersView helpers: `isBackendTestOrder`, `buildSelectedRateProofPayload`, `getAutoBestRateRequest`, `runStrictBestRateRecalculation`, `BATCH_RECALCULATE_TIMEOUT_MS`, `BATCH_QUEUE_CONCURRENCY`, `runWithConcurrency`, `getShippingString`, `toStringValue`, `toNumberValue`, `getDimensions`, `getOrderWeightOz`, `buildOrderShippingOptionsPayload`, `buildRateQuoteRefForOrder`, `orderDetailsById`, `setTransitionalShippedIds`, `transitionalTimeoutsRef`, `scheduleOrdersRefetch`, `openQueuePrintWindow`, `showToast`, `clearSelection`, `setBatchBusy`.

- [ ] **Step 6.1: Import the chain module**

Add to the OrdersView import section (near the `orders-persistent-queue-job` import):
```ts
import { runCreatePrintChain } from './batch-create-print-chain'
```

- [ ] **Step 6.2: Add the override-payload builder**

Insert after the `resolveOrderShippingProviderId` function (after its closing `}` at ~line 2881):

```ts
  // Batch-print pipeline: build the label-payload override for an order whose saved
  // rate could not serve as proof, from the FRESH strict-recalc rate. Mirrors the
  // legacy print loop's payload (PS-204: proof and provider id derive from the SAME
  // fresh rate, so account binding is coherent by construction). Returns null when
  // the fresh rate still cannot prove a purchase — the order is skipped, no postage.
  function buildBatchPrintOverridePayload(order: OrderSummaryDto, freshRate: unknown): Record<string, unknown> | null {
    const rate = freshRate as Record<string, unknown> | null
    if (!rate) return null
    const shippingProviderId = toNumberValue((rate as any)?.shippingProviderId)
      ?? order.selectedRate?.shippingProviderId
      ?? order.label?.shippingProviderId
      ?? null
    const serviceCode = getShippingString(order, 'serviceCode') ?? toStringValue((rate as any)?.serviceCode) ?? order.selectedRate?.serviceCode
    const carrierCode = getShippingString(order, 'carrierCode') ?? toStringValue((rate as any)?.carrierCode) ?? order.selectedRate?.carrierCode
    const orderDetail = orderDetailsById.get(order.orderId) ?? null
    const dims = getDimensions(order, orderDetail)
    const weightOz = getOrderWeightOz(order, orderDetail)
    const shippingOptions = buildOrderShippingOptionsPayload(order)
    const selectedRateProof = buildSelectedRateProofPayload(order, rate)
    if (!selectedRateProof || !serviceCode || !carrierCode || shippingProviderId == null) return null
    return {
      serviceCode,
      carrierCode,
      packageCode: 'package',
      shippingProviderId,
      weightOz: weightOz > 0 ? weightOz : undefined,
      length: dims?.length,
      width: dims?.width,
      height: dims?.height,
      confirmation: shippingOptions.confirmation,
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue,
      selectedRateProof,
      ...buildRateQuoteRefForOrder(order, rate, shippingProviderId),
      testLabel: batchTestMode || isBackendTestOrder(order),
    }
  }
```

- [ ] **Step 6.3: Add the fade helper**

Insert directly above `async function handleBatchAction(` (~line 5052):

```ts
  // Batch-print pipeline: the same 30s fade + refetch the legacy print loop runs
  // per bought row (boss directive 2026-05-07 — the operator must SEE the order
  // fading). The legacy block below stays byte-identical this ship; this helper is
  // consumed only by the flag-ON chain and by the follow-up that deletes the loop.
  function beginShippedFadeTransition(orderId: number) {
    const TRANSITION_MS = 30_000
    setTransitionalShippedIds((prev) => {
      const next = new Set(prev)
      next.add(orderId)
      return next
    })
    const existing = transitionalTimeoutsRef.current.get(orderId)
    if (existing) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      setTransitionalShippedIds((prev) => {
        const next = new Set(prev)
        next.delete(orderId)
        return next
      })
      transitionalTimeoutsRef.current.delete(orderId)
      scheduleOrdersRefetch(250)
    }, TRANSITION_MS)
    transitionalTimeoutsRef.current.set(orderId, timer)
  }
```

- [ ] **Step 6.4: Insert the flag-ON branch**

In `handleBatchAction`, between the end of the `if (mode === 'queue') { … return }` block and the legacy `setBatchBusy(true)` line, insert:

```ts
    if (mode === 'print' && batchPrintViaQueue) {
      // Batch-print pipeline (BATCH_PRINT_VIA_QUEUE, default OFF): Create + Print
      // chains the two existing backend jobs — /print-queue/batch-send buys
      // (≤8 concurrent, durable, createLabelV2 gate ladder, LABEL_EXISTS recovery)
      // and /print-queue/print merges ONE 4×6-normalized PDF. The FE buys nothing
      // here. Flag OFF ⇒ the legacy sequential loop below runs byte-identical.
      const printWindow = openQueuePrintWindow()
      setBatchBusy(true)
      try {
        const outcome = await runCreatePrintChain(batchOrders, {
          needsOverride: (order) =>
            !isBackendTestOrder(order) &&
            !buildSelectedRateProofPayload(
              order,
              order.bestRate ?? order.selectedRate,
              resolveOrderShippingProviderId(order),
            ),
          recalculate: async (order) => {
            const request = getAutoBestRateRequest(order)
            if (!request) return { ok: false as const, message: 'Recalculate current best rate before label purchase' }
            const result = await runStrictBestRateRecalculation(order, request, {
              timeoutMs: BATCH_RECALCULATE_TIMEOUT_MS,
            })
            if (result.status !== 'updated' || !result.rate) {
              return { ok: false as const, message: result.message || 'Current best rate could not be proven before label purchase' }
            }
            return { ok: true as const, rate: result.rate }
          },
          buildOverride: (order, freshRate) => buildBatchPrintOverridePayload(order, freshRate),
          runPool: (poolOrders, worker) => runWithConcurrency(poolOrders, BATCH_QUEUE_CONCURRENCY, worker),
          sendToQueue: (sendableOrders, overrides) =>
            sendOrdersToQueueBackend(sendableOrders, {
              kind: 'create-print',
              label: 'Creating labels',
              batchTestMode,
              labelPayloadOverrides: overrides,
              deferOrdersRefetch: true,
            }),
          printEntries: (entryIds) => printQueueEntries(entryIds, { printWindow }),
          markShipped: (orderId) => beginShippedFadeTransition(orderId),
        })
        if (!outcome.printAttempted) printWindow?.close()
        if (outcome.queued > 0) {
          const failSuffix = outcome.failed > 0
            ? ` — ${outcome.errors.slice(0, 3).join('; ')}${outcome.errors.length > 3 ? ` (+${outcome.errors.length - 3} more)` : ''}`
            : ''
          showToast(
            `✅ Created ${outcome.queued} label${outcome.queued === 1 ? '' : 's'} — ${outcome.printed ? 'merged PDF opened' : 'PDF ready in the Print Queue drawer'}${failSuffix}`,
            outcome.failed > 0 ? undefined : 'success',
          )
        } else {
          showToast(outcome.errors[0] ?? 'No labels were created', 'error')
        }
      } catch (error) {
        printWindow?.close()
        showToast(error instanceof Error ? error.message : 'Create + Print failed', 'error')
      } finally {
        setBatchBusy(false)
        clearSelection()
      }
      return
    }
```

- [ ] **Step 6.5: Typecheck web project**

Run: `npx tsc --noEmit -p web/tsconfig.json`
Expected: no NEW errors (the Task 2 unused-flag error is now consumed and gone).

- [ ] **Step 6.6: Commit**

```bash
git add web/src/components/Views/OrdersView.tsx
git commit -m "Wire Create+Print chain behind BATCH_PRINT_VIA_QUEUE (legacy loop untouched)"
```

---

### Task 7: Guard wiring half

**Files:**
- Modify: `scripts/batch-print-via-queue-guard.ts`

**Interfaces:**
- Consumes: source text of `web/src/components/Views/OrdersView.tsx`, `src/lib/env.ts`, `src/routes/users.ts`, `web/src/components/Views/orders-persistent-queue-job.ts`.

- [ ] **Step 7.1: Append source asserts to the guard**

Add to `scripts/batch-print-via-queue-guard.ts` (inside `main()`, before the failure exit; add `import { readFileSync } from 'node:fs';` at top):

```ts
  const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  const envSource = readFileSync('src/lib/env.ts', 'utf8');
  const usersRoute = readFileSync('src/routes/users.ts', 'utf8');
  const jobKinds = readFileSync('web/src/components/Views/orders-persistent-queue-job.ts', 'utf8');

  const sourceCheck = (name: string, condition: boolean) => {
    if (!condition) {
      failures += 1;
      console.error(`FAIL ${name}`);
    } else {
      console.log(`ok   ${name}`);
    }
  };

  sourceCheck('env flag exists (default OFF)', /BATCH_PRINT_VIA_QUEUE:\s*booleanFlag\(false\)/.test(envSource));
  sourceCheck('/users/me exposes batchPrintViaQueue', /batchPrintViaQueue:\s*env\.BATCH_PRINT_VIA_QUEUE === true/.test(usersRoute));
  sourceCheck("job kind union includes 'create-print'", /'create-print'/.test(jobKinds));

  const branchStart = ordersView.indexOf("if (mode === 'print' && batchPrintViaQueue)");
  const legacyStart = ordersView.indexOf('const processOrder = async (order: OrderSummaryDto)');
  sourceCheck('flag-ON branch exists', branchStart >= 0);
  sourceCheck('legacy per-order loop still present (byte-identical this ship)', legacyStart > branchStart && branchStart >= 0);
  const branchSlice = branchStart >= 0 && legacyStart > branchStart ? ordersView.slice(branchStart, legacyStart) : '';
  sourceCheck('branch chains runCreatePrintChain', /runCreatePrintChain\(/.test(branchSlice));
  sourceCheck("branch uses kind 'create-print' + deferred refetch", /kind:\s*'create-print'/.test(branchSlice) && /deferOrdersRefetch:\s*true/.test(branchSlice));
  sourceCheck('branch NEVER buys from the FE (no apiClient.createLabel)', !/apiClient\.createLabel\(/.test(branchSlice));
  sourceCheck('legacy loop still buys via apiClient.createLabel (unchanged)', /const response = await apiClient\.createLabel\(payload\)/.test(ordersView));
```

- [ ] **Step 7.2: Run guard — verify all checks pass**

Run: `npm run test:batch-print-via-queue`
Expected: all `ok` lines, exit 0.

- [ ] **Step 7.3: Commit**

```bash
git add scripts/batch-print-via-queue-guard.ts
git commit -m "Extend batch-print guard with wiring + never-buys source asserts"
```

---

### Task 8: Browser e2e for the chained flow

**Files:**
- Create: `web/e2e/batch-create-print-via-queue.spec.js`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: the interception harness pattern from `web/e2e/carrier-print-to-queue.spec.js` (mock supabase session under `sb-fdkseckgfuvdczzqmnac-auth-token`, playwright webServer from `playwright.config.js`).

- [ ] **Step 8.1: Write the spec**

Create `web/e2e/batch-create-print-via-queue.spec.js`:

```js
// Batch-print pipeline browser smoke (design: docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md).
// Drives the REAL "Create + Print Label" batch button with BATCH_PRINT_VIA_QUEUE mocked ON.
// Every backend endpoint is intercepted (no real carrier, postage, or marketplace). Asserts the
// chain: POST /print-queue/batch-send → status → POST /print-queue/print with THAT job's entry
// ids — and that the FE never buys (/labels never called).
import { test, expect } from 'playwright/test'

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const TEST_CLIENT = { id: 3, name: '__BATCH_PRINT_HARNESS__', active: true, isTest: true, storeId: 103 }

const rate = {
  carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver',
  carrierNickname: 'HARNESS', providerAccountNickname: 'HARNESS', shippingProviderId: 7381,
  amount: 9.86, cost: 9.86, shipmentCost: 9.86, otherCost: 0,
}

const PDF_DATAURI = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+Cg=='

function makeTestOrder() {
  return {
    id: 990001, orderId: 990001, orderNumber: 'HARNESS-BATCH-PRINT-1', orderStatus: 'awaiting_shipment',
    orderDate: '2026-07-07T02:11:00.000Z', externalOrderId: null, sourceProvider: 'internal',
    clientId: TEST_CLIENT.id, storeId: TEST_CLIENT.storeId, isTestOrdersStore: true,
    customerEmail: 'harness@example.com', shipToName: 'Batch Print Tester',
    shipToCity: 'San Francisco', shipToState: 'CA', shipToPostalCode: '94104',
    orderTotal: 16.99, shippingAmount: 7.3, weightOz: 16,
    items: [{ name: 'Batch print test item', sku: 'TEST-BATCH-PRINT', quantity: 1, unitPrice: 16.99, imageUrl: '' }],
    raw: { shipTo: { name: 'Batch Print Tester', street1: '417 Montgomery St', city: 'San Francisco', state: 'CA', postalCode: '94104', country: 'US', phone: '4150000000' }, dimensions: { length: 8, width: 6, height: 4 } },
    overrides: { rateWeightOz: 16, rateDimsL: 8, rateDimsW: 6, rateDimsH: 4, bestRateJson: rate },
    bestRate: rate, selectedRate: rate, label: null, shipping: null,
    // Backend test-order fact (PS-186): isBackendTestOrder(order) keys off DTO isTest, which
    // makes the chain's needsOverride false — no strict-recalc round-trip in this harness, and
    // the queue payload uses the TEST service codes (backend is fully mocked anyway).
    isTest: true,
  }
}

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

const order = makeTestOrder()

const queueListPayload = {
  queuedOrders: [{
    queue_entry_id: 'entry-1', order_id: '990001', order_number: 'HARNESS-BATCH-PRINT-1',
    client_id: TEST_CLIENT.id, label_url: PDF_DATAURI, sku_group_id: 'TEST-BATCH-PRINT',
    primary_sku: 'TEST-BATCH-PRINT', item_description: 'Batch print test item', order_qty: 1,
    multi_sku_data: null, status: 'queued', print_count: 0, last_printed_at: null,
    auto_retired_at: null, queued_at: '2026-07-07T02:15:00.000Z', shipping_hold: false, held_reason: null,
  }],
  totalOrders: 1, totalQty: 1,
}

function responseFor(url, method) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApi = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApi) return null

  // ── the chain under test ──
  if (url.pathname === '/print-queue/batch-send' && method === 'POST') return json({ job_id: 'qs_e2e', total: 1 })
  if (url.pathname === '/print-queue/batch-send/status/qs_e2e') {
    return json({
      job_id: 'qs_e2e', status: 'done', progress: 100, total: 1, current: 1, queued: 1, failed: 0,
      message: 'done', client_id: TEST_CLIENT.id, queued_entry_ids: ['entry-1'],
      results: [{ orderId: 990001, success: true, queueEntryId: 'entry-1', labelUrl: PDF_DATAURI }],
      error: null, durableJob: null,
    })
  }
  if (url.pathname === '/print-queue/print' && method === 'POST') return json({ job_id: 'mg_e2e', total: 1 })
  if (url.pathname === '/print-queue/print/status/mg_e2e') {
    return json({
      job_id: 'mg_e2e', status: 'done', progress: 100, total: 1, current: 1,
      message: 'Done - 1 label merged.', file_name: 'batch_print_e2e.pdf', error: null,
      label_errors: [], successful_entry_ids: ['entry-1'], durableJob: null,
    })
  }
  if (url.pathname === '/print-queue/print/signed-url/mg_e2e') {
    return json({ url: `${apiOrigin}/print-queue/print/view/mg_e2e?token=e2e`, expires_at: '2026-07-07T03:00:00.000Z', expires_in_seconds: 300, filename: 'batch_print_e2e.pdf', disposition: 'inline' })
  }
  if (url.pathname === '/print-queue/print/last') return json({ job: null })
  if (url.pathname === '/print-queue' && method === 'GET') return json(queueListPayload)
  if (url.pathname.startsWith('/print-queue')) return json({ ok: true })

  // ── FE must NEVER buy: these return 500 so any hit fails the test loudly ──
  if (url.pathname === '/labels' || url.pathname === '/api/carriers/labels') {
    return { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'FE MUST NOT BUY' }) }
  }

  // ── identity: flag ON ──
  if (url.pathname === '/users/me') {
    return json({ id: 'u1', email: 'operator@example.com', isAdmin: true, printQueueFeDelegation: false, batchPrintViaQueue: true })
  }

  // ── supporting reads (mirrors carrier-print-to-queue.spec.js) ──
  if (url.pathname === '/api/carriers/rates') return json({ rates: [rate], rateQuoteId: 'rq_e2e', carrierEligibility: null })
  if (url.pathname === '/clients') return json([TEST_CLIENT])
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/locations') return json([{ id: 1, name: 'GWH', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', isDefault: true, active: true }])
  if (url.pathname === '/packages') return json([{ id: 1, name: '8x6x4', length: 8, width: 6, height: 4, unitCost: '0.62', source: 'custom' }])
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-07-07T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: [{ id: TEST_CLIENT.storeId, storeId: TEST_CLIENT.storeId, name: TEST_CLIENT.name, storeName: TEST_CLIENT.name, clientName: TEST_CLIENT.name, clientId: TEST_CLIENT.id, active: true, isTest: true }] })
  if (url.pathname === '/init/counts') return json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 1 }], byStatusStore: [{ orderStatus: 'awaiting_shipment', storeId: TEST_CLIENT.storeId, cnt: 1 }] })
  if (url.pathname === '/clients/order-stats') return json({ data: [{ clientId: TEST_CLIENT.id, awaiting_shipment: 1, shipped: 0, cancelled: 0 }] })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['TEST-BATCH-PRINT'] })
  if (url.pathname === '/orders') return json({ data: [order], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } })
  if (/^\/orders\/\d+\/full$/.test(url.pathname)) return json(order)
  return json({})
}

async function setup(page) {
  await page.addInitScript((projectRef) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
      access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', expires_at: expiresAt, expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'operator@example.com' },
    }))
  }, supabaseProjectRef)
  await page.route('**/*', async (route) => {
    const req = route.request()
    const mocked = responseFor(new URL(req.url()), req.method())
    if (mocked) { await route.fulfill(mocked); return }
    await route.continue()
  })
}

test('Create + Print Label with flag ON chains batch-send → print and never buys from the FE', async ({ page }) => {
  const consoleErrors = []
  const failedResponses = []
  const pipelineCalls = []
  let printRequestBody = null
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname === '/print-queue/print' && req.method() === 'POST') {
      try { printRequestBody = JSON.parse(req.postData() ?? 'null') } catch { printRequestBody = null }
    }
    if (/^\/print-queue\/(batch-send|print)$/.test(u.pathname) || u.pathname === '/labels' || u.pathname === '/api/carriers/labels') {
      pipelineCalls.push(`${req.method()} ${u.pathname}`)
    }
  })
  page.on('response', (res) => {
    const u = new URL(res.url())
    if (u.origin === baseUrl && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/labels') && !u.pathname.startsWith('/print-queue')) return
    if (res.status() >= 400) failedResponses.push(`${res.status()} ${u.pathname}`)
  })

  const ordersListCalls = []
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname === '/orders' && req.method() === 'GET') ordersListCalls.push(u.search)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  await page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]').first().check()
  await page.waitForSelector('[data-testid="orders-selection-toolbar"]', { state: 'visible' })

  const ordersCallsBeforeClick = ordersListCalls.length
  await page.getByRole('button', { name: /Create \+ Print Label/ }).first().click()

  // batch-send poll (750ms) + print poll (600ms) + signed-url — give the chain room.
  await page.waitForTimeout(5000)

  expect(pipelineCalls, 'chain order').toEqual(['POST /print-queue/batch-send', 'POST /print-queue/print'])
  expect(printRequestBody?.queue_entry_ids, 'print uses the job-returned entry ids').toEqual(['entry-1'])
  // Fade directive: the chain defers the orders refetch to the per-row 30s timers,
  // so no immediate awaiting-list refetch fires within this 5s window.
  expect(ordersListCalls.length, 'no immediate orders refetch before the fade timers').toBe(ordersCallsBeforeClick)
  expect(failedResponses, `failed API responses: ${failedResponses.join(', ')}`).toEqual([])
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
})
```

Register in `package.json` scripts:
```json
"test:batch-print-via-queue:browser": "playwright test web/e2e/batch-create-print-via-queue.spec.js --reporter=line",
```

- [ ] **Step 8.2: Run the e2e**

Run: `npm run test:batch-print-via-queue:browser`
Expected: 1 passed. (If the selection toolbar's button label ever changes, the guard in Task 7 still pins the wiring; fix the selector, not the assertions.)

- [ ] **Step 8.3: Commit**

```bash
git add web/e2e/batch-create-print-via-queue.spec.js package.json
git commit -m "e2e: Create+Print flag-ON chains batch-send→print, FE never buys"
```

---

### Task 9: Prefetch module (TDD — guard first) [Track 2, override authorized]

**Files:**
- Create: `src/services/print-queue-label-prefetch.ts` (new file — not itself a locked surface)
- Create: `scripts/print-queue-label-prefetch-guard.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `startLabelPrefetch(items: Array<{id: string; url: string}>, opts: {concurrency: number; timeoutMs: number; fetchImpl?: typeof fetch}): (id: string) => Promise<PrefetchResult>` with `PrefetchResult = {ok: true; bytes: Uint8Array} | {ok: false; kind: 'http'; status: number} | {ok: false; kind: 'network'; message: string}`.

- [ ] **Step 9.1: Write the failing guard**

Create `scripts/print-queue-label-prefetch-guard.ts`:

```ts
/**
 * Guard: print-queue label prefetch pool (batch-print pipeline design).
 *
 * Behavioral: pool cap respected; results keyed per id regardless of completion
 * order; http/network mapping; unknown id → materialized network error.
 * Real-runtime smoke (exceljs lesson — no fake-object-only guards on library
 * boundaries): real node:http server + real global fetch + real pdf-lib load
 * of the returned bytes, including a 404 and a timeout.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startLabelPrefetch } from '../src/services/print-queue-label-prefetch';

const MINIMAL_PDF = Buffer.from(
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+Cg==',
  'base64',
);

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}:`, err instanceof Error ? err.message : err);
  }
}

async function main() {
  await check('pool cap: never more than `concurrency` fetches in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fakeFetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, url: `http://x/${i}` }));
    const prefetch = startLabelPrefetch(items, { concurrency: 3, timeoutMs: 1000, fetchImpl: fakeFetch });
    const results = await Promise.all(items.map((item) => prefetch(item.id)));
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);
  });

  await check('results keyed per id regardless of completion order', async () => {
    const delays = new Map([['a', 60], ['b', 5]]);
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const key = String(input).slice(-1);
      await new Promise((resolve) => setTimeout(resolve, delays.get(key) ?? 0));
      return new Response(new TextEncoder().encode(key), { status: 200 });
    }) as unknown as typeof fetch;
    const prefetch = startLabelPrefetch(
      [{ id: 'a', url: 'http://x/a' }, { id: 'b', url: 'http://x/b' }],
      { concurrency: 2, timeoutMs: 1000, fetchImpl: fakeFetch },
    );
    const [ra, rb] = await Promise.all([prefetch('a'), prefetch('b')]);
    assert.ok(ra.ok && new TextDecoder().decode(ra.bytes) === 'a');
    assert.ok(rb.ok && new TextDecoder().decode(rb.bytes) === 'b');
  });

  await check('unknown id → materialized network error (never a rejection)', async () => {
    const prefetch = startLabelPrefetch([], { concurrency: 1, timeoutMs: 100 });
    const result = await prefetch('nope');
    assert.ok(!result.ok && result.kind === 'network');
  });

  await check('real-runtime smoke: http server + real fetch + real pdf-lib', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/ok.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(MINIMAL_PDF);
        return;
      }
      if (req.url === '/missing.pdf') {
        res.writeHead(404);
        res.end();
        return;
      }
      // /slow.pdf: never respond — exercises AbortSignal.timeout.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    try {
      const prefetch = startLabelPrefetch(
        [
          { id: 'ok', url: `${base}/ok.pdf` },
          { id: 'missing', url: `${base}/missing.pdf` },
          { id: 'slow', url: `${base}/slow.pdf` },
        ],
        { concurrency: 3, timeoutMs: 500 },
      );
      const [ok, missing, slow] = await Promise.all([prefetch('ok'), prefetch('missing'), prefetch('slow')]);
      assert.ok(ok.ok, 'ok.pdf should fetch');
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(ok.ok ? ok.bytes : new Uint8Array());
      assert.equal(doc.getPageCount(), 1);
      assert.ok(!missing.ok && missing.kind === 'http' && missing.status === 404);
      assert.ok(!slow.ok && slow.kind === 'network', 'slow.pdf should time out as a network result');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll print-queue-label-prefetch checks passed.');
}

void main();
```

Register in `package.json` scripts:
```json
"test:print-queue-label-prefetch": "tsx scripts/print-queue-label-prefetch-guard.ts",
```

- [ ] **Step 9.2: Run guard — verify it fails**

Run: `npm run test:print-queue-label-prefetch`
Expected: FAIL (module missing).

- [ ] **Step 9.3: Implement the module**

Create `src/services/print-queue-label-prefetch.ts`:

```ts
// Batch-print pipeline (docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md):
// bounded prefetch pool for merge-job label PDFs. Pure fetch mechanics — the caller
// (runMergeJob) keeps ownership of ordering, grouping, headers, and every error branch.
// concurrency 1 = at most one fetch in flight, walked in the caller's order (today's
// serial behavior on the wire). Errors are MATERIALIZED results, never rejections, so
// the assembly loop's branch structure stays intact.

export type PrefetchResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network'; message: string };

export type LabelPrefetchItem = { id: string; url: string };

export function startLabelPrefetch(
  items: LabelPrefetchItem[],
  opts: { concurrency: number; timeoutMs: number; fetchImpl?: typeof fetch },
): (id: string) => Promise<PrefetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, Math.min(8, Math.floor(opts.concurrency || 1)));
  const results = new Map<string, Promise<PrefetchResult>>();
  const resolvers = new Map<string, (result: PrefetchResult) => void>();
  for (const item of items) {
    results.set(item.id, new Promise<PrefetchResult>((resolve) => resolvers.set(item.id, resolve)));
  }

  const fetchOne = async (item: LabelPrefetchItem): Promise<PrefetchResult> => {
    try {
      const res = await fetchImpl(item.url, {
        headers: { Accept: 'application/pdf' },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) return { ok: false, kind: 'http', status: res.status };
      return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch (err) {
      return { ok: false, kind: 'network', message: err instanceof Error ? err.message : String(err) };
    }
  };

  let nextIndex = 0;
  let active = 0;
  const pump = () => {
    while (active < concurrency && nextIndex < items.length) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      active += 1;
      void fetchOne(item).then((result) => {
        resolvers.get(item.id)?.(result);
        active -= 1;
        pump();
      });
    }
  };
  pump();

  return (id: string) =>
    results.get(id) ??
    Promise.resolve<PrefetchResult>({ ok: false, kind: 'network', message: 'Label was not scheduled for prefetch' });
}
```

- [ ] **Step 9.4: Run guard — verify it passes**

Run: `npm run test:print-queue-label-prefetch`
Expected: `All print-queue-label-prefetch checks passed.` exit 0.

- [ ] **Step 9.5: Commit**

```bash
git add src/services/print-queue-label-prefetch.ts scripts/print-queue-label-prefetch-guard.ts package.json
git commit -m "Add bounded label prefetch pool for the merge job (behavior + real-runtime guard)"
```

---

### Task 10: Consume the prefetch in runMergeJob [LOCKED FILE — override stamping required]

**Files:**
- Modify: `src/lib/env.ts` (after `BATCH_PRINT_VIA_QUEUE`)
- Modify: `src/services/print-queue.ts` (imports; `runMergeJob` ~lines 1333-1459)

**Interfaces:**
- Consumes: `startLabelPrefetch` (Task 9), `env.PRINT_QUEUE_MERGE_FETCH_CONCURRENCY`.
- Produces: no signature changes; `runMergeJob` behavior identical at concurrency 1.

- [ ] **Step 10.1: Add the knob to env.ts**

Insert after the `BATCH_PRINT_VIA_QUEUE: booleanFlag(false),` block:

```ts
  // Per user override unlock shipped data on 2026-07-07: merge-job label fetch concurrency
  // (batch-print pipeline design). Default 1 = at most one fetch in flight, walked in merge
  // order — today's serial behavior on the wire. DJ raises to ~4 on Render after a canary
  // Print All. Read-only label fetch mechanics — never postage, never a shipped/cancelled
  // mutation.
  PRINT_QUEUE_MERGE_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
```

- [ ] **Step 10.2: Add imports to src/services/print-queue.ts**

After the line `import { GLOBAL_SCOPE } from '../lib/client-store-scope';` insert:

```ts
// Per user override unlock shipped data on 2026-07-07: batch-print pipeline — the merge job's
// label fetches now go through a bounded prefetch pool (default concurrency 1 = serial, byte-
// identical on the wire). Fetch mechanics only; ordering/grouping/error branches stay below.
import { env } from '../lib/env';
import { startLabelPrefetch, type PrefetchResult } from './print-queue-label-prefetch';
```

- [ ] **Step 10.3: Start the pool after the holds load**

In `runMergeJob`, after:
```ts
    const shippingHoldsByOrderId = await loadShippingHoldsByOrderId(entriesByGroup);
```
insert:
```ts
    // Per user override unlock shipped data on 2026-07-07 (batch-print pipeline): prefetch the
    // label PDFs through a bounded pool instead of fetching inline one-at-a-time. Held entries
    // and unresolvable URLs are excluded here — the loop below still reports them through its
    // existing branches. Read-only label fetches — no postage, no shipped/cancelled mutation.
    const prefetchItems: Array<{ id: string; url: string }> = [];
    for (const entry of sorted) {
      if (shippingHoldsByOrderId.get(Number(entry.orderId))) continue;
      try {
        prefetchItems.push({ id: entry.id, url: resolveLabelFetchUrl(entry.labelUrl, requestOrigin) });
      } catch {
        // Unresolvable URL — the loop below reports it via formatLabelUrlError.
      }
    }
    const prefetch = startLabelPrefetch(prefetchItems, {
      concurrency: env.PRINT_QUEUE_MERGE_FETCH_CONCURRENCY,
      timeoutMs: 15_000,
    });
```

- [ ] **Step 10.4: Replace the inline fetch with pool consumption**

Replace this block inside the loop:
```ts
      try {
        const res = await fetch(labelFetchUrl, {
          headers: { Accept: 'application/pdf' },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404 || res.status === 410) {
          if (isMockLabel) {
            addMockFallback(`Mock label not found (HTTP ${res.status})`);
            continue;
          }
          job.labelErrors!.push(
            `Label expired for order ${e.orderNumber ?? e.orderId} (HTTP ${res.status}).`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        if (!res.ok) {
          if (isMockLabel) {
            addMockFallback(`Mock label fetch failed (HTTP ${res.status})`);
            continue;
          }
          job.labelErrors!.push(
            `Failed to fetch label for order ${e.orderNumber ?? e.orderId} (HTTP ${res.status}).`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        pdfBytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (isMockLabel) {
          addMockFallback((err as Error).message || 'Mock label fetch failed');
          continue;
        }
        job.labelErrors!.push(
          `Network error for order ${e.orderNumber ?? e.orderId}: ${(err as Error).message}`
        );
        failedEntryIds.add(e.id);
        continue;
      }
```
with:
```ts
      // Per user override unlock shipped data on 2026-07-07 (batch-print pipeline): consume the
      // prefetched result. Every branch below maps 1:1 onto the previous inline-fetch branches —
      // same messages, same mock fallbacks, same failedEntryIds bookkeeping.
      const fetched: PrefetchResult = await prefetch(e.id);
      if (!fetched.ok && fetched.kind === 'http' && (fetched.status === 404 || fetched.status === 410)) {
        if (isMockLabel) {
          addMockFallback(`Mock label not found (HTTP ${fetched.status})`);
          continue;
        }
        job.labelErrors!.push(
          `Label expired for order ${e.orderNumber ?? e.orderId} (HTTP ${fetched.status}).`
        );
        failedEntryIds.add(e.id);
        continue;
      }
      if (!fetched.ok && fetched.kind === 'http') {
        if (isMockLabel) {
          addMockFallback(`Mock label fetch failed (HTTP ${fetched.status})`);
          continue;
        }
        job.labelErrors!.push(
          `Failed to fetch label for order ${e.orderNumber ?? e.orderId} (HTTP ${fetched.status}).`
        );
        failedEntryIds.add(e.id);
        continue;
      }
      if (!fetched.ok) {
        if (isMockLabel) {
          addMockFallback(fetched.message || 'Mock label fetch failed');
          continue;
        }
        job.labelErrors!.push(
          `Network error for order ${e.orderNumber ?? e.orderId}: ${fetched.message}`
        );
        failedEntryIds.add(e.id);
        continue;
      }
      pdfBytes = fetched.bytes;
```
(`labelFetchUrl` stays — the resolve try/catch above this block and `isMockLabel` still use it.)

- [ ] **Step 10.5: Typecheck + run the print-queue guards**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npm run test:print-queue-label-prefetch
npm run test:ps-084-label-size-normalize
npm run guard:print-queue-batch-names
npm run test:ps-053-print-queue-atomic
```
Expected: all pass / no NEW failures vs baseline. If a pre-existing guard greps the replaced inline-fetch text, repoint that guard to the prefetch consumption (list it in the commit body) — guards are repointable per the PS-331 precedent.

- [ ] **Step 10.6: Commit (override stamped)**

```bash
git add src/lib/env.ts src/services/print-queue.ts
git commit -m "Merge job: bounded label prefetch pool (default 1 = serial)

Per user override unlock shipped data on 2026-07-07: fetch mechanics only
inside runMergeJob — no postage, no shipped/cancelled mutation, error
branches byte-identical; PRINT_QUEUE_MERGE_FETCH_CONCURRENCY default 1."
```

---

### Task 11: Full verification + ship-readiness report (NO push)

**Files:** none modified (unless a rotted guard repoint from 10.5 remains).

- [ ] **Step 11.1: Full suite**

Run:
```bash
npm run typecheck
npm run test:batch-print-via-queue
npm run test:print-queue-label-prefetch
npm run test:batch-print-via-queue:browser
npm run test:rate-source-of-truth
npm run test:master:all-safe > "$SCRATCHPAD/all-safe-after.txt" 2>&1 || true
```
Expected: typecheck no NEW errors; the three new suites pass; rate-source-of-truth passes.

- [ ] **Step 11.2: Zero-new-reds diff**

Compare `all-safe-after.txt` against `all-safe-baseline.txt`: the set of failing checks after must be a subset of the baseline's. Any NEW red must be fixed before reporting done.

- [ ] **Step 11.3: Report to DJ and STOP before push**

Report per the completion-% convention: what shipped per slice, guard/e2e evidence, canary/flip instructions (`BATCH_PRINT_VIA_QUEUE=true`, `PRINT_QUEUE_MERGE_FETCH_CONCURRENCY=4` on Render), and the exact locked files touched with override stamping proof. Do NOT push — DJ confirms the ship (lockdown rule: confirm before pushing).
