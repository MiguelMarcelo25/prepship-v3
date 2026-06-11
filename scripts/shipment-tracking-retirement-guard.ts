/**
 * Shipment-tracking retirement guard — delivered packages auto-leave the print queue.
 *
 * THE FEATURE: a 15-min poller asks ShipStation v2 for tracking status of orders
 * with an ACTIVE queued print-queue entry; when the carrier confirms DELIVERED,
 * the entry moves 'queued' → 'delivered' (leaves the active queue, stays in
 * History with auto_retired_at). Observe-only unless TRACKING_AUTO_RETIRE_ENABLED.
 *
 * SAFETY MODEL THIS GUARD PINS:
 *   - Only normalized 'delivered' retires, and only 'queued' entries — printed
 *     history, exceptions, returns, unknowns, and in-flight packages all KEEP.
 *   - The tracking service never writes orders/shipments (lockdown) and never
 *     persists raw payloads/events (PII).
 *   - The retirement writer never DELETEs and pins status='queued' in its WHERE.
 *   - listQueue's active filter is unchanged (status='queued') — 'delivered'
 *     leaves the list/count/Print-All by construction.
 *   - The job is registered in BOTH schedulers (interval + pg-boss) behind
 *     ENABLE_SHIPMENT_TRACKING_SCHEDULER, with auto-retire behind its own flag.
 *
 *   npx tsx scripts/shipment-tracking-retirement-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  decidePrintQueueRetirement,
  normalizeShipStationTrackingPayload,
  TRACKING_STATUS_DESCRIPTION_MAX,
} from '../src/services/shipment-tracking-policy';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. Retirement decision matrix (pure) ─────────────────────────────────────
check('delivered + queued → retire',
  decidePrintQueueRetirement({ trackingStatus: 'delivered', entryStatus: 'queued' }) === 'retire');
check('delivered + printed → keep (printed history is immutable)',
  decidePrintQueueRetirement({ trackingStatus: 'delivered', entryStatus: 'printed' }) === 'keep');
check('delivered + delivered → keep (idempotent)',
  decidePrintQueueRetirement({ trackingStatus: 'delivered', entryStatus: 'delivered' }) === 'keep');
check('exception + queued → keep (operator may need the label)',
  decidePrintQueueRetirement({ trackingStatus: 'exception', entryStatus: 'queued' }) === 'keep');
check('return_to_sender + queued → keep',
  decidePrintQueueRetirement({ trackingStatus: 'return_to_sender', entryStatus: 'queued' }) === 'keep');
check('in_transit / pre_transit / unknown + queued → keep',
  decidePrintQueueRetirement({ trackingStatus: 'in_transit', entryStatus: 'queued' }) === 'keep' &&
  decidePrintQueueRetirement({ trackingStatus: 'pre_transit', entryStatus: 'queued' }) === 'keep' &&
  decidePrintQueueRetirement({ trackingStatus: 'unknown', entryStatus: 'queued' }) === 'keep');
check('garbage / null inputs → keep (never retire on bad data)',
  decidePrintQueueRetirement({ trackingStatus: null, entryStatus: 'queued' }) === 'keep' &&
  decidePrintQueueRetirement({ trackingStatus: 'DELIVERED', entryStatus: 'queued' }) === 'keep' &&
  decidePrintQueueRetirement({ trackingStatus: 'delivered', entryStatus: null }) === 'keep');

// ── 2. ShipStation payload normalization (pure) ──────────────────────────────
check('DE → delivered with delivery date',
  (() => {
    const n = normalizeShipStationTrackingPayload({
      tracking_number: '1Z999', status_code: 'DE',
      status_description: 'Delivered', actual_delivery_date: '2026-06-12T16:00:00Z',
    });
    return n.status === 'delivered' && n.deliveredAt === '2026-06-12T16:00:00Z' && n.trackingNumber === '1Z999';
  })());
check('SP (collection point) → delivered',
  normalizeShipStationTrackingPayload({ status_code: 'SP' }).status === 'delivered');
check('AT (delivery ATTEMPT) → in_transit, NOT delivered',
  normalizeShipStationTrackingPayload({ status_code: 'AT' }).status === 'in_transit');
check('IT → in_transit; AC/NY → pre_transit; EX → exception; UN → unknown',
  normalizeShipStationTrackingPayload({ status_code: 'IT' }).status === 'in_transit' &&
  normalizeShipStationTrackingPayload({ status_code: 'AC' }).status === 'pre_transit' &&
  normalizeShipStationTrackingPayload({ status_code: 'NY' }).status === 'pre_transit' &&
  normalizeShipStationTrackingPayload({ status_code: 'EX' }).status === 'exception' &&
  normalizeShipStationTrackingPayload({ status_code: 'UN' }).status === 'unknown');
check('missing/garbage payload → unknown (never retires)',
  normalizeShipStationTrackingPayload(null).status === 'unknown' &&
  normalizeShipStationTrackingPayload({ status_code: 'ZZ' }).status === 'unknown' &&
  normalizeShipStationTrackingPayload('garbage').status === 'unknown');
check('"return to sender" prose → return_to_sender',
  normalizeShipStationTrackingPayload({ status_code: 'EX', exception_description: 'Package returned to sender' }).status === 'return_to_sender');
check('status description is truncated and events[] never survives',
  (() => {
    const n = normalizeShipStationTrackingPayload({
      status_code: 'IT',
      status_description: 'x'.repeat(500),
      events: [{ city_locality: 'Las Vegas' }],
    });
    return (n.statusDescription?.length ?? 0) <= TRACKING_STATUS_DESCRIPTION_MAX &&
      !('events' in n) && !('rawPayload' in n);
  })());
check('non-delivered status carries no deliveredAt',
  normalizeShipStationTrackingPayload({ status_code: 'IT', actual_delivery_date: '2026-06-12' }).deliveredAt === null);

// ── 3. Source pins: lockdown + no-raw-persistence in the service ─────────────
const trackingService = readFileSync('src/services/shipment-tracking.ts', 'utf8');
check('tracking service never writes orders/shipments (lockdown)',
  !/db\s*\.\s*update\(\s*orders\b/.test(trackingService) &&
  !/db\s*\.\s*update\(\s*shipments\b/.test(trackingService) &&
  !/db\s*\.\s*insert\(\s*shipments\b/.test(trackingService) &&
  !/db\s*\.\s*delete\(/.test(trackingService));
check('tracking service never persists raw payloads or events',
  !/rawPayload/.test(trackingService) && !/raw_payload/.test(trackingService) &&
  !/\bevents\b\s*:/.test(trackingService));
check('candidates exclude test clients + the prepship_test fixture carrier',
  /prepship_test/.test(trackingService) && /is_test/.test(trackingService));
check('service carries the shipped-data override citation',
  /Per user override unlock shipped data on 2026-06-11/.test(trackingService));

// ── 4. Source pins: the retirement writer (print-queue owner) ────────────────
const printQueueService = readFileSync('src/services/print-queue.ts', 'utf8');
{
  const writerStart = printQueueService.indexOf('export async function retireDeliveredQueueEntries');
  // The multi-line parameter type closes with a column-0 '}', so anchor the end
  // of the slice on the NEXT export instead of brace matching.
  const writerEnd = printQueueService.indexOf('\nexport ', writerStart + 10);
  const writer = printQueueService.slice(writerStart, writerEnd > 0 ? writerEnd : writerStart + 2000);
  check('retirement writer exists in the print-queue owner module', writerStart > 0);
  check("retirement writer pins status='queued' in its WHERE (printed never touched)",
    /eq\(printQueue\.status, 'queued'\)/.test(writer));
  check('retirement writer never DELETEs',
    !/\.delete\(/.test(writer));
  check("retirement writer sets status 'delivered' + autoRetiredAt only",
    /status: 'delivered'/.test(writer) && /autoRetiredAt/.test(writer) &&
    !/lastPrintedAt/.test(writer) && !/printCount/.test(writer));
}
check("listQueue active filter unchanged (status='queued')",
  /if \(!includePrinted\) conds\.push\(eq\(printQueue\.status, 'queued'\)\)/.test(printQueueService));
check('listQueue surfaces auto_retired_at to the UI',
  /auto_retired_at: e\.autoRetiredAt\?\.toISOString\(\) \?\? null/.test(printQueueService));

// ── 5. Source pins: both schedulers, both flags ───────────────────────────────
const intervalScheduler = readFileSync('src/services/sync-scheduler.ts', 'utf8');
check('interval scheduler registers the tick behind ENABLE_SHIPMENT_TRACKING_SCHEDULER',
  /runShipmentTrackingTick/.test(intervalScheduler) &&
  /env\.ENABLE_SHIPMENT_TRACKING_SCHEDULER && env\.SHIPSTATION_API_KEY_V2/.test(intervalScheduler));
check('interval tick passes the auto-retire kill-switch through',
  /autoRetire: env\.TRACKING_AUTO_RETIRE_ENABLED === true/.test(intervalScheduler));
const bossScheduler = readFileSync('src/services/sync-job-queue.ts', 'utf8');
check('pg-boss scheduler registers + enqueues the job behind the same flag',
  /shipmentTracking: 'prepship\.tracking\.poll'/.test(bossScheduler) &&
  /registerWorker\(JOBS\.shipmentTracking, runShipmentTrackingTick\)/.test(bossScheduler) &&
  /env\.ENABLE_SHIPMENT_TRACKING_SCHEDULER && env\.SHIPSTATION_API_KEY_V2/.test(bossScheduler));

// ── 6. Source pins: connector + FE ────────────────────────────────────────────
const connector = readFileSync('src/connectors/tracking/shipstation.ts', 'utf8');
check('connector calls GET /v2/tracking via the shared ssRequest (rate-limited)',
  /ssRequest<Record<string, unknown>>\(`\/v2\/tracking\?/.test(connector));
check('connector maps 404/400 to unknown (never retires)',
  /err\.status === 404 \|\| err\.status === 400/.test(connector) &&
  /status: 'unknown'/.test(connector));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check("FE history shows everything that left the active queue (status !== 'queued')",
  /activeQueueEntries\.filter\(\(entry\) => entry\.status !== 'queued'\)/.test(ordersView));
check('FE history renders the Delivered pill from auto_retired_at',
  /wasDelivered/.test(ordersView) && /auto_retired_at \?\? entry\.last_printed_at/.test(ordersView));
const parityTypes = readFileSync('web/src/components/Views/orders-parity.ts', 'utf8');
const apiTypes = readFileSync('web/src/types/api.ts', 'utf8');
check("both FE status unions include 'delivered'",
  /'queued' \| 'printed' \| 'delivered'/.test(parityTypes) &&
  /'queued' \| 'printed' \| 'delivered'/.test(apiTypes));

if (failures > 0) {
  console.error(`\nFAIL shipment-tracking retirement guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS shipment-tracking retirement guard');
