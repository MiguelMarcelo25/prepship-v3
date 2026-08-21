import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  freezeSyncIngressCustomerShippingMoney,
  recordSyncIngressFreezeRetry,
} from './customer-shipping-money-sync-ingress.js';
import { ensureCustomerShippingMoneySyncSchema } from './customer-shipping-money-sync-readiness.js';

/**
 * PS-509 — re-drive non-terminal outcomes whose blocking fact has changed.
 *
 * ── WHY A SWEEP EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * The two trigger boundaries (INSERT transaction, orphan-link transaction) cover the
 * canonical paths, but two real lanes escape them and would otherwise become permanent
 * tuple-less gaps on ELIGIBLE rows:
 *
 *  1. shipment-sync's UPDATE branch re-resolves the order every pass and can relink an
 *     orphan (values.orderId set where the row's was null). That branch runs with no
 *     transaction, 3-at-a-time, by deliberate pooler-budget design — it cannot freeze.
 *  2. An orphan-link transaction that aborted (freeze failure) rolled back the link;
 *     the order now exists, so the hydrate pass never revisits it, and the relink
 *     arrives later through lane 1.
 *
 * The durable outcomes are the retry queue: a shipment whose outcome is still
 * no_order / no_client / needs_retry but whose row NOW carries the missing link is
 * exactly a late attribution that bypassed the link boundary. Each is frozen in its own
 * transaction (tuple and outcome commit together); a failure records needs_retry and the
 * next sweep tries again. Terminal outcomes (billing_inactive, no_billable_cost, return,
 * voided, test, needs_review) are never re-driven: what happened at evaluation is a
 * durable fact, and a later config change must not retroactively manufacture money.
 */
export async function sweepSyncIngressFreezeRetries(
  options: { limit?: number; database?: typeof db } = {},
): Promise<{ scanned: number; frozen: number; alreadyFrozen: number; failed: number; reclassified: number }> {
  const database = options.database ?? db;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  await ensureCustomerShippingMoneySyncSchema(database);

  const candidates = await database.execute<{ shipmentId: number }>(sql`
    select o.shipment_id as "shipmentId"
    from customer_shipping_money_sync_outcomes o
    join shipments s on s.id = o.shipment_id
    where (
      (o.outcome in ('no_order', 'needs_retry') and s.order_id is not null)
      or (o.outcome = 'no_client' and s.client_id is not null)
    )
    order by o.last_evaluated_at asc
    limit ${limit}
  `);
  const rows = (Array.isArray(candidates)
    ? candidates
    : ((candidates as { rows?: unknown[] })?.rows ?? [])) as Array<{ shipmentId: number }>;

  let frozen = 0;
  let alreadyFrozen = 0;
  let failed = 0;
  let reclassified = 0;
  for (const candidate of rows) {
    try {
      const result = await database.transaction(async (tx) => {
        return freezeSyncIngressCustomerShippingMoney(candidate.shipmentId, {
          boundary: 'retry_sweep',
          exec: tx,
        });
      });
      if (result.outcome === 'frozen') {
        if (result.alreadyFrozen) alreadyFrozen += 1;
        else frozen += 1;
      } else {
        // The re-evaluation landed on a different durable outcome (e.g. billing went
        // inactive before the retry). That outcome is now persisted; the row leaves
        // the retryable set unless the sweep's own predicate still matches it.
        reclassified += 1;
      }
    } catch (error) {
      failed += 1;
      await recordSyncIngressFreezeRetry(candidate.shipmentId, {
        boundary: 'retry_sweep',
        failureClassification: 'retry_failed',
        detail: error instanceof Error ? error.message : String(error),
        database,
      });
    }
  }

  if (rows.length) {
    console.log(
      `[ps-509] retry sweep: ${rows.length} candidate(s), ${frozen} frozen, `
      + `${alreadyFrozen} already frozen, ${reclassified} reclassified, ${failed} failed`,
    );
  }
  return { scanned: rows.length, frozen, alreadyFrozen, failed, reclassified };
}
