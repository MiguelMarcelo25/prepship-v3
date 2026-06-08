# PS-108 Phase 1 — Authoritative ShipStation source for ParcelGuard billed cost

> Status: **source identified from documented ShipStation v2/v1 contracts + existing
> PrepShip read helpers. Live read-only confirmation against `se-292074298` is still
> pending** (the implementing environment has no live ShipStation credentials and must
> not buy postage). The enricher (Phase 2) is built provider-agnostic so the confirmed
> field can be pinned without touching the selection pipeline. See
> `src/services/shipping-workflow/insurance-cost.ts`.

## Observed case (seed)

| Field | Value |
|---|---|
| HUGRAB order | `#1247` |
| Local order id | `1203003` |
| ShipStation shipment | `se-292074298` / `292074298` |
| Service | USPS Ground Advantage |
| Weight / dims | 35 oz, 12 × 10 × 3 |
| PrepShip stored/displayed label cost | `$6.67` (postage only) |
| ShipStation UI billed **Total Cost** | `$7.76` |
| Difference (ParcelGuard premium) | `$1.09` |
| `insurance_provider` (v2 shipment) | `parcelguard` |
| `packages[0].insured_value` (v2 shipment) | `{ amount: 100, currency: 'usd' }` |

The `$1.09` is the **observed calibration point only**. It appears in this repo solely
inside Phase-4 test fixtures (`scripts/ps-108-*-guard.ts`). It is **not** a runtime
constant — runtime reads the premium from the sources below or marks the rate
unresolved.

## Endpoints evaluated (read-only)

All shapes below are taken from the typed ShipStation contracts already in this repo
(`src/lib/shipstation/types.ts`, `src/lib/shipstation/labels.ts`) plus the documented
ShipStation v2/v1 APIs. Requests are read-only `GET`s; none create or void labels.

### ✅ Primary (authoritative billed breakdown): `GET /v2/labels/{label_id}`

Sanitized request:

```
GET https://api.shipstation.com/v2/labels/{label_id}
api-key: <redacted>
```

Sanitized response fields that matter (`src/lib/shipstation/types.ts` `Label`):

```jsonc
{
  "label_id": "se-...",
  "shipment_id": "se-292074298",
  "shipment_cost":  { "amount": 6.67, "currency": "usd" },   // postage
  "insurance_cost": { "amount": 1.09, "currency": "usd" },   // <-- ParcelGuard premium
  "voided": false
}
```

- **`insurance_cost.amount` is the ParcelGuard premium.** `shipment_cost.amount` is
  postage. Final billed total = `shipment_cost + insurance_cost` = `$7.76`.
- This is a **per-label** breakdown, so it is the most precise authoritative source for
  a purchased label. It is what the Phase-3 backfill prefers when a `label_id` is known
  (PrepShip can resolve it via the stored shipment or `ssListRecentLabels()`).

### ✅ Secondary (billed, when only the numeric shipment id is known): `GET /v1/shipments/{shipmentId}`

Already wrapped by `ssGetShipmentV1()` (`src/lib/shipstation/labels.ts:303`):

```jsonc
{
  "shipmentCost": 6.67,   // postage
  "otherCost":    1.09,   // <-- ParcelGuard billed as "other cost" in v1
  "voided": false
}
```

- In the **v1** model insurance is folded into `otherCost`, so billed total =
  `shipmentCost + otherCost` = `$7.76`.
- Used by the backfill as a fallback when the v2 `label_id` is not resolvable but the
  numeric ShipStation shipment id (`labelShipmentId`) is.

### ⚠️ Not authoritative for premium — do not trust: `GET /v2/shipments/se-{id}`

```jsonc
{
  "insurance_provider": "parcelguard",
  "packages": [ { "insured_value": { "amount": 100, "currency": "usd" } } ],
  "amount_paid":   { "amount": 0 },   // observed 0 while UI showed $7.76
  "shipping_paid": { "amount": 0 }    // observed 0
}
```

- Correctly confirms **eligibility** (`insurance_provider`, `insured_value`) — use it
  for that, and only that.
- `amount_paid` / `shipping_paid` were **`0`** in a read-only test while the UI showed
  `$7.76`. **Do not derive billed cost from this endpoint** unless a future live test
  proves these fields populate consistently across affected shipments.

### ⚠️ Not final for premium at rate time: `POST /v2/rates/estimate`

This is the per-carrier quote PrepShip already issues (`fetchEstimateForCarrier`,
`src/services/rates.ts`). With `insurance_provider=parcelguard` + `insured_value=100`
in the body it returned `insurance_amount: { amount: 0 }` for the observed route.

- **The estimate omits the ParcelGuard premium.** PrepShip must therefore **not** treat
  the estimate total as final for an insured HUGRAB ground rate. Phase 2 enriches the
  estimate before best-rate selection (or blocks the rate if the premium cannot be
  proven).

## Why pre-purchase needs a model, not a billed read

The two authoritative sources above (`/v2/labels/{id}`, `/v1/shipments/{id}`) only exist
**after** a label is purchased — they need a `label_id` / `shipment_id`. **Best Rate runs
before purchase**, so there is no shipment to read. At rate time the only honest options
are:

1. Trust a **non-zero** `insurance_amount` if ShipStation ever returns one in the
   estimate (provenance `shipstation_estimate`).
2. Use a **backend-owned ParcelGuard premium resolver** — a configurable schedule, not a
   magic constant — to compute the premium from `insured_value` (provenance
   `parcelguard_schedule`). The schedule is validated in tests against the `$100 → $1.09`
   calibration and is intended to be confirmed/replaced with the live billed value.
3. If neither yields a provable premium → mark the rate **`insuranceCostUnresolved`** and
   **exclude it from best-rate selection** (PS-108 requirement #6 — never silently fall
   back to raw postage).

The billed reads (#1/#2 above) remain the authority for **reconciliation** (Phase 3
backfill) and for **calibrating** the schedule.

## Chosen source matrix

| Phase | Context | Source | Field | Provenance |
|---|---|---|---|---|
| Rate (pre-purchase) | estimate returns non-zero insurance | `/v2/rates/estimate` | `insurance_amount.amount` | `shipstation_estimate` |
| Rate (pre-purchase) | estimate returns 0, schedule configured | backend ParcelGuard schedule | `premium(insured_value)` | `parcelguard_schedule` |
| Rate (pre-purchase) | premium cannot be proven | — | (none) | `unresolved` → rate blocked |
| Backfill (post-purchase) | `label_id` known | `GET /v2/labels/{label_id}` | `insurance_cost.amount` | `shipstation_v2_label` |
| Backfill (post-purchase) | only numeric shipment id | `GET /v1/shipments/{id}` | `otherCost` | `shipstation_v1_shipment` |

## Live-confirmation checklist (for DJ / whoever has credentials)

Run read-only against `se-292074298` and paste sanitized results to pin the field:

1. `GET /v2/labels/{label_id}` → confirm `insurance_cost.amount == 1.09`.
2. `GET /v1/shipments/292074298` → confirm `otherCost == 1.09`.
3. `GET /v2/shipments/se-292074298` → confirm `amount_paid`/`shipping_paid` (expect they
   may still be `0`; this validates the "do not trust" note).

Once confirmed, set the ParcelGuard schedule (or pin the proven field) per
`src/services/shipping-workflow/insurance-cost.ts` — no change to the rate-selection
pipeline is required.
