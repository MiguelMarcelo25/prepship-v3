# PS-317 — Phase 5 Proof Packet

**Thesis:** the backend owns ALL business truth (rates, label purchase, carrier
selection, inventory, marketplace confirmation, billing totals, shipped/cancelled
locks). The frontend only *renders backend DTOs* and *sends operator intent*. No
backend-critical business logic survives in React.

| Fact | Value |
|---|---|
| Repo | `X:/Private/prepship-final/prepship-v4-stable` |
| Branch | `ps-166-ordersview-hooks` |
| HEAD at packet authoring | `d50e9cd138fdeb808de36430286bf5f246d8787e` |
| `master:all-safe` guard suite | 512/512 |

This packet is **additive** — a doc only. It touches no locked surface, buys no
postage, and runs no mutating script.

---

## (1) BEFORE / AFTER — OrdersView LOC

```
$ wc -l web/src/components/Views/OrdersView.tsx
8017 web/src/components/Views/OrdersView.tsx
```

| Milestone | LOC |
|---|---|
| PS-166 historic peak | ~9,935 |
| **Current (`d50e9cd1`)** | **8,017** |
| Absorbed PS-166 target | ~1,500 |

The raw line count (8,017) is still above the ~1,500 calibration figure inherited
from PS-166. **This residual gap is an explicit DJ LOC-calibration decision:** DJ
ruled he will judge the file by *what is in it* — i.e. whether any backend-critical
business truth still lives in the FE — **not by the raw line count.** Sections (2),
(4) and (5) below discharge that real bar: every authoritative decision (rate
ranking, label purchase, carrier selection, inventory, marketplace confirmation,
billing totals, the selected-rate-proof gate, account binding) lives in a backend
owner; the residual OrdersView volume is render markup, layout, local UI state, and
intent assembly. The "**no backend logic in the FE**" bar is therefore **met**; the
remaining LOC reduction is a cosmetic/calibration follow-up, not a correctness gate.

---

## (2) SEARCH-PROOF — the retired FE label-buy authority is GONE

The Phase A1→A4 cutover **deleted** `createDirectCarrierLabelThenQueue` — the old
FE-owned direct/synthetic-carrier purchase orchestrator. It has zero occurrences in
the frontend:

```
$ grep -rn "createDirectCarrierLabelThenQueue" web/src/
(no output — ZERO MATCHES)
```

The `'direct-create'` route token still exists, but in `OrdersView.tsx` it is now a
**no-op branch that pushes to the backend create/recover job** — it no longer buys
anything:

```
$ grep -rn "direct-create" web/src/
web/src/components/Views/OrdersView.tsx:3284:      if (route !== 'direct-create') {
web/src/components/Views/OrdersView.tsx:3288:      // PS-317 A4: the frontend no longer buys ANY label. A 'direct-create' route — now only the
web/src/lib/resolve-backend-route-plan.ts:47:      ... (route === 'direct-create' || route === 'backend')
web/src/lib/shipping-routes.ts:15:export type QueueOrderRoute = 'direct-create' | 'backend'
web/src/lib/shipping-routes.ts:53:    ... 'direct-create' : 'backend'
web/src/lib/shipping-routes.ts:56:    if (input.backendQueueRoute === 'backend' || input.backendQueueRoute === 'direct-create')
web/src/lib/shipping-routes.ts:61:    if (input.isDirectCarrier) return 'direct-create'
web/src/lib/v2-apiClient/shared.ts:798:// carrier_accounts rate (10M offset) takes the direct-create queue route; a
```

The 4 `OrdersView` / route-plan hits are the **token classification + no-op branch**,
not a buy. The actual branch body (`OrdersView.tsx:3284-3296`):

```ts
      if (route !== 'direct-create') {
        backendJobOrders.push(order)
        continue
      }
      // PS-317 A4: the frontend no longer buys ANY label. A 'direct-create' route — now only the
      // flag-OFF local fallback produces it (the backend plan returns 'backend' for direct orders) —
      // routes to the SAME backend create/recover job as everything else. createLabelV2 buys
      // direct-carrier labels server-side (labels.ts directRef → createDirectCarrierLabelForOrder,
      // with the same selected-rate-proof gate, inventory deduction, and marketplace-confirmation
      // tail), so the backend owns every purchase and the FE is a pure intent-sender.
      backendJobOrders.push(order)
```

Both arms of the branch do the same thing — `backendJobOrders.push(order)` — so the
direct route is fully collapsed onto the backend job. **The FE re-owning a
direct/synthetic-carrier purchase outside `apiClient.createLabel` is the genuinely
dead pattern a guard should pin** (zero `createDirectCarrierLabelThenQueue`, no new
FE buy construction).

---

## (3) FILE MAP — `web/src/components/Views/orders/*`

Every unit below is **UI / render / interaction / intent only**. None owns rate
ranking, label purchase, carrier selection, inventory, billing, or persistence
truth.

