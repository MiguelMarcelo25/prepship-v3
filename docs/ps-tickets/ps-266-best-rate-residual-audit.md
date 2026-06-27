# PS-266 - Post-SOT Best Rate residual audit

PS-266 does not create a new Best Rate source of truth. It is a residual audit
over the current source-of-truth work from PS-313, PS-319, PS-320, PS-321,
PS-326, PS-327, PS-328, PS-330, PS-333, PS-334, and PS-335.

Current finding: No new unowned gap found. No duplicate broad implementation is
needed. Any future issue must be opened as a narrow card tied to the exact
boundary that owns it.

## Residual audit scope

The audit checks that Awaiting row, Rate Browser, Recalculate, Apply Best Rate,
Create Label, and Print Queue consume the same backend-selected Best Rate or
block clearly when the backend proof is incomplete, stale, ineligible, or
live/canary-only.

It also checks the card's residual risk list: HUGRAB-disabled/automation-disabled
services, marked-up customer charge, insurance, confirmation, account scope,
service eligibility, and cached/saved rate freshness.

## Canonical owner map

| Concern | Canonical owner | PS-266 classification |
| --- | --- | --- |
| Cross-carrier Best Rate selection, priced-rate filtering, second-best rate, and completion | `src/services/rates-combined.ts`, `src/services/rates.ts` | already covered |
| Awaiting row Best Rate DTO and package/rate display verdicts | `src/services/shipping-workflow/best-rate-workflow-dto.ts`, `src/services/shipping-workflow/order-row-package-facts.ts`, `src/services/order-rate-dto.ts` | already covered; PS-328-owned for warning copy |
| Rate Browser response proof/ref stamping | `src/routes/rates.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | already covered |
| Selected-rate proof, account binding, and retry classification | `src/services/shipping-workflow/rate-fingerprint.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | already covered |
| Rate money display basis, house/customer charge, markup, insurance, confirmation, and rate cost facts | `src/services/shipping-workflow/rate-money.ts`, `src/services/rates-combined.ts`, `src/services/order-rate-dto.ts` | already covered |
| Create Label final safety and provider purchase boundary | `src/services/labels.ts#createLabelV2` | already covered; live/canary-only for real postage proof |
| Print Queue missing-label creation and queue retry reporting | `src/services/print-queue.ts`, `src/routes/print-queue.ts` | already covered; PS-330-owned for flag/canary cutover |

## Imperfect data injection points

| Injection point | Current owner response | PS-266 classification |
| --- | --- | --- |
| Provider payloads with missing, zero, or partial rates | `isPricedRate`, `rateTotal`, `combineCarrierUniverses`, carrier diagnostics, and `bestRateComplete` decide whether a rate can become authoritative. | already covered |
| Direct-carrier or ShipStation account scope drift | Carrier identity and account binding are guarded by PS-326 plus selected-rate proof checks before purchase. | already covered |
| HUGRAB-disabled/automation-disabled services | Backend eligibility and automation rules stay in the rate workflow and label preflight; frontend only displays the verdict. | already covered |
| marked-up customer charge, insurance, confirmation, and other carrier amounts | These amounts are normalized before ranking/proof and preserved in backend DTOs. | already covered |
| cached/saved rate freshness | Snapshot/ref validation, row package facts, and PS-328 copy distinguish expired/out-of-date rates from package-change assumptions. | PS-328-owned |
| Browser-applied rate intent | Rate Browser passes backend `rateQuoteId`, `selectedRateKey`, `selectedRateProof`, and `secondBestRate`; it does not declare official Best Rate. | already covered |
| Live label purchase, marketplace notification, or canary-only workflow confidence | PS-330 owns the live/canary approval matrix. PS-266 does not run live side effects. | PS-330-owned; live/canary-only |

## Residual workflow matrix

