# PS-209 — Shipping architecture audit (2026-06-13, HEAD 7be37834)

First-slice deliverable for the cleanup track. Owner maps verified by reading
current code on `prepshipv4-stable` (not the Hermes snapshot at a40489ad —
several risk areas moved since; deltas noted).

## 1. Label-purchase owner map

| Path | Owner | Status |
|---|---|---|
| FE Create+Print / Print-to-Queue / batch | `apiClient.createLabel` → **POST v4 `/labels`** → `createLabelV2` (src/services/labels.ts) | ✅ canonical (PS-202; guard `test:ps-202-direct-label-owner`) |
| Queue worker (create/recover-and-queue) | `processQueueSendOrder` → `createLabelV2` in-process | ✅ same owner |
| Direct carriers (shipp/UPS/EasyPost/Walmart/eBay) | `createLabelV2` direct branch → `carrier-connector-orchestrator` | ✅ shared persist/deduction/confirmation tail |
| Proof/account gates | `assertLabelPurchaseRateSelection` + PS-204 account binding + PS-186 test authority, both branches | ✅ |
| **Legacy `api/carriers/labels.ts` (Vercel)** | independent purchase pipeline (own JWT verify, connector calls, persist, outbox kick) | ⚠️ **was REACHABLE**: `vercel.json` rewrites exclude `carriers/`, so `/api/carriers/labels` served the LOCAL function. No current caller (PS-202 pins FE → v4 only), but any stale tab/script could buy postage through a second owner. **→ FIRST SLICE (this PR): blocked as a purchase path — 410 `LEGACY_LABEL_ENDPOINT_RETIRED`, zero purchase imports.** Full file deletion stays PS-200 S5 (gated on DJ's live order test). |

Callers of `/carriers/labels` found: **none** in web/src, src/, scripts (grep
+ existing guard). Sibling `api/carriers/rates.ts` is quotes-only (no
postage) and remains for PS-200 S8.

## 2. Direct marketplace import (Walmart/eBay)

- API pull: StoreConnector orchestrator (`store-connector-orchestrator.ts`,
  `connectors/registry.ts`) ✅ canonical.
- Persistence: `store-order-import.ts` → `upsertNormalizedStoreOrders`
  (+ PS-205 package-facts materialization) ✅ canonical.
- Residual: `src/lib/imported-handlers/{walmart,ebay}-orders.ts` carry
  handler-local query/mirror logic beyond thin delegation (PS-200 S1 mounted
  them v4-side; the Vercel twins persist until S8). **Risk: MEDIUM** —
  follow-up card proposed below.

## 3. Confirmation lifecycle (label → outbox → marketplace)

- Label purchase (both branches) → `ensureShipmentConfirmationLifecycle` →
  `fulfillment_outbox` → `resolveShipmentConfirmationProvider` → provider
  confirm with retry/recovery ✅ canonical.
- **Manual shipped-external** (`services/fulfillment/mark-shipped-externally.ts`,
  PS-136): hardcodes `ssMarkOrderShippedV1` — bypasses the outbox resolver, so
  non-ShipStation sources can get the wrong/no notification and failures are
  log-only (no outbox retry). **Risk: HIGH — this is PS-192** (already
  carded; implementation blocked until DJ types the shipped-data unlock
  phrase, since it is the shipped-transition path).

## 4. Print Queue create+queue

- One backend-owned workflow: `/print-queue/batch-send` →
  `startQueueSendJob` → per-order `processQueueSendOrder` (create/recover
  label, then queue insert in the same worker step; PS-176 route authority +
  recover-existing-label path covers the bought-but-not-queued window).
  PS-191 (this week) removed the FE auto-repurchase loop; PS-195 made clears
  explicitly targeted + in-flight-merge-safe. **Risk: LOW-MEDIUM** — a formal
  atomicity certification (simulated crash between purchase and queue insert
  proving recovery) is the remaining gap → follow-up card.

## 5. PDF/print-job readiness + Confirm-Printed authority

- PS-194 (this week): `successfulEntryIds` persisted on merge jobs + durable
  snapshot; Confirm-Printed gates on backend truth and survives refresh;
  signed-URL PDF flow (PS-065). **Risk: LOW** (resolved this track).

## 6. Workflow certification matrix

- Static guards: green (202/203/204/205/206 + queue/outbox/connector suites +
  shipping-roundtrip cert). Live operator matrix (real direct-carrier canary,
  marketplace confirm observation) still pends DJ's live order test (PS-202
  canary doubles as fixture capture). **Risk: MEDIUM until the canary runs.**

## Risk ranking

| Risk | Area | Action |
|---|---|---|
| ~~HIGH~~ → closed by this slice | Legacy Vercel label endpoint reachable | 410-blocked here |
| HIGH | shipped-external bypasses outbox resolver | **PS-192** (needs unlock phrase) |
| MEDIUM | imported-handler-local Walmart/eBay persistence logic | follow-up card A |
| MEDIUM | live certification matrix unexecuted | DJ canary (PS-202) |
| LOW-MEDIUM | queue create+queue atomicity certification | follow-up card B |
| LOW | confirm-printed/PDF authority | done (PS-194/195) |

## Proposed follow-up cards

- **A — Canonical direct-marketplace persistence owner:** collapse
  imported-handler-local SQL into `store-order-import.ts`; handlers become
  thin validate→delegate; boundary tests on the import owner. Files:
  `src/lib/imported-handlers/{walmart,ebay}-orders.ts`,
  `src/services/store-order-import.ts`.
- **B — Queue create+queue atomicity certification:** mocked crash-window
  test proving a purchased-but-unqueued label is recovered (not re-bought) on
  the next queue attempt. Files: `src/services/print-queue.ts`
  (`processQueueSendOrder`), `src/services/labels.ts` recovery path.
- **C (exists) — PS-211** universal void; **PS-214** universal HUGRAB
  insurance — both sequenced after this audit in the current batch.

## First-slice implementation (this PR)

`api/carriers/labels.ts` → minimal no-import handler returning
410 `LEGACY_LABEL_ENDPOINT_RETIRED` ("label purchases go through the v4
/labels API — refresh PrepShip"). No purchase code remains in the module, so
no second owner exists even for stale clients; reversible by git; the full
api/ deletion remains PS-200 S5/S8 behind DJ's live test. Guard
`test:ps-209-label-owner-slice` pins the block + the absence of purchase
imports + that no client code references the legacy path.
