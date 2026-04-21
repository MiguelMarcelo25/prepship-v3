# BILLING — Phase 1 audit (v2 → v4-stable)

Read-only gap analysis. v4 is ~60% feature-complete vs v2.

---

## Summary

Core invoice generation + config management work. Advanced workflows (detail drilldown, reference rates, storage fees) are missing. v4's standalone `Invoice.tsx` page is a useful print-friendly alternative but lacks analytics columns.

---

## 1. Frontend gaps

### 1.1 Detail drilldown modal — **missing**
- v2: `BillingView.tsx:264-300` opens inline detail showing per-order line items (order #, ship date, pick/pack, shipping, margins) with toggleable columns
- v4: `Billing.tsx` has no per-client detail expansion; shows summary totals only

### 1.2 Detail columns & analytics — **missing**
- v2: `billing-parity.ts:29-102` defines 14 configurable columns with localStorage persistence (order #, ship date, SKUs, pick/pack, ref rates UPS/USPS, margins)
- v4: no per-order analytics; `Invoice.tsx` shows line items by `lineType` only

### 1.3 Reference-rates workflow — **missing**
- v2: `BillingView.tsx:332-376` has two workflows:
  - **Fetch Ref Rates** — initiates carrier fetch job, polls `/api/billing/fetch-ref-rates/status` every 5s with progress UI
  - **Backfill Ref Rates** — one-shot static backfill
- v4: `POST /billing/fetch-ref-rates` returns `{ status: 'not_implemented' }` stub; no UI

### 1.4 Package pricing "Set Default" — **missing**
- v2: `BillingView.tsx:554-600` shows custom per-client package pricing with Set-Default button
- v4: no pricing table UI (routes exist; frontend missing)

### 1.5 Invoice PDF export — **missing UI (backend ready)**
- v2: "📄 Export" button (line 700) → `GET /api/billing/invoice?clientId=X&from=...&to=...`
- v4 backend: implemented at `src/routes/billing.ts:166-185` (renders HTML) ✅
- v4 frontend: no export button in `Billing.tsx` summary
- **Fix: wire a link pointing to `/invoice?clientId=...&dateFrom=...&dateTo=...`**

### 1.6 Billing config: storage fee + mode fields — **missing**
- v2: `BillingView.tsx:407-528` has 8 config columns including:
  - **Storage $/cu ft** (`storageFeePerCuFt`, step 0.001)
  - **Mode** dropdown (Label Cost vs SS Ref Rate)
  - Additional unit fee
- v4: `Billing.tsx:264-294` only has pick/pack + shipping % + shipping flat

### 1.7 Date-range presets — **missing**
- v2: `BillingView.tsx:609-629` has 4 preset buttons: This Month / Last Month / Last 30 / Last 90
- v4: `Billing.tsx:113-138` has manual date inputs only

---

## 2. Backend gaps

### 2.1 `POST /api/billing/fetch-ref-rates` — **stubbed**
v4 `src/routes/billing.ts:243-250`:
```ts
return c.json({ job_id: null, status: 'not_implemented', message: '...' });
```
Needs actual RateShopper integration + job tracker.

### 2.2 `GET /api/billing/fetch-ref-rates/status` — **shape mismatch**
- v2 returns: `{ running, total, done, errors, startedAt }`
- v4 `src/routes/billing.ts:252-260` returns: `{ status: 'idle', total_ref_rates: count }`
- Missing fields break v2's polling UI

### 2.3 `GET /api/billing/invoice` — **DONE ✅**
Both implemented identically. Frontend just needs button wire-up.

### 2.4 Billing-config schema mismatch (see Section 3)

### 2.5 `/api/billing/details` response shape
- v2 `BillingDetailDto` includes order-level fields, ref rates, margins
- v4 `billingLineItems` has `lineType`, `description`, `qty`, `unitCost`, `totalCost`
- Missing: shipment metadata, ref rates, margin calculations, order details

---

## 3. Schema gaps

### `billing_config` table (`src/db/schema/billing.ts:16-29`) — missing columns

| Field | v2 | v4 | Issue |
|---|---|---|---|
| `billing_mode` | `'label_cost' \| 'reference_rate'` | `'per_shipment'` | **enum mismatch** |
| `storageFeePerCuFt` | ✓ | **missing** | v4 lacks storage billing |
| `storageFeeMode` | ✓ (`'cubicft'`) | **missing** | |
| `palletPricingPerMonth` | ✓ | **missing** | |
| `palletCuFt` | ✓ | **missing** | |

**Critical:** billing mode enum diverges — must be aligned or migrated.

---

## 4. Priority punch list

### Small (1–2h)
1. **Add invoice export link to Billing.tsx summary** — backend ready. Frontend only.
2. **Add date-range preset buttons** — copy v2 logic from `billing-parity.ts:136-160`. Frontend only.
3. **Add `billing_mode` select to config row** — Backend enum fix needed.

### Medium (3–5h)
4. **Detail drilldown modal** — wire summary-row onClick to line-item breakdown. Backend: expand `/billing/details` DTO.
5. **Add `storageFeePerCuFt` config field** — schema migration + UI input.
6. **Package-pricing table UI** — new Card in Billing.tsx wired to existing `/package-prices` routes. Frontend only.
7. **Fix billing_mode enum mismatch** — align v4 with v2 enum (critical for interop).

### Large (6h+)
8. **Reference-rate fetch + polling UI** — buttons, job init, 5s polling, progress display. Backend: replace stub + add job tracker.
9. **Detail analytics view** — standalone or modal showing order-level breakdown with toggleable columns.
10. **Enhance Invoice.tsx analytics columns** — add order #, ship date, ref rates (UPS/USPS), margin %. Backend: extend `/billing/details`.
11. **Storage billing calculation in `src/services/billing.ts`** — cubic-feet × `storageFeePerCuFt`.
12. **Set-Default package pricing workflow** — UI + confirm → `POST /billing/package-prices/set-default`. Frontend only.
13. **Job-status polling parity** — return `{ running, total, done, errors, startedAt }`.
14. **Pallet pricing config (optional v2 feature)** — `palletPricingPerMonth`, `palletCuFt`.
15. **Port v2 billing helpers** — `computeBillingDetailMetrics()`, `buildBillingSummaryTotals()` from `billing-parity.ts`.

---

## 5. Files to touch

**v4 (target):**
- `web/src/pages/Billing.tsx` — tasks 1, 2, 3, 6, 12
- `web/src/pages/Invoice.tsx` — task 10
- `src/routes/billing.ts` — tasks 3, 8, 13
- `src/db/schema/billing.ts` — tasks 5, 7, 14
- `src/services/billing.ts` — tasks 4, 11

**v2 (reference only):**
- `apps/react/src/components/Views/BillingView.tsx`
- `apps/react/src/components/Views/billing-parity.ts`
- `apps/api/src/modules/billing/api/billing-routes.ts`
- `apps/api/src/modules/billing/application/billing-services.ts`

---

## Conclusion

Most critical: **schema mismatch** (`billing_mode` enum + missing storage-fee columns) — this needs resolving before any UI port can be faithful.

Estimated full-parity effort: 40–50 engineering hours.
