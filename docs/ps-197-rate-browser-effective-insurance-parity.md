# PS-197 — Rate Browser must show effective HUGRAB insurance and raw-vs-label-safe rate parity

**Assignee:** Lawrence `<@714064895963955211>`
**Repo:** `drprepperusa-org/prepship-v4` · **Base branch:** `prepshipv4-stable`
**Status:** 🆕 New — from DJ/Hermes investigation on 2026-06-10.

> **NOT covered by PS-196.** PS-196 is about cache-first Awaiting Shipment Best Rate
> display after reload. PS-197 is about Rate Browser / ShipStation parity diagnostics and
> the mismatch between visible UI insurance state and backend-applied HUGRAB insurance
> policy.

## User-reported bug

DJ compared order `#1461` in PrepShip Rate Browser vs ShipStation Rate Browser for the
same ROCEL C81F70 UPS Ground service/account.

**Visible ShipStation manual estimate:**
- Order: `#1461`
- Ship From: Warehouse GWH
- Destination ZIP: 92801-5567
- Residential: checked
- Weight: 2 lb 3 oz / 35 oz
- Dimensions: 12 × 10 × 3 in
- Package: Package
- Confirmation: No Confirmation
- Selected account: ROCEL C81F70
- UPS® Ground visible price: **$7.93**
- UPS Ground Saver also visible: $6.92

**Visible PrepShip Rate Browser:**
- Ship From: GWH Fulfillment Center
- Destination ZIP: 92801-5567
- Residential: checked / always
- Weight: 2 lb 3 oz / 35 oz
- Dimensions: 12 × 10 × 3 in
- Delivery Confirmation: None
- Insurance dropdown: **None**
- Selected account: ROCEL C81F70
- UPS® Ground visible price: **$8.95**
- Rate Source: ShipStation
- Banner: "UPS Ground Saver is disabled for HUGRAB orders."

## Read-only investigation evidence

- Order `#1461` is HUGRAB: `clientId = 4`, `storeId = 378060`.
- Stored / raw order fields match the screenshots:
  - `ship_to_postal_code = 92801-5567`; raw `shipTo.postalCode = 92801-5567`
  - raw `residential = true`
  - `weight_oz = 35`; override `rate_weight_oz = 35`
  - override dims = 12 × 10 × 3
- PrepShip `rate_cache` for the matching context contained ROCEL UPS Ground:
  - `carrier_id = se-607855`, `carrier_nickname = ROCEL C81F70`
  - `service_code = ups_ground`, `service_type = UPS® Ground`
  - `shipping_amount = 8.95`, `confirmation_amount = 0`, `insurance_amount = 0`,
    `other_amount = 0`, `total = 8.95`
- The matching cache key included:
  - `w=350`, `z=92801-5567`, `r=1`, `cl=4`, `l=120`, `dw=100`, `h=30`,
    `ip=parcelguard`, `iv=10000`, `c` includes `se-607855`

## Important interpretation

The visible UI says `Insurance: None`, but the backend request/fingerprint applies HUGRAB
default insurance as **ParcelGuard / $100** for UPS Ground. That means PrepShip is likely
showing a **label-safe HUGRAB-policy rate**, while the ShipStation screenshot is showing a
**plain manual no-insurance estimate**. The UI does not make this distinction clear
enough, so operators see $8.95 vs $7.93 and assume PrepShip is wrong.

## Architecture-first requirement

