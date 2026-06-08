# PS-118 — Source-of-Truth & Canonical Field Audit

**Date:** 2026-06-08 · **Status:** **CERTIFIED (with minor notes)**

This audit verifies, at runtime/code level, that the architecture-first standard
([../../ARCHITECTURE.md](../../ARCHITECTURE.md)) is actually followed: every critical
workflow has a **canonical backend owner** (its single source of truth), canonical
fields flow through the right schema → service → DTO boundaries, and the **frontend owns
no backend-critical truth** — it never becomes an alternate source of truth.
It is backed by a machine-checkable certification:

- Spec: [source-of-truth-canonical-fields.json](source-of-truth-canonical-fields.json)
- Check: `npm run check:architecture-source-of-truth` (`scripts/check-source-of-truth-canonical-fields.ts`)

The check FAILS the build if a canonical field/owner/guard disappears from its
authoritative file. As of this audit: **16/16 checks pass (0 P0, 0 P1 failures).**

> Naming note: the repo standardizes on guard/check **scripts** (run via `tsx`), not a
> jest/vitest `tests/architecture/*.test.ts` runner. The certification is therefore
> delivered as `scripts/check-source-of-truth-canonical-fields.ts` + the JSON spec and
> wired as `check:architecture-source-of-truth`. This substitutes for the
> `tests/architecture/source-of-truth-canonical-fields.test.ts` form named in the task.

## Workflow → canonical owner map

| Workflow | Canonical owner (backend) | Canonical schema fields | DTO/API to UI | UI consumer (fetch vs compute) | Fallback risk | Coverage | Severity |
|---|---|---|---|---|---|---|---|
| **Order identity & tenant scope** | `orders` table | `id`, `orderNumber`, `externalOrderId`, `sourceProvider`, `sourceAccountId`, `clientId`, `storeId`, `orderStatus` | order DTO | display only | none — tenant scope enforced by `clientId` in every query | route auth + scope guards | P0 |
| **Order items / SKU / qty** | `order_items` (`UNIQUE(orderId,lineIndex)`); raw `orders.items` is import-compat | `sku`, `name`, `quantity`, `orderId`, `lineIndex` | order item DTO; print `multi_sku_data` | display; PS-109 preserves name | **resolved** — PS-109 stopped the frontend stripping `description` | ps-109, ps-070 | P0 |
| **Package / dims / defaults** | `shipments` (frozen snapshot) | `selectedPackageId`, `dimsL/W/H`, `weightOz` | selected-rate DTO | display | safe | combo/default guards | P1 |
| **Rate shopping / Best Rate / selected-rate proof** | `rate-fingerprint.ts` (`selectedRateAuthorityKey`, `validateExactSelectedRate`, `assertSelectedRateProofForLabelPurchase`) + `rate-quote-snapshot.ts` (`deriveRateQuoteId`, `resolveRateQuoteForPurchase`) | `rate_cache` (`cacheKey`, `rates`, `bestRate`, `diagnostics`) — perf cache only | `order-rate-dto` (`isComplete`, `requestFingerprint`, `rateQuoteId`, `selectedRateKey`) | **consumes** backend `bestRate`; PS-111 made completeness backend-owned | **resolved** — frontend no longer mints proofs (ps-103) or asserts completeness (ps-111) | ps-079, ps-094, ps-103, ps-111 | P0 |
| **Label purchase / direct vs ShipStation** | `labels.ts` `createLabelV2` → `assertLabelPurchaseRateSelection` before real postage | `shipments.selectedRateJson` (frozen) | label result DTO | operator action | safe — purchase requires proof; **reprint/test bypass** is intentional (no postage) | selected-rate-proof-boundary, ps-098 | P0 |
| **Shipment persistence + tracking** | `shipments` table | `orderId`, `clientId`, `trackingNumber`, `labelShipmentId`, `providerAccountId`, `selectedRateJson`, `carrierCode`, `serviceCode`, `cost`, `labelCost`, `otherCost`, `voided` | shipment DTO | display | safe — links to `orderId`/`clientId`, not UI state | shipment-sync guards | P0 |
| **Print Queue durability** | `print_queue_orders` + `print-queue-identity.ts` | `orderId`, `clientId`, `labelUrl`, `skuGroupId`, `primarySku`, `multiSkuData`, `status` | queue DTO | display; `headerCardTitle` for names | safe — durable identity; `UNIQUE(orderId,clientId)` | ps-109, ps-053, durable guards | P1 |
| **Fulfillment outbox / marketplace confirmation** | `fulfillment/outbox.ts` (`enqueueShipmentConfirmation`, `processFulfillmentOutboxOnce`) | `fulfillment_outbox` (`shipmentId`, `orderId`, `provider`, `status`, `dedupeKey`) | confirmation status | display | safe — explicit lifecycle: `pending`/`processing`/`succeeded`/`failed`/`not_required`/`not_supported` | outbox guards | P0 |
| **Inventory deduction / ledger** | `fulfillment-deductions.ts` (`INVENTORY_AUTO_DEDUCT` kill switch) | `inventory_ledger` (`type='ship'`, `orderId`, `inventoryId`) | inventory DTO | display | safe — dedup per `(orderId, inventoryId, 'ship')` prevents double-deduct | inventory guards | P0 |
| **Billing line items** | `billing.ts` (`billingLineItems`) | `clientId`, `orderId`, `shipmentId`, `lineType`, `totalCost` | billing DTO | display | safe — missing shipment cost emits `shipping_missing` $0; does NOT suppress labor/package lines | billing guards | P0 |
| **Client Portal read models** | tenant-scoped queries (`clientId`), auth context `isPortalSession` | `clients` (`storeIds`, `ssApiKeyV2`, `isTest`, `rateSourceClientId`) | portal projections | display | safe — same tables filtered by requesting `clientId`; no alternate owner | scope guards | P0 |

