# PS-339 - eBay API testing certification

Custom Trello source card: https://trello.com/c/gRogisQ0

PS-339 is the PrepShip PS-track version of the custom card "ebay is ready
for api testing". It is a certification ticket, not a new marketplace
confirmation owner and not a live marketplace mutation.

Current finding: eBay is ready for offline/mocked API certification. Live eBay
marketplace confirmation is not run by this ticket and remains blocked until DJ
approves one exact order/shipment/outbox/action with a rollback plan.

## Source of truth

| Concern | Canonical owner | PS-339 status |
| --- | --- | --- |
| eBay connector capability and API translation | `src/connectors/store/ebay.ts` | existing owner |
| Marketplace identity hydration for eBay order id and line items | `src/services/fulfillment/confirmation-payload.ts` | existing owner |
| Confirmation lifecycle, idempotency, retry, and shipment/outbox state | `src/services/fulfillment/outbox.ts` | existing owner |
| Read-only marketplace confirmation inspection | `scripts/smoke-marketplace-confirm.ts` | existing read-only tool |
| Mocked eBay fulfillment API proof | `scripts/ebay-confirmation-mocked-guard.ts` | existing guard |

The frontend does not own eBay confirmation truth. Routes/scripts may inspect or
request a dry-run, but the backend outbox/connector path owns provider dispatch.

## Imperfect data injection points

| Injection point | Current owner response | Classification |
| --- | --- | --- |
| Missing `appId`, `certId`, or refresh token | eBay connector fails safely before fulfillment API calls. | covered |
| Missing tracking number | eBay connector returns a non-retryable validation failure. | covered |
| Missing eBay order id | eBay connector returns a non-retryable validation failure. | covered |
| Missing eBay `lineItemId` payload | confirmation payload owner hydrates from `orders.raw`; connector rejects if still missing. | covered |
| OAuth/provider error containing tokens | eBay connector redacts token-like values before surfacing errors. | covered |
| eBay already-fulfilled / duplicate fulfillment response | eBay connector treats matching 409 conflicts as safe success. | covered |
| 429 or 5xx provider outage | eBay connector marks the failure retryable for the outbox owner. | covered |
| Operator attempts live processing from smoke script | smoke script refuses `--process-once`; only `--mock-process-once` is allowed. | covered |
| Live eBay confirmation | requires exact DJ approval and a reviewed command/path; not run by PS-339. | blocked |

## API testing ladder

1. Static/source guard:
   - `npm run test:ps-339-ebay-api-testing-certification`
2. Mocked connector proof:
   - `npm run test:ebay-confirmation:mocked`
3. Read-only or fixture-only smoke:
   - `npm run smoke:marketplace-confirm -- --mock-process-once`
   - `npm run smoke:marketplace-confirm -- --order-id <id>` for read-only outbox/shipment inspection
4. Surrounding marketplace lifecycle proof:
   - `npm run test:ps-268-marketplace-confirmation-residual-audit`
   - `npm run test:ps-285-marketplace-confirm-boundary`
   - `npm run test:ps-330-controlled-canary-certification`
5. Live eBay canary:
   - Not run by default.
   - Required approval text:
     `DJ approves PS-339 eBay live API test: run <command-or-browser-workflow> for order <id>, shipment <id>, outbox <id>, provider ebay, action <action>, expected side effect <none-or-one-ebay-fulfillment-notification>, rollback <rollback-plan>.`

## Acceptance proof

- The eBay connector requests OAuth with the `sell.fulfillment` scope.
- The eBay connector posts fulfillment to eBay Sell Fulfillment
  `createShippingFulfillment` only after credentials, order id, line items,
  carrier, tracking, and ship date are available.
- Existing mocked guard proves success, missing-data blocks, already-fulfilled
  idempotency, retryability, and token redaction.
- Smoke script remains read-only by default and fixture-only for processing.
- Existing Walmart-only exact retry command is not silently expanded to eBay
  without a separate reviewed live path.
- No live marketplace notification, label purchase, postage, production order
  mutation, shipped/cancelled mutation, billing mutation, or inventory mutation
  occurs in this ticket.
