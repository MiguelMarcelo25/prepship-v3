# PS-343 - RateBrowserModal Money Normalization Cleanup

## Goal

Remove the remaining Rate Browser frontend money reconstruction path. The modal
must consume backend-stamped money aliases for display, dedupe, saved-rate seed,
and apply payloads instead of reading provider component money fields.

## Source Of Truth

- Backend owner: `src/services/rates.ts#applyMarkups` preserves the customer
  charge and the raw/internal rate cost after markup.
- Backend owner: `src/services/rates-combined.ts#rateTotal` and
  `src/services/rates-combined.ts#rateCostTotal` define customer charge and
  internal provider cost.
- API display alias boundary: `src/routes/rates.ts#stampRateBrowserDisplayAlias`
  stamps `amount`, `shipmentCost`, `otherCost`, `customerRateAmount`, and
  `rateCostAmount` before Rate Browser rows leave the backend.

## Imperfect Data Injection

The risky input is legacy/provider-shaped rate payloads with component money
fields such as `shipping_amount`, `original_amount`, `other_amount`,
`confirmation_amount`, and `insurance_amount`. Those fields can enter through
provider responses or saved cached payloads. The backend may normalize them at
the source/read-model boundary; the frontend must not reinterpret them as a
second rate-money owner.

## Guard

Run:

```bash
npm run test:ps-343-ratebrowsermodal-money-normalization-cleanup
```

The guard proves:

- backend markup preserves customer charge and raw provider cost separately;
- `/rates/browse` stamps customer/rate-cost aliases;
- `RateBrowserModal.tsx` saved-rate seed and dedupe paths do not read provider
  money components;
- `rate-browser-money.ts` consumes backend aliases only.
