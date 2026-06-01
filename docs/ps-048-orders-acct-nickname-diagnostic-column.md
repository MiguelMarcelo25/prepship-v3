# PS-048 - Fix Orders Acct Nickname Diagnostic Column Showing Carrier Code

Created from DJ handoff on 2026-06-01.

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Assignee: `Lawrence <@714064895963955211>`

## Safety Baseline

- Read `AGENTS.md` first.
- This task touches shipped-row display logic in `web/src/components/Views/OrdersView.tsx`, which is inside the shipped/cancelled lockdown surface.
- Obey the repo lockdown exactly. Do not bypass it.
- If the coding agent refuses due to lockdown, stop and ask DJ for the repo-required override in the coding thread.
- Keep the change surgical and display-only.
- Do not mutate production data.
- Do not run SQL `UPDATE` or `DELETE` against `shipments` or shipped/cancelled orders.
- Do not create real labels, buy postage, or notify marketplaces.
- Do not expose secrets, tokens, API keys, raw provider payloads, raw labels, or customer PII in logs, screenshots, or tests.
- Do not weaken auth, RBAC, client/store scope, source-of-truth constraints, secret redaction, financial redaction, shipped/cancelled lockdown, or label safety.
- Do not re-enable batch selection or destructive controls on shipped/cancelled Orders views.
- Do not broaden this into a refactor of Orders table rendering.

## Problem

In the Orders table diagnostic columns, the `Acct Nickname` column is showing the carrier code (`ups`) instead of the actual shipping/account nickname.

A mobile screenshot showed diagnostic columns like:

- `Carrier Code` = `ups`
- `Provider ID` = `565377` / `607855`
- `Acct Nickname` = `ups` (wrong)

`Acct Nickname` should display the real account nickname, for example a provider/account nickname such as `ROCEL C81F70`, not the carrier code.

Investigation found this is frontend display logic, not backend data corruption. The bad fallback is in `web/src/components/Views/OrdersView.tsx`:

```ts
function getShippedDisplayAccountNickname(order: OrderSummaryDto) {
  if (getIsExternallyFulfilled(order)) return null
  if (hasV2SelectedRatePayload(order)) {
    const selectedNickname = toStringValue(order.selectedRate?.providerAccountNickname)
    if (selectedNickname) return selectedNickname
  }
  return toStringValue(order.label?.carrierCode)
}
```

That final fallback is wrong: `order.label?.carrierCode` is `ups`, so the account nickname diagnostic column displays `ups`.

This fallback was introduced by commit `03df3d8903953ec43541627dd43b3328f40ce8b8` (`03df3d8`), message `Align shipped table display with v2`, dated 2026-04-28.

The canonical intended source priority is documented in `CANONICAL_ORDER_FIELD_SOURCES.md`: `shipping.accountNickname` should come from selected-rate nickname, `shipments.provider_account_nickname`, best-rate nickname, or derived account lookup. It should not come from carrier code.

## Files And Areas To Inspect First

- `AGENTS.md`
- `web/src/components/Views/OrdersView.tsx`
- `getShippedDisplayAccountNickname`
- `getAwaitingDisplayAccountNickname`
- `getSelectedRateCarrierNickname`
- `getBestRateCarrierNickname`
- `getShipAccountDisplay`
- `case 'test_shippingAccount'`
- `TABLE_COLUMNS` diagnostic labels
- `CANONICAL_ORDER_FIELD_SOURCES.md`
- `src/routes/orders.ts`
- Confirm `shipping`, `canonicalOrder`, `selectedRate`, `bestRate`, and `provider_account_nickname` are already available in the API shape.
- `web/e2e/orders-column-integrity.spec.js`
- If missing locally, pull latest `origin/prepshipv4-stable` first; origin has this file.

## Implementation Requirements

Fix shipped diagnostic account nickname display so it uses account-nickname sources, never carrier-code sources.

Replace the bad fallback in `getShippedDisplayAccountNickname` with this source priority:

1. Canonical `shipping.accountNickname` via `getShippingString(order, 'accountNickname')`
2. `order.selectedRate?.providerAccountNickname`
3. `order.selectedRate?.carrierNickname`
4. Normalized best-rate/canonical nickname via `getBestRateCarrierNickname(order)`
5. `getV2CarrierAccountForOrder(order)?.nickname`
6. `null`