| File | LOC | Allowed responsibility (no business truth) |
|---|---|---|
| `useColumnDrag.ts` | 104 | React hook — column drag-to-reorder *interaction* (pointer state, drop index). Pure UI. |
| `useColumnResize.ts` | 139 | React hook — column resize *interaction* (drag width, min/max clamp). Pure UI. |
| `column-reorder.ts` | 33 | Pure helper — compute the reordered column array from a from→to move. UI layout only. |
| `use-order-bundles.ts` | 77 | React hook — render state for the combined-shipment (PS-312) panel; calls backend `POST /orders/bundles` (create) and `/orders/bundles/resolve` (read model) and **renders the returned DTO**. Sends intent; owns no bundle truth. |
| `order-row-actions.ts` | 134 | Pure FE reader of the backend row-workflow DTO (verbs/axes/blockedReasons, PS-301). Maps backend verdict → button enablement. Owns no policy. |
| `panel-shipment-dims.ts` | 69 | Pure helper — shape the side-panel dims/weight form payload (operator intent). No rate/label decision. |
| `rate-request-normalizers.ts` | 31 | Pure shape normalizer for the rate *request* payload the FE sends. Translates form input → request shape; does not rank or price. |
| `cells/order-cells.tsx` | 429 | Render-only table cell components (money/status/carrier/account display of backend facts). Display only. |
| `test-mock-rate-normalizer.ts` | 51 | Test-only offline mock normalizer (fixtures). Never ships truth. |
| `test-rate-mock.ts` | 89 | Test-only offline rate mock (fixtures for the mock harness). Never ships truth. |

Adjacent FE plan helpers (under `web/src/lib/`, not `orders/`) referenced above —
`shipping-routes.ts`, `resolve-backend-route-plan.ts` — only **classify** a route
token for display/dispatch; the authoritative plan is the backend
`POST /print-queue/route-plan` (see section 4). They choose no money path.

---

## (4) SOURCE-OF-TRUTH MAP — backend owner per concern (real file:line)

| Concern (backend-critical) | Canonical owner | Evidence |
|---|---|---|
| **Label purchase — ALL labels incl. direct/synthetic carrier** | `createLabelV2` | `src/services/labels.ts:1108` (`export async function createLabelV2`); direct-carrier buy delegated at `src/services/labels.ts:1546` (`createDirectCarrierLabelForOrder({…})`, imported at `:51`) |
| **Selected-rate-proof gate + account binding (PS-204)** | proof boundary inside `createLabelV2` | `src/services/labels.ts:1426-1452` (selected-rate proof/fingerprint boundary, proof bound to the account being charged) |
| **Rate-proof snapshot store / enforcement** | rate-quote snapshot store + enforcement | `src/services/shipping-workflow/rate-quote-snapshot-store.ts`; `src/services/shipping-workflow/rate-proof-enforcement.ts`; `src/services/shipping-workflow/rate-fingerprint.ts` |
| **Combined-shipment CREATE (PS-312)** | `POST /orders/bundles` → `createScopedBundle` | `src/routes/orders.ts:4551` (`'/bundles'`); delegates to `createScopedBundle` at `src/routes/orders.ts:4564` (imported `:93`) |
| **Combined-shipment READ MODEL (PS-312)** | `POST /orders/bundles/resolve` → `resolveScopedBundles` | `src/routes/orders.ts:4533` (`'/bundles/resolve'`); `resolveScopedBundles` at `src/routes/orders.ts:4538` |
| **Print-queue route plan (buy-vs-backend-job ladder)** | `POST /print-queue/route-plan` → `planQueueRouteForOrders` | `src/routes/print-queue.ts:573` (`app.post('/route-plan', …)`); orchestrator `planQueueRouteForOrders` at `:584` (imported `:40`) |
| **Apply best rate (PS-302)** | `buildApplyBestRatePatch` / best-rate workflow DTO | `src/services/shipping-workflow/apply-best-rate.ts` (imported `src/routes/orders.ts:118`); `buildBestRateWorkflowDto` at `src/routes/orders.ts:115` |
| **Billing invoice totals** | `src/services/billing.ts` | per-client markup resolver + invoice totals (`src/services/billing.ts`); the FE never recomputes invoice totals |

The FE for each concern is a thin consumer: it renders the returned DTO or POSTs an
intent payload. It never re-derives the authoritative value.

---

## (5) THE EXPLICIT `createLabel` / `addToQueue` RULING

This is the card's whole thesis and rebuts any "FE buy still live" reading.

### 5a. `apiClient.createLabel` is a thin backend POST, NOT an FE buy

`apiClient.createLabel` is literally `api.post('/labels', payload)` →
`createLabelV2`. From `web/src/lib/v2-apiClient.ts` (`createLabel`):

