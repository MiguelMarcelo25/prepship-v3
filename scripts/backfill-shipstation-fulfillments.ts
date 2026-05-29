import 'dotenv/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { clients } from '../src/db/schema/clients';
import { ssV1Request } from '../src/lib/shipstation/v1-client';
import { parseShipStationV1Date } from '../src/lib/shipstation/v1-date';

/**
 * PS-039 — Backfill ShipStation **fulfillments** (manual "Mark as Shipped")
 * into PrepShip's shipments table.
 *
 * Why this exists: `shipment-sync.ts` only imports `/shipments` (purchased
 * labels). When an operator voids a label and then **Marks as Shipped** with
 * manual tracking, ShipStation records that under `/fulfillments`, NOT
 * `/shipments`. PrepShip never sees it, so the only local row is the voided
 * label and the Orders grid shows "Missing shipment sync" for a real shipped
 * order (e.g. order #1010 → UPS tracking 1ZGG…872, fulfillmentId 18215558).
 *
 * This tool, per order number, fetches the active (non-voided) fulfillment from
 * ShipStation and inserts a non-voided shipment row representing it (carrier +
 * tracking + ship/create dates, source 'shipstation_fulfillment', cost null —
 * a manual fulfillment carries no label cost). The voided label row is left
 * untouched as history.
 *
 * SAFETY:
 *   - Dry-run unless `--apply`. Dry-run is read-only and idempotent.
 *   - INSERT-ONLY: never updates/deletes/un-voids existing shipment rows, never
 *     mutates order history, never creates labels/postage, never voids, never
 *     notifies marketplaces.
 *   - Idempotent: skips when a non-voided shipment already carries the
 *     fulfillment's tracking number for that order.
 *   - `main()` only runs when invoked directly so the guard can import the pure
 *     planner without DB/network.
 */

// ---------------------------------------------------------------------------
// Pure planner — no DB, no network. Exported for the guard.
// ---------------------------------------------------------------------------

export type FulfillmentBackfillAction =
  | 'insert' // active fulfillment exists, no matching local non-voided shipment → insert
  | 'skip_already_linked' // a non-voided local shipment already carries this tracking
  | 'skip_has_active_shipment' // order already has a non-voided shipment (label) → no need
  | 'skip_no_active_fulfillment' // no non-voided fulfillment upstream → nothing to do
  | 'skip_no_order'; // no local order for the number

export interface SSFulfillment {
  fulfillmentId: number;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  shipDate?: string | null;
  createDate?: string | null;
  voided?: boolean | null;
}

export interface FulfillmentBackfillInput {
  localOrder: { id: number; clientId: number | null; orderNumber: string } | null;
  /** Non-voided local shipment rows already linked to the order. */
  activeLocalShipments: Array<{ trackingNumber: string | null }>;
  /** Fulfillments returned by ShipStation for this order number. */
  fulfillments: SSFulfillment[];
}

export function planFulfillmentBackfill(input: FulfillmentBackfillInput): {
  action: FulfillmentBackfillAction;
  fulfillment?: SSFulfillment;
} {
  if (!input.localOrder) return { action: 'skip_no_order' };

  const active = (input.fulfillments ?? []).filter(
    (f) => f.voided !== true && typeof f.trackingNumber === 'string' && f.trackingNumber.trim() !== '',
  );
  if (!active.length) return { action: 'skip_no_active_fulfillment' };

  // Prefer the most recent active fulfillment (largest fulfillmentId).
  const chosen = active.reduce((a, b) => (b.fulfillmentId > a.fulfillmentId ? b : a));
  const tracking = (chosen.trackingNumber ?? '').trim();

  // Already represented locally by a non-voided shipment with the same tracking?
  const linked = input.activeLocalShipments.some(
    (s) => (s.trackingNumber ?? '').trim() === tracking && tracking !== '',
  );
  if (linked) return { action: 'skip_already_linked', fulfillment: chosen };

  // The order already has *some* non-voided shipment (a real label) → that's the
  // authoritative record; don't add a second one from a manual fulfillment.
  if (input.activeLocalShipments.length > 0) {
    return { action: 'skip_has_active_shipment', fulfillment: chosen };
  }

  return { action: 'insert', fulfillment: chosen };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function parseOrderNumbers(): string[] | null {
  const raw = argValue('order-numbers');
  if (!raw) return null;
  const list = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return list.length ? list : null;
}

type FulfillmentAccount = { label: string; apiKey?: string; apiSecret?: string };

async function loadAccounts(): Promise<FulfillmentAccount[]> {
  const rows = await db
    .select({ name: clients.name, ssApiKey: clients.ssApiKey, ssApiSecret: clients.ssApiSecret })
    .from(clients)
    .where(eq(clients.active, true));
  const accts: FulfillmentAccount[] = [{ label: 'main' }];
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) accts.push({ label: `client:${r.name}`, apiKey: r.ssApiKey, apiSecret: r.ssApiSecret });
  }
  return accts;
}

