# v2 → v4-stable Parity Port — Parallel Plan

**Goal**: 100% v2 feature parity in v4-stable. Work split across 3 agents (T1 / T2 / T3) with **file-level ownership** to prevent merge conflicts.

**Branch**: `prepshipv4-stable` (keep. Each agent works in a sub-branch: `parity/labels`, `parity/sync-inventory`, `parity/frontend-wiring`. Rebase and merge daily.)

**Ground rules**:
- Each agent edits ONLY files in their column below. If you need to touch a file outside your column, stop and post in `COORDINATION.md`.
- Before committing: run `npm run typecheck` on backend and `npm run build` on frontend.
- Supabase DB is shared — migrations are sequential. T2 owns `drizzle/` filenames; no one else adds migrations.

---

## Agent T1 — Labels & ShipStation label orchestration

**Why first-class**: Cannot ship a single order without this. Biggest gap.

**Owns**:
- `src/routes/labels.ts` (expand)
- `src/services/labels.ts` (expand)
- `src/lib/shipstation/labels.ts` (new if needed)
- `web/src/components/Views/OrdersView.tsx` — ONLY label-related handlers (`handleCreateLabel`, `handleVoidLabel`, `handleCreateBatch`). Do not touch unrelated code in this file.
- `web/src/lib/v2-apiClient.ts` — ONLY label method stubs (search `fetchLabel`, `createLabel`, `voidLabel`, `createBatch`, `returnLabel`).

**Endpoints to port**:
1. `POST /labels/create` — single label from rate_id + order_id
2. `POST /labels/create-batch` — array of `{orderId, rateId}` pairs
3. `POST /labels/:shipmentId/void` — void label
4. `POST /labels/:shipmentId/return` — create return label
5. `GET /labels/:lookup/retrieve` — fetch label URL by shipmentId or orderId
6. `GET /labels/mock/:shipmentId` — dev-only mock (optional)

**DB schema** — extend `src/db/schema/shipments.ts` with:
- `labelUrl`, `labelFormat`, `labelCreatedAt`, `voidedAt`, `rateId` (already partially there; verify each)

**Done when**: clicking "Create Label" on an awaiting order creates a real label in ShipStation, updates `shipments` row, and the tracking # column populates on next poll.

---

## Agent T2 — Sync worker + Inventory ledger + Schema

**Why**: The worker is how fresh data lands. Ledger is how warehouse tracks SKU movements.

**Owns**:
- `src/services/order-sync.ts` (expand — stable already has a skeleton)
- `src/services/inventory.ts` (expand)
- `src/routes/cron.ts` (expand — add per-job endpoints)
- `src/routes/inventory.ts` — ONLY new ledger endpoints (`/inventory/:sku/ledger`, `/inventory/:sku/orders`)
- `src/db/schema/inventory.ts` — add `inventory_ledger` table
- `src/db/schema/index.ts` — re-export new schemas
- `drizzle/` — owns all new migrations (no one else adds one without coordinating)

**Endpoints to port**:
1. `GET /inventory/:sku/ledger` — SKU receipt/adjustment history with paging
2. `GET /inventory/:sku/orders` — orders that contain a given SKU (already partially in `/orders/ids`; consolidate)
3. `POST /cron/sync-orders` (already exists) — extend to call three sub-jobs
4. `POST /cron/sync-shipments` — pull recent shipments from ShipStation
5. `POST /cron/sync-stores` — pull store list (writes to `stores` table if boss's port branch already added it)

**New DB migration**: `inventory_ledger` table — `(id, sku, client_id, delta, reason, reference_order_id?, created_at, created_by?)`.

**Done when**: `curl -H "x-cron-secret: $SECRET" http://localhost:3000/cron/sync-orders` returns `{synced: N, skipped: M}`, and the Inventory view shows a ledger history panel for each SKU.

---

## Agent T3 — Frontend wiring + notImpl resolution

**Why**: 6 `notImpl` stubs mean several UI buttons silently do nothing.

**Owns**:
- `web/src/lib/v2-apiClient.ts` — ALL non-label methods that currently return `notImpl`, empty, or fake data
- `web/src/hooks/v2Hooks.ts` — add new hooks for ledger / shipment status
- `web/src/components/Views/InventoryView.tsx` — wire ledger panel
- `web/src/components/Views/SettingsView.tsx` — wire "Clear cache & resync" button
- `web/src/components/Views/ManifestsView.tsx` — wire form submission + download
- `web/src/components/Views/LocationsView.tsx` — wire setDefault button (backend already exists: `POST /locations/:id/default`)

**Stubs to resolve** (search `notImpl` + `'fake'` + `return []` in v2-apiClient.ts):
1. `fetchShipmentSyncStatus()` → call `GET /sync/status` (T2 adds this)
2. `triggerShipmentSync()` → `POST /cron/sync-shipments` (T2)
3. `clearAndRefetchAllRates()` → `DELETE /rates/cache` (already exists) + `POST /cron/sync-orders`
4. `markOrderShippedExternal()` → `PATCH /orders/:id` with `externallyShipped: true` (backend already supports per boss's port plan)
5. `fetchInventoryLedger()` → `GET /inventory/:sku/ledger` (T2)
6. `fetchInventorySkuOrders()` → `GET /inventory/:sku/orders` (T2)

**Done when**: no method in v2-apiClient.ts calls `notImpl()`. Every UI button does something real.

---

## Sequencing & dependencies

```
Day 1 (parallel):
  T1: start labels backend
  T2: inventory_ledger migration + service
  T3: wire locations setDefault + markOrderShippedExternal (both backend-ready)

Day 2 (parallel):
  T1: finish labels backend + start frontend wiring
  T2: start sync worker endpoints
  T3: wait on T2 for ledger endpoints → in meantime wire Settings "clear cache"

Day 3 (parallel):
  T1: finish label UI flow
  T2: finish sync worker
  T3: wire ledger UI + sync status indicator

Day 4: integration test. Each agent runs:
  - backend typecheck
  - frontend build
  - manual UI walkthrough of their owned views
  Merge all three branches into prepshipv4-stable.

Day 5: bug fix + deploy.
```

---

## Coordination protocol

- `COORDINATION.md` at repo root — each agent posts "starting X", "blocked on Y", "finished Z".
- If an agent needs a file outside their column: post a request, wait for the owner to either grant or do the edit themselves.
- Daily: each agent pushes to their `parity/*` branch. Main agent (T2) rebases each onto `prepshipv4-stable` at end of day.
- No pushing directly to `prepshipv4-stable` during the week — everyone PRs or local-merges through T2.

---

## Out of scope for this port

- dj UI swap (boss's separate handoff doc) — do NOT start until parity hits 100%.
- Additive markup math change — verify current code first, separate task.
- Portal features — explicitly excluded.

---

## Commands to seed the three agents

```bash
# T1
git checkout -b parity/labels prepshipv4-stable

# T2
git checkout -b parity/sync-inventory prepshipv4-stable

# T3
git checkout -b parity/frontend-wiring prepshipv4-stable
```

Each Claude Code session opens in the v4-stable repo, checks out its branch, and reads PLAN.md + COORDINATION.md before starting.
