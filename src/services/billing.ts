import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  billingConfig,
  billingLineItems,
  clientPackagePrices,
} from '../db/schema/billing';
import { shipments } from '../db/schema/shipments';
import { orders } from '../db/schema/orders';
import { packages } from '../db/schema/packages';
import { clients } from '../db/schema/clients';

export type GenerateInput = {
  clientId?: number;
  dateFrom: string; // ISO
  dateTo: string; // ISO
};

// v2 parity constant: the first unit on every order is included in the pick/pack
// fee; every subsequent unit is billed at additionalUnitFee. v2 hardcodes this
// to 1 (see apps/api/src/modules/billing/data/sqlite-billing-repository.ts:216).
// If a configurable per-client cap is needed later, add a pick_pack_max_units
// column to billing_config and read it here.
// Fallback when a client's billing_config row has no pickPackMaxUnits set
// (legacy rows or newly-created clients). Matches v2's hardcoded constant.
const PICK_PACK_MAX_UNITS_DEFAULT = 1;

function toNum(v: string | null | undefined) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Sum the billable units on an order. Mirrors v2's logic:
//   - Filter out items flagged as `adjustment: true` (refunds, price tweaks)
//   - Default missing `quantity` to 1 (v2 line 192 / pick-list default)
function totalUnitsFromItems(items: unknown[] | null | undefined): number {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if ((it as { adjustment?: unknown }).adjustment === true) continue;
    const qRaw = (it as { quantity?: unknown }).quantity;
    const q = qRaw == null ? 1 : Number(qRaw);
    if (Number.isFinite(q) && q > 0) n += q;
  }
  return n;
}

