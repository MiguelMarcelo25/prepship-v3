import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orderItems, type NewOrderItem } from '../db/schema/order-items.js';
import { orders } from '../db/schema/orders.js';

type SourceOrder = {
  id: number;
  items: unknown[] | null;
  clientId: number | null;
  storeId: number | null;
  orderStatus: string;
  orderDate: Date | null;
};

const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;
const TRUE_TEXT = new Set(['true', 't', '1', 'yes']);

let storageEnsurePromise: Promise<void> | null = null;

export function ensureOrderItemsStorage(): Promise<void> {
  if (!storageEnsurePromise) storageEnsurePromise = runEnsureOrderItemsStorage();
  return storageEnsurePromise;
}

async function runEnsureOrderItemsStorage(): Promise<void> {
  const missingRelations = await db.execute<{ relation_name: string }>(sql`
    with required(relation_name) as (
      values
        ('order_items'),
        ('order_items_order_line_idx'),
        ('order_items_order_id_idx'),
        ('order_items_sku_idx'),
        ('order_items_lower_sku_idx'),
        ('order_items_date_idx'),
        ('order_items_client_date_idx'),
        ('order_items_store_date_idx'),
        ('order_items_active_date_idx'),
        ('order_items_active_client_date_idx'),
        ('order_items_active_sku_date_idx'),
        ('analytics_cache'),
        ('analytics_cache_expires_idx')
    )
    select relation_name
    from required
    where to_regclass('public.' || relation_name) is null
    order by relation_name
  `);

  if (missingRelations.length > 0) {
    throw new Error(
      `Order item analytics migrations are missing relations: ${missingRelations
        .map((row) => row.relation_name)
        .join(', ')}. Run drizzle/0024_order_items_phase2.sql and drizzle/0025_order_items_sync_trigger.sql before using order item analytics.`
    );
  }

  const missingFunction = await db.execute<{ function_name: string }>(sql`
    select function_name
    from (values ('prepship_refresh_order_items_for_order')) as required(function_name)
    where to_regproc('public.' || function_name) is null
  `);

  if (missingFunction.length > 0) {
    throw new Error(
      'Order item analytics migration is missing function: prepship_refresh_order_items_for_order. ' +
        'Run drizzle/0025_order_items_sync_trigger.sql before using order item analytics.'
    );
  }

  const missingTrigger = await db.execute<{ trigger_name: string }>(sql`
    select trigger_name
    from (values ('prepship_order_items_refresh')) as required(trigger_name)
    where not exists (
      select 1
      from pg_trigger t
      where t.tgname = required.trigger_name
        and t.tgrelid = 'orders'::regclass
        and not t.tgisinternal
    )
  `);

  if (missingTrigger.length > 0) {
    throw new Error(
      'Order item analytics migration is missing trigger: prepship_order_items_refresh. ' +
        'Run drizzle/0025_order_items_sync_trigger.sql before using order item analytics.'
    );
  }
}

