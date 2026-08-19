import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { billingLineItems } from '../src/db/schema/billing';
import {
  buildBillingShipmentRepairPlan,
  type BillingShipmentRepairCandidate,
} from '../src/services/billing-detail-utils';

type Args = {
  apply: boolean;
  approved: boolean;
  json: boolean;
  dateFrom: string;
  dateTo: string;
  clientId: number | null;
  orderNumber: string | null;
  limit: number;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parsePositiveInteger(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Math.floor(parsed);
}

function parseRequiredDate(name: string): string {
  const raw = argValue(name);
  if (!raw) throw new Error(`Missing --${name}=YYYY-MM-DD or ISO datetime`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--${name} must be a valid date`);
  }
  return parsed.toISOString();
}

function parseArgs(): Args {
  const clientIdRaw = argValue('client-id');
  const clientId = clientIdRaw == null ? null : Number(clientIdRaw);
  if (clientIdRaw != null && (!Number.isInteger(clientId) || clientId <= 0)) {
    throw new Error('--client-id must be a positive integer');
  }

  return {
    apply: hasFlag('apply'),
    approved: hasFlag('approved'),
    json: hasFlag('json'),
    dateFrom: parseRequiredDate('date-from'),
    dateTo: parseRequiredDate('date-to'),
    clientId: clientId ?? null,
    orderNumber: argValue('order-number'),
    limit: parsePositiveInteger('limit', 500),
  };
}

const args = parseArgs();

if (args.apply && !args.approved) {
  throw new Error(
    'Refusing write mode without --approved. Run dry-run first, review with DJ, then use --apply --approved if authorized.',
  );
}

const candidates = await db.execute<BillingShipmentRepairCandidate>(sql`
  select
    b.id::int as "billingLineItemId",
    b.order_id::int as "orderId",
    b.order_number as "orderNumber",
    b.line_type as "lineType",
    b.description,
    b.shipment_id::int as "currentShipmentId",
    s.id::int as "matchingShipmentId",
    s.carrier_code as "carrierCode",
    coalesce(s.cost, s.label_cost)::text as cost,
    s.dims_l::float as "dimsL",
    s.dims_w::float as "dimsW",
    s.dims_h::float as "dimsH",
    coalesce(b.invoiced, false) as "lineHasManualInvoiceLock"
  from billing_line_items b
  inner join orders o on o.id = b.order_id
  left join lateral (
    select
      candidate.id,
      candidate.carrier_code,
      candidate.cost,
      candidate.label_cost,
      candidate.dims_l,
      candidate.dims_w,
      candidate.dims_h
    from shipments candidate
    where coalesce(candidate.voided, false) = false
      and candidate.source is distinct from 'replacement'
      and (
        candidate.order_id = b.order_id
        or (
          b.order_number is not null
          and candidate.order_number = b.order_number
        )
      )
    order by candidate.id desc
    limit 1
  ) s on true
  where b.ship_date >= ${args.dateFrom}::timestamptz
    and b.ship_date <= ${args.dateTo}::timestamptz
    and o.order_status = 'shipped'
    and b.line_type in ('pick_pack', 'additional_unit', 'shipping', 'package_cost')
    ${args.clientId != null ? sql`and b.client_id = ${args.clientId}` : sql``}
    ${args.orderNumber ? sql`and b.order_number = ${args.orderNumber}` : sql``}
  order by b.ship_date desc, b.id desc
  limit ${args.limit}
`);

const plan = buildBillingShipmentRepairPlan(candidates);

let updated = 0;
if (args.apply) {
  for (const action of plan.actions) {
    await db
      .update(billingLineItems)
      .set({ shipmentId: action.matchingShipmentId })
      .where(eq(billingLineItems.id, action.billingLineItemId));
    updated += 1;
  }
}

const output = {
  mode: args.apply ? 'apply' : 'dry-run',
  dateFrom: args.dateFrom,
  dateTo: args.dateTo,
  clientId: args.clientId,
  orderNumber: args.orderNumber,
  scanned: plan.scanned,
  alreadyLinked: plan.alreadyLinked,
  missingShipment: plan.missingShipment,
  ambiguousOrLocked: plan.ambiguousOrLocked,
  wouldUpdate: plan.actions.length,
  updated,
  actions: plan.actions.slice(0, 100),
  safety:
    'Default dry-run is read-only. Apply mode updates generated billing_line_items.shipment_id only and does not mutate orders, shipments, labels, postage, or marketplace notifications.',
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Billing shipment-linkage repair ${output.mode}`);
  console.log(`Window: ${output.dateFrom} -> ${output.dateTo}`);
  if (output.clientId != null) console.log(`Client: ${output.clientId}`);
  if (output.orderNumber) console.log(`Order: ${output.orderNumber}`);
  console.log(`Scanned billing rows: ${output.scanned}`);
  console.log(`Already linked: ${output.alreadyLinked}`);
  console.log(`Missing matching shipment: ${output.missingShipment}`);
  console.log(`Locked/ambiguous: ${output.ambiguousOrLocked}`);
  console.log(`Would update: ${output.wouldUpdate}`);
  if (args.apply) console.log(`Updated: ${output.updated}`);
  for (const action of output.actions) {
    console.log(
      `- billing_line_items.${action.billingLineItemId} order=${action.orderNumber ?? action.orderId} ` +
        `line=${action.lineType} shipment ${action.currentShipmentId ?? 'NULL'} -> ${action.matchingShipmentId} ` +
        `carrier=${action.carrierCode ?? 'unknown'} cost=${action.cost ?? 'unknown'} dims=${action.dims ?? 'unknown'}`,
    );
  }
  console.log(output.safety);
}