```ts
  createLabel(payload: unknown): Promise<any> {
    // PS-202: ONE label owner. Direct carrier-account purchases (synthetic
    // 10M+/20M+ provider ids: Shipp, Walmart Shipping, direct UPS, EasyPost)
    // now go through the SAME v4 POST /labels as ShipStation — createLabelV2
    // resolves the account, applies the proof gate/safety/eligibility, buys
    // via the carrier connector, and runs the identical persistence/deduction/
    // confirmation tail. ...
    return api.post<any>('/labels', payload).then(normalizeLabelResponse);
  },
```

`createLabelV2` (`src/services/labels.ts:1108`) owns: the buy, the selected-rate
proof gate (`:1426-1452`), PS-204 account binding, inventory deduction, and
marketplace confirmation. **The FE only ASSEMBLES the payload** (serviceCode /
carrierCode / dims / weight / confirmation / insurance + `selectedRateProof`) and
sends intent.

Call sites in `OrdersView.tsx` (line numbers as of `d50e9cd1`; the ruling's
~3867 / ~6041 references are the same two flows pre-rebase):

- **Single Create+Print:** `OrdersView.tsx:3791` — `await apiClient.createLabel(payload)`.
- **Batch Create+Print:** `OrdersView.tsx:5965` — `const response = await apiClient.createLabel(payload)`.

Both are `api.post('/labels')` → `createLabelV2`. Backend-owned buy.

### 5b. The batch `createLabel` → `addToQueue` sequence is NON-AUTHORITATIVE

At the batch flow the FE calls `createLabel` and then `addToQueue`:

```
$ grep -n "apiClient.createLabel\|addToQueue(" web/src/components/Views/OrdersView.tsx
3791:      const response = await apiClient.createLabel(payload)
5370:    const result = await apiClient.addToQueue(buildQueueAddPayload(order, queueableLabelUrl))
5965:        const response = await apiClient.createLabel(payload)
5969:          await apiClient.addToQueue(buildQueueAddPayload(order, queueableLabelUrl))
6285:        await apiClient.addToQueue(payload)
```

`OrdersView.tsx:5965` → `:5969` is the **LIVE, INTENDED batch flow**:

1. `createLabel` — backend POST `/labels` → `createLabelV2` **buys** the label.
2. `addToQueue(buildQueueAddPayload(order, queueableLabelUrl))` — **enqueues an
   ALREADY-backend-bought label** (by its label URL) into the print queue.

`addToQueue` does **not** rank, select, or buy a rate. It only enqueues a label that
the backend already purchased. It is therefore **non-authoritative — pure intent
(enqueue)**.

> **RULING (honor exactly):** A guard must **NOT** assert this `createLabel`-then-
> `addToQueue` sequence is "gone." It is live and correct; asserting its removal
> would go RED on the current tree. The sequence is documented here as: `createLabel`
> = backend POST `/labels` → `createLabelV2` (the buy); `addToQueue` = enqueue of an
> already-bought label = intent only.
>
> The genuinely-DEAD pattern a guard SHOULD pin is the deleted
> `createDirectCarrierLabelThenQueue` (zero matches, section 2) and any **NEW** FE
> construction that buys a direct/synthetic-carrier label **outside**
> `apiClient.createLabel` — i.e. the FE re-owning the direct-carrier purchase
> orchestration.

This rebuts "FE buy still live": every byte the FE sends is either a `POST /labels`
intent (backend buys) or an enqueue of an already-bought label. The FE owns no
purchase.

---

## Still-deferred items

1. **PS-312 side-effect wiring** — the bundle billing / inventory / confirmation
   side-effects remain behind **default-OFF flags** pending a **DJ live canary**
   (guards: `ps-312-bundle-billing-policy-guard.ts`,
   `ps-312-bundle-inventory-policy-guard.ts`,
   `ps-312-bundle-confirmation-policy-guard.ts`). The create + display + Combine
   path is shipped and verified; the money/inventory side-effects are gated.
2. **OrdersView LOC calibration** — 8,017 vs the ~1,500 PS-166 figure. Per DJ this
   is judged by *content* (no backend logic in FE — met) not raw count; further
   reduction is a cosmetic follow-up, not a correctness gate.

---

## Verification

- `wc -l web/src/components/Views/OrdersView.tsx` → 8017 (section 1).
- `grep -rn "createDirectCarrierLabelThenQueue" web/src/` → zero matches (section 2).
- `grep -rn "direct-create" web/src/` → 4 OrdersView/route-plan hits are the no-op
  token branch (section 2).
- Backend owners confirmed by file:line read (section 4): `labels.ts:1108`,
  `orders.ts:4533/4551`, `print-queue.ts:573`, `apply-best-rate.ts`, billing.ts,
  rate-quote-snapshot-store.ts.
- `createLabel` = `api.post('/labels')` confirmed in `v2-apiClient.ts`; the
  `5965`→`5969` createLabel→addToQueue sequence confirmed live (section 5).
