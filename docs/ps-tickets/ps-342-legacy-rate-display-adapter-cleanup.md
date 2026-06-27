# PS-342 - Legacy rate display adapter cleanup

Goal: Keep `apiClient.fetchRates()` as a compatibility array adapter without letting it rebuild backend rate money aliases in the frontend.

Backend source of truth:
- `src/routes/rates.ts#stampRateBrowserDisplayAliases` stamps `amount`, `shipmentCost`, `otherCost`, carrier/service aliases, and `secondBestRate` before `/rates/browse` rows reach the client.
- `apiClient.browseRates()` remains a backend DTO pass-through.
- `apiClient.fetchRates()` may return the legacy array shape for old UI callers, but it must pass through backend-stamped aliases.

Cleanup:
- `translateRateToLegacyDisplayShape()` must not read provider money fields such as `shipping_amount`, `original_amount`, `confirmation_amount`, or `insurance_amount`.
- The adapter must not compute `shipmentCost`, `otherCost`, or `amount` from those provider fields.
- Backend-issued proof refs and house-rate tuples remain pass-through only.
