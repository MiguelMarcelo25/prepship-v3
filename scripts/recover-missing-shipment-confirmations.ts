import 'dotenv/config';
import { sql } from '../src/db/client';
import { enqueueMissingShipmentConfirmations } from '../src/services/fulfillment/outbox';

type Args = {
  apply: boolean;
  orderId?: number;
  shipmentId?: number;
  limit: number;
  maxAgeHours: number;
  help: boolean;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function intArg(name: string): number | undefined {
  const raw = argValue(name);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

function parseArgs(): Args {
  return {
    apply: hasFlag('apply'),
    orderId: intArg('order-id'),
    shipmentId: intArg('shipment-id'),
    limit: Math.max(1, Math.min(100, intArg('limit') ?? 25)),
    maxAgeHours: Math.max(1, Math.min(24 * 14, intArg('max-age-hours') ?? 72)),
    help: hasFlag('help') || hasFlag('h'),
  };
}

function usage(): void {
  console.log(`PS-059 missing shipment confirmation recovery.

Dry-run:
  npm run shipment-confirmation:recover -- --order-id 1181901 --shipment-id 24968
  npm run shipment-confirmation:recover -- --limit 25

Apply, enqueue only:
  npm run shipment-confirmation:recover:apply -- --order-id 1181901 --shipment-id 24968

Safety:
  - Dry-run by default.
  - --apply requires exact --order-id and --shipment-id.
  - Creates only fulfillment_outbox confirmation work for an existing active label.
  - Never creates labels, buys postage, voids labels, or deletes shipment history.
  - The normal fulfillment outbox worker performs the provider notification.`);
}

function maskTracking(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return `****${text.slice(-4)}`;
}

async function listCandidates(args: Args) {
  return sql`
    SELECT
      o.id AS order_id,
      o.order_number,
      o.external_order_id,
      o.source_provider,
      o.canonical_status,
      s.id AS shipment_id,
      s.carrier_code,
      s.service_code,
      s.tracking_number,
      s.label_url IS NOT NULL AS has_label_url,
      s.confirmation_provider,
      s.confirmation_status,
      s.confirmation_attempts,
      s.marketplace_confirmed_at,
      pq.id IS NOT NULL AS in_print_queue
    FROM shipments s
    INNER JOIN orders o ON o.id = s.order_id
    LEFT JOIN print_queue_orders pq
      ON pq.order_id = o.id::text
      AND pq.client_id = o.client_id
      AND pq.status = 'queued'
    WHERE o.order_status = 'shipped'
      AND o.external_order_id ~ '^[0-9]+$'
      AND coalesce(s.voided, false) = false
      AND coalesce(s.is_return, false) = false
      AND s.label_url IS NOT NULL
      AND nullif(trim(coalesce(s.tracking_number, '')), '') IS NOT NULL
      AND s.confirmation_status IS NULL
      AND s.created_at >= NOW() - (${args.maxAgeHours} || ' hours')::interval
      ${args.orderId ? sql`AND o.id = ${args.orderId}` : sql``}
      ${args.shipmentId ? sql`AND s.id = ${args.shipmentId}` : sql``}
      AND NOT EXISTS (
        SELECT 1
        FROM fulfillment_outbox fo
        WHERE fo.event_type = 'shipment_confirmation_requested'
          AND (
            fo.shipment_id = s.id
            OR (fo.order_id = o.id AND fo.status IN ('pending', 'processing', 'succeeded'))
          )
      )
    ORDER BY s.created_at ASC
    LIMIT ${args.limit}
  ` as Promise<Array<Record<string, unknown>>>;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  if (args.apply && (!args.orderId || !args.shipmentId)) {
    throw new Error('--apply requires exact --order-id and --shipment-id');
  }

  const candidates = await listCandidates(args);
  console.log(JSON.stringify({
    ok: true,
    mode: args.apply ? 'apply_enqueue_only' : 'dry_run',
    readOnly: !args.apply,
    applyRequiresExactIds: true,
    createsLabels: false,
    buysPostage: false,
    notifiesMarketplaceDirectly: false,
    candidates: candidates.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      externalOrderId: row.external_order_id,
      sourceProvider: row.source_provider,
      canonicalStatus: row.canonical_status,
      shipmentId: row.shipment_id,
      carrierCode: row.carrier_code,
      serviceCode: row.service_code,
      trackingNumber: maskTracking(row.tracking_number),
      hasLabelUrl: row.has_label_url,
      inPrintQueue: row.in_print_queue,
      confirmationProvider: row.confirmation_provider,
      confirmationStatus: row.confirmation_status,
      confirmationAttempts: row.confirmation_attempts,
      marketplaceConfirmedAt: row.marketplace_confirmed_at,
      plannedProviderPath: 'shipstation',
      plannedAction: 'enqueue fulfillment_outbox shipment_confirmation_requested',
    })),
  }, null, 2));

  if (!args.apply) return;

  const result = await enqueueMissingShipmentConfirmations({
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    limit: 1,
    maxAgeHours: args.maxAgeHours,
  });
  console.log(JSON.stringify({ ok: true, applied: result }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  });