async function fetchFulfillments(orderNumber: string, accts: FulfillmentAccount[]): Promise<SSFulfillment[]> {
  const out: SSFulfillment[] = [];
  for (const a of accts) {
    try {
      const res = await ssV1Request<{ fulfillments?: SSFulfillment[] }>(
        `/fulfillments?orderNumber=${encodeURIComponent(orderNumber)}&pageSize=50&page=1`,
        { apiKey: a.apiKey, apiSecret: a.apiSecret, dedupeKey: `ps039:fulfill:${a.label}:${orderNumber}` },
      );
      for (const f of res.fulfillments ?? []) out.push(f);
    } catch {
      /* best-effort per account */
    }
  }
  return out;
}

function printUsage(): void {
  console.log(`
PS-039 ShipStation fulfillment backfill (manual "Mark as Shipped")

Usage:
  npm run shipstation:fulfillments:dry-run -- --order-numbers 1010
  npm run shipstation:fulfillments:apply   -- --order-numbers 1010   # DJ-approved only

Options:
  --order-numbers a,b,c   Order numbers to reconcile (required).
  --apply                 Insert the shipment row(s). OFF by default.

Safety: INSERT-ONLY. Never updates/deletes/un-voids shipments, never creates
labels/postage, never voids, never notifies marketplaces. Idempotent.
`);
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) return printUsage();

  const apply = hasFlag('apply');
  const orderNumbers = parseOrderNumbers();
  if (!orderNumbers) {
    console.error('Error: --order-numbers is required (e.g. --order-numbers 1010).');
    printUsage();
    process.exit(1);
  }

  console.log(`\n[fulfillment-backfill] ${apply ? 'APPLY' : 'DRY RUN'} — orders: ${orderNumbers.join(',')}`);
  const accts = await loadAccounts();

  let inserted = 0;
  for (const orderNumber of orderNumbers) {
    const orderRows = await db
      .select({ id: orders.id, clientId: orders.clientId, orderNumber: orders.orderNumber, status: orders.orderStatus })
      .from(orders)
      .where(eq(orders.orderNumber, orderNumber));
    const localOrder = orderRows[0] ?? null;

    const activeLocalShipments = localOrder
      ? await db
          .select({ trackingNumber: shipments.trackingNumber })
          .from(shipments)
          .where(and(eq(shipments.orderId, localOrder.id), eq(shipments.voided, false)))
      : [];

    const fulfillments = await fetchFulfillments(orderNumber, accts);
    const plan = planFulfillmentBackfill({
      localOrder: localOrder ? { id: localOrder.id, clientId: localOrder.clientId, orderNumber: localOrder.orderNumber } : null,
      activeLocalShipments,
      fulfillments,
    });

    const f = plan.fulfillment;
    console.log(
      `  #${orderNumber}: ${plan.action}` +
        (f ? ` (fulfillmentId=${f.fulfillmentId}, carrier=${f.carrierCode ?? '—'}, tracking=${f.trackingNumber ?? '—'})` : ''),
    );

    if (plan.action !== 'insert' || !f || !localOrder) continue;

    const values: typeof shipments.$inferInsert = {
      orderId: localOrder.id,
      clientId: localOrder.clientId,
      orderNumber: localOrder.orderNumber,
      carrierCode: (f.carrierCode ?? '').toLowerCase() || null,
      serviceCode: null,
      trackingNumber: f.trackingNumber ?? null,
      shipDate: parseShipStationV1Date(f.shipDate),
      createDate: parseShipStationV1Date(f.createDate),
      cost: null, // manual fulfillment carries no label cost (voided label kept as history)
      labelCarrier: (f.carrierCode ?? '').toLowerCase() || null,
      labelTracking: f.trackingNumber ?? null,
      labelShipDate: parseShipStationV1Date(f.shipDate),
      voided: false,
      isReturn: false,
      source: 'shipstation_fulfillment',
      updatedAt: new Date(),
    };

    console.log(
      `    -> would INSERT shipment: orderId=${values.orderId} clientId=${values.clientId} ` +
        `carrier=${values.carrierCode} tracking=${values.trackingNumber} source=${values.source} cost=null`,
    );

    if (apply) {
      await db.insert(shipments).values(values);
      inserted += 1;
      console.log('    -> INSERTED');
    }
  }

  console.log(`\n[fulfillment-backfill] ${apply ? `applied: inserted=${inserted}` : 'dry run only — re-run with --apply (DJ-approved) after review.'}`);
}

const invokedDirectly = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