export async function generateLineItems(input: GenerateInput) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);

  const rawConfigs = await db
    .select({
      config: billingConfig,
      isTest: clients.isTest,
    })
    .from(billingConfig)
    .innerJoin(clients, eq(clients.id, billingConfig.clientId))
    .where(
      input.clientId !== undefined
        ? eq(billingConfig.clientId, input.clientId)
        : eq(billingConfig.active, true)
    );
  // Test clients are hard-excluded — their shipments never generate invoice
  // line items, even if someone manually sets billingConfig.active=true.
  const configs = rawConfigs
    .filter((r) => !r.isTest)
    .map((r) => r.config);
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
      selectedPid: shipments.selectedPid,
      selectedPackageId: shipments.selectedPackageId,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
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

  // Pre-fetch order.items for every shipment in the window so the B1
  // additional-units computation doesn't N+1 the DB. One SELECT, Map lookup.
  const orderIds = [
    ...new Set(
      ships
        .map((s) => s.orderId)
        .filter((x): x is number => x !== null && x !== undefined)
    ),
  ];
  const orderItemsRows = orderIds.length
    ? await db
        .select({ id: orders.id, items: orders.items })
        .from(orders)
        .where(inArray(orders.id, orderIds))
    : [];
  const orderItemsById = new Map<number, unknown[]>();
  for (const r of orderItemsRows) {
    orderItemsById.set(r.id, Array.isArray(r.items) ? r.items : []);
  }

  // ─── B2 pre-fetch: packages + per-client package prices ──────────────────
  // Three lookup maps for the resolvePackageId resolver:
  //   packagesById     — shipment.selectedPid → package
  //   packagesByCode   — shipment.selectedPackageId (text ShipStation code)
  //   packagesByDims   — dims fallback when no explicit pid/code on shipment
  // Pricing is keyed (clientId, packageId) with `isCustom` meaning "don't
  // overwrite on set-default"; for computation both kinds are equal.
  const allPackages = await db
    .select({
      id: packages.id,
      name: packages.name,
      packageCode: packages.packageCode,
      length: packages.length,
      width: packages.width,
      height: packages.height,
    })
    .from(packages);

  type PkgRow = (typeof allPackages)[number];
  const packagesById = new Map<number, PkgRow>();
  const packagesByCode = new Map<string, PkgRow>();
  const packagesByDims = new Map<string, PkgRow>();
  const dimsKey = (l: number, w: number, h: number): string =>
    `${l}×${w}×${h}`;
  for (const p of allPackages) {
    packagesById.set(p.id, p);
    if (p.packageCode) packagesByCode.set(p.packageCode, p);
    if (p.length > 0 && p.width > 0 && p.height > 0) {
      packagesByDims.set(dimsKey(p.length, p.width, p.height), p);
    }
  }

  const clientIdsInScope = [...configByClient.keys()];
  const priceRows = clientIdsInScope.length
    ? await db
        .select()
        .from(clientPackagePrices)
        .where(inArray(clientPackagePrices.clientId, clientIdsInScope))
    : [];
  const pricesByClient = new Map<number, Map<number, number>>();
  for (const r of priceRows) {
    let m = pricesByClient.get(r.clientId);
    if (!m) {
      m = new Map();
      pricesByClient.set(r.clientId, m);
    }
    m.set(r.packageId, Number(r.price));
  }

  function resolvePackageId(s: {
    selectedPid: number | null;
    selectedPackageId: string | null;
    dimsL: number | null;
    dimsW: number | null;
    dimsH: number | null;
  }): number | null {
    // 1. Explicit integer custom-package FK on the shipment.
    if (s.selectedPid != null && packagesById.has(s.selectedPid)) {
      return s.selectedPid;
    }
    // 2. Text code — could be numeric id stringified, or a ShipStation
    //    package_code (e.g. "large_flat_rate_box"). Try both.
    if (s.selectedPackageId) {
      const asInt = Number.parseInt(s.selectedPackageId, 10);
      if (Number.isFinite(asInt) && packagesById.has(asInt)) return asInt;
      const byCode = packagesByCode.get(s.selectedPackageId);
      if (byCode) return byCode.id;
    }
    // 3. Exact dims match (v2 makeDimsKey parity — unsorted, verbatim).
    if (s.dimsL != null && s.dimsW != null && s.dimsH != null) {
      const match = packagesByDims.get(dimsKey(s.dimsL, s.dimsW, s.dimsH));
      if (match) return match.id;
    }
    return null;
  }

  let generated = 0;
  let skipped = 0;

  // Collect ALL line-item rows across every shipment first, then run a
  // single batched INSERT at the end. Previous per-row insert + ON
  // CONFLICT DO NOTHING loop was the bottleneck (16K round-trips over a
  // 3,267-shipment generate). Batched upsert turns that into ~32
  // round-trips (chunks of 500).
  type LineRow = {
    clientId: number;
    orderId: number | null;
    orderNumber: string | null;
    shipmentId: number | null;
    shipDate: Date | null;
    lineType: string;
    description: string;
    qty: string;
    unitCost: string;
    totalCost: string;
  };
  const allRows: LineRow[] = [];

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

    const rows: LineRow[] = [];

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

    // ─── Additional-unit fee (gap B1) ───────────────────────────────────────
    // Every unit past pickPackMaxUnits on the order is billed at
    // additionalUnitFee each. Threshold is now per-client (was hardcoded);
    // defaults to 1 via schema default and the constant below as a belt-and-
    // braces fallback for any row missing the column.
    const additionalUnitFee = toNum(cfg.additionalUnitFee);
    const maxUnits =
      typeof cfg.pickPackMaxUnits === 'number' && cfg.pickPackMaxUnits > 0
        ? cfg.pickPackMaxUnits
        : PICK_PACK_MAX_UNITS_DEFAULT;
    const items =
      s.orderId !== null ? orderItemsById.get(s.orderId) ?? [] : [];
    const totalUnits = totalUnitsFromItems(items);
    if (totalUnits > maxUnits && additionalUnitFee > 0) {
      const extraUnits = totalUnits - maxUnits;
      const extraCost = extraUnits * additionalUnitFee;
      rows.push({
        clientId: s.clientId,
        orderId: s.orderId,
        orderNumber: s.orderNumber,
        shipmentId: s.id,
        shipDate: s.shipDate,
        lineType: 'additional_unit',
        description: `Additional units (×${extraUnits})`,
        qty: String(extraUnits),
        unitCost: additionalUnitFee.toFixed(2),
        totalCost: extraCost.toFixed(2),
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

    // ─── Package cost (gap B2) ──────────────────────────────────────────────
    // Resolve which custom package was used on this shipment (selectedPid →
    // selectedPackageId → dims match), look up the client's price for it,
    // then emit a package_cost line. packageCostMarkup on the billing config
    // is applied as a percent on top of the base price.
    const resolvedPkgId = resolvePackageId(s);
    if (resolvedPkgId != null) {
      const basePrice = pricesByClient.get(s.clientId)?.get(resolvedPkgId);
      if (basePrice != null && basePrice > 0) {
        const markupPct = toNum(cfg.packageCostMarkup);
        const effectivePrice = basePrice * (1 + markupPct / 100);
        const pkgName =
          packagesById.get(resolvedPkgId)?.name ?? `Box #${resolvedPkgId}`;
        rows.push({
          clientId: s.clientId,
          orderId: s.orderId,
          orderNumber: s.orderNumber,
          shipmentId: s.id,
          shipDate: s.shipDate,
          lineType: 'package_cost',
          description: `Box (${pkgName})`,
          qty: '1',
          unitCost: effectivePrice.toFixed(2),
          totalCost: effectivePrice.toFixed(2),
        });
      }
    }

    // Collect for batch insert instead of inserting one at a time.
    for (const row of rows) allRows.push(row);
  }

  // Batch INSERT in chunks of 500 with ON CONFLICT DO NOTHING. The unique
  // constraint (order_id, line_type, description) still guards against
  // duplicates, so re-running the generate is idempotent.
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    try {
      await db
        .insert(billingLineItems)
        .values(chunk)
        .onConflictDoNothing({
          target: [
            billingLineItems.orderId,
            billingLineItems.lineType,
            billingLineItems.description,
          ],
        });
      generated += chunk.length;
    } catch {
      // Fall back to per-row to isolate which row poisoned the chunk.
      for (const row of chunk) {
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
  }

  // ─── Storage fees (once per client per billing period) ──────────────────────
  // v2 charged storage per cuft/month on current inventory on hand. v4
  // approximates: for each client with storageFeePerCuFt > 0, compute
  // SUM(stock_qty × cuFt_per_unit) × feeRate, emitted as one line item
  // dated at the period's end.
  const periodEnd = new Date(input.dateTo);
  for (const [clientId, cfg] of configByClient.entries()) {
    const storageRate = toNum(cfg.storageFeePerCuFt ?? 0);
    if (storageRate <= 0) continue;
    if (cfg.active === false) continue;

    const invRows = await db.execute<{
      total_cuft: string | number | null;
    }>(sql`
      select
        coalesce(sum(
          case
            when coalesce(cu_ft_override, 0) > 0 then stock_qty * cu_ft_override
            when length > 0 and width > 0 and height > 0
              then stock_qty * ((length * width * height) / 1728.0)
            else 0
          end
        ), 0)::numeric(14,4) as total_cuft
      from inventory
      where client_id = ${clientId}
        and active = true
        and stock_qty > 0
    `);
    const totalCuFt = Number(invRows[0]?.total_cuft ?? 0);
    if (totalCuFt <= 0) continue;
    const fee = totalCuFt * storageRate;
    if (fee <= 0) continue;

    try {
      await db
        .insert(billingLineItems)
        .values({
          clientId,
          orderId: null,
          orderNumber: null,
          shipmentId: null,
          shipDate: periodEnd,
          lineType: 'storage',
          description: `Storage — ${totalCuFt.toFixed(2)} cuft × $${storageRate.toFixed(4)}/cuft`,
          qty: totalCuFt.toFixed(2),
          unitCost: storageRate.toFixed(4),
          totalCost: fee.toFixed(2),
        })
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
    pickPackMaxUnits: number;
    additionalUnitFee: string;
    packageCostMarkup: string;
    shippingMarkupPct: string;
    shippingMarkupFlat: string;
    storageFeePerCuFt: string;
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
