# Audit 4.5 — billing small fixes

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** Billing generation counters must
  report rows actually persisted; one logical reference rate must occupy one
  durable row and refresh in place; legacy invoice-row total fallbacks must
  include the billed package cost in every export format.
- **Canonical backend/domain/read-model/policy owner:** `generateLineItems` in
  `src/services/billing.ts` owns generation results. The billing reference-rate
  store and the `billing_ref_rates` identity constraint own rate persistence.
  `src/services/billing-invoice-row-total.ts` owns the backend compatibility
  fallback used by HTML, XLSX, and CSV serializers.
- **Current duplicated/unsafe owners:** Storage generation increments counters
  without reading `RETURNING`; manual and live reference-rate writers append
  independently; HTML, XLSX, and CSV each reproduce a fallback that omits
  `package_cost_amt`.
- **Where bad/stale/incomplete data can enter:** A conflict can skip an insert
  after the generator has planned it; repeated live/manual ingestion can submit
  the same weight/ZIP/carrier/service identity; legacy invoice rows can expose
  component amounts while `row_total` is zero.
- **Callers that must delegate to the owner:** The billing generator counts
  returned rows. Manual backfill and live reference-rate fetch call the shared
  store. HTML, XLSX, and CSV invoice serializers call the shared row-total
  resolver.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Direct
  append-only `billing_ref_rates` inserts and serializer-local
  `pickPack + shipping + storage` fallbacks are forbidden. Routes remain
  validate/authenticate → call owner → return/audit.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend code changes. Generated charges, rate-cache identity, and invoice
  totals remain backend-owned.
- **Backend boundary tests required:** Offline behavior tests cover persisted
  count source pins, duplicate normalization, migration dedupe/uniqueness/upsert,
  and authoritative-versus-fallback invoice totals.
- **Workflow/UI proof required:** Existing billing generation, reference-rate,
  invoice CSV/XLSX, finalized-billing, scope, lockdown, strict typecheck,
  production build, runtime-readiness, and SOT-pack guards must pass.

The current conversation contains the explicit override `unlock shipped data`.
Changes remain limited to billing reads/derived billing rows and reference-rate
cache persistence. No order/shipment status, shipment history, label/postage,
inventory, or marketplace-notification mutation is authorized or performed.
