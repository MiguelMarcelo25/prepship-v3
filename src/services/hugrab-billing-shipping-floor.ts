import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingLineItems } from '../db/schema/billing.js';

export const HUGRAB_BILLING_CLIENT_NAME = 'HUGRAB';
export const HUGRAB_SELECTED_RATE_BELOW = 7.95;
export const HUGRAB_TARGET_SHIPPING = 7.73;
export const HUGRAB_SHIPPING_FLOOR_DEFAULT_LIMIT = 5000;

export type HugrabBillingShippingFloorAction = 'floor' | 'revert';

export type HugrabBillingShippingFloorCandidate = {
  billingLineId: number;
  clientId?: number;
  orderId: number | null;
  orderNumber: string | null;
  shipDate: string | null;
  currentShipping: number;
  selectedRateCost: number;
};

export type HugrabBillingShippingFloorPreviewRow = HugrabBillingShippingFloorCandidate & {
  nextShipping: number;
};

export type HugrabBillingShippingFloorPreview = {
  action: HugrabBillingShippingFloorAction;
  clientName: typeof HUGRAB_BILLING_CLIENT_NAME;
  selectedRateBelow: typeof HUGRAB_SELECTED_RATE_BELOW;
  targetShipping: typeof HUGRAB_TARGET_SHIPPING;
  count: number;
  currentTotal: number;
  newTotal: number;
  delta: number;
  sampleRows: HugrabBillingShippingFloorPreviewRow[];
};

export type HugrabBillingShippingFloorApplyResult = HugrabBillingShippingFloorPreview & {
  applied: true;
  updatedCount: number;
};

type RawCandidate = {
  billing_line_id: number | string;
  client_id: number | string;
  order_id: number | string | null;
  order_number: string | null;
  ship_date: string | null;
  current_shipping: string | number;
  selected_rate_cost: string | number;
};

export class HugrabBillingShippingFloorCountMismatchError extends Error {
  expectedCount: number;
  currentCount: number;

  constructor(expectedCount: number, currentCount: number) {
    super(`HUGRAB billing shipping floor expected ${expectedCount} row(s), but currently matches ${currentCount}. Preview again before applying.`);
    this.name = 'HugrabBillingShippingFloorCountMismatchError';
    this.expectedCount = expectedCount;
    this.currentCount = currentCount;
  }
}

