# PS-405 Shopify Shipping feasibility report

Date: 2026-07-15  
Branch: `prepshipv4-stable`  
Reviewed commit: `e84513026bbe343955b62eabccf5bf2bd0fcaf15`  
Shopify Admin API version reviewed: `2026-07`

## Decision

**Feasibility: conditional yes for an approved implementation; no-go for live production enablement today.**

Shopify's Admin GraphQL API can purchase one Shopify Shipping label for one eligible
fulfillment order through the shop's own Shopify account. This supports the business goal of
having HUGRAB, rather than DR PREPPER, own the postage charge. PrepShip already has a guarded
backend adapter, replay/mock proof, asynchronous purchase polling, shipment persistence, and a
Print Queue delegation path.

The current path must not be treated as production-approved until all gates in this report are
closed. In particular, PrepShip does not yet have authoritative Shopify postage cost, explicit
payment-owner persistence/Billing treatment, a purchased-label rate proof, a documented label
cancel/refund API, or a real eligible HUGRAB fulfillment-order proof. No live canary is part of
PS-405.

## Official API evidence

- [`shippingLabelPurchase`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/shippingLabelPurchase)
  requires `write_orders`, requires the authorized user to have `buy_shipping_labels`, and
  requires the shop to accept the Shopify Shipping terms of service. It validates an eligible
  fulfillment order, address, origin, package, weight, customs data, and available rate before
  starting an asynchronous purchase.
- The purchase input requires a `fulfillmentOrderId` and `shippingDatetime`; it accepts package,
  weight, origin, customer-notification, and preferred carrier/service inputs.