Read `AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and
`.github/pull_request_template.md` before coding. Identify the canonical owner/source of
truth before editing. Rate request options, HUGRAB insurance policy, provider payload
construction, and selected-rate/label safety are **backend-owned**. UI must display
backend-classified effective options and diagnostics; it must not infer or override
label-safety policy.

## Files/docs to inspect first

- `AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`
- `src/services/rates.ts` — HUGRAB insurance normalization / cache key construction;
  ShipStation `/v2/rates/estimate` payload construction; rate totals, `insurance_amount`,
  `confirmation_amount`, `other_amount` handling
- `src/lib/shipping-service-eligibility.ts` — HUGRAB client/store detection; HUGRAB
  default insurance and blocked Ground Saver/SurePost rules
- `src/services/shipping-workflow/insurance-cost.ts` — account/service capability aware
  insurance policy and premiums
- `src/services/shipping-workflow/rate-fingerprint.ts` — request fingerprint fields for
  insurance provider/value
- `src/routes/rates.ts` — Rate Browser / rates API DTO shape
- `web/src/components/RateBrowserModal.tsx` — visible Insurance dropdown; rate row amount
  display; carrier/account panel; warning/diagnostic UI
- `web/src/lib/v2-apiClient.ts` — rate DTO normalization / rate amount components
- Existing relevant guards:
  - `test:ps-108-parcelguard-insured-best-rate`
  - `test:ps-123-insured-rate-browser-display`
  - `test:ps-124-backend-combined-best-rate`
  - `test:ps-125-hugrab-zero-insurance-premium`
  - `test:ps-126-parcelguard-schedule-premium`
  - `test:ps-170-account-capability-insurance`
  - `test:best-rate-saved-display-contract`

## Implementation requirements

1. **Make effective backend shipping options visible in Rate Browser.**
   - If backend applies HUGRAB default insurance, Rate Browser must not simply show
     operator dropdown state `Insurance: None` as if no insurance is being used.
   - Show the effective policy clearly, e.g.
     `Effective insurance: ParcelGuard $100 — HUGRAB default`, or equivalent copy
     approved by the existing design language.
   - Distinguish operator-selected option from backend-applied effective option if both
     are useful.
   - The displayed effective option must come from **backend DTO/state**, not frontend
     guesswork.
2. **Expose raw amount components and final displayed total consistently.**
   - Rate row DTO/UI should make clear what final total is composed of:
     `shipping_amount`, `confirmation_amount`, `insurance_amount`, `other_amount`,
     effective insurance provider/value, final displayed total.
   - If ShipStation returns the insurance effect inside `shipping_amount` instead of
     `insurance_amount`, the UI/diagnostic should still show that the request was
     insurance-adjusted by policy.
   - Do not fabricate a separate insurance fee when the provider returned zero; show
     source/provenance accurately.
3. **Add a parity/debug detail path safe for operators/support.**
   - Add a small Rate Browser details/diagnostic affordance or backend DTO field set
     that can answer: "Why does PrepShip not match ShipStation manual estimate?" without
     exposing secrets/PII.
   - Include redacted request facts such as ZIP+4, residential flag, weight, dims,
     confirmation, effective insurance provider/value, carrier_id/account nickname,
     service code, cache/live status, and rate source.
   - Do not expose API keys, raw provider tokens, full customer PII, or raw provider
     payloads in UI/logs.
4. **Preserve HUGRAB label-safety policy.**
   - Do NOT remove or weaken the HUGRAB $100 coverage requirement.
   - Do NOT allow UPS Ground Saver/SurePost for HUGRAB automation just to match the
     cheaper ShipStation manual row.
   - Do NOT show ShipStation's lower manual no-insurance rate as label-safe unless the
     exact backend label payload can purchase at that amount with the required coverage.
   - Do NOT weaken selected-rate proof/fingerprint enforcement.
5. **Optional but preferred: compare raw-manual vs label-safe mode explicitly.**
   - If feasible without large scope, expose separate language/state for:
     - raw ShipStation/manual estimate options, and
     - PrepShip label-safe policy estimate.
   - The default operational selection must remain **label-safe**.
   - If raw comparison is too large, return it as documented follow-up, but still fix
     effective-policy visibility now.

## Testing applicability

This crosses an external-provider/rate payload boundary and affects the operator Rate
Browser workflow. It needs backend DTO/guard coverage plus frontend UI/component/browser
coverage. Live provider mutation is not required and must not happen. If live ShipStation
read-only parity is attempted, it must be read-only `/rates/estimate` only; no label
purchase/postage/marketplace notification.

## Required tests / verification

1. **Backend guard(s)** proving a HUGRAB UPS Ground Rate Browser request for an order
   `#1461`-style fixture:
   - clientId/storeId identifies HUGRAB.
   - ZIP+4 is preserved as `92801-5567`.
   - `residential = true`.
   - weight = 35 oz.
   - dims = 12 × 10 × 3.
   - confirmation = none.
   - effective insurance provider/value = `parcelguard` / `100` when policy requires it.
   - request fingerprint/cache key includes insurance provider/value.
   - Ground Saver remains blocked/unavailable for HUGRAB.
2. **DTO/UI guard** proving Rate Browser receives/displays effective insurance state:
   - UI must not show only `Insurance: None` when backend effective policy is
     ParcelGuard $100.
   - Rate row/details must show final amount and amount components/provenance accurately.
   - Rate source/account/service must remain tied to the exact selected carrier account
     (ROCEL C81F70 / UPS Ground fixture).
3. **Parity regression around amount mismatch explanation:**
   - Fixture: ShipStation visible/manual row could be $7.93 no-insurance, while PrepShip
     label-safe row could be $8.95 with effective HUGRAB insurance policy.
   - Test should assert this is explained/classified as `effective_policy_diff` or
     similar, not as an unexplained generic mismatch.

## Suggested commands

```bash
npm run typecheck
npm run test:ps-108-parcelguard-insured-best-rate
npm run test:ps-123-insured-rate-browser-display
npm run test:ps-124-backend-combined-best-rate
npm run test:ps-125-hugrab-zero-insurance-premium
npm run test:ps-126-parcelguard-schedule-premium
npm run test:ps-170-account-capability-insurance
npm run test:best-rate-saved-display-contract
npm run build:web
```

If any commands are stale/renamed, inspect `package.json`, update the task/PR notes with
the actual equivalents, and run the closest focused guards. Add a new `test:ps-197-*`
guard if no existing test cleanly covers the new behavior.

## Definition of done

- Rate Browser clearly shows backend-effective HUGRAB insurance when it differs from the
  operator-visible dropdown/default.
- Operators can explain why order `#1461` ROCEL UPS Ground is $8.95 in PrepShip while
  ShipStation manual UI shows $7.93.
- Backend remains the source of truth for HUGRAB insurance policy, blocked services,
  rate payload/fingerprint, and label-purchase safety.
- UI consumes backend DTO/state and does not independently decide insurance policy.
- ZIP+4, residential, weight, dims, confirmation, carrier account, service, insurance
  provider/value, cache/live status, and amount components are represented in safe
  diagnostic output.
- HUGRAB Ground Saver/SurePost block remains intact.
- Selected-rate proof/fingerprint enforcement remains intact.
- Tests/guards pass, including a focused PS-197 regression.
- No real labels/postage/marketplace notifications are created/sent; no production
  shipped/cancelled rows are mutated; no secrets/PII are exposed.

## Return/update format

Every update must start with: `PS-197 update:`

Include:

- Trello URL
- branch name
- PR URL if opened
- architecture placement note
- files changed
- tests/commands run with pass/fail
- screenshot or browser/UI verification of the Rate Browser effective insurance display
- explanation of order `#1461`-style ROCEL UPS Ground mismatch classification
- confirmation that no real labels/postage/marketplace notifications/production
  shipped-cancelled mutations occurred
- blockers or follow-ups
