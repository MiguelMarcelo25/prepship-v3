# PS-051 - Wire Insurance and Confirmation Into Rates + Labels Across ShipStation and Direct Carrier Connectors

Created from DJ handoff on 2026-06-01.

Status: New standalone task. This is separate from PS-050; PS-050 owns rate performance, freshness, and autostart. PS-051 owns shipping-option correctness and parity.

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Assignee: `<@714064895963955211>`

## Context

DJ asked whether the Insurance controls in the Orders side panel affect label cost, and whether changing Confirmation from the default Delivery to Signature or Adult Signature affects the displayed rate and final label purchase.

Current inspection findings:

- Orders side-panel state has `panelForm.insurance` and `panelForm.insuranceValue`, but those values appear to be UI-only right now. They were not observed in rate requests, label DTOs, queue payloads, backend label creation, or direct-carrier label payload paths.
- Confirmation is partially wired:
  - `OrdersView.tsx` defaults confirmation to `delivery`.
  - Changing confirmation can trigger `refreshPanelBestRate(...)`.
  - `src/routes/rates.ts` accepts `confirmation` / `signature`.
  - `src/services/rates.ts` normalizes confirmation, includes it in ShipStation `/v2/rates/estimate`, includes it in the cache key, and totals `confirmation_amount`.
  - `src/lib/shipstation/labels.ts` sends confirmation during ShipStation label creation.
- Confirmation is not consistently applied everywhere:
  - Some queue/batch flows hardcode `confirmation: 'delivery'`.
  - Direct carrier rate calls forward `confirmation`, but direct carrier connectors do not consistently map confirmation into provider-specific API payloads.
- Insurance is not implemented end-to-end:
  - `src/services/labels.ts` `CreateLabelInputDto` lacks insurance provider/value fields.
  - `src/lib/shipstation/labels.ts` lacks insurance fields in the ShipStation label payload.
  - Direct carrier endpoints/connectors do not consistently receive or map insurance.

## Core Invariant

A rate shown as current/selectable must be priced with the exact same shipment options used to buy the label.

Do not allow UI-only state, saved-rate reuse, queue defaults, or connector defaults to drift from label-purchase behavior.

## Normalized Option Contract Required

Introduce and thread a single normalized shipping-options contract through rate shopping, saved-rate validity, label purchase, queue/batch label creation, and direct carrier connectors.

At minimum it must include:

- `confirmation`: canonical value, for example `delivery`, `signature`, `adult_signature`, plus `none` only if intentionally supported.
- `insuranceProvider` or `insurance.provider`: `none`, `carrier`, `shipsurance`.
- `insuredValue` or `insurance.insuredValue`: numeric declared/insured value.
- Existing rate fingerprint fields: ship date, weight, dims, package, destination, residential flag, carrier/account/service set, store/client/source credential.

## Inspect First

- `web/src/components/Views/OrdersView.tsx` - side-panel form state, confirmation dropdown, insurance dropdown/value, `refreshPanelBestRate`, `createOrQueueLabel`, queue/batch payload builders, saved best-rate checks.
- `web/src/components/RateBrowserModal.tsx` - rate request construction and selected-rate application.
- `web/src/lib/v2-apiClient.ts` - `translateRatePayloadToV4`, `fetchRates`, `browseRates`, `fetchDirectCarrierRates`, `createLabel` direct-carrier routing.
- `src/routes/rates.ts` - request schema, `/rates`, `/rates/browse`, cached lookup behavior.
- `src/services/rates.ts` - `RateInput`, `normalizeRateConfirmation`, `rateCacheKey`, ShipStation `/v2/rates/estimate` body, rate totals, saved/cache/fingerprint behavior.
- `src/services/labels.ts` - `CreateLabelInputDto`, `CreateBatchLabelInputDto`, label creation, batch creation.
- `src/lib/shipstation/labels.ts` - ShipStation label payload construction.
- `api/carriers/rates.ts` - direct-carrier rate endpoint payload and connector dispatch.
- `api/carriers/labels.ts` - direct-carrier label endpoint payload and connector dispatch.
- Carrier connector files:
  - `src/connectors/types.ts`
  - `src/services/carrier-connector-orchestrator.ts`
  - `src/connectors/carrier/shipstation.ts`
  - `src/connectors/carrier/ups.ts`
  - `src/connectors/carrier/easypost.ts`
  - `src/connectors/carrier/shipengine.ts`
  - `src/connectors/carrier/walmart-shipping.ts`
  - `src/connectors/carrier/shipp.ts`
  - any FedEx/USPS/eBay/Amazon direct connectors that advertise `rates.quote` or `labels.create`.

## Implementation Requirements

### 1. Shared Normalized Shipping Option Model

- Add a typed/shared normalized model for confirmation and insurance options used by rates and labels.
- Do not keep provider-specific option logic scattered in `OrdersView`.
- Normalize aliases consistently: Delivery, Signature, Adult Signature, and related variants.
- Reject or diagnose invalid combinations instead of silently downgrading.

### 2. Frontend Wiring

- Orders side-panel Insurance dropdown and insured value must be included in rate requests and label purchase payloads.
- Confirmation changes must invalidate/refresh the currently displayed best rate using the selected confirmation option.
- Insurance changes must also invalidate/refresh the displayed best rate when insured value/provider changes.
- Rate Browser must receive and apply the same options.
- Selected/applied rates must persist enough metadata to prove which confirmation/insurance options produced the price.
- Queue and batch label creation must not hardcode `confirmation: 'delivery'` when the order, panel, or selected rate has different requirements.
- Queue/batch flows must include insurance options when present.

### 3. ShipStation Rate Path