## Canonical field families verified

- **Order identity:** `orders.id`, `orderNumber`, `externalOrderId`, `sourceProvider`/`sourceAccountId`.
- **Tenant scope:** `clientId`, `storeId`, `clients.storeIds`; portal scoping is auth-context, not a separate store.
- **Item identity:** `order_items.sku`/`name`/`quantity`; print `multiSkuData` preserves name (PS-109).
- **Package identity:** `shipments.selectedPackageId`/`dimsL/W/H`/`weightOz`.
- **Rate identity:** `rate-fingerprint` (`cacheKey`, `selectedRateAuthorityKey`), `rateQuoteId`/`selectedRateKey` (snapshot), `isComplete` (backend-owned).
- **Label identity:** `shipments.labelShipmentId`/`labelUrl`/`trackingNumber`/`providerAccountId`/`selectedRateJson`.
- **Print queue identity:** `print_queue_orders.skuGroupId`/`multiSkuData`/`status`.
- **Fulfillment identity:** `fulfillment_outbox.shipmentId`/`orderId`/`provider`/`status`.
- **Inventory identity:** `inventory_ledger.orderId`/`inventoryId`/`type`.
- **Billing identity:** `billing_line_items.shipmentId`/`orderId`/`clientId`.

## UI-owned-truth risks (assessed)

The frontend is a **consumer** for all backend-critical fields. The risks that *would*
be source-of-truth violations are each covered by a dedicated guard:

- Rate fingerprint/proof minting in the UI → blocked by **ps-103** (`selectedRateProof` is backend-issued).
- Best-rate **completeness** decided in the UI → fixed by **ps-111** (backend stamps `isComplete`).
- Frontend picking a divergent best rate → **ps-079** (UI consumes `response.bestRate`).
- Label purchase without backend proof → **selected-rate-proof-boundary** / **ps-098**.

No unsafe UI-owned authoritative truth was found. UI display fallbacks (e.g. carrier
nickname, `Unnamed item`) are presentation-only and cannot be mistaken for certified
backend state.

## Findings (notes, not blockers)

1. **`bestRateJson`/`bestRateAt` live on `order_overrides`, not `orders`** — intentional
   (overrides are the mutable rate layer; `orders` stays the import-stable record). Not a
   violation; documented so the certification points at the right owner.
2. **No dedicated `portal-client/` projection directory** — portal is a tenant-scoped
   *view* of the same tables via auth context (`isPortalSession` + `clientId`), not a
   separate read model. Safe, but worth a future explicit read-model boundary if the
   portal grows.
3. **HUGRAB insured-rate total** is correct only once **PS-108** is confirmed/deployed;
   until then the insured total is enriched from an unconfirmed schedule. Tracked by
   PS-108, not a PS-118 regression.

## Architecture certified / blocked / partial

**CERTIFIED.** All critical workflows have a canonical backend owner; canonical fields
are present at their authoritative schema/service/DTO boundaries; the frontend owns no
backend-critical decision; and the certification check passes 16/16. The three findings
above are notes/follow-ups, not source-of-truth regressions. No P0/P1 gaps.

## How to run

```bash
npm run check:architecture-source-of-truth   # the source-of-truth gate
npm run typecheck
```
