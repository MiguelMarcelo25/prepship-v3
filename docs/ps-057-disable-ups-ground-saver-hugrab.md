# PS-057 - Disable UPS Ground Saver/SurePost for HUGRAB Orders

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: `prepshipv4-stable`
Status: New standalone task.

## Copy/Paste Codex Prompt

You are working in PrepShip V4.

Task ID: PS-057
Title: Disable UPS Ground Saver/SurePost for HUGRAB Orders
Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: `prepshipv4-stable`

## Context

DJ wants UPS Ground Saver disabled for HUGRAB orders. This is client-specific shipping service eligibility, not a global removal of Ground Saver unless existing rules already block it for another reason. HUGRAB orders should not auto-select, display as selectable, queue, batch, or buy labels using UPS Ground Saver / SurePost services.

Current repo clues from review:

- HUGRAB is already referenced in package-default / ShipStation sync docs as a client with shipping-specific behavior.
- Rate Browser currently maps these UPS economy services:
  - `ups_ground_saver` => UPS Ground Saver
  - `ups_surepost` => UPS Ground Saver
  - `ups_surepost_1_lb_or_greater` => UPS Ground Saver (1 lb+)
  - `ups_surepost_less_than_1_lb` => UPS Ground Saver (<1 lb)
- `web/src/components/RateBrowserModal.tsx` still has a local `isBlockedRate(_rate)` stub returning false, with comments saying per-client block-list logic should eventually be extracted instead of fattening the component.
- Existing historical parity docs/scripts show Ground Saver/SurePost has moved between blocked/unblocked states before, so this needs a client-scoped immutable rule and tests.

## Core Invariant

For HUGRAB orders only, UPS Ground Saver / UPS SurePost must be unavailable everywhere a label service can be chosen or purchased. The system must not choose it as best rate, show it as selectable in Rate Browser, retain it as a saved selected/best rate, or allow label purchase/queue/batch with it.

## Blocked Services

Treat these service identifiers as blocked for HUGRAB at minimum:

- `ups_ground_saver`
- `ups_surepost`
- `ups_surepost_1_lb_or_greater`
- `ups_surepost_less_than_1_lb`
- any provider service name/display name containing `UPS Ground Saver` or `SurePost`
- direct UPS numeric Ground Saver/SurePost service codes, if present in direct connector payloads, such as `92` / `93` or equivalent provider-specific codes after verification

## Files To Inspect First

- `src/services/rates.ts`
  - `RateInput`
  - service filtering / `isBlockedRate` / rate cache key / best-rate selection
  - ShipStation rate response normalization and `invalid_rates` handling
- `src/routes/rates.ts`
  - `/rates` and `/rates/browse` request schemas
  - client/store/order context passed to services
- `web/src/components/Views/OrdersView.tsx`
  - side-panel passive best-rate refresh
  - selected/best-rate freshness checks
  - create/print/queue/batch payload builders
- `web/src/components/RateBrowserModal.tsx`
  - local `isBlockedRate` stub
  - displayed/hidden unavailable rates
  - selected/applied rate handling
- `web/src/lib/v2-apiClient.ts`
  - rate request payload shape and selected-rate/label payloads
- `src/services/labels.ts`
  - `CreateLabelInputDto` / `CreateBatchLabelInputDto`
  - label purchase and batch creation validation
- `api/carriers/rates.ts` and `api/carriers/labels.ts`
  - direct-carrier rate/label paths
- `src/connectors/types.ts`
- `src/services/carrier-connector-orchestrator.ts`
- `src/connectors/carrier/shipstation.ts`
- `src/connectors/carrier/ups.ts`
- Existing guards/tests:
  - `scripts/smoke-shipstation-parity.ts`
  - `scripts/verify-ground-saver-fix.ts`
  - `scripts/shipping-certification-guard.mjs`
  - `web/e2e/orders-column-integrity.spec.js` or maintained Orders/rate browser specs

## Implementation Requirements

1. Add a client-scoped service eligibility rule.
   - Implement a single shared helper/model for service eligibility instead of scattering HUGRAB checks across UI components.
   - The helper must receive enough context to decide: client id/client name/store/order context plus carrier/service code/name.
   - HUGRAB matching must be robust and source-of-truth based. Prefer canonical client id/config/settings when available; if matching by name is necessary, normalize case/spacing and document why.
   - The rule should return a structured reason, e.g. `HUGRAB does not allow UPS Ground Saver/SurePost`.
   - Do not hardcode this only in `RateBrowserModal`. UI should consume backend/contract eligibility when possible.

2. Apply the rule to all rate-shopping paths.
   - Passive side-panel best-rate calculation must exclude HUGRAB Ground Saver/SurePost.
   - Rate Browser must not allow HUGRAB Ground Saver/SurePost to be selected/applied.
   - If hidden/unavailable rates are shown, they must be visibly unavailable with a clear reason, not recommended/selectable.
   - Saved/cached rates that are Ground Saver/SurePost for HUGRAB must be considered stale/invalid and not reused as current selected/best rate.
   - Rate cache/fingerprint or validity checks must include any relevant service-eligibility version so old Ground Saver cached rows cannot keep winning for HUGRAB.

