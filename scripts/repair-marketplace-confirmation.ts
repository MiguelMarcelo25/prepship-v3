import 'dotenv/config';
import { sql } from '../src/db/client';
import { ensureShipmentConfirmationLifecycle } from '../src/services/fulfillment/outbox';

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usage(): void {
  console.log(`PS-064 marketplace/source confirmation lifecycle repair.

Dry-run:
  npm run marketplace:confirmation:repair -- --order-number 1149 --dry-run
  npm run marketplace:confirmation:repair -- --order-id 1191799 --dry-run

Apply live confirmation lifecycle repair:
  npm run marketplace:confirmation:repair -- --order-number 1149 --apply --live-approved

Safety:
  - Dry-run by default.
  - --apply requires --live-approved and an exact order id/number.
  - Never creates labels, buys postage, voids labels, or deletes shipment history.
  - Apply may enqueue/process the normal fulfillment_outbox confirmation for the exact order.`);
}

function intArg(name: string): number | undefined {
  const raw = argValue(name);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    usage();
    return;
  }

  const orderId = intArg('order-id');
  const orderNumber = argValue('order-number')?.trim() || undefined;
  const shipmentId = intArg('shipment-id');
  const apply = hasFlag('apply');
  const liveApproved = hasFlag('live-approved');

  if (!orderId && !orderNumber) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (apply && !liveApproved) {
    throw new Error('--apply requires --live-approved for the exact order/operation');
  }

  const result = await ensureShipmentConfirmationLifecycle({
    orderId,
    orderNumber,
    shipmentId,
    dryRun: !apply,
    processNow: apply,
  });

  console.log(JSON.stringify({
    ok: result.ok,
    mode: result.mode,
    creates_label: false,
    buys_postage: false,
    voids_label: false,
    safe_to_buy_label: result.plan.safeToBuyLabel,
    order: result.plan.orderNumber ?? result.plan.orderId,
    shipment: result.plan.shipmentId,
    source_provider: result.plan.provider,
    external_shipstation_order_id: result.plan.provider === 'shipstation' ? result.plan.upstreamOrderId : null,
    active_label_exists: result.plan.shipmentId != null,
    outbox_exists: result.plan.outboxExists,
    confirmation_status: result.plan.confirmationStatus,
    planned_action: result.plan.plannedAction,
    planned_reason: result.plan.reason,
    notify_marketplace: result.plan.notifyMarketplace,
    queued: result.queued,
    outbox_id: result.outboxId,
    processed: result.processed,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  });
