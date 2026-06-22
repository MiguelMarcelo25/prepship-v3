# PS-291 manual order preview status

Date: 2026-06-22

## Current status

Current completion estimate: PS-291 86%.

PS-291 is not Final Review-ready yet. The manual-order preview implementation
has strong offline code and guard proof, but the card still needs a
DJ-approved runtime manual-order canary before it can move to Final Review.

## Evidence

- `test:ps-291-manual-order-preview`
- `test:ps-291-manual-order-preview-closeout`
- `test:ps-291-manual-order-preview-status`

What is proven:

- Manual orders are real operational orders, not test orders.
- Line items are optional.
- Rate preview uses the operator-selected Ship-From origin instead of a
  hard-coded default ZIP.
- Custom Ship-From origin can be saved through the canonical location owner.
- Marketplace-owned providers are excluded from unsaved manual-order preview.
- Account nickname appears above the service name.
- The selected preview rate is persisted in the canonical best-rate shape.

## Missing

- DJ-approved manual-order runtime/canary proof.
- Read-only evidence that selected origin/rate persist in the deployed workflow.
- Documentation that the canary did not buy postage, print labels, notify
  marketplaces, mutate production queues, repair production data, or alter
  shipped/cancelled data.

## Trello recommendation

Keep PS-291 in progress until DJ approves and observes the manual-order canary.
Do not comment or move the Trello card from this status document alone.

## Safety

This status packet is offline/static. It does not run live labels, buy postage,
print labels, send marketplace notifications, mutate production orders, mutate
production queues, repair production data, or modify shipped/cancelled data.
