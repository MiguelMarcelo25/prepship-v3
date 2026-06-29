# PS-346 Rate And Order Slow Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rate Browser, Orders refresh, and Print Queue high-volume flows backend-owned, partial-result capable, observable, and proof-safe without reintroducing frontend business truth.

**Architecture:** Keep rates and label safety in backend source-of-truth owners. Add a small durable JSON settings helper, then layer a backend rate-browse workflow/status DTO over the existing quote owners instead of moving ranking or proof to React. Add a frontend refresh coordinator that dedupes list refetches, and gate any Print Queue implementation that touches shipped/shipments code behind the repository lockdown rule.

**Tech Stack:** TypeScript, Hono routes, Drizzle/Postgres, React, TanStack Query, existing PrepShip rate/queue services, tsx guard scripts.

---

## File Structure

- Create: `src/services/settings-json.ts` - shared JSON settings upsert/read helper for durable workflow snapshots.
- Create: `src/services/rate-browse-workflow-types.ts` - DTOs for partial/final rate browse workflow snapshots.
- Create: `src/services/rate-browse-workflow-store.ts` - settings-backed snapshot store for rate browse jobs.
- Create: `src/services/rate-browse-workflow.ts` - backend rate browse job orchestrator that delegates to existing `getRates`, `getDirectCarrierRatesForRateInput`, and `combineCarrierUniverses`.
- Modify: `src/routes/rates.ts` - add additive start/status endpoints and keep existing `/rates/browse` compatibility.
- Create: `web/src/components/RateBrowser/useRateBrowseWorkflow.ts` - UI hook that starts a backend workflow, polls status, and renders backend DTOs only.
- Modify: `web/src/components/RateBrowserModal.tsx` - wire explicit live browse button to the workflow hook; no rate math, ranking, or proof minting.
- Create: `web/src/components/Views/useOrdersRefreshCoordinator.ts` - latest-wins/single-flight wrapper around `refetchOrders`.
- Modify: `web/src/components/Views/OrdersView.tsx` - replace rate/queue settle refetch bursts with the coordinator.
- Create: `scripts/ps-346-rate-order-slow-paths-guard.ts` - static guard for workflow ownership, partial result status, refresh dedupe, and no frontend rate truth.
- Modify: `package.json` - add `test:ps-346-rate-order-slow-paths`.
- Modify: `docs/ps-tickets/ps-ledger.md` - add PS-346 ownership/status row.

## Lockdown Gate

Do not modify `src/services/print-queue.ts`, `src/routes/print-queue.ts`, shipment-history code, shipped/cancelled mutation paths, or schema involving `shipments` unless the user explicitly types `unlock shipped data` in the current conversation. Until then, Print Queue work in this plan is limited to docs, guards, and read-only evidence outside locked files.

### Task 1: Shared JSON Settings Helper

**Files:**
- Create: `src/services/settings-json.ts`
- Test: `scripts/ps-346-rate-order-slow-paths-guard.ts`

- [ ] **Step 1: Create the helper**

```ts
import { getSetting, setSetting } from './settings';

export type JsonSettingRow<T> = {
  key: string;
  value: T;
};

export async function setJsonSetting(key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

export async function setJsonSettings(rows: ReadonlyArray<JsonSettingRow<unknown>>): Promise<void> {
  for (const row of rows) {
    await setJsonSetting(row.key, row.value);
  }
}

export async function getJsonSetting<T>(key: string): Promise<T | null> {
  const value = await getSetting(key);
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Add the guard checks**

Add checks that `settings-json.ts` exists, uses `setSetting`, and does not use a multi-row `insert(settings).values([...])` snapshot pattern.

- [ ] **Step 3: Run the guard**

Run: `npm run test:ps-346-rate-order-slow-paths -- --no-color`

Expected first run: FAIL until the package script is added in Task 7.

### Task 2: Rate Browse Workflow DTO And Store

**Files:**
- Create: `src/services/rate-browse-workflow-types.ts`
- Create: `src/services/rate-browse-workflow-store.ts`
- Test: `scripts/ps-346-rate-order-slow-paths-guard.ts`

- [ ] **Step 1: Define the DTO**

```ts
export type RateBrowseWorkflowPhase = 'queued' | 'cached' | 'running' | 'partial' | 'complete' | 'error';

