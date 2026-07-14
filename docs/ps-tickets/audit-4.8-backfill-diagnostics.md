# Audit 4.8 — Backfill diagnostic buffers

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** Expected rate-backfill skips must
  remain separately diagnosable from actual processing failures, with each
  sample class retaining its own bounded capacity.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/rates-backfill.ts` owns per-order outcome classification. The
  small `rate-backfill-diagnostics.ts` owner records that classification into
  independent bounded buffers and normalizes durable diagnostic fields.
- **Current duplicated/unsafe owners:** Three expected skip branches append to
  `failureSamples`, allowing ordinary missing-dimension, no-rate, and
  no-downgrade results to hide real exceptions.
- **Where bad/stale/incomplete data can enter:** The diagnostic state first
  becomes ambiguous when those skip branches write into the failure buffer;
  durable snapshots and API DTOs then preserve the ambiguity unchanged.
- **Callers that must delegate to the owner:** Every skip and exception branch
  in `rates-backfill.ts` records through the diagnostic owner; durable snapshot
  parsing normalizes both buffers; the Rates and Orders routes pass both fields
  through without reclassifying them.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Direct
  writes of skip messages into `failureSamples`, one shared sample-capacity
  budget, and route/frontend reclassification are forbidden.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend changes. Clients may display the backend-provided sample classes but
  do not decide whether an outcome was skipped or failed.
- **Backend boundary tests required:** The focused guard fills both sample
  classes beyond their cap, proves each independently retains five entries,
  proves no cross-contamination, and verifies old durable snapshots normalize
  a missing `skipSamples` field to an empty array.
- **Workflow/UI proof required:** Focused diagnostic, durable backfill,
  coordination, rate source-of-truth, strict typecheck, production build, and
  mandatory SOT guards pass.

The Orders status route change is read-only DTO pass-through under the user's
current-conversation override `unlock shipped data`. It does not alter an order,
shipment, label, postage, inventory, marketplace notification, or lifecycle
protection.
