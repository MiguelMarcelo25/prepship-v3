import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { billingConfig, billingLineItems } from '../db/schema/billing';
import { shipments } from '../db/schema/shipments';
import { orders } from '../db/schema/orders';

export type GenerateInput = {
  clientId?: number;
  dateFrom: string; // ISO
  dateTo: string; // ISO
};

function toNum(v: string | null | undefined) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function generateLineItems(input: GenerateInput) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);

  const configs = await db
    .select()
    .from(billingConfig)
    .where(
      input.clientId !== undefined
        ? eq(billingConfig.clientId, input.clientId)
        : eq(billingConfig.active, true)
    );
  if (!configs.length) {
    return { generated: 0, skipped: 0, message: 'No billing configs found' };
  }

  const configByClient = new Map(configs.map((c) => [c.clientId, c]));

  const ships = await db
    .select({
      id: shipments.id,
      orderId: shipments.orderId,
      orderNumber: shipments.orderNumber,
      clientId: shipments.clientId,
      shipDate: shipments.shipDate,
      labelCost: shipments.labelCost,
      voided: shipments.voided,
    })
    .from(shipments)
    .where(
      and(
        isNotNull(shipments.clientId),
        isNotNull(shipments.shipDate),
        gte(shipments.shipDate, from),
        lte(shipments.shipDate, to),
        eq(shipments.voided, false),
        input.clientId !== undefined
          ? eq(shipments.clientId, input.clientId)
          : undefined
      )
    );

  let generated = 0;
  let skipped = 0;

  for (const s of ships) {
    if (s.clientId === null) {
      skipped += 1;
      continue;
    }
    const cfg = configByClient.get(s.clientId);
    if (!cfg) {
      skipped += 1;
      continue;
    }

    const rows: {
      clientId: number;
      orderId: number | null;
      orderNumber: string | null;
      shipmentId: number;
      shipDate: Date | null;
      lineType: string;
      description: string;
      qty: string;
      unitCost: string;
      totalCost: string;
    }[] = [];

    const pickPackFee = toNum(cfg.pickPackFee);
    if (pickPackFee > 0) {
      rows.push({
        clientId: s.clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'pick_pack',
        description: `Pick/pack for order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: pickPackFee.toFixed(2),
        totalCost: pickPackFee.toFixed(2),
      });
    }

    const labelCost = toNum(s.labelCost);
    if (labelCost > 0) {
      const pct = toNum(cfg.shippingMarkupPct);
      const flat = toNum(cfg.shippingMarkupFlat);
      const shipCost = labelCost * (1 + pct / 100) + flat;
      rows.push({
        clientId: s.clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'shipping',
        description: `Shipping${pct > 0 || flat > 0 ? ` (${pct}% + $${flat.toFixed(2)})` : ''} · order ${s.orderNumber ?? s.orderId}`,
        qty: '1',
        unitCost: shipCost.toFixed(2),
        totalCost: shipCost.toFixed(2),
      });
    }

    for (const row of rows) {
      try {
        await db
          .insert(billingLineItems)
          .values(row)
          .onConflictDoNothing({
            target: [
              billingLineItems.orderId,
              billingLineItems.lineType,
              billingLineItems.description,
            ],
          });
        generated += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  return { generated, skipped, message: `Generated ${generated} line items from ${ships.length} shipments.` };
}

export async function billingSummary(input: GenerateInput) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);

  const rows = await db
    .select({
      clientId: billingLineItems.clientId,
      lineType: billingLineItems.lineType,
      total: sql<string>`sum(${billingLineItems.totalCost})`,
      count: sql<number>`count(*)::int`,
    })
    .from(billingLineItems)
    .where(
      and(
        gte(billingLineItems.shipDate, from),
        lte(billingLineItems.shipDate, to),
        input.clientId !== undefined
          ? eq(billingLineItems.clientId, input.clientId)
          : undefined
      )
    )
    .groupBy(billingLineItems.clientId, billingLineItems.lineType);

  const byClient = new Map<
    number,
    { clientId: number; total: number; byType: Record<string, number>; count: number }
  >();

  for (const r of rows) {
    const cur = byClient.get(r.clientId) ?? {
      clientId: r.clientId,
      total: 0,
      byType: {},
      count: 0,
    };
    const amount = toNum(r.total);
    cur.total += amount;
    cur.byType[r.lineType] = (cur.byType[r.lineType] ?? 0) + amount;
    cur.count += r.count;
    byClient.set(r.clientId, cur);
  }

  return {
    clients: [...byClient.values()].sort((a, b) => b.total - a.total),
    grandTotal: [...byClient.values()].reduce((sum, c) => sum + c.total, 0),
  };
}

export async function billingDetails(input: GenerateInput & { limit?: number }) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);
  const rows = await db
    .select()
    .from(billingLineItems)
    .where(
      and(
        gte(billingLineItems.shipDate, from),
        lte(billingLineItems.shipDate, to),
        input.clientId !== undefined
          ? eq(billingLineItems.clientId, input.clientId)
          : undefined
      )
    )
    .orderBy(billingLineItems.shipDate)
    .limit(input.limit ?? 500);
  return rows;
}

export async function upsertBillingConfig(
  clientId: number,
  patch: Partial<{
    pickPackFee: string;
    additionalUnitFee: string;
    packageCostMarkup: string;
    shippingMarkupPct: string;
    shippingMarkupFlat: string;
    billingMode: string;
    active: boolean;
  }>
) {
  const [row] = await db
    .insert(billingConfig)
    .values({ clientId, ...patch })
    .onConflictDoUpdate({
      target: billingConfig.clientId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return row;
}