export type RateBrowseWorkflowSnapshot = {
  jobId: string;
  phase: RateBrowseWorkflowPhase;
  requestKey: string | null;
  orderId: number | null;
  totalCarriers: number;
  completedCarriers: number;
  successfulCarriers: number;
  failedCarriers: number;
  ratesCount: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  message: string;
  result: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
  error: string | null;
};
```

- [ ] **Step 2: Implement the store**

Use `setJsonSettings` and `getJsonSetting` from `src/services/settings-json.ts`.

Keys:

```ts
export const RATE_BROWSE_WORKFLOW_LATEST_KEY = 'rate_browse_workflow.latest';
export const RATE_BROWSE_WORKFLOW_JOB_PREFIX = 'rate_browse_workflow.job.';
```

Persist both latest and job-specific keys by calling `setJsonSettings([{ key: latest, value }, { key: jobKey, value }])`.

- [ ] **Step 3: Guard the store**

The guard must prove the store writes both latest/job keys through the JSON settings helper and exposes a read function for `jobId`.

### Task 3: Backend Rate Browse Workflow

**Files:**
- Create: `src/services/rate-browse-workflow.ts`
- Modify: `src/routes/rates.ts`
- Test: `scripts/ps-346-rate-order-slow-paths-guard.ts`

- [ ] **Step 1: Add the workflow service**

Implement a service with this public API:

```ts
export type StartRateBrowseWorkflowInput = {
  body: Record<string, unknown>;
  canViewFinancials: boolean;
};

export async function startRateBrowseWorkflow(input: StartRateBrowseWorkflowInput): Promise<RateBrowseWorkflowSnapshot> {
  // Start cached snapshot immediately, then run live quote work in the backend.
}

export async function getRateBrowseWorkflow(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  // Read durable snapshot by job id.
}
```

The implementation must delegate ranking/proof/completeness to the existing backend owners. It must not reimplement `rateTotal`, `combineCarrierUniverses`, customer markup, house tuple, or selected-rate proof in the frontend or in a duplicate helper.

- [ ] **Step 2: Add additive endpoints**

Add routes:

```ts
app.post('/browse/workflow', zValidator('json', browseBody), async (c) => { ... });
app.get('/browse/workflow/:jobId', async (c) => { ... });
```

The response shape must be:

```ts
{
  job_id: snapshot.jobId,
  status: snapshot.phase,
  result: publicRatesResult(snapshot.result, canViewFinancials),
  diagnostics: snapshot.diagnostics
}
```

- [ ] **Step 3: Keep compatibility**

Do not remove or weaken existing `/rates/browse`. Rate Shop and older callers must continue to receive the current final payload.

- [ ] **Step 4: Guard backend ownership**

The PS-346 guard must prove the new workflow service exists, the route exposes workflow start/status, and no frontend file imports `combineCarrierUniverses`, `rateTotal`, `loadCarrierMarkups`, or selected-rate proof minting helpers.

### Task 4: Rate Browser Partial Workflow Consumer

**Files:**
- Create: `web/src/components/RateBrowser/useRateBrowseWorkflow.ts`
- Modify: `web/src/components/RateBrowserModal.tsx`
- Test: `scripts/ps-346-rate-order-slow-paths-guard.ts`

- [ ] **Step 1: Add the hook**

```ts
export function useRateBrowseWorkflow(options: {
  postWorkflow: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  fetchWorkflow: (jobId: string) => Promise<Record<string, unknown>>;
  onSnapshot: (snapshot: Record<string, unknown>) => void;
}) {
  // Start workflow on explicit Browse/Refresh only.
  // Poll until status is complete or error.
  // Ignore stale job ids when a newer browse starts.
}
```

- [ ] **Step 2: Wire explicit live browse**

Rate Browser open remains cached-only. The Browse/Refresh button starts the workflow endpoint and renders each backend snapshot result. The modal may sort for display only using existing backend display ranks, but it must not choose official best rate or mint proof.

- [ ] **Step 3: Guard UI ownership**

The guard must prove RateBrowserModal imports `useRateBrowseWorkflow`, keeps cached-only open behavior, and live browse goes through `/rates/browse/workflow` only on explicit click.

### Task 5: Orders Refresh Coordinator

**Files:**
- Create: `web/src/components/Views/useOrdersRefreshCoordinator.ts`
- Modify: `web/src/components/Views/OrdersView.tsx`
- Test: `scripts/ps-346-rate-order-slow-paths-guard.ts`

- [ ] **Step 1: Add the coordinator**

```ts
export type OrdersRefreshReason =
  | 'rate-job-mid'
  | 'rate-job-done'
  | 'rate-job-settle'
  | 'queue-job-done'
  | 'label-action'
  | 'manual';

