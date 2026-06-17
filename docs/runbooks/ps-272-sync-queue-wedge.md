# PS-272 runbook — "Shipment sync error" / wedged sync queue

**Incident (2026-06-17):** Shipped Walmart orders show **"Shipment sync error"** in the
Carrier / Shipping-Account / Tracking columns. Confirmed live: orders `200014872687210`,
`200014733741155` are `order_status='shipped'`, `externally_shipped=false`, **0 rows in
`shipments`**. The shipped order has no local shipment, so those cells render the error
placeholder. `shipped_missing_shipments` (last 3 days) = **4**.

## Root cause (confirmed from the live `pgboss.job` queue)

The heavy sync jobs are **wedged**: each has jobs frozen in `active` state for ~3 days that
never completed or expired, while thousands pile up unprocessed in `created`:

| job | `created` (pending) | stuck `active` | last `completed_on` |
|---|---|---|---|
| `prepship.sync.shipments` | 1,335 | 3 (since 2026-06-14) | 2026-06-14 |
| `prepship.sync.orders` | 1,332 | 3 (since 2026-06-14) | 2026-06-14 |
| `prepship.sync.fulfillment-outbox` | **4,691** | 3 (since 2026-06-13) | 2026-06-13 |
| `prepship.sync.rate-backfill` | 112 | 3 (since 2026-06-16) | 2026-06-16 |

The light jobs (`reporting.refresh`, `inventory-import`, `products`, `tracking.poll`,
`external-shipped-classifier`) completed normally at 02:xx–04:xx, so **the worker process is
alive** — only the heavy syncs are jammed by orphaned `active` rows.

### Why a restart does NOT fix it
`activeJobName` ([sync-job-queue.ts:61](../../src/services/sync-job-queue.ts)) is an
**in-process** mutex reset to `null` on boot, and `withDeadline` + `finally` self-heal an
in-process hang. But when the **process dies mid-job** (Render redeploy / OOM), pgboss leaves
the job `active` in the DB. pgboss's `expireInMinutes: 30` maintenance is supposed to reap
those — it isn't (the rows are 3 days old). Multiple worker restarts this session did **not**
clear them. So the fix must explicitly clear the stale `active` rows.

## Remediation — run SUPERVISED in the Supabase SQL editor (project **Prepship** `fdkseckgfuvdczzqmnac`)

### Step 1 — diagnose (read-only, safe)
```sql
select name, state, count(*) n, max(created_on) newest, min(started_on) oldest_active
  from pgboss.job group by name, state order by name, state;
select count(*) shipped_missing_shipments
  from orders o left join shipments s on s.order_id=o.id
 where o.order_status='shipped' and o.order_date>=now()-interval '3 days'
   and s.order_id is null and o.externally_shipped is not true;
```

### Step 2 — clear the READ-side stuck-active (SAFE: idempotent reads → local writes, **no outward effect**)
```sql
update pgboss.job
   set state='failed', completed_on=now(),
       output='{"reason":"PS-272 manual reaper: cleared stale active"}'::jsonb
 where state='active'
   and started_on < now() - interval '15 minutes'
   and name in ('prepship.sync.shipments','prepship.sync.orders',
                'prepship.sync.inventory-import','prepship.sync.products',
                'prepship.sync.rate-backfill','prepship.reporting.refresh');
```
The 1,335 shipments + 1,332 orders `created` jobs then drain (worker polls every 5s, one job
at a time, each bounded to 10 min). Re-run Step 1's canary — `shipped_missing_shipments`
should fall to 0 and the badges clear after the next shipments tick.

### Step 3 — the OUTBOX (⚠️ do this LAST, with eyes on)
`prepship.sync.fulfillment-outbox` = **real marketplace ship-confirmations**. Clearing its
stuck-active resumes the queue and drains the **4,691** pending → sends a ship-confirm for
every not-yet-confirmed order. The outbox is idempotent (PS-253 `marketplace_confirmed_at`
dedupe), so already-confirmed orders settle as no-ops — but **inspect the pending set first**
and run this only when you can watch it:
```sql
-- inspect:
select count(*) from pgboss.job
 where name='prepship.sync.fulfillment-outbox' and state='created';
-- then clear stuck-active to let it drain (sends confirmations!):
update pgboss.job set state='failed', completed_on=now()
 where state='active' and name='prepship.sync.fulfillment-outbox'
   and started_on < now() - interval '15 minutes';
```

## Permanent fix (code)
`SYNC_STUCK_JOB_REAPER` (default-OFF) — a boot + periodic reaper that clears READ-side
stuck-`active` rows automatically (the Step 2 logic, **never** the outbox). Ships inert; flip
it on Render once validated. The deeper question — why pgboss's own `expireInMinutes` reap
isn't firing in prod — should be checked against the worker logs / pgboss version next.

## Why I did not auto-run this
Per the no-unsupervised-prod-mutation rule and because Step 3 fires thousands of live
marketplace notifications, the unwedge is left for DJ to run supervised.