| Workflow | Evidence | Classification | Follow-up |
| --- | --- | --- | --- |
| Awaiting row | Consumes backend row DTOs and backend stale/rerate facts. The Best Rate Final column remains display-only over backend values and PS-334 evidence. | already covered | None |
| Rate Browser | `/rates/browse` delegates to `combineCarrierUniverses` and `finalizeBestRateWithQuote`; `RateBrowserModal` passes backend proof/ref fields through apply state. | already covered | None |
| Recalculate | Recalculate consumes the same backend Best Rate response and persists only backend complete/finalized results. | already covered | None |
| Apply Best Rate | Backend apply route/authority remains covered by PS-302 and PS-319; frontend sends intent plus backend-issued rate fields. | already covered | None |
| Create Label | `createLabelV2` calls `assertLabelPurchaseRateSelection` before direct-carrier or ShipStation purchase branches. | already covered | None |
| Print Queue | Worker delegates missing-label creation to `createLabelV2`; retry eligibility comes from `classifyLabelPurchaseRetry`. | already covered; PS-330-owned for flag cutover | None |
| HUGRAB-disabled/automation-disabled services | Backend service/account eligibility and HUGRAB policy guards cover exclusion from authoritative Best Rate. | already covered | None |
| marked-up customer charge / insurance / confirmation | PS-313/PS-327/PS-333/PS-334 evidence keeps ranking and display on backend-owned rate money fields. | already covered | None |
| cached/saved rate freshness | PS-328 owns stale/expired copy and package-facts invalidation; stale saved rates block instead of silently buying. | PS-328-owned | None |
| live/canary-only confidence | PS-330 owns exact DJ approval requirements for real labels, provider calls, and marketplace notifications. | PS-330-owned; live/canary-only | None |
| new unowned gap | No current unowned residual gap was proven by this audit. | new unowned gap: none found | None |

## Evidence commands

Required residual audit evidence:

- `test:ps-266-best-rate-residual-audit`
- `test:rate-source-of-truth`
- `test:ps-319-rate-convergence-certification`
- `test:ps-320-v2-api-client-transport`
- `test:ps-321-ratebrowsermodal-thin-ui`
- `test:ps-326-carrier-account-identity-certification`
- `test:ps-327-hugrab-margin-policy`
- `test:ps-328-rerate-warning-reason`
- `test:ps-330-controlled-canary-certification`
- `test:ps-333-hugrab-current-rate-sot`
- `test:ps-334-house-rate-column`
- `test:sot-guard-pack`
- `npm run typecheck -- --pretty false`
- `npm run build:web`

## Verification status

| Command | Status | Notes |
| --- | --- | --- |
| `npm run test:ps-266-best-rate-residual-audit` | Pass | Initial red run failed until this audit document existed; final guard passed. |
| `npm run test:rate-source-of-truth` | Pass | Rate source-of-truth guard. |
| `npm run test:ps-319-rate-convergence-certification` | Pass | Convergence predecessor. |
| `npm run test:ps-320-v2-api-client-transport` | Pass | API transport/pass-through predecessor. |
| `npm run test:ps-321-ratebrowsermodal-thin-ui` | Pass | Rate Browser thin UI predecessor. |
| `npm run test:ps-326-carrier-account-identity-certification` | Pass | Carrier/account identity predecessor. |
| `npm run test:ps-327-hugrab-margin-policy` | Pass | HUGRAB policy predecessor. |
| `npm run test:ps-328-rerate-warning-reason` | Pass | Re-rate warning reason predecessor. |
| `npm run test:ps-330-controlled-canary-certification` | Pass | Live/canary matrix predecessor. |
| `npm run test:ps-333-hugrab-current-rate-sot` | Pass | HUGRAB current-rate SOT predecessor. |
| `npm run test:ps-334-house-rate-column` | Pass | House-rate/Best Rate Final predecessor. |
| `npm run test:sot-guard-pack` | Pass | Guard-pack predecessor. |
| `npm run typecheck -- --pretty false` | Pass | Repo typecheck. |
| `npm run build:web` | Pass | Web build. |

## Safety

This audit is read-only/offline only. It performs No real labels, No postage, No marketplace notifications, No production order mutations, and No shipped/cancelled mutations.
It does not alter shipped/cancelled locked paths, does not run SQL updates/deletes, and does not call live provider, marketplace, or postage APIs.
