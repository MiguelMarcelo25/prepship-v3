import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orderItems, type NewOrderItem } from '../db/schema/order-items';
import { orders } from '../db/schema/orders';

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
  await db.execute(sql`
    create table if not exists order_items (
      id serial primary key,
      order_id integer not null references orders(id) on delete cascade,
      line_index integer not null default 0,
      sku text not null,
      name text,
      quantity numeric(12, 3) not null default 0,
      unit_price numeric(12, 2) not null default 0,
      line_total numeric(12, 2) not null default 0,
      image_url text,
      client_id integer references clients(id),
      store_id integer,
      order_status text not null,
      order_date timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await db.execute(sql`
    create table if not exists analytics_cache (
      cache_key text primary key,
      payload jsonb not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
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
