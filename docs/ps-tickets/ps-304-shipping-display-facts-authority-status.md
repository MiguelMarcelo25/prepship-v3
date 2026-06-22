# PS-304 Shipping display facts authority status

Date: 2026-06-22

## Current status

Current completion estimate: PS-304 86%.

PS-304 is improved but not Final Review-ready yet. The backend owns the package
facts, carrier/service display tuple, account display tuple, and
provider-account identity exposed on the Orders row workflow DTO. The frontend
now prefers `bestRateWorkflow.display.accountNickname` for the shipping account
column, but older account candidates still exist as compatibility fallbacks for
payload skew and need final cutover review.

This does not complete PS-166 or PS-258. Those broad OrdersView decomposition
cards still need DOM/byte-equality certification before larger extraction work.

## Evidence now wired

- `test:ps-205-package-facts-precedence`
- `test:ps-301-row-workflow-authority`
- `test:ps-304-shipping-display-facts-authority`
- `test:ps-305-authority-drift`
- `test:ps-306-ordersview-parity-cutover`

## What is proven

- `resolvePackageFactsFromInputs` is the pure backend owner for package fact
  precedence and never mixes fields across source rungs.
- `withOrderRowWorkflow` emits a backend display tuple containing carrier code,
  service code, account nickname, and provider account id.
- Orders row DTOs feed canonical package, carrier, account, and provider facts
  into the backend workflow owner before returning rows.
- The frontend carrier, service, and account readers prefer the backend display
  tuple when present.
- Frontend package/weight/dimension and account fallbacks remain compatibility
  fallbacks only, not business authority.

## Missing before Final Review

- Audit or remove the remaining frontend account compatibility fallback path, or
  explicitly accept it as payload-skew-only debt in PS-306.
- PS-306 extraction/parity work must remain separate from this card.
- Trello move/comment only after explicit `task update`.

## Safety

This proof is offline-only. It does not run labels, buy postage, mutate queues,
call providers, send marketplace notifications, update production orders, or
mutate shipped/cancelled data.
