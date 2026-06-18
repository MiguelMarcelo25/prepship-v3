# PS-196 — Cache-first Awaiting Shipment Best Rate display after reload

**Assignee:** Lawrence `<@714064895963955211>`
**Repo:** `drprepperusa-org/prepship-v4` · **Base branch:** `prepshipv4-stable`
**Status:** 🆕 New — from DJ report on 2026-06-10: reloading Awaiting Shipment makes all
Best Rates reload instead of showing saved rates immediately.

## User-reported bug

On Awaiting Shipment, after a page reload, rows that already have saved Best Rates look
like they have to reload/re-rate. This makes caching appear broken. Investigation showed
the database still has saved Best Rates, but most legacy saved rows lack newer
proof/freshness metadata, so the frontend/backend workflow rejects them as not
displayable and falls back to spinner/live re-rate behavior.

## Evidence (read-only DB check, 2026-06-10)

| Metric | Count |
|---|---|
| awaiting orders | 29,292 |
| awaiting with saved `best_rate_json` | 29,150 |
| awaiting without saved `best_rate_json` | 142 |
| saved awaiting rates with `requestFingerprint`/`cacheKey` | 41 |
| saved awaiting rates with `rateQuoteId` | 29 |
| saved awaiting rates with `selectedRateKey` | 29 |
| HUGRAB | 13 awaiting / 13 saved |
| Tran Agency | 8 awaiting / 8 saved |
| eBay - DJC | 4 awaiting / 4 saved |
| Walmart - DJC | 4 awaiting / 4 saved |

## Interpretation

Saved rates are not gone. The display/freshness/proof gating is too strict for page-load
display. It is mixing two different decisions:

1. Can the UI **display** the last saved Best Rate immediately?
2. Can the system **buy postage** or send to Print Queue using that saved rate without a
   fresh backend-issued proof?

## Correct behavior

- Awaiting Shipment should be **cache-first on reload**.
- If an awaiting row has a saved `order_overrides.best_rate_json` with a positive amount
  and enough display metadata, show it immediately in Best Rate / Carrier / Shipping
  Account / Ship Margin instead of spinner-only behavior.
- If that saved rate lacks current proof/fingerprint/freshness metadata, render it as
  **saved/stale/refreshing**, not blank/loading forever.
- Background refresh may re-rate and update the saved rate.
- Label purchase / Print Queue / Create Label must remain blocked or require re-rate
  unless the backend-issued selected-rate proof/fingerprint/`rateQuoteId`/
  `selectedRateKey` is current.
- Do **NOT** weaken selected-rate proof enforcement.

## Architecture-first requirement