3. Apply the rule to all label-purchase paths.
   - Backend label creation must reject HUGRAB + Ground Saver/SurePost before buying postage.
   - Queue mode, Create + Print, and batch label flows must reject or re-rate rather than purchasing Ground Saver for HUGRAB.
   - Direct-carrier label path must also reject HUGRAB + Ground Saver/SurePost before provider calls.
   - Error must be operator-readable, e.g. `UPS Ground Saver is disabled for HUGRAB orders. Choose UPS Ground or another service.`

4. Preserve non-HUGRAB behavior.
   - Do not globally remove Ground Saver/SurePost for other clients unless another existing rule already does so.
   - Do not block normal UPS Ground, UPS 2nd Day Air, UPS Next Day Air, USPS, etc. for HUGRAB unless a separate explicit rule exists.
   - Do not break the PS-051 insurance eligibility work: Ground Saver/SurePost can still be insurance-ineligible independent of this HUGRAB-specific service ban.

5. Preserve source-of-truth behavior.
   - Identify how HUGRAB is represented in the Orders/rates flow: clientId, clientName, storeId, rate source client, or another canonical field.
   - Ensure the same identity reaches backend rates, backend label purchase, and direct-carrier endpoints.
   - If any path lacks client context, fix the payload/context plumbing rather than adding UI-only blocking.

## Guardrails

- Do not buy real postage in tests.
- Do not create real labels, void labels, reissue labels, notify marketplaces, or mutate shipped/cancelled orders.
- Do not delete/rewrite shipment history, order history, rate history, or billing records.
- Do not weaken auth/RBAC/client/store scope/source-of-truth/shipped-cancelled lockdown/secret redaction/financial redaction.
- Do not make this a purely frontend filter. Backend must enforce before purchase.
- Do not silently downgrade Ground Saver to another UPS service without operator visibility or an explicit selected/refreshed rate.

## Required Verification

1. Unit/contract tests prove:
   - HUGRAB + `ups_ground_saver` is blocked.
   - HUGRAB + `ups_surepost` is blocked.
   - HUGRAB + `ups_surepost_1_lb_or_greater` is blocked.
   - HUGRAB + `ups_surepost_less_than_1_lb` is blocked.
   - HUGRAB + service display/name containing Ground Saver/SurePost is blocked even if provider code differs.
   - HUGRAB + UPS Ground / UPS 2nd Day Air remains allowed.
   - Non-HUGRAB + Ground Saver remains allowed unless another existing global rule blocks it.

2. Rate path tests prove:
   - HUGRAB passive best-rate excludes Ground Saver/SurePost and chooses next valid service.
   - HUGRAB Rate Browser either hides or marks Ground Saver/SurePost unavailable and prevents apply/select.
   - Saved/cached HUGRAB Ground Saver/SurePost rate is invalidated and not reused.

3. Label path tests prove:
   - HUGRAB Create + Print rejects Ground Saver/SurePost before provider purchase.
   - HUGRAB Send to Queue rejects Ground Saver/SurePost before provider purchase.
   - HUGRAB batch label creation rejects Ground Saver/SurePost before provider purchase.
   - Direct-carrier label path rejects HUGRAB Ground Saver/SurePost before provider purchase.

4. Browser/workflow coverage:
   - Use mock/fixture HUGRAB order where provider returns Ground Saver plus at least one allowed UPS/USPS option.
   - Confirm Ground Saver cannot be selected/applied and the next valid service is used/recommended.
   - Confirm operator-visible explanation is shown.

5. Run at minimum and report exact output:
   - `npm run typecheck`
   - `npm run build:web`
   - `npm run guard:shipping-certification`
   - `npm run test:ps-051-shipping-options`, if present/maintained, because this overlaps shipping option/rate-label parity
   - new focused HUGRAB Ground Saver service-eligibility tests
   - relevant Orders/Rate Browser browser test, e.g. `npm run test:orders-ux:browser` or the closest maintained Playwright spec that exercises rate selection

## Definition Of Done

- HUGRAB orders never auto-select, display as selectable, queue, batch, or buy UPS Ground Saver/SurePost.
- Backend enforcement prevents purchase even if frontend state is stale or manually crafted.
- Non-HUGRAB Ground Saver behavior is preserved unless separately blocked by existing global rules.
- Old saved/cached HUGRAB Ground Saver rates cannot continue as current selected/best rates.
- Operator sees a clear reason when a HUGRAB Ground Saver/SurePost rate is blocked.
- All required tests/guards/browser checks pass without live postage/marketplace notifications.

## Return Format

Reply with:

1. Summary of files changed.
2. How HUGRAB identity is detected and where the source of truth lives.
3. Exact blocked service identifiers/names/codes.
4. Where backend enforcement happens for rates and label purchase.
5. What the UI shows in Rate Browser / Orders side panel.
6. Exact commands run and pass/fail results.
7. Confirmation that no real labels/postage/marketplace notifications or shipped/cancelled mutations occurred.
