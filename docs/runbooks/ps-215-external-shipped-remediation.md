# PS-215 runbook — Shipped rows resting on "Shipment sync error"

**Invariant (DJ, 2026-06-12):** the Shipped table shows either `Ext. Label`
(genuine marketplace/external fulfillment) or an actionable sync-error badge.
The raw "Missing shipment sync" resting state is gone (PS-215); a row showing
**Shipment sync error** means *no local shipment data and no persisted
external flag* — it needs one of the remediations below, it is never a state
to leave indefinitely.

## State model

| Operator badge | Meaning | Owner |
|---|---|---|
| (normal label data) | `local_label` — local shipment/label/rate exists | ShipStation sync / v4 labels |
| `Ext. Label` | `external_label` — persisted external/marketplace flag (PS-036: never inferred from absence) | PS-056 classifier or import-time flag |
| `Shipment sync error` | recoverable sync gap **or** unclassified external candidate | this runbook |

The recoverable-vs-external split is decided by the PS-056 classifier
(`scripts/reconcile-external-shipped-orders.ts`), which checks upstream
ShipStation for a real shipment/fulfillment before ever flagging external.

## Why rows rest on the error badge

1. **Classifier scheduler off.** Check `GET /health/deep` →
   `externalShippedClassifier.schedulerEnabled` / `autoApplyEnabled`.
   Production needs **both** env vars on Render:
   - `ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER=true`
   - `ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY=true` (apply step; leave `false` for
     observe-only dry-run reporting)
   The 2026-06-12 dry run found `missing_local_unflagged=10`, all 10
   classified external, with both flags defaulting false — exactly this case.
2. **Recoverable ShipStation gap.** Upstream has the shipment; the local row
   never synced. Re-run ShipStation sync / the PS-039 fulfillment backfill.
3. **Lookup failures.** Credentials/timeout errors in the classifier report —
   fix the provider error and re-run; these rows must NOT be force-flagged.

## Remediation procedure

1. **Dry run (read-only, safe anytime):**
   ```bash
   npm run certify:external-shipped
   ```
   Review counts: `classified_external`, `classified_recoverable`,
   `lookup_failures`. Samples are redacted by design.
2. **Recoverable rows:** run ShipStation sync / shipment backfill; re-run the
   dry run and confirm `classified_recoverable` drains.
3. **External rows — apply (DJ-approved only):** either enable the scheduler
   flags above (steady-state) or run the classifier apply step explicitly per
   docs/ps-056-marketplace-fulfilled-ext-label.md. The apply writes ONLY the
   reversible `externally_shipped` flag — never shipment history.
4. **Verify:** dry run reports `missing_local_unflagged=0`; the Shipped table
   shows `Ext. Label` on the flagged rows and no resting error badges except
   genuinely-in-progress sync gaps.

## Deploy checklist addition

Any environment rebuild must restore the two env flags — `GET /health/deep`
is the post-deploy check (a `false` there with a clean DB is the silent-
disable failure mode this runbook exists for).
