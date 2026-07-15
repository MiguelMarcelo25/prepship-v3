# Audit 5.6 - Bounded `orders.raw` payload policy

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** Order import persistence keeps one
  bounded operational provider-payload projection. It must not duplicate the
  complete provider response in both `orders.raw` and
  `orders.raw_source_payload`, or duplicate item/billing/normalized facts in
  `orders.raw` without a current backend consumer.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/order-raw-payload-policy.ts#retainOrderRawForPersistence` owns
  the retained JSONB shape and
  `retainOrderRawSourcePayloadForPersistence` owns the one-copy rule.
- **Current duplicated/unsafe owners:** Connector-specific raw response shapes
  previously flowed through `store-order-import.ts` unchanged. The importer
  persisted the same JSONB object in two columns, and the raw object repeated
  `orders.items`/`order_items`, billing address, weight, normalized order
  fields, and the entire `advancedOptions` object.
- **Where bad/stale/incomplete data can enter:** The earliest injection point
  is every store connector/import page. A provider can add or enlarge fields at
  any time; without an allowlist, routine sync writes that new mass into every
  matched order, including terminal rows.
- **Callers that must delegate to the owner:** The shared normalized store
  importer applies the policy before every insert/upsert. The existing-row
  maintenance script uses the same pure owner and an optimistic compare-and-swap
  update, so online and backfill behavior cannot drift.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Do not add
  per-connector retention lists, persist exact `raw_source_payload = raw`
  copies, archive provider PII into another database table, or let the
  maintenance script reimplement the projection. New retained fields must be
  added to the canonical policy with a backend-consumer test.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend change. The Orders list already receives a small backend-built
  projection and continues to render it without deciding retention.
- **Backend boundary tests required:** `test:audit-orders-raw-payload-policy`
  behaviorally proves required shipping/rate/billing/history evidence survives,
  duplicate and high-mass ShipStation fields are absent, direct marketplace
  payloads remain complete in the single retained copy, repeated compaction is
  idempotent, the importer delegates, and the compactor is gated.
- **Workflow/UI proof required:** Run the focused guard, store connector/import
  guards, marketplace confirmation and Shopify shipping guards, billing/rate/
  package consumers, lockdown guards, strict typecheck, production build, and
  the mandatory source-of-truth pack. No UI changed, so no new browser proof is
  required.

## Policy decision

PostgreSQL JSONB already uses TOAST compression for large values. Compressing a
JSON string inside JSONB would make fields unqueryable and add application-level
decompression at every consumer while retaining the duplicate facts. Moving the
same PII into an archive table would move, not solve, database pressure.

The policy therefore minimizes at the import boundary:

| Surface | Retention rule |
|---|---|
| ShipStation `orders.raw` | Allowlisted operational/reconciliation evidence only. Full `shipTo` and dimensions remain; `advancedOptions` retains only `storeId`. |
| Direct marketplace `orders.raw` | Retain the complete provider-specific shape for fulfillment and marketplace-confirmation identity until those shapes have their own normalized owner. |
| `orders.raw_source_payload` | Always `NULL`; `orders.raw` is the one retained payload copy and normalized `source_*` columns own provenance. |
| ShipStation items | Omitted from `raw`; `orders.items` remains import compatibility and `order_items` is the canonical analytics/SKU table. |
| Billing address, raw weight, notes, provider noise | Omitted for ShipStation. Billing address has no operational consumer; weight and other order facts already have normalized columns. |
| Archive | None in the PrepShip database. ShipStation remains re-fetchable; canonical columns, items, shipment history, and billing records preserve PrepShip truth. |

## Measured baseline and expected reduction

Read-only production measurements on 2026-07-15 found:

- 70,665 orders; 503 MB total relation size.
- 112 MB logical `raw` payload size.
- 41,019 non-null `raw_source_payload` rows, all 41,019 exact duplicates of
  `raw`, totaling 76 MB logical.
- Duplicated `raw.items` alone totaled 32 MB; `advancedOptions`, `billTo`, and
  raw `weight` contributed about 48 MB more.

The bounded projection prevents new full-payload growth immediately. Existing
rows are intentionally not rewritten by a migration: a 70k-row transactional
rewrite would temporarily amplify disk pressure and lock risk.

A read-only 10,000-row compactor sample found 9,973 candidates and estimated
23,177,991 logical bytes removable in that slice. It performed no updates.

## Existing-row compaction runbook

`npm run orders-raw:compact:dry-run` is read-only and reports only aggregate
counts/bytes by lifecycle status. Apply mode requires the explicit
`--confirm=compact-orders-raw` token, defaults to at most 1,000 scanned rows,
and prints the next `--after-id` cursor. Each update compares the selected raw
values before writing, so a concurrent import wins and is counted as skipped.

The update changes only `raw` and `raw_source_payload`; it does not set
`updated_at`, alter `order_status`, touch `shipments`, or invoke labels,
postage, inventory, billing, or marketplace notifications. No apply run was
performed during this audit. Production execution requires separate operator
approval for the real shipped/cancelled row mutation, bounded batches, disk
headroom monitoring, and DBA-managed `VACUUM (ANALYZE)` between/after batches.
Do not run `VACUUM FULL` during live traffic.

Per the current-conversation user override `unlock shipped data` on 2026-07-15,
the shared importer may change the retained raw JSONB on terminal-row syncs.
The existing terminal `CASE` expression, effective-lifecycle edit locks,
shipment history, label/postage boundaries, inventory, and marketplace
confirmation state are unchanged.

## Verification

Passed: focused Audit 5.6 guard; strict backend/frontend typecheck; production
web build; the 35-guard source-of-truth pack; connector architecture; shared
store connector/import; PS-388 source identity; PS-401 order totals; Shopify
store/fulfillment replay; mocked eBay/Walmart confirmations; billing raw-store
fallback; order-editable lockdown; and PS-245 lockdown-fence unit coverage.

`test:ps-205-package-facts-precedence` has one pre-existing stale static-regex
failure: it looks for direct `eq(orders.orderStatus, 'awaiting_shipment')`, while
the unchanged package-facts owner now uses the stronger
`orderLifecycleEffectiveStatusSql() = 'awaiting_shipment'` predicate. Neither
that guard nor `combo-package-defaults.ts` is part of this diff; all of its
behavior checks passed. The Audit 5.6 change does not weaken or bypass that
effective-lifecycle gate.