- [`ShippingLabelPurchaseResult`](https://shopify.dev/docs/api/admin-graphql/latest/objects/ShippingLabelPurchaseResult)
  requires `read_orders` to poll. It provides the operation ID, terminal status, errors, and
  purchased labels. Status progresses from `PENDING_PURCHASE` to `PURCHASED` or
  `PURCHASE_FAILED`.
- [`ShippingLabel`](https://shopify.dev/docs/api/admin-graphql/latest/objects/ShippingLabel)
  provides a Shopify label ID, tracking data, printable shipping documents, and a `cancellable`
  flag. The documented object does not expose the purchased postage amount or currency.
- Shopify creates fulfillment orders automatically. They are retrieved from the order and are
  filtered by the app's fulfillment-order scopes; see
  [`fulfillmentOrder`](https://shopify.dev/docs/api/admin-graphql/latest/queries/fulfillmentorder).
- If label purchase does not create the fulfillment, Shopify documents
  [`fulfillmentCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate)
  as the operation that fulfills the selected fulfillment order(s) with tracking. It requires an
  applicable write fulfillment-order scope and the user permission `fulfill_and_ship_orders`.
- [`fulfillmentCancel`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCancel)
  cancels a fulfillment and reopens fulfillment work. It is not documented as cancelling a
  shipping label or refunding postage.

## Required HUGRAB access

### Shopify permissions and setup

Required for label purchase and result retrieval:

- App access scopes: `write_orders` and `read_orders`.
- Shopify user permission: `buy_shipping_labels`.
- Shop setup: HUGRAB must have accepted the Shopify Shipping terms of service.

Required for the current HUGRAB merchant-managed fulfillment-order workflow:

- `read_merchant_managed_fulfillment_orders` to retrieve eligible fulfillment orders.
- `write_merchant_managed_fulfillment_orders` and user permission
  `fulfill_and_ship_orders` if PrepShip performs the separate fulfillment step.

The current PrepShip readiness policy additionally requires `read_draft_orders` because the
shared Shopify Rates spike reads draft-order delivery options. That is a current PrepShip
integration requirement, not the documented minimum for `shippingLabelPurchase` itself.

The access-scope endpoint can prove token scopes. The current readiness check reports, but does
not programmatically prove, the user's `buy_shipping_labels` permission or TOS acceptance. Those
remain explicit operator checks until Shopify exposes a reliable read API or an approved canary
returns conclusive evidence.

### Required identity and shipment fields

PrepShip must resolve these values without guessing from display order numbers:

- Local PrepShip order ID, client ID, store ID, and source-account ID.
- Shopify shop/account identity.
- Shopify Order ID (REST numeric ID and/or GraphQL GID).
- Shopify Fulfillment Order GID and its eligibility/location/remaining-line state.
- Package dimensions, weight, ship date, destination, origin, and customs data when required.
- Shopify purchase-result GID and terminal status.
- Shopify label GID, tracking number/URL, PDF document URL/format, carrier, and service.
- Authoritative postage cost, currency, and cost source.
- Explicit postage payment owner and payer account.
- Shopify fulfillment GID/status after confirmation.
- Label cancellation eligibility, cancellation/refund operation ID, refund amount/status, and
  timestamps if Shopify later exposes a supported path.

Direct Shopify-sourced orders already carry source/store identity, and the purchase workflow
refreshes fulfillment-order context from Shopify before purchasing. An order imported only as a
ShipStation order is not eligible unless the Shopify source account and native Shopify order ID
are deterministically mapped and persisted. Order number matching must never be the authority.

## Current PrepShip proof

The existing implementation provides useful spike evidence without requiring a live purchase:

- `src/services/shopify-shipping-labels.ts` owns the provider key, feature gate, scope and
  fulfillment-order eligibility, purchase input, and non-printable mock result.
- `src/connectors/store/shopify.ts` owns Shopify request/response translation for purchase,
  asynchronous polling, label document/tracking parsing, readiness, and Shopify fulfillment.
- `src/services/labels.ts#createShopifyShippingLabelForOrder` owns order/client scope,
  shipped/cancelled safety, duplicate-label locking, live fulfillment-order refresh, purchase,
  polling, and shipment persistence.
- The persisted shipment snapshot currently includes provider, fulfillment-order ID,
  purchase-result ID, label ID, tracking URL, provider account, and raw provider result.
- `src/services/print-queue.ts` recognizes a Shopify label request and delegates purchase to the
  backend label workflow before passing the returned label URL through the normal queue URL
  validation and durable queue write.
- `src/services/fulfillment/outbox.ts` owns durable confirmation dedupe/retry state. The Shopify
  connector checks for active fulfillment orders before creating a fulfillment and treats an
  already-fulfilled order as success.
- `scripts/ps-405-shopify-shipping-spike-guard.ts` proves the disabled feature gate, required
  source/scopes/fulfillment-order ID, exact empty-fulfillment blocker, no-postage mock result,
  no-network hard gate, replayed asynchronous purchase result, and readiness wiring.

This is implementation evidence, not permission to enable the live flag or buy postage.

## Source-of-truth placement

- **Business workflow:** choose and purchase a HUGRAB-paid Shopify Shipping label, persist the
  purchased label truth, queue its document, and fulfill Shopify exactly once.
- **Canonical purchase owner:** `src/services/labels.ts` must remain the label orchestration and
  final pre-postage safety boundary.
- **Provider policy/input owner:** `src/services/shopify-shipping-labels.ts`.
- **Provider translation owner:** `src/connectors/store/shopify.ts`; it must not own Billing,
  payment-owner, cross-provider rate ranking, or persistence policy.
- **Purchased shipment owner:** the `shipments` record plus durable provider-operation/audit
  state. Provider IDs and terminal results must survive process/cache loss.
- **Print Queue owner:** `src/services/print-queue.ts`; the frontend sends intent and displays
  status only.
- **Fulfillment owner:** `src/services/fulfillment/outbox.ts` plus the Shopify store connector.
- **Billing owner:** the backend Billing generator/read model, using persisted payment-owner and
  purchased-cost facts. The frontend must not infer ownership from provider names.
- **Earliest imperfect-data boundaries:** Shopify/store import identity, live fulfillment-order
  lookup, access scopes/permissions, purchase response, missing cost, and asynchronous result
  persistence.
- **Wrappers to forbid:** no frontend Shopify purchase/rate/payment-owner logic; no route-level
  purchase decision; no order-number-only Shopify identity resolver; no zero-cost fallback
  presented as authoritative postage; no generic ShipStation void for Shopify labels.

## Production gaps found

### 1. Purchased rate and cost are not authoritative

The public purchase result and label object reviewed here do not expose cost. The local adapter
therefore returns `cost: null`, while the shipment workflow currently persists zero and records
`unavailable_from_shopify_admin_api`. Zero is not a safe substitute for an unknown real charge.

The shared Shopify Rates path currently exposes checkout delivery options, explicitly reports
that Shopify label rates are unavailable, and has a backend quote snapshot type. However, the
current Shopify label-create route does not accept/validate `shopifyRateQuoteId` and
`selectedRateKey`, does not pass `preferredRateSelection`, and returns both fields as null. Thus
Shopify would choose its default rate, and PrepShip could not prove the selected/purchased cost.

Production must fail closed or place the shipment in Billing review until an authoritative cost
source is captured. A live canary may help identify a Shopify transaction/billing endpoint, but
it must not redefine checkout shipping as postage cost.

### 2. Payment owner is not persisted explicitly

Provider/source account identifies where the label came from but is not an explicit accounting
fact. Add a backend-owned shipment-level classification such as:

- `postagePaymentOwner = client`
- `postagePayerAccount = HUGRAB Shopify account`
- `postageProvider = shopify_shipping`
- `postageCostStatus = known | pending | unavailable | refunded`

Billing must use that classification so Shopify-paid postage is not reimbursed to or charged as
DR PREPPER-paid postage. The classification should be stamped at successful purchase and frozen
into generated Billing line-item evidence.

### 3. Pending purchase state is cache-backed

The asynchronous purchase snapshot is currently stored through the analytics cache. A purchase
operation that can spend money needs a durable operation ledger/idempotency record before the
provider call, with the Shopify purchase-result ID stored before polling. A process crash or
cache eviction must never make an uncertain purchase look safe to retry.

### 4. Account readiness is still conditional

The latest documented sample returned no fulfillment orders. That can mean the sampled order is
not eligible, the order is already fulfilled, location/routing is incomplete, the order did not
originate in the expected HUGRAB Shopify workflow, or the app lacks the applicable fulfillment
scope. A real eligible HUGRAB order and account permission set remain unproven.

## Billing and margin design

- `C. Shipping Rate` remains the customer-paid shipping amount from Shopify/order source of
  truth. Shopify label purchase must not overwrite it.
- Selected/purchased Shopify postage remains visible for audit and margin analysis when an
  authoritative cost becomes available.
- Shopify-paid postage is a client-paid/client-owned cost, not a DR PREPPER reimbursement.
- HUGRAB owns the Shopify shipping margin by default unless the commercial contract explicitly
  says otherwise. DR PREPPER service or handling fees remain separate Billing lines.
- Unknown Shopify postage is `unknown/pending`, never authoritative `$0.00`.
- Refunds must reverse the same client-paid cost state without creating a DR PREPPER credit.

## Print Queue behavior

The queue path is architecturally viable and already delegates to the backend label workflow.
Production behavior should be:

1. Accept only an operator intent for a Shopify-sourced, scoped order.
2. Re-check order safety, fulfillment-order eligibility, durable purchase idempotency, account
   permission, and selected-rate authority in the backend immediately before purchase.
3. Poll the Shopify purchase result to terminal success or store a durable pending operation.
4. Persist the shipment/provider IDs and payment-owner/cost state before queueing.
5. Queue only a validated printable HTTPS label document. Never queue the mock URL or a pending
   result.
6. Reuse the existing shipment/queued label on retry; never repurchase because queueing failed.

The offline guard proves shape and delegation, not that a real Shopify document URL remains
downloadable by the print worker. That needs a separately approved canary or a captured/replayed
document fixture that complies with Shopify's terms.

## Fulfillment and duplicate-confirmation behavior

The reviewed `shippingLabelPurchase` documentation describes label purchase, not fulfillment
creation. Therefore the safe design is to treat purchase and fulfillment as separate operations:

1. Persist the terminal purchased label and tracking once.
2. Enqueue one fulfillment outbox event keyed to the order and shipment.
3. Immediately before `fulfillmentCreate`, re-read the target fulfillment order.
4. If it is already fulfilled/closed, settle idempotently without another mutation.
5. Otherwise create one fulfillment with the purchased tracking information.
6. Persist the Shopify fulfillment GID and success state so retry cannot double-confirm.

The current outbox and Shopify connector already provide dedupe and an active-fulfillment-order
check. Production approval still requires an offline workflow test that proves the purchase path
and fulfillment path cannot both confirm the order, plus one separately approved real canary if
DJ wants end-to-end evidence.

## Void, cancel, and refund behavior

The 2026-07 `ShippingLabel` object exposes `cancellable`, but the reviewed public Admin GraphQL
documentation does not identify a shipping-label cancellation/refund mutation. This is an
evidence-based limitation, not proof that no Shopify-internal or future API exists.

Current PrepShip behavior is safely fail-closed: the generic void policy routes a
`shopify_shipping` shipment to that provider, but no Shopify Shipping carrier void capability is
registered, so the void returns `not_supported` and keeps the local label active. Do not dispatch
it to ShipStation and do not mark it locally voided.

`fulfillmentCancel` must not be used as a postage-refund substitute; it cancels a fulfillment,
not the shipping label. Until Shopify documents and the team verifies a label-specific API,
operators must cancel/refund in Shopify Admin and reconcile the result manually. A production
follow-up must document time limits, refund timing, native IDs, and webhook/polling state before
automating any local void transition.

## Go-live gates and follow-up tasks

1. Verify the HUGRAB app token has the required read/write scopes; verify the operator has
   `buy_shipping_labels` and `fulfill_and_ship_orders`; verify Shopify Shipping TOS acceptance.
2. Prove deterministic Shopify order and fulfillment-order identity for the actual HUGRAB import
   path. Add a Shopify sync/mapping change if HUGRAB orders currently arrive only through
   ShipStation.
3. Put Shopify purchase behind the same durable provider-operation/idempotency boundary as other
   money paths, including uncertain-result recovery.
4. Make the label purchase consume a backend-issued, unexpired Shopify label-rate selection, or
   explicitly obtain approval for Shopify default selection. Capture authoritative purchased
   cost/currency before Billing treats the shipment as complete.
5. Add explicit shipment payment-owner/cost-status facts and update the backend Billing generator
   so client-paid Shopify postage is never treated as DR PREPPER-paid postage.
6. Add boundary tests for unknown-cost fail-closed behavior, payment owner, retry-after-timeout,
   PDF queueing, fulfillment dedupe, and unsupported void behavior.
7. Confirm Shopify's supported label cancellation/refund workflow with current official support
   or documentation; keep automatic void disabled until proven.
8. Only after gates 1-7, request separate DJ approval for one named low-risk HUGRAB canary order.
   Record the purchase result, account charged, label document, tracking, fulfillment result,
   Billing classification, and cancellation/refund findings without exposing credentials.

## Verification and safety record

Focused repository verification for this report is recorded below after execution:

- `npm run test:ps-405-shopify-shipping-spike` — PASS (mock/replay only)
- `npm run test:shopify-store-connector` — PASS (mock/replay only)
- `npm run test:shopify-order-sync` — PASS
- `npm run test:ps-406-shopify-rates-labels` — PASS
- `npm run test:sot-guard-pack` — PASS (37/37 guard commands)
- `npm run typecheck` — PASS
- `npm run build:web` — PASS

PS-405 performed no live Shopify/provider request, label or postage purchase, fulfillment,
customer/marketplace notification, void/refund, production database write, or shipped/cancelled
mutation. No credential or token was read, printed, stored, or changed.