Do not fallback to any of these for `Acct Nickname`:

- `order.label?.carrierCode`
- `order.carrierCode`
- `order.bestRate?.carrierCode`
- `formatCarrierCode(...)`
- Provider/account ID fields

Keep external-label and missing-sync classification intact. Do not regress PS-036 behavior:

- Explicit external shipped rows must remain external-label behavior.
- Shipped rows with no explicit external flag and no local shipment data must remain missing-sync behavior.
- This task only fixes real local shipped rows where account nickname exists but diagnostic display incorrectly falls back to carrier code.

Do not change backend source-of-truth logic unless you prove the frontend lacks the needed data. The investigation indicates the backend already exposes `shipping`, `canonicalOrder`, `selectedRate`, and `bestRate`.

Keep the normal Shipping Account column and the diagnostic `Acct Nickname` column semantically aligned for real local shipped rows.

Expected helper shape:

```ts
function getShippedDisplayAccountNickname(order: OrderSummaryDto) {
  if (getIsExternallyFulfilled(order)) return null
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    normalizeShippingAccountName(getBestRateCarrierNickname(order)) ??
    getV2CarrierAccountForOrder(order)?.nickname ??
    null
  )
}
```

If an existing helper is reused instead of duplicating the source chain, preserve the exact same behavior and make sure no carrier-code fallback remains.

## Testing Requirements

This is an operator-facing Orders table UI regression, so browser E2E coverage is required. Unit/static checks alone are not enough. No live ShipStation/carrier/marketplace calls are required or allowed; use mocked/offline fixtures only.

Update `web/e2e/orders-column-integrity.spec.js` to pin the persisted shipped row diagnostic account nickname.

The test must fail against the current buggy helper and pass after the fix.

For the persisted shipped fixture, assert the diagnostic cells separate the values correctly:

- `test_carrierCode` shows `ups`
- `test_shippingProviderID` shows the provider/account ID, for example `7381` in the fixture
- `test_shippingAccount` / `Acct Nickname` shows the nickname, for example `ROCEL C81F70`
- `test_shippingAccount` does not contain `ups`
- `test_shippingAccount` does not contain `Ext. Label` or `Missing shipment sync`

Keep or extend the existing assertions that external and missing-sync shipped rows remain correctly classified.

If the test fixture lacks `canonicalOrder.sourceMap`, preserve that if useful: it is valuable because the current bug reproduces when `hasV2SelectedRatePayload(order)` is false and the helper falls through to `label.carrierCode`.

## Verification Commands

Run from repo root after implementation:

```bash
npm run typecheck
npm run build:web
npm run guard:source-of-truth
npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line
npm run test:orders-ux:browser
```

If any command fails because the local environment is missing dependencies/browsers, install only what is necessary and rerun. If a command fails due to an unrelated existing blocker, document the blocker with the exact error and still run the focused test if possible.

## Definition Of Done

- Shipped Orders diagnostic `Acct Nickname` shows the real account nickname for persisted local shipments.
- `Acct Nickname` never displays plain carrier code such as `ups` as a nickname fallback.
- Carrier Code, Provider ID, Service Code, normal Shipping Account, external-label, and missing-sync behavior remain correct.
- `web/e2e/orders-column-integrity.spec.js` has regression coverage for this exact bug.
- Typecheck/build/source-of-truth guard/focused Playwright test/orders UX browser test have been run and results returned.
- No live labels/postage/marketplace notifications/production shipped-cancelled mutations were performed.

## Return Format

- Branch name and PR URL, or commit SHA if no PR yet.
- Files changed.
- Summary of the exact code change.
- Before/after behavior for a persisted shipped row.
- Test evidence: each command run with pass/fail result.
- Screenshot or Playwright artifact path for the shipped Orders table if available.
- Confirmation that no secrets/PII/live labels/postage/marketplace notifications/production shipped/cancelled mutations occurred.
- Confirmation that the shipped/cancelled lockdown was obeyed and whether DJ override was required by the coding agent.