function itemValue(item: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key];
  }
  return undefined;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = textValue(value);
  if (!NUMERIC_TEXT.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isAdjustment(item: Record<string, unknown>): boolean {
  const value = item.adjustment;
  if (typeof value === 'boolean') return value;
  return TRUE_TEXT.has(textValue(value).toLowerCase());
}

function toOrderItemRows(order: SourceOrder): NewOrderItem[] {
  const items = Array.isArray(order.items) ? order.items : [];
  const now = new Date();
  const rows: NewOrderItem[] = [];

  items.forEach((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return;
    const item = rawItem as Record<string, unknown>;
    if (isAdjustment(item)) return;

    const sku = textValue(itemValue(item, ['sku']));
    if (!sku) return;

    const quantity = Math.max(0, numberValue(itemValue(item, ['quantity']), 1));
    if (quantity <= 0) return;

    const unitPrice = Math.max(0, numberValue(itemValue(item, ['unitPrice', 'unit_price', 'price']), 0));
    const explicitLineTotal = numberValue(itemValue(item, ['lineTotal', 'line_total', 'total']), Number.NaN);
    const lineTotal = Number.isFinite(explicitLineTotal) ? Math.max(0, explicitLineTotal) : unitPrice * quantity;
    const name = textValue(itemValue(item, ['name', 'title', 'description'])) || null;
    const imageUrl = textValue(itemValue(item, ['imageUrl', 'image_url', 'thumbnailUrl', 'thumbnail'])) || null;

    rows.push({
      orderId: order.id,
      lineIndex: index,
      sku,
      name,
      quantity: quantity.toFixed(3),
      unitPrice: unitPrice.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
      imageUrl,
      clientId: order.clientId,
      storeId: order.storeId,
      orderStatus: order.orderStatus,
      orderDate: order.orderDate,
      updatedAt: now,
    });
  });

  return rows;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

export async function replaceOrderItemsForOrders(sourceOrders: SourceOrder[]): Promise<void> {
  if (!sourceOrders.length) return;
  await ensureOrderItemsStorage();

  const ids = Array.from(new Set(sourceOrders.map((order) => order.id)));
  const rows = sourceOrders.flatMap(toOrderItemRows);

  await db.transaction(async (tx) => {
    await tx.delete(orderItems).where(inArray(orderItems.orderId, ids));

    for (const chunk of chunks(rows, 1000)) {
      if (!chunk.length) continue;
      await tx
        .insert(orderItems)
        .values(chunk)
        .onConflictDoUpdate({
          target: [orderItems.orderId, orderItems.lineIndex],
          set: {
            sku: sql`excluded.sku`,
            name: sql`excluded.name`,
            quantity: sql`excluded.quantity`,
            unitPrice: sql`excluded.unit_price`,
            lineTotal: sql`excluded.line_total`,
            imageUrl: sql`excluded.image_url`,
            clientId: sql`excluded.client_id`,
            storeId: sql`excluded.store_id`,
            orderStatus: sql`excluded.order_status`,
            orderDate: sql`excluded.order_date`,
            updatedAt: sql`now()`,
          },
        });
    }
  });
}

export async function replaceOrderItemsForExternalOrderIds(externalOrderIds: string[]): Promise<void> {
  const ids = Array.from(new Set(externalOrderIds.filter(Boolean)));
  if (!ids.length) return;
  await ensureOrderItemsStorage();

  const rows = await db
    .select({
      id: orders.id,
      items: orders.items,
      clientId: orders.clientId,
      storeId: orders.storeId,
      orderStatus: orders.orderStatus,
      orderDate: orders.orderDate,
    })
    .from(orders)
    .where(inArray(orders.externalOrderId, ids));

  await replaceOrderItemsForOrders(rows);
}

export type OrderItemsBackfillStatus = {
  ordersTotal: number;
  ordersWithItems: number;
  ordersWithValidItems: number;
  orderItemsTotal: number;
  orderItemsOrders: number;
  missingOrdersWithAnyItems: number;
  missingOrdersWithValidItems: number;
  staleOrdersWithOrderFieldMismatch: number;
  firstMissingValidOrderId: number | null;
  complete: boolean;
};

export async function getOrderItemsBackfillStatus(): Promise<OrderItemsBackfillStatus> {
  await ensureOrderItemsStorage();

  const [row] = await db.execute<{
    orders_total: number;
    orders_with_items: number;
    orders_with_valid_items: number;
    order_items_total: number;
    order_items_orders: number;
    missing_orders_with_any_items: number;
    missing_orders_with_valid_items: number;
    stale_orders_with_order_field_mismatch: number;
    first_missing_valid_order_id: number | null;
  }>(sql`
    with orders_with_items as (
      select o.id, o.items
      from orders o
      where jsonb_array_length(coalesce(o.items, '[]'::jsonb)) > 0
    ),
    valid_orders as (
      select distinct o.id
      from orders_with_items o
      cross join lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as item(value)
      where nullif(trim(coalesce(item.value->>'sku', '')), '') is not null
        and lower(coalesce(item.value->>'adjustment', 'false')) not in ('true', 't', '1', 'yes')
        and (
          case
            when coalesce(item.value->>'quantity', '') ~ '^-?[0-9]+([.][0-9]+)?$'
              then greatest(0, (item.value->>'quantity')::numeric)
            else 1
          end
        ) > 0
    ),
    missing_valid_orders as (
      select v.id
      from valid_orders v
      where not exists (
        select 1
        from order_items oi
        where oi.order_id = v.id
      )
    ),
    stale_order_item_orders as (
      select distinct oi.order_id
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.client_id is distinct from o.client_id
        or oi.store_id is distinct from o.store_id
        or oi.order_status is distinct from o.order_status
        or oi.order_date is distinct from o.order_date
    )
    select
      (select count(*)::int from orders) as orders_total,
      (select count(*)::int from orders_with_items) as orders_with_items,
      (select count(*)::int from valid_orders) as orders_with_valid_items,
      (select count(*)::int from order_items) as order_items_total,
      (select count(distinct order_id)::int from order_items) as order_items_orders,
      (
        select count(*)::int
        from orders_with_items o
        where not exists (
          select 1
          from order_items oi
          where oi.order_id = o.id
        )
      ) as missing_orders_with_any_items,
      (select count(*)::int from missing_valid_orders) as missing_orders_with_valid_items,
      (select count(*)::int from stale_order_item_orders) as stale_orders_with_order_field_mismatch,
      (select min(id)::int from missing_valid_orders) as first_missing_valid_order_id
  `);

  const missingOrdersWithValidItems = Number(row?.missing_orders_with_valid_items ?? 0) || 0;
  const staleOrdersWithOrderFieldMismatch =
    Number(row?.stale_orders_with_order_field_mismatch ?? 0) || 0;

  return {
    ordersTotal: Number(row?.orders_total ?? 0) || 0,
    ordersWithItems: Number(row?.orders_with_items ?? 0) || 0,
    ordersWithValidItems: Number(row?.orders_with_valid_items ?? 0) || 0,
    orderItemsTotal: Number(row?.order_items_total ?? 0) || 0,
    orderItemsOrders: Number(row?.order_items_orders ?? 0) || 0,
    missingOrdersWithAnyItems: Number(row?.missing_orders_with_any_items ?? 0) || 0,
    missingOrdersWithValidItems,
    staleOrdersWithOrderFieldMismatch,
    firstMissingValidOrderId: row?.first_missing_valid_order_id ?? null,
    complete: missingOrdersWithValidItems === 0 && staleOrdersWithOrderFieldMismatch === 0,
  };
}

export async function syncOrderItemOrderFields(): Promise<number> {
  await ensureOrderItemsStorage();
  const [row] = await db.execute<{ updated_count: number }>(sql`
    with repaired as (
      update order_items oi
      set
        client_id = o.client_id,
        store_id = o.store_id,
        order_status = o.order_status,
        order_date = o.order_date,
        updated_at = now()
      from orders o
      where o.id = oi.order_id
        and (
          oi.client_id is distinct from o.client_id
          or oi.store_id is distinct from o.store_id
          or oi.order_status is distinct from o.order_status
          or oi.order_date is distinct from o.order_date
        )
      returning oi.id
    )
    select count(*)::int as updated_count
    from repaired
  `);
  return Number(row?.updated_count ?? 0) || 0;
}

export async function backfillMissingOrderItems(batchSize = 5000): Promise<number> {
  await ensureOrderItemsStorage();
  const size = Math.max(100, Math.min(20000, Math.trunc(batchSize)));
  const inserted = await db.execute<{ id: number }>(sql`
    with source_orders as (
      select o.*
      from orders o
      where jsonb_array_length(coalesce(o.items, '[]'::jsonb)) > 0
        and not exists (
          select 1
          from order_items oi
          where oi.order_id = o.id
        )
        and exists (
          select 1
          from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as item(value)
          where nullif(trim(coalesce(item.value->>'sku', '')), '') is not null
            and lower(coalesce(item.value->>'adjustment', 'false')) not in ('true', 't', '1', 'yes')
            and (
              case
                when coalesce(item.value->>'quantity', '') ~ '^-?[0-9]+([.][0-9]+)?$'
                  then greatest(0, (item.value->>'quantity')::numeric)
                else 1
              end
            ) > 0
        )
      order by o.id asc
      limit ${size}
    ),
    raw_items as (
      select
        o.id as order_id,
        (item.ordinality - 1)::int as line_index,
        nullif(trim(coalesce(item.value->>'sku', '')), '') as sku,
        nullif(coalesce(item.value->>'name', item.value->>'title', item.value->>'description', ''), '') as name,
        nullif(coalesce(item.value->>'imageUrl', item.value->>'image_url', item.value->>'thumbnailUrl', item.value->>'thumbnail', ''), '') as image_url,
        coalesce(item.value->>'quantity', '') as qty_text,
        coalesce(item.value->>'unitPrice', item.value->>'unit_price', item.value->>'price', '') as unit_price_text,
        coalesce(item.value->>'lineTotal', item.value->>'line_total', item.value->>'total', '') as line_total_text,
        o.client_id,
        o.store_id,
        o.order_status,
        o.order_date,
        lower(coalesce(item.value->>'adjustment', 'false')) as adjustment_text
      from source_orders o
      cross join lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) with ordinality as item(value, ordinality)
    ),
    normalized as (
      select
        order_id,
        line_index,
        sku,
        name,
        image_url,
        case
          when qty_text ~ '^-?[0-9]+([.][0-9]+)?$' then greatest(0, qty_text::numeric)
          else 1
        end as quantity,
        case
          when unit_price_text ~ '^-?[0-9]+([.][0-9]+)?$' then unit_price_text::numeric
          else 0
        end as unit_price,
        case
          when line_total_text ~ '^-?[0-9]+([.][0-9]+)?$' then line_total_text::numeric
          else null
        end as explicit_line_total,
        client_id,
        store_id,
        order_status,
        order_date,
        adjustment_text
      from raw_items
      where sku is not null
        and adjustment_text not in ('true', 't', '1', 'yes')
    )
    insert into order_items (
      order_id,
      line_index,
      sku,
      name,
      quantity,
      unit_price,
      line_total,
      image_url,
      client_id,
      store_id,
      order_status,
      order_date,
      updated_at
    )
    select
      order_id,
      line_index,
      sku,
      name,
      quantity,
      unit_price,
      coalesce(explicit_line_total, unit_price * quantity),
      image_url,
      client_id,
      store_id,
      order_status,
      order_date,
      now()
    from normalized
    where quantity > 0
    on conflict (order_id, line_index) do update set
      sku = excluded.sku,
      name = excluded.name,
      quantity = excluded.quantity,
      unit_price = excluded.unit_price,
      line_total = excluded.line_total,
      image_url = excluded.image_url,
      client_id = excluded.client_id,
      store_id = excluded.store_id,
      order_status = excluded.order_status,
      order_date = excluded.order_date,
      updated_at = now()
    returning id
  `);

  return inserted.length;
}