- Include normalized confirmation and insurance options in ShipStation `/v2/rates/estimate` request bodies using ShipStation's supported payload shape.
- Include confirmation plus insurance provider/value in rate cache keys and fingerprints.
- Rate totals must include `confirmation_amount`, `insurance_amount`, and other relevant charges.
- Saved best-rate reuse must be invalid/stale when confirmation or insurance differs from the current request.

### 4. ShipStation Label Path

- Extend label DTOs and service payloads to include normalized insurance provider/value.
- `src/lib/shipstation/labels.ts` must send confirmation and insurance into ShipStation label creation using the correct ShipStation payload fields.
- Label purchase must use the exact options from the selected/displayed rate.
- If the user changes confirmation/insurance after a rate was selected, require a refresh or mark the displayed rate stale before buying.

### 5. Direct Carrier Architecture

- Pass the normalized option contract through direct-carrier endpoints and orchestrator.
- Provider-specific mapping belongs in `CarrierConnector` implementations, not in `OrdersView` or generic API endpoints.
- Update `CarrierConnector`/carrier input types as needed so each connector receives the same normalized options.
- Each direct connector that supports rates/labels must explicitly handle or explicitly reject the requested options.
- Unsupported options must return a clear per-carrier diagnostic, for example `adult_signature is not supported by Walmart Shipping for this order/carrier`.
- Direct carrier rate and label paths must agree: if a connector quotes with signature/insurance, label creation must buy with signature/insurance; if it cannot, it must block before showing/buying an inaccurate rate.

### 6. Direct Connector Coverage

- Wire supported option mapping in the appropriate connector files, not generic UI code:
  - UPS: map confirmation/signature and declared/insured value into UPS rating and shipment payloads if supported.
  - EasyPost: map confirmation/signature/insurance into EasyPost shipment/rate/buy payloads if supported.
  - ShipEngine/ShipStation-like direct connectors: map options into their native rate/label payloads.
  - Walmart Shipping/Shipp/eBay/Amazon/FedEx/USPS connectors: support what the carrier/API supports; otherwise return explicit diagnostics.
- Add a connector capability/support matrix in code/tests if helpful so UI can explain unsupported options.

### 7. Persistence And Source Of Truth

- Persist selected rate metadata for confirmation and insurance options.
- Persist or expose enough shipping-model data so re-opening an order panel shows what options are selected/current.
- Do not weaken canonical shipping field rules.
- Do not overwrite shipped/cancelled rows except through existing safe shipped/label flows.

## Guardrails / Forbidden Changes

- Do not buy real postage in tests.
- Do not create real labels, notify marketplaces, or mutate live orders without explicit DJ approval.
- Do not expose secrets, tokens, raw credentials, raw provider payloads with PII, label PDFs, or cross-client data in logs/tests/output.
- Do not weaken auth, RBAC, client scope, source-of-truth, financial redaction, or shipped/cancelled lockdown.
- Do not silently treat unsupported insurance/signature options as `delivery`/`none`.

## Required Tests / Verification

### Unit / Contract Tests

- Normalized shipping options parse/validate aliases correctly.
- Rate cache/fingerprint changes when confirmation changes.
- Rate cache/fingerprint changes when insurance provider/value changes.
- Saved best-rate validity fails when confirmation/insurance differ from current request.

### ShipStation Mocked Route / Service Tests

- ShipStation rate request includes selected confirmation and insurance.
- ShipStation label request includes selected confirmation and insurance.
- Rate total includes confirmation and insurance charges.

### Direct Carrier Connector Tests

- Connector input receives normalized options.
- UPS/EasyPost/ShipEngine supported mappings appear in provider payloads where supported.
- Walmart/Shipp/other unsupported option combinations return explicit diagnostics instead of silently ignoring.
- Rate quote and label create use matching option payloads.

### Frontend / Browser Workflow Tests

- In Orders side panel, changing Confirmation from Delivery to Signature/Adult Signature refreshes or invalidates the displayed rate.
- Selecting Insurance and entering insured value refreshes or invalidates the displayed rate.
- Create + Print / Queue sends the same confirmation and insurance options used by the selected/displayed rate.
- Rate Browser opened from the order panel uses the same options.

### Minimum Commands

- `npm run typecheck`
- `npm run build:web`
- `npm run guard:source-of-truth`
- Focused tests added for this task, with exact commands reported back.
- `npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line`
- `npm run test:orders-ux:browser`

## Definition Of Done

- Insurance dropdown/value affects displayed rates whenever the selected provider supports insurance.
- Confirmation dropdown affects displayed rates for ShipStation and all supported direct carriers.
- Label purchase uses the exact same confirmation/insurance options used to produce the selected/displayed rate.
- Queue/batch label flows preserve order/panel/selected-rate confirmation and insurance options instead of hardcoding defaults.
- Saved rates are considered stale when confirmation or insurance options differ.
- Provider-specific carrier logic lives in `CarrierConnector` implementations or provider-specific service helpers, not scattered in UI/generic endpoints.
- Unsupported options produce visible diagnostics and block inaccurate purchase/rate display when needed.
- All required verification passes without live postage or marketplace notifications.

## Return Format

Reply with:

1. Summary of files changed.
2. Confirmation/insurance normalized model added/changed.
3. Carrier-by-carrier support matrix: ShipStation, UPS, EasyPost, ShipEngine, Walmart Shipping, Shipp, and any other touched connector.
4. Exact behavior for unsupported options.
5. Exact commands run and pass/fail results.
6. Screenshots or concise UI evidence for Orders side-panel and Rate Browser behavior if browser tests are run.
7. Explicit statement that no real labels/postage/marketplace notifications were created unless DJ explicitly approved them.