export function useOrdersRefreshCoordinator(refetchOrders: () => Promise<unknown>) {
  // Single-flight refetches.
  // If a refresh is requested while one is active, run exactly one trailing refresh.
  // Keep counters by reason for console diagnostics.
}
```

- [ ] **Step 2: Replace broad direct calls**

Use the coordinator in the rate-backfill poller, queue-send completion, label-create completion, and settle timers. Preserve existing manual behavior, but collapse overlapping calls into latest-wins refetches.

- [ ] **Step 3: Guard refresh pressure**

The guard must prove OrdersView imports the coordinator and that the Recalculate All poller no longer calls `refetchOrders()` directly inside its 2.5s interval.

### Task 6: Print Queue High-Volume Completion Gate

**Files:**
- Locked unless override: `src/services/print-queue.ts`
- Locked unless override: `src/routes/print-queue.ts`
- Create before unlock: `docs/ps-tickets/ps-346-print-queue-volume-evidence.md`

- [ ] **Step 1: Do not edit locked files without override**

If implementation requires changing Print Queue internals, stop until the user types exactly `unlock shipped data`.

- [ ] **Step 2: After unlock, standardize snapshot persistence**

Replace hand-rolled multi-row settings snapshot writes with `setJsonSettings`. This specifically targets the live failure pattern where batch-send status persistence can fail while the queue job itself is processing.

- [ ] **Step 3: Add per-order blocked reason proof**

Ensure the backend status response returns every order result, not just samples, for active jobs. Durable snapshots may keep capped samples for storage safety, but active status must support operator proof for the current batch.

- [ ] **Step 4: Prove volume behavior**

Use test mode first. Evidence must show:

```text
Selected: 10 -> status total 10, current 10, queued + failed = 10
Selected: 20 -> status total 20, current 20, queued + failed = 20
No cumulative 30/30 from a previous run
No whole-batch failure when individual orders have legitimate blockers
```

### Task 7: Guard, Ledger, And Verification

**Files:**
- Create: `scripts/ps-346-rate-order-slow-paths-guard.ts`
- Modify: `package.json`
- Modify: `docs/ps-tickets/ps-ledger.md`

- [ ] **Step 1: Add the guard script**

Guard requirements:

```text
settings-json helper exists and avoids multi-row settings upsert
rate browse workflow types/store/service exist
rates route exposes workflow start/status endpoints
RateBrowserModal uses workflow hook for explicit live browse
OrdersView uses refresh coordinator for rate-job polling
no frontend rate ranking/proof/business imports are introduced
PS-346 findings doc exists
PS-346 ledger row exists
```

- [ ] **Step 2: Wire package script**

Add:

```json
"test:ps-346-rate-order-slow-paths": "tsx scripts/ps-346-rate-order-slow-paths-guard.ts"
```

- [ ] **Step 3: Update ledger**

Add PS-346 to `docs/ps-tickets/ps-ledger.md` with status `In progress` and the Trello URL `https://trello.com/c/CcZRrJsH`.

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm run test:ps-346-rate-order-slow-paths -- --no-color
npm run test:ps-340-backend-rate-engine -- --no-color
npm run test:ps-345-rate-loading-sot -- --no-color
npm run test:ps-333-hugrab-current-rate-sot -- --no-color
npm run test:ps-320-v2-api-client-transport -- --no-color
npm run test:ps-321-ratebrowsermodal-thin-ui -- --no-color
npm run test:ps-rate-limiter-priority-behavior -- --no-color
```

Expected: all PASS.

- [ ] **Step 5: Run build checks after implementation**

Run:

```bash
npm run typecheck
npm run build:web
```

Expected: both PASS.

## Final Acceptance

PS-346 is not complete until evidence shows:

- Rate Browser open is cache/display-only.
- Explicit Browse/Refresh returns useful backend-owned partial state instead of blank/spinner-only waiting.
- Final selected rate, proof, house/customer fields, freshness, and carrier account identity are backend-owned.
- Orders refreshes are single-flight/latest-wins with reason/count diagnostics.
- Print Queue selected count is per-run, not cumulative across runs.
- Batch send reports per-order success/blocker reasons and does not fail the whole batch for legitimate individual blockers.
- No stale/unproven rate can buy a label.
- No shipped/cancelled protections are weakened.
