# PS-327 HUGRAB Margin Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the existing SHIPP house-margin model into a backend-owned margin policy that can safely enable HUGRAB next-best customer-rate billing while preserving HUGRAB insurance eligibility.

**Architecture:** The backend policy owner remains the source of truth. `house-account-opt-in.ts` should evolve from a SHIPP-only boolean into a policy accessor that still defaults off, while `next-best-non-house-rate.ts` and `house-tuple-stamp.ts` own the rate/margin tuple. The frontend Settings table only renders policy state and sends admin intent.

**Tech Stack:** TypeScript, Hono routes, raw SQL runtime-DDL pattern for `billing_config`, existing shipping service eligibility and HUGRAB insurance owners, TSX guard scripts.

---

### Task 1: Policy Model And Red Guard

**Files:**
- Create: `scripts/ps-327-hugrab-margin-policy-guard.ts`
- Modify: `package.json`
- Later modify: `src/services/house-account-opt-in.ts`
- Later modify: `src/lib/next-best-non-house-rate.ts`

- [ ] **Step 1: Write the failing guard**

Create `scripts/ps-327-hugrab-margin-policy-guard.ts` with a pure behavioral test that imports the policy/selector owners and asserts:

```ts
const houseRate = { provider: 'shipp', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 10.54 } };
const insuredCompetitor = { provider: 'ups', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 11.21 } };
const uninsuredCheaper = { provider: 'ups', carrier_code: 'ups', service_code: 'ups_ground_saver', shipping_amount: { amount: 9.90 } };

// Expected once implemented:
// policy mode "next_best_customer_rate" enables the resolver.
// cheapest insurance-ineligible competitor is rejected.
// selected customer rate is 11.21, not 9.90.
```

Also add static checks proving the old SHIPP-only names have replacements:

```ts
check('policy owner exports shippingMarginPolicyForClient', /shippingMarginPolicyForClient/.test(policySrc));
check('resolver uses policy.mode instead of houseAccountOptIn boolean only', /shippingMarginPolicy/.test(resolverSrc));
```

- [ ] **Step 2: Run red**

Run:

```bash
npm run test:ps-327-hugrab-margin-policy
```

Expected: FAIL because the policy owner does not yet export the generalized policy shape and the resolver still expects `client.houseAccountOptIn`.

- [ ] **Step 3: Wire the package script**

Add:

```json
"test:ps-327-hugrab-margin-policy": "tsx scripts/ps-327-hugrab-margin-policy-guard.ts"
```

near the PS-320/PS-328 guard scripts.

### Task 2: Generalize The Backend Policy Owner

**Files:**
- Modify: `src/services/house-account-opt-in.ts`
- Modify: `drizzle/0050_billing_config_house_account.sql` only if needed for comments/default-compatible runtime-DDL

- [ ] **Step 1: Add policy types**

Add:

```ts
export type ShippingMarginPolicyMode = 'pass_through' | 'next_best_customer_rate';
export type ShippingMarginPolicy = {
  mode: ShippingMarginPolicyMode;
  legacyHouseAccountEnabled: boolean;
};
```

- [ ] **Step 2: Add pure conversion**

Add:

```ts
export function shippingMarginPolicyFromRow(row: { house_account_enabled?: boolean | null } | null | undefined): ShippingMarginPolicy {
  const enabled = row?.house_account_enabled === true;
  return {
    mode: enabled ? 'next_best_customer_rate' : 'pass_through',
    legacyHouseAccountEnabled: enabled,
  };
}
```

- [ ] **Step 3: Add async policy accessor**

Add `shippingMarginPolicyForClient(clientId)` that keeps the same fail-safe behavior as `clientHouseAccountEnabled`: null/missing/error returns pass-through.

- [ ] **Step 4: Preserve legacy API compatibility**

Keep `clientHouseAccountEnabled`, `setClientHouseAccountEnabled`, and `houseAccountEnabledClientIds` working by delegating to the new policy accessor/legacy column. Existing SHIPP behavior must remain byte-compatible.

