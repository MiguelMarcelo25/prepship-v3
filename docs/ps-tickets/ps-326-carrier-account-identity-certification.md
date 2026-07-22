# PS-326 — Carrier/account identity certification

PS-326 is a certification layer over existing provider/account identity owners. It does
not create a new provider identity service and does not redo PS-317 direct-carrier Print
Queue cutover. The purpose is to prove that quote -> selected -> label -> queue ->
shipment -> billing -> display preserves the same provider/account identity and uses
display-safe metadata.

## Carrier/account identity SOT owner map

| Boundary | Current owner | Certified responsibility |
| --- | --- | --- |
| Direct-carrier assignment and store-scoped visibility | `src/lib/direct-carrier-scope.ts` | Normalizes provider keys, blocks unassigned direct carriers, and keeps `eBay Shipping` / `Walmart Shipping` store-scoped instead of globally visible. |
| Connector/provider family resolution | `src/connectors/carrier-resolution.ts` | Maps covered provider aliases such as `ShipStation`, `Shipp brokered UPS`, `EasyPost`, `Walmart Shipping`, and `eBay Shipping` to connector families and capabilities. |
| Selected-rate proof account binding | `src/services/shipping-workflow/rate-fingerprint.ts` | Rejects purchase-account mismatch, including synthetic direct-carrier IDs on a ShipStation proof. |
| Quote snapshot purchase boundary | `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | Re-validates account identity for both snapshot and legacy proof paths before label purchase. |
| ShipStation label request shaping | `src/lib/shipstation/label-request-body.ts` | Blocks synthetic `se-10000000+` direct-carrier IDs from the ShipStation label path and supplies the shared provider-dispatch/operation-hash payload shape. |
| Label purchase and shipment snapshot | `src/services/labels.ts#createLabelV2` | Runs proof/account binding before provider branches and freezes provider/account identity onto shipment records. |
| Print Queue route authority | `src/services/print-queue/queue-route-orchestrator.ts` | Classifies direct vs backend queue routing and supports the PS-317 direct-via-backend cutover. |
| Billing / margin read model | `src/services/shipping-margin-analytics.ts` | Reads display-safe `carrierCode`, `serviceCode`, `providerAccountId`, and `providerAccountNickname` from shipment truth. |

## Matrix covered

The guard `npm run test:ps-326-carrier-account-identity-certification` composes the
existing owner guards and direct owner behavior for:

- quote -> selected -> label -> queue -> shipment -> billing -> display identity preservation.
- ShipStation duplicate account identity: same carrier family with distinct provider account IDs and human nicknames.
- eBay Shipping and Walmart Shipping store-scoped visibility: never treated as global direct carriers.
- Shipp brokered UPS and EasyPost connector-family resolution.
- HUGRAB insurance-sensitive paths through the existing proof/account and selected-rate owners, without adding frontend policy.
- Synthetic direct-carrier ID rejection before a ShipStation label request can be built.
- Quote proof -> selected-rate proof -> label purchase -> queue route -> shipment snapshot -> billing/display identity preservation.

## Existing owners reused

- `test:ps-083-direct-carrier-scope`
- `test:shipstation-carrier-account-identity`
- `test:ps-204-account-binding`
- `test:ps-216-rate-browser-account-labels`
- `test:ps-250-rates-scope-enforcement`
- `test:ps-303-print-queue-authority`
- `test:ps-317-fe-buy-anti-regression`
- `test:direct-carrier-queue-route`

These remain the implementation proof for their owner surfaces. PS-326 certifies that the
surfaces line up as a matrix, and only creates/fixes code if the matrix proves a specific
unowned gap.

## Out of scope and safety

- Do not create a second provider identity service.
- Do not redo PS-317 direct-carrier Print Queue cutover.
- Do not hide provider/account bugs in the frontend.
- No real label purchases.
- No raw credentials, API keys, raw labels, provider payloads, or customer PII.
- Do not weaken client/store assignment scope, carrier eligibility, selected-rate proof, or shipped/cancelled protections.