function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function money(value: number): string {
  return round2(value).toFixed(2);
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextShippingFor(action: HugrabBillingShippingFloorAction, row: HugrabBillingShippingFloorCandidate): number {
  return action === 'revert' ? round2(row.selectedRateCost) : HUGRAB_TARGET_SHIPPING;
}

export function summarizeHugrabBillingShippingFloorCandidates(
  action: 'floor' | 'revert',
  rows: HugrabBillingShippingFloorCandidate[],
): HugrabBillingShippingFloorPreview {
  const currentTotal = round2(rows.reduce((sum, row) => sum + row.currentShipping, 0));
  const sampleRows = rows.slice(0, 25).map((row) => ({
    ...row,
    currentShipping: round2(row.currentShipping),
    selectedRateCost: round2(row.selectedRateCost),
    nextShipping: nextShippingFor(action, row),
  }));
  const newTotal = round2(rows.reduce((sum, row) => sum + nextShippingFor(action, row), 0));
  return {
    action,
    clientName: HUGRAB_BILLING_CLIENT_NAME,
    selectedRateBelow: HUGRAB_SELECTED_RATE_BELOW,
    targetShipping: HUGRAB_TARGET_SHIPPING,
    count: rows.length,
    currentTotal,
    newTotal,
    delta: round2(newTotal - currentTotal),
    sampleRows,
  };
}

function mapCandidate(row: RawCandidate): HugrabBillingShippingFloorCandidate {
  return {
    billingLineId: Number(row.billing_line_id),
    clientId: Number(row.client_id),
    orderId: row.order_id == null ? null : Number(row.order_id),
    orderNumber: row.order_number,
    shipDate: row.ship_date,
    currentShipping: round2(toNumber(row.current_shipping)),
    selectedRateCost: round2(toNumber(row.selected_rate_cost)),
  };
}

async function fetchHugrabBillingShippingFloorCandidates(input: {
  action: HugrabBillingShippingFloorAction;
  dateFrom: string;
  dateTo: string;
  limit?: number;
}, clientScopePredicate: SQL | undefined): Promise<HugrabBillingShippingFloorCandidate[]> {
  const action = input.action;
  const limit = input.limit ?? HUGRAB_SHIPPING_FLOOR_DEFAULT_LIMIT;
  const scoped = clientScopePredicate ?? sql`true`;

  const rows = await db.execute<RawCandidate>(sql`
    with source_rows as (
      select
        billing_line_items.id as billing_line_id,
        billing_line_items.client_id,
        billing_line_items.order_id,
        billing_line_items.order_number,
        billing_line_items.ship_date,
        billing_line_items.total_cost as current_shipping,
        coalesce(s.cost, fs.cost) as cost,
        coalesce(s.label_cost, fs.label_cost) as label_cost,
        coalesce(s.other_cost, fs.other_cost) as other_cost,
        coalesce(s.selected_rate_json, fs.selected_rate_json) as selected_rate_json
      from billing_line_items
      join clients c on c.id = billing_line_items.client_id
      left join shipments s on s.id = billing_line_items.shipment_id
      left join lateral (
        select sx.*
        from shipments sx
        where sx.order_id = billing_line_items.order_id
          and coalesce(sx.voided, false) = false
          and coalesce(sx.is_return, false) = false
        order by sx.ship_date desc nulls last, sx.id desc
        limit 1
      ) fs on s.id is null and billing_line_items.order_id is not null
      where c.name = ${HUGRAB_BILLING_CLIENT_NAME}
        and billing_line_items.line_type = 'shipping'
        and coalesce(billing_line_items.invoiced, false) = false
        and billing_line_items.total_cost > 0
        and billing_line_items.description not ilike 'Included%'
        and billing_line_items.ship_date >= ${input.dateFrom}::timestamptz
        and billing_line_items.ship_date < ${input.dateTo}::timestamptz
        and ${scoped}
    ),
    priced_rows as (
      select
        src.billing_line_id,
        src.client_id,
        src.order_id,
        src.order_number,
        src.ship_date::text as ship_date,
        src.current_shipping::text as current_shipping,
        round(
          coalesce(
            money.postage_cost + money.other_cost,
            money.selected_total
          ),
          2
        ) as selected_rate_cost
      from source_rows src
      left join lateral (
        select
          coalesce(
            src.cost,
            src.label_cost,
            max(case
              when j.key in ('shipmentCost', 'shipment_cost', 'labelCost', 'label_cost', 'rateCostAmount')
                and (j.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              then (j.value #>> '{}')::numeric
              else null
            end)
          ) as postage_cost,
          coalesce(
            src.other_cost,
            max(case
              when j.key in ('otherCost', 'other_cost', 'insuranceCost', 'insurance_cost')
                and (j.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
              then (j.value #>> '{}')::numeric
              else null
            end),
            0
          ) as other_cost,
          max(case
            when j.key in ('totalCost', 'total_cost')
              and (j.value #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            then (j.value #>> '{}')::numeric
            else null
          end) as selected_total
        from jsonb_each(coalesce(src.selected_rate_json, '{}'::jsonb)) j
      ) money on true
    )
    select
      billing_line_id,
      client_id,
      order_id,
      order_number,
      ship_date,
      current_shipping,
      selected_rate_cost::text as selected_rate_cost
    from priced_rows
    where selected_rate_cost is not null
      and selected_rate_cost < ${HUGRAB_SELECTED_RATE_BELOW}
      and (
        case
          when ${action === 'revert'}::boolean
            then abs(current_shipping::numeric - ${HUGRAB_TARGET_SHIPPING}) <= 0.004
              and abs(current_shipping::numeric - selected_rate_cost) > 0.004
          else abs(current_shipping::numeric - ${HUGRAB_TARGET_SHIPPING}) > 0.004
        end
      )
    order by ship_date desc nulls last, billing_line_id desc
    limit ${limit}
  `);

  return rows.map(mapCandidate);
}

export async function listHugrabBillingShippingFloorCandidates(input: {
  action: HugrabBillingShippingFloorAction;
  dateFrom: string;
  dateTo: string;
  limit?: number;
}, clientScopePredicate?: SQL): Promise<HugrabBillingShippingFloorPreview> {
  const rows = await fetchHugrabBillingShippingFloorCandidates(input, clientScopePredicate);
  return summarizeHugrabBillingShippingFloorCandidates(input.action, rows);
}

export async function applyHugrabBillingShippingFloor(input: {
  action: HugrabBillingShippingFloorAction;
  dateFrom: string;
  dateTo: string;
  expectedCount: number;
  limit?: number;
}, clientScopePredicate?: SQL): Promise<HugrabBillingShippingFloorApplyResult> {
  const rows = await fetchHugrabBillingShippingFloorCandidates(input, clientScopePredicate);
  const current = summarizeHugrabBillingShippingFloorCandidates(input.action, rows);
  const expectedCount = input.expectedCount;

  if (current.count !== expectedCount) {
    throw new HugrabBillingShippingFloorCountMismatchError(expectedCount, current.count);
  }

  const updatedIds: number[] = [];
  if (rows.length > 0) {
    await db.transaction(async (tx) => {
      for (const row of rows) {
        const amount = money(nextShippingFor(input.action, row));
        const currentAmount = money(row.currentShipping);
        const updated = await tx
          .update(billingLineItems)
          .set({
            unitCost: amount,
            totalCost: amount,
          })
          .where(
            and(
              eq(billingLineItems.id, row.billingLineId),
              eq(billingLineItems.clientId, Number(row.clientId)),
              eq(billingLineItems.lineType, 'shipping'),
              eq(billingLineItems.invoiced, false),
              eq(billingLineItems.totalCost, currentAmount),
            ),
          )
          .returning({ id: billingLineItems.id });
        if (updated.length !== 1) {
          throw new Error(`HUGRAB billing line ${row.billingLineId} changed during apply. Preview again before applying.`);
        }
        updatedIds.push(...updated.map((updatedRow) => updatedRow.id));
      }
    });
  }

  return {
    ...current,
    applied: true,
    updatedCount: updatedIds.length,
  };
}
