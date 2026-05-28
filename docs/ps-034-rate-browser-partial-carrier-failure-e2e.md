# PS-034 - Add Rate Browser Partial-Carrier Failure E2E Coverage and Fix Unavailable Carrier Errors

Task ID: PS-034

Title: Add Rate Browser Partial-Carrier Failure E2E Coverage and Fix Unavailable Carrier Errors

Assignee: `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

## Copy/Paste Codex Prompt

You are working in PrepShip V4.

Task PS-034: Add Rate Browser Partial-Carrier Failure E2E Coverage and Fix Unavailable Carrier Errors

Assignee: Lawrence / `<@714064895963955211>`

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

## Context

DJ reported from the live Rate Browser UI that some carrier accounts are showing red error badges / unavailable state while others return rates. Screenshot evidence showed:

- Rate Browser header: `10 of 10 carriers checked - 7 with rates | live`
- Three carrier accounts with red exclamation badges: `Shipp Ca...`, `EasyPost ...`, and `UPS Carri...`
- Successful rates are still shown for working ShipStation/UPS/USPS/FedEx accounts.
- `Hide Unavailable` is checked, so failed/unavailable carrier accounts are hidden from the rate list but shown in the carrier account sidebar.

Important test gap found during review:

- `npm run test:full-site-certification` currently passes.
- Existing full-site/browser certification does not deeply cover the Rate Browser UI partial-carrier failure scenario.
- `web/e2e/site-actions.spec.js` has only a broad rate timeout/failure smoke (`ratesShouldTimeout`) and does not open Rate Browser, assert per-carrier diagnostics, assert mixed success/failure account badges, or prove one failed carrier does not block successful rates.
- `RATE_SYSTEM_HARDENING_PLAN.md` already calls this out: Rate Browser browser audit / production verification is still needed.

## Goal

Make Rate Browser certification real enough that future full-site testing catches the exact issue DJ saw: some carriers failing/unavailable while the modal still shows successful rates. Also diagnose and fix the actual unavailable/error causes for Shipp/EasyPost/UPS Carrier when safe to do so.

## Files / Docs To Inspect First

- `web/src/components/RateBrowserModal.tsx`
- `web/src/lib/v2-apiClient.ts`
- `src/services/rates.ts`
- `src/routes/rates.ts`
- `api/carriers/rates.ts`
- `src/lib/imported-handlers/rates-multi.ts`
- `scripts/rate-system-hardening-guard.mjs`
- `web/e2e/site-actions.spec.js`
- `web/e2e/orders-ux.spec.js`
- `RATE_SYSTEM_HARDENING_PLAN.md`
- `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`
- `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`

## Implementation Requirements

### 1. Add Rate Browser E2E Coverage For Partial Carrier Failures

- Add a mocked/offline Playwright test that opens the actual Rate Browser from an awaiting order.
- Mock a realistic response where 10 carrier accounts are checked, 7 return rates, and 3 return unavailable/error diagnostics.
- Assert the UI shows:
  - Rate Browser modal opens.
  - Header/status reflects all carriers checked and only the successful subset with rates.
  - Working carrier accounts show blue count badges.
  - Failed/unavailable accounts show red error/exclamation badges.
  - Successful rate rows remain visible and sorted cheapest first.
  - `Hide Unavailable` hides unavailable rows from the rate list but does not hide diagnostic/error state from the carrier sidebar.
  - Refresh Live Rates can be clicked and keeps the partial-failure state readable/recoverable.
- Ensure the test blocks live provider hosts; no real ShipStation/Shipp/EasyPost/UPS calls in automated tests.

### 2. Add / Extend Static Guard If Needed

- Extend `npm run test:rate-system-hardening` or create a focused guard if useful so Rate Browser cannot silently drop `carrierDiagnostics`, error states, unavailable states, or per-carrier account identity.
- Guard should ensure diagnostics survive API client normalization and reach Rate Browser rendering.

### 3. Diagnose Live Unavailable / Error Accounts Safely

- Investigate why the live UI shows errors for:
  - Shipp carrier account
  - EasyPost account
  - UPS Carrier account
- Use safe read-only diagnostics/logs/config inspection only unless DJ explicitly approves credential/provider mutation.
- Determine whether each failure is caused by credentials, disabled account, unsupported package/service, provider API outage, missing account mapping, timeout/rate-limit, or code normalization bug.
- Do not expose raw secrets, tokens, API keys, full provider payloads, label URLs, customer PII, or cross-client data in logs or PR text.

### 4. Fix Actual Code / Config Issue If It Is Code-Side

- If carrier diagnostics are present but Rate Browser renders them ambiguously, improve the UI wording/state without leaking sensitive provider details.
- If one bad carrier blocks, delays, or poisons the whole modal, fix so each carrier is isolated and failures are per-account.
- If a direct carrier connector path is broken in code, fix the connector/call shape at the proper boundary.
- Keep provider-specific API calls inside provider connector/helper code; do not spread direct provider calls into UI/core services.
- Keep the architecture thin; do not overengineer a new rate framework.

### 5. Include This In End-To-End Certification

- Ensure the new Rate Browser test is part of the appropriate browser certification command, preferably `npm run test:workflow-certification:browser` or an explicitly named script included by `npm run test:full-site-certification`.
- The next time `npm run test:full-site-certification` passes, it must include Rate Browser partial-carrier failure coverage.

## Verification Commands

- `npm run typecheck`
- `npm run build:web`
- `npm run test:rate-system-hardening`
- New/updated Rate Browser E2E test command
- `npm run test:workflow-certification:browser`
- `npm run test:full-site-certification`

## Guardrails / Forbidden Changes

- Do not buy postage or create labels.
- Do not send marketplace notifications.
- Do not mutate live orders, shipped/cancelled orders, shipments, or terminal state.
- Do not change carrier credentials or provider account configuration without DJ approval.
- Do not expose secrets, API keys, raw provider responses, customer PII, label URLs, or cross-client data.
- Do not weaken auth/RBAC, client/store scope, source-of-truth boundaries, secret redaction, label safety, shipped/cancelled lockdown, or provider isolation.
- Do not mark complete just because static tests pass; this needs actual browser UI coverage.

## Definition Of Done

- Rate Browser has mocked/offline browser coverage for mixed carrier success/failure.
- Full-site certification includes that Rate Browser coverage.
- Partial carrier failures are isolated: failed carriers show readable unavailable/error state, while successful rates still load and remain selectable/visible.
- Live Shipp/EasyPost/UPS Carrier error causes are diagnosed and summarized safely.
- Any code-side cause is fixed; any credential/provider/account issue is clearly flagged for DJ without leaking secrets.
- All required verification commands pass, or any unrelated blocker is documented with proof the PS-034 targeted checks pass.

## Return Format

1. Summary of code/test changes.
2. Whether the live reported carrier errors were code, config/credential, provider, or data/package related.
3. Exact Rate Browser E2E coverage added.
4. Commands run with pass/fail results.
5. Any remaining DJ approvals needed for provider account/credential fixes.
6. Confirmation that no real labels, postage, marketplace notifications, secrets/PII exposure, or unauthorized live mutations occurred.

## Closeout Notes

Status: implemented pending final verification loop.

What changed:

- Added mocked/offline Rate Browser browser coverage in `web/e2e/site-actions.spec.js`.
- The new browser test opens the actual Rate Browser from an awaiting order, fills modal dimensions, refreshes live rates, and asserts a mixed carrier result:
  - `10 of 10 carriers checked`
  - `7 with rates`
  - Shipp, EasyPost, and UPS direct carrier accounts show safe error indicators.
  - Successful ShipStation-backed rates remain visible and sorted cheapest first.
  - `Hide Unavailable` remains enabled while the failed carrier diagnostics stay visible in the carrier sidebar.
  - Refreshing live rates keeps the partial-failure state readable.
- Extended `scripts/rate-system-hardening-guard.mjs` so `npm run test:rate-system-hardening` now fails if this browser coverage is removed or if full-site certification no longer includes the workflow browser spec.
- Expanded the browser test's forbidden-provider host list so automated coverage cannot accidentally contact live ShipStation, Shipp, EasyPost, UPS, Walmart, or eBay provider APIs.

Safe live diagnostics:

- Read-only configuration inspection found active Shipp, EasyPost, and UPS carrier accounts with the required credential fields present. Credential values were not printed.
- Quote-only connector probes were run for Shipp, EasyPost, and UPS. No labels were created, no postage was purchased, and no marketplace/order/shipment mutations were performed.
- Generic probe result: all three providers returned rates through `quoteCarrierRates(...)`.
- Screenshot-like probe (`4 lb`, `11x8x6`, `90248 -> 07848`) result: all three providers returned rates through `quoteCarrierRates(...)`.

Current interpretation:

- The configured Shipp, EasyPost, and UPS direct carrier connections are not globally broken.
- The live screenshot's unavailable/error badges were not reproduced by safe connector-level quote probes. If the UI still shows errors after deployment, the likely causes are runtime-request specific: selected ship-from location, exact order address, exact package/service eligibility, stale deployment/runtime cache, or a request payload mismatch between UI and connector route.
- The new PS-034 browser coverage certifies the important behavior even when a partial failure happens: failed carrier accounts stay isolated and readable, and successful rates remain visible/selectable.
