# PS-304 Account display fallback debt acceptance

Date: 2026-06-22

## Decision

PS-304 is Final Review-ready for the package/carrier/account/display facts
authority scope. The backend row workflow DTO owns the display tuple, and the
frontend account display resolver now consumes
`bestRateWorkflow.display.accountNickname` before every older account candidate.

The remaining frontend account-display candidates are accepted as PS-306 cutover
debt. They are compatibility fallbacks for payload skew and older rows only; they
are not allowed to become business authority for carrier/account truth.

## Fallback Debt Mapped To PS-306

- awaiting best-rate nickname
- canonical shipping nickname
- selected-rate nickname
- live label account label
- Shipp brokered display fallback
- V2 static account lookup
- selected-rate `External`
- best-rate nickname
- carrier-code display fallback

PS-306 must review or remove these compatibility paths during the OrdersView
thin-client cutover. PS-304 should not stay blocked on that larger frontend
extraction card.

## Safety

This is an offline authority/debt acceptance packet. It does not run labels,
buy postage, mutate queues, call providers, update production orders, notify a
marketplace, or mutate shipped/cancelled data.
