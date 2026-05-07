/**
 * One-shot script to delete print_queue_orders rows whose underlying
 * order is already shipped or cancelled.
 *
 * BACKGROUND
 * ──────────
 * Until 2026-05-07 the print queue had no auto-cleanup hook on
 * order-status transitions. So any "Send to Queue" entry stuck around
 * forever after the order shipped — operators saw stale entries
 * cluttering the queue panel pointing at orders that no longer
 * needed printing.
 *
 * The auto-cleanup is now wired in two places:
 *   1. services/labels.ts markOrderShipped — fires on local Print Label
 *   2. services/order-sync.ts updateExistingOrderStatusesBatch —
 *      fires when sync detects a status flip from upstream
 *
 * This script handles the entries that already accumulated before
 * the auto-cleanup landed.
 *
 * USAGE (Render Shell)
 * ────────────────────
 *   tsx scripts/cleanup-stale-queue-entries.ts
 *
 * SAFETY
 * ──────
 * - Only deletes queue entries pointing at orders with
 *   order_status IN ('shipped', 'cancelled')
 * - Never touches orders, shipments, billing, or inventory
 * - Idempotent: running twice is harmless (second run finds 0)
 *
 * Per user override `unlock shipped data` on 2026-05-07.
 */

import { inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { printQueue } from '../src/db/schema/print-queue';

async function main() {
  console.log('Scanning for stale queue entries…\n');

  type StaleRow = {
    queue_id: string;
    order_id: number;
    order_status: string;
    order_number: string | null;
  };

  const stale = await db.execute<StaleRow>(sql`
    select pq.id as queue_id,
           o.id as order_id,
           o.order_status,
           o.order_number
    from print_queue_orders pq
    inner join orders o on o.id = pq.order_id::int
    where o.order_status in ('shipped', 'cancelled')
  `);

  if (stale.length === 0) {
    console.log('✅ Queue is already clean — 0 stale entries.');
    process.exit(0);
  }

  console.log(`Found ${stale.length} stale entries:`);
  for (const row of stale) {
    console.log(
      `  - queue ${row.queue_id} → order ${row.order_id} (${row.order_number ?? 'no#'}) · ${row.order_status}`
    );
  }

  console.log('\nDeleting…');
  const queueIds = stale.map((row) => row.queue_id);
  const removed = await db
    .delete(printQueue)
    .where(inArray(printQueue.id, queueIds))
    .returning({ id: printQueue.id });

  console.log(`\n✅ Removed ${removed.length} stale queue entries.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