Read `AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and
`.github/pull_request_template.md` before coding. Identify the canonical owner/source of
truth before editing. Best Rate selection and quote proof validity are **backend-owned**.
UI should display backend DTO/workflow state and capture intent; it should not become the
authority for label-purchase safety.

## Files/docs to inspect first

- `AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`
- `src/routes/orders.ts` — list payload construction for `overrideBestRate`, `bestRate`,
  `shipping.bestRate`, `bestRateWorkflow`
- `src/services/shipping-workflow/best-rate-workflow-dto.ts` —
  `buildBestRateWorkflowDto()`; saved rate state classification (`fresh`, `stale`,
  `unknown`, `missing`, etc.)
- `src/services/order-rate-dto.ts` — persisted best-rate DTO shape and metadata fields
- `src/services/rates.ts` — `getRates()`, cache TTL, proof/cache metadata returned from
  live/cache rates
- `src/services/rates-backfill.ts` — how backend persists `bestRateJson`, `bestRateAt`,
  `cacheKey`, `cacheExpiresAt`, metadata
- `web/src/components/Views/orders-parity.ts` —
  `classifyAwaitingRateCellStateWithWorkflow()`,
  `savedBestRateCanDisplayForCurrentRequest()`, rate display/readiness helpers
- `web/src/components/Views/OrdersView.tsx` —
  `hasDisplayableBestRateForCurrentRequest()`, `hasSavedBestRateForRequest()`,
  `renderBestRatePrice()`, carrier/shipping-account/margin renderers, passive auto-rating
  queue and cache-first lookup integration
- Existing guards/tests:
  - `scripts/best-rate-saved-display-contract-guard.ts`
  - `scripts/ps-102-best-rate-workflow-dto-guard.ts`
  - `scripts/ps-099-orders-rate-cache-first-guard.mjs`
  - related package scripts: `test:best-rate-saved-display-contract`,
    `test:ps-102-best-rate-workflow-dto`, `test:ps-099-orders-rate-cache-first`

## Implementation requirements

1. **Separate displayability from purchase authority.**
   - Create or refine explicit semantics for:
     - **displayable saved rate**: OK to render last saved amount/account/service
       immediately.
     - **purchase-authorized selected rate**: OK to buy postage / Print Queue only with
       current backend-issued proof.
   - A saved rate with amount + carrier/service/account display fields but missing newer
     proof metadata should render as saved/stale/refreshing, not trigger
     blank/spinner-only reload behavior.
2. **Backend DTO/workflow state must expose this distinction clearly.**
   - Do not rely on frontend-only inference for safety-critical state.
   - If needed, extend `BestRateWorkflowDto` or adjacent shipping/read model DTO with
     fields such as display status vs proof/purchase status.
   - Ensure older/legacy saved rates can be represented as
     displayable-but-not-purchase-authorized.
   - Preserve existing backend selected-rate proof/fingerprint guard for label purchase.
3. **Frontend Awaiting Shipment cells must consume the canonical display state.**
   - Best Rate, Carrier, Shipping Account, and Ship Margin must all use the same
     effective saved/auto best-rate source.
   - On page reload, a saved legacy Best Rate should appear immediately where display
     metadata exists.
   - Rows may show a small stale/refreshing affordance, but not wipe out the saved rate
     or show only spinners.
   - If no saved rate exists and no rate is currently loading, render actionable terminal
     state (`Add Dims`, `Rate unavailable`, `No carrier account`, `Retry`, etc.) instead
     of indefinite spinner.
4. **Background refresh behavior.**
   - Keep cache-first behavior before live rate calls.
   - Do not force-live re-rate on every page reload for rows that already have a
     displayable saved rate.
   - Stale/proof-missing saved rates may enqueue a bounded background refresh, but the
     operator should still see the saved value immediately.
   - Explicit operator actions such as Recalculate / Refresh Live Rates may still force
     live.
5. **Legacy saved-rate compatibility.**
   - Existing `order_overrides.best_rate_json` rows without `requestFingerprint`,
     `cacheKey`, `cacheExpiresAt`, `rateQuoteId`, or `selectedRateKey` must not be
     treated as missing for display purposes when they have a positive amount and usable
     carrier/service/account fields.
   - They must still be considered **not purchase-authorized** unless backend proof is
     current.
6. **Safety/guardrails.**
   - Do not weaken Create Label / Print Queue selected-rate proof enforcement.
   - Do not allow stale/legacy saved rates to buy postage.
   - Do not hide carrier failures or remove diagnostics.
   - Do not buy real postage, create real labels, notify marketplaces, expose
     secrets/PII, or mutate production shipped/cancelled rows in tests.
   - Preserve auth/RBAC, client/store scope, source-provider carrier eligibility, HUGRAB
     insurance requirements, shipped/cancelled lockdown, and financial redaction.

## Testing applicability

This affects an operator workflow on Awaiting Shipment and crosses the rate/proof
boundary. It needs backend DTO/guard tests plus frontend/browser or component workflow
coverage. The new regression should fail on current behavior when practical, then pass
after the fix.

## Required tests / verification

1. **Backend/workflow guard** proving:
   - saved legacy Best Rate with positive amount and carrier/service/account display
     fields is `displayable` on reload.
   - same saved legacy rate is NOT label-purchase-authorized without current backend
     proof.
   - current fully-proven saved Best Rate remains displayable and purchase-authorized.
   - changed dims/weight/request fingerprint still marks the saved rate stale/requires
     refresh for purchase.
2. **Frontend display guard** proving:
   - Awaiting Shipment rows render saved Best Rate / Carrier / Shipping Account
     immediately after page reload when saved legacy metadata exists.
   - the UI may show stale/refreshing, but does not replace saved value with
     spinner-only state.
   - Best Rate, Carrier, Shipping Account, and Ship Margin consume the same effective
     rate state.
   - terminal no-rate/error/no-carrier states do not spin forever.
3. **Cache-first guard** proving:
   - page-load passive rating does not force live `/rates` calls for rows that already
     have displayable saved rates.
   - explicit Recalculate / Refresh Live Rates still can force live.

## Suggested commands

```bash
npm run typecheck
npm run test:ps-102-best-rate-workflow-dto
npm run test:best-rate-saved-display-contract
npm run test:ps-099-orders-rate-cache-first
npm run test:recalculate-best-rate-strict
npm run test:batch-recalculate-best-rate
npm run test:shipping-roundtrip-certification
npm run build:web
```

If any of these commands are stale/renamed, update the task with the actual command
names from `package.json` and run the closest equivalent. Do not mark complete until the
focused regression and surrounding rate/proof guards pass.

## Definition of done

- Reloading Awaiting Shipment no longer makes saved Best Rates appear gone or
  spinner-only when a saved displayable rate exists.
- Saved legacy rates display immediately but are clearly stale/refreshing/not
  proof-authorized when applicable.
- Create Label / Print Queue still require current backend-issued proof and cannot
  purchase from stale/legacy saved display-only rates.
- Backend DTO/workflow cleanly separates display state from purchase/proof authority.
- Frontend cells use the canonical state consistently across Best Rate, Carrier,
  Shipping Account, and Ship Margin.
- Cache-first behavior is preserved; live re-rating is bounded/background unless
  explicitly requested.
- Required tests pass and the PR includes architecture placement note, safety checklist,
  commands run/results, and remaining debt if any.

## Return/update format

Every update must start with: `PS-196 update:`

Include:

- Trello URL
- branch name
- PR URL if opened
- architecture placement note
- files changed
- tests/commands run with pass/fail
- browser/workflow behavior verified
- confirmation that no real labels/postage/marketplace notifications/production
  shipped-cancelled mutations occurred
- blockers or follow-ups
