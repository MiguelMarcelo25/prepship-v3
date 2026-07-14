# Audit 5.3 - PO Box eligibility axis

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** A destination identified as a US
  Post Office Box must not select or purchase an UPS/FedEx service, while USPS
  and non-PO-Box destinations retain their existing eligibility.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/shipping-workflow/address-classification.ts` owns the pure PO
  Box address fact. `src/lib/shipping-service-eligibility.ts` owns the carrier
  allow/deny decision. Rate, cache, saved-rate, and label boundaries consume
  those facts without re-deriving the rule.
- **Current duplicated/unsafe owners:** No canonical PO Box axis exists. Raw
  street text can reach provider rate requests while eligibility sees only
  client/store identity, so UPS/FedEx rows can enter cache, Best Rate, saved
  proof, or label purchase.
- **Where bad/stale/incomplete data can enter:** Marketplace/store sync payloads,
  recipient overrides, and manual rate requests first supply raw street lines.
  Missing street text stays unknown/non-PO-Box; a broad match on any word
  `box` would incorrectly block rural-route boxes, PMBs, and Boxwood addresses.
- **Callers that must delegate to the owner:** Order-backed Rate Browser,
  background backfill, cache fingerprint/filtering, saved Best Rate checks,
  and the final label purchase guard must carry the backend-classified PO Box
  fact into the shared eligibility policy.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Frontend PO
  Box detection, provider-specific regex copies, eligibility inferred only from
  ZIP, coarse cache reuse across PO/non-PO destinations, and label purchase
  paths that omit the address axis are forbidden.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend changes. Existing backend eligibility reasons remain the display
  contract.
- **Backend boundary tests required:** Pure classification covers `PO Box`,
  punctuation/spacing variants, `Post Office Box`, street line 2, and false
  positives. Eligibility proves UPS/FedEx blocked and USPS/non-PO unchanged.
  Fingerprint proof requires a PO/non-PO cache miss.
- **Workflow/UI proof required:** Backfill and order-backed browse pass the
  authoritative street line; saved-rate and label boundaries recheck the same
  policy. Focused, PS-127/276, PS-057/079/313, label, lockdown, strict
  typecheck, production build, and SOT guards pass.

## Scope decision

The PO Box axis is derived on every request from the effective destination
street lines, so migration `0048` and the residential/commercial evidence cache
remain unchanged. The axis does not override residential/commercial
classification. It recognizes explicit USPS PO Box forms only; private mailbox
(`PMB`) and rural-route box forms are intentionally not classified as PO Boxes.

Per the current-conversation user override `unlock shipped data`, final label
eligibility may read an awaiting order's effective recipient before any
provider call. Existing shipped/cancelled locks remain earlier and unchanged.
No shipment history or terminal order data is mutated by this work.