### Task 3: Generalize House/Internal Rate Selection

**Files:**
- Modify: `src/lib/next-best-non-house-rate.ts`
- Modify: `src/services/shipping-workflow/house-tuple-stamp.ts`
- Modify: `src/services/shipping-workflow/house-margin-capture.ts`
- Modify: `src/services/shipping-workflow/house-tuple-save-policy.ts`

- [ ] **Step 1: Add a general internal-rate predicate**

Add:

```ts
export function isInternalHouseRate(rate: CombinableRate): boolean {
  return isHouseShippRate(rate);
}
```

This is intentionally conservative for the first PS-327 slice: it generalizes the API without broadening account identity beyond proven SHIPP unless a backend policy/source says so.

- [ ] **Step 2: Change resolver input**

Change:

```ts
client: { houseAccountOptIn?: boolean | null }
```

to:

```ts
shippingMarginPolicy?: { mode?: 'pass_through' | 'next_best_customer_rate' | null } | null
```

Then default `client.houseAccountOptIn` to the same policy for legacy callers until all callers are migrated.

- [ ] **Step 3: Preserve eligibility and insurance filtering**

Keep `filterEligibleShippingServices(... shippingOptions ...)` exactly in the resolver path. This is the HUGRAB safety line that excludes Ground Saver/SurePost and unsupported insured competitors before selecting customer rate.

- [ ] **Step 4: Update stamp/capture/save-policy callers**

Use `shippingMarginPolicyForClient` in tuple stamping and realized capture. Keep default-off pass-through on error.

### Task 4: Thin Admin/UI Policy Consumption

**Files:**
- Modify: `src/routes/admin.ts`
- Modify: `src/routes/billing.ts`
- Modify: `web/src/lib/v2-apiClient.ts`
- Modify: `web/src/components/Views/BillingConfigTable.tsx`
- Modify: `web/src/components/Views/billing-parity.ts`

- [ ] **Step 1: Keep the existing endpoint compatible**

`PATCH /admin/clients/:id/house-account` may continue accepting `{ enabled: boolean }`, but response should include:

```ts
{ clientId, houseAccountEnabled, shippingMarginPolicyMode }
```

- [ ] **Step 2: Billing config read returns policy mode**

`GET /billing/config` should include `shippingMarginPolicyMode`, derived by the backend owner. `houseAccountEnabled` remains for deploy compatibility.

- [ ] **Step 3: UI label becomes policy-accurate**

Rename display copy from SHIPP-specific "House Acct" to a concise backend-policy label such as "Margin Mode"; the checkbox remains a boolean toggle for `next_best_customer_rate`.

### Task 5: Verification And Commit

**Files:**
- Existing guards plus new PS-327 guard.

- [ ] **Step 1: Run focused guards**

```bash
npm run test:ps-327-hugrab-margin-policy
npm run test:ps-220-house-margin
npm run test:ps-057-hugrab-ground-saver
npm run test:ps-051-shipping-options-rework
npm run test:ps-290-hugrab-insurance-coverage-badge
npm run test:ps-307-marked-rate-comparison
npm run test:rate-source-of-truth
```

- [ ] **Step 2: Run build checks**

```bash
npm run typecheck
npm run build:web
git diff --check
```

- [ ] **Step 3: Commit locally**

```bash
git add docs/superpowers/plans/2026-06-26-ps-327-hugrab-margin-policy.md package.json scripts/ps-327-hugrab-margin-policy-guard.ts src/services/house-account-opt-in.ts src/lib/next-best-non-house-rate.ts src/services/shipping-workflow/house-tuple-stamp.ts src/services/shipping-workflow/house-margin-capture.ts src/services/shipping-workflow/house-tuple-save-policy.ts src/routes/admin.ts src/routes/billing.ts web/src/lib/v2-apiClient.ts web/src/components/Views/BillingConfigTable.tsx web/src/components/Views/billing-parity.ts
git commit -m "PS-327 generalize house margin policy"
```

Do not push or mutate Trello unless DJ explicitly asks.
