import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import {
  billingConfig,
  billingLineItems,
  clientPackagePrices,
} from '../db/schema/billing';
import { shipments } from '../db/schema/shipments';
import { orderOverrides, orders } from '../db/schema/orders';
import { packages } from '../db/schema/packages';
import { clients } from '../db/schema/clients';
import { inventory } from '../db/schema/inventory';
import { SS_BASELINE_CARRIER_CODES } from './rates';
import { resolveCarrierNickname } from './labels';
import {
  getFreshBillingSummaryMetrics,
  refreshBillingSummaryMetrics,
} from './reporting-metrics';

export type GenerateInput = {
  clientId?: number;
  dateFrom: string; // ISO
  dateTo: string; // ISO
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeRestricted?: boolean;
};

export type BillingGenerationStatus = {
  upToDate: boolean;
  dateFrom: string;
  dateTo: string;
  clientId?: number;
  latestBillingShipDate: string | null;
  latestSourceShipDate: string | null;
  missingFrom: string | null;
  missingTo: string | null;
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

function billingSummaryHasValues(summary: { clients: BillingSummaryRow[] }): boolean {
  return summary.clients.some(
    (row) =>
      row.orderCount > 0 ||
      row.pickPackTotal > 0 ||
      row.additionalTotal > 0 ||
      row.packageTotal > 0 ||
      row.shippingTotal > 0 ||
      row.storageTotal > 0 ||
      row.grandTotal > 0
  );
}

function normalizeScopeIds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function intArraySql(values: number[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::int[]`;
}

function billingClientScopePredicate(input: GenerateInput): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(input.scopeClientIds);
  const storeIds = normalizeScopeIds(input.scopeStoreIds);

  if (clientIds.length) {
    predicates.push(sql`c.id = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`c.store_ids && ${intArraySql(storeIds)}`);
  }
  if (!predicates.length) {
    return input.scopeRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function billingLineItemScopePredicate(input: GenerateInput): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(input.scopeClientIds);
  const storeIds = normalizeScopeIds(input.scopeStoreIds);

  if (clientIds.length) {
    predicates.push(sql`${billingLineItems.clientId} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients scoped_client
      where scoped_client.id = ${billingLineItems.clientId}
        and scoped_client.store_ids && ${intArraySql(storeIds)}
    )`);
  }
  if (!predicates.length) {
    return input.scopeRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function isoDayStart(value: Date): string {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  ).toISOString();
}

function isoDayEnd(value: Date): string {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      23,
      59,
      59,
      999
    )
  ).toISOString();
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export async function billingGenerationStatus(
  input: GenerateInput
): Promise<BillingGenerationStatus> {
  const fromIso = new Date(input.dateFrom).toISOString();
  const toIso = new Date(input.dateTo).toISOString();

  const [billingRow] = await db.execute<{
    latest_billing_ship_date: string | null;
  }>(sql`
    select max(b.ship_date)::text as latest_billing_ship_date
    from billing_line_items b
    where b.ship_date >= ${fromIso}::timestamptz
      and b.ship_date <= ${toIso}::timestamptz
      and b.order_id is not null
      ${input.clientId !== undefined ? sql`and b.client_id = ${input.clientId}` : sql``}
      and ${billingLineItemScopePredicate(input)}
  `);

  const latestBilling = billingRow?.latest_billing_ship_date
    ? new Date(billingRow.latest_billing_ship_date)
    : null;

  const sourceLowerBound = latestBilling?.toISOString() ?? fromIso;
  const [sourceRow] = await db.execute<{
    latest_source_ship_date: string | null;
  }>(sql`
    with scoped_clients as (
      select c.id, c.store_ids
      from clients c
      where c.active = true
        and c.name not in ('Manual Orders', 'Rate Browser', 'Api Shipments')
        ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
        and ${billingClientScopePredicate(input)}
    )
    select max(coalesce(s.ship_date, o.order_date))::text as latest_source_ship_date
    from orders o
    left join shipments s on s.order_id = o.id and s.voided = false
    where o.order_status = 'shipped'
      and o.externally_shipped = false
      and coalesce(o.raw->>'externallyFulfilled', 'false') <> 'true'
      and coalesce(s.ship_date, o.order_date) <= ${toIso}::timestamptz
      ${latestBilling
        ? sql`and coalesce(s.ship_date, o.order_date) > ${sourceLowerBound}::timestamptz`
        : sql`and coalesce(s.ship_date, o.order_date) >= ${sourceLowerBound}::timestamptz`}
      and exists (
        select 1
        from scoped_clients sc
        where o.client_id = sc.id
           or (o.store_id is not null and o.store_id = any(sc.store_ids))
           or (
             coalesce(
               case
                 when coalesce(o.raw->>'storeId', '') ~ '^[0-9]+$'
                   then (o.raw->>'storeId')::int
                 else null
               end,
               case
                 when coalesce(o.raw->'advancedOptions'->>'storeId', '') ~ '^[0-9]+$'
                   then (o.raw->'advancedOptions'->>'storeId')::int
                 else null
               end
             ) = any(sc.store_ids)
           )
      )
  `);

  const latestSource = sourceRow?.latest_source_ship_date
    ? new Date(sourceRow.latest_source_ship_date)
    : null;

  if (!latestSource) {
    return {
      upToDate: true,
      dateFrom: fromIso,
      dateTo: toIso,
      clientId: input.clientId,
      latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
      latestSourceShipDate: billingRow?.latest_billing_ship_date ?? null,
      missingFrom: null,
      missingTo: null,
    };
  }

  const from = new Date(fromIso);
  const latestBillingDay = latestBilling ? isoDayStart(latestBilling) : null;
  const latestSourceDay = isoDayStart(latestSource);
  const missingFrom =
    !latestBilling
      ? isoDayStart(from)
      : latestBillingDay === latestSourceDay
        ? latestBillingDay
        : isoDayStart(addUtcDays(latestBilling, 1));

  return {
    upToDate: false,
    dateFrom: fromIso,
    dateTo: toIso,
    clientId: input.clientId,
    latestBillingShipDate: billingRow?.latest_billing_ship_date ?? null,
    latestSourceShipDate: sourceRow?.latest_source_ship_date ?? null,
    missingFrom,
    missingTo: isoDayEnd(latestSource),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function itemSkuOrFallback(record: Record<string, unknown>): string | null {
  const sku =
    stringOrNull(record.sku) ??
    stringOrNull(record.fulfillmentSku) ??
    stringOrNull(record.warehouseLocation);
  if (sku) return sku;

  const productId = toFiniteNumber(record.productId);
  return productId != null ? String(Math.trunc(productId)) : null;
}

function providerAccountIdOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized =
    typeof value === 'string' ? value.replace(/^se-/i, '') : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemSummary(items: unknown) {
  if (!Array.isArray(items)) {
    return { itemNames: null, itemSkus: null, totalQty: null };
  }

  const names: string[] = [];
  const skus: string[] = [];
  let totalQty = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.adjustment === true) continue;

    const name = stringOrNull(record.name);
    const sku = itemSkuOrFallback(record);
    const qty = toFiniteNumber(record.quantity) ?? 1;

    if (name) names.push(name);
    if (sku) skus.push(sku);
    if (qty > 0) totalQty += qty;
  }

  return {
    itemNames: names.length ? [...new Set(names)].join(' | ') : null,
    itemSkus: skus.length ? [...new Set(skus)].join(' | ') : null,
    totalQty: totalQty > 0 ? totalQty : null,
  };
}

function dimsKey(length: unknown, width: unknown, height: unknown) {
  const l = toFiniteNumber(length);
  const w = toFiniteNumber(width);
  const h = toFiniteNumber(height);
  if (l == null || w == null || h == null || l <= 0 || w <= 0 || h <= 0) {
    return null;
  }
  return `${l}x${w}x${h}`;
}

function dimsLabel(length: unknown, width: unknown, height: unknown) {
  const key = dimsKey(length, width, height);
  return key ? `${key} in` : null;
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
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Match /billing/config: active clients without a billing_config row still
  // generate with defaults, otherwise a fresh install has visible clients but
  // "Generate Invoices" finds no configs and produces an empty summary.
  const configs = await db.execute<{
    clientId: number;
    pickPackFee: string;
    pickPackMaxUnits: number;
    additionalUnitFee: string;
    packageCostMarkup: string;
    shippingMarkupPct: string;
    shippingMarkupFlat: string;
    storageFeePerCuFt: string;
    billingMode: string;
    active: boolean;
  }>(sql`
    select
      c.id as "clientId",
      coalesce(b.pick_pack_fee, '0'::numeric)::text as "pickPackFee",
      coalesce(b.pick_pack_max_units, 1)::int as "pickPackMaxUnits",
      coalesce(b.additional_unit_fee, '0'::numeric)::text as "additionalUnitFee",
      coalesce(b.package_cost_markup, '0'::numeric)::text as "packageCostMarkup",
      coalesce(b.shipping_markup_pct, '0'::numeric)::text as "shippingMarkupPct",
      coalesce(b.shipping_markup_flat, '0'::numeric)::text as "shippingMarkupFlat",
      coalesce(b.storage_fee_per_cu_ft, '0'::numeric)::text as "storageFeePerCuFt",
      coalesce(b.billing_mode, 'per_shipment') as "billingMode",
      coalesce(b.active, true) as active
    from clients c
    left join billing_config b on b.client_id = c.id
    where c.active = true
      and c.name not in ('Manual Orders', 'Rate Browser', 'Api Shipments')
      and coalesce(b.active, true) = true
      ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
    order by c.name asc
  `);
  if (!configs.length) {
    return {
      generated: 0,
      count: 0,
      total: 0,
      skipped: 0,
      message: 'No billing configs found',
    };
  }

  const configByClient = new Map(configs.map((c) => [c.clientId, c]));

  const clientRows = await db
    .select({ id: clients.id, storeIds: clients.storeIds })
    .from(clients);
  const clientByStore = new Map<number, number>();
  for (const c of clientRows) {
    for (const storeId of c.storeIds ?? []) {
      clientByStore.set(storeId, c.id);
    }
  }

  const orderShipmentRows = await db
    .select({
      shipmentId: shipments.id,
      shipmentClientId: shipments.clientId,
      shipDate: shipments.shipDate,
      labelCost: shipments.labelCost,
      cost: shipments.cost,
      otherCost: shipments.otherCost,
      carrierCode: shipments.carrierCode,
      selectedPid: shipments.selectedPid,
      selectedPackageId: shipments.selectedPackageId,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
      refUspsRate: orderOverrides.refUspsRate,
      refUpsRate: orderOverrides.refUpsRate,
      rateDimsL: orderOverrides.rateDimsL,
      rateDimsW: orderOverrides.rateDimsW,
      rateDimsH: orderOverrides.rateDimsH,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderClientId: orders.clientId,
      orderDate: orders.orderDate,
      orderStoreId: orders.storeId,
      orderItems: orders.items,
      orderRaw: orders.raw,
    })
    .from(orders)
    .leftJoin(
      shipments,
      and(eq(shipments.orderId, orders.id), eq(shipments.voided, false))
    )
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(
      and(
        eq(orders.orderStatus, 'shipped'),
        eq(orders.externallyShipped, false),
        sql`coalesce(${orders.raw}->>'externallyFulfilled', 'false') <> 'true'`,
        sql`coalesce(${shipments.shipDate}, ${orders.orderDate}) >= ${fromIso}::timestamptz`,
        sql`coalesce(${shipments.shipDate}, ${orders.orderDate}) <= ${toIso}::timestamptz`
      )
    );

  function rawStoreId(
    raw: Record<string, unknown>,
    orderStoreId: number | null
  ): number | null {
    if (orderStoreId !== null) return orderStoreId;
    const advanced =
      raw.advancedOptions && typeof raw.advancedOptions === 'object'
        ? (raw.advancedOptions as Record<string, unknown>)
        : {};
    const rawStore = advanced.storeId ?? raw.storeId;
    const n = Number(rawStore);
    return Number.isFinite(n) ? n : null;
  }

  type BillableRow = {
    id: number | null;
    orderId: number | null;
    orderNumber: string | null;
    clientId: number | null;
    shipDate: Date | null;
    labelCost: string | null;
    cost: string | null;
    otherCost: string | null;
    carrierCode: string | null;
    selectedPid: number | null;
    selectedPackageId: string | null;
    dimsL: number | null;
    dimsW: number | null;
    dimsH: number | null;
    rateDimsL: number | null;
    rateDimsW: number | null;
    rateDimsH: number | null;
    refUspsRate: string | null;
    refUpsRate: string | null;
    items: unknown[];
  };

  const billableRows: BillableRow[] = orderShipmentRows
    .map((row) => {
      const storeId = rawStoreId(row.orderRaw ?? {}, row.orderStoreId ?? null);
      const clientId =
        (storeId !== null ? clientByStore.get(storeId) ?? null : null) ??
        row.orderClientId ??
        row.shipmentClientId ??
        null;
      return {
        id: row.shipmentId,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        clientId,
        shipDate: row.shipDate ?? row.orderDate,
        labelCost: row.labelCost,
        cost: row.cost,
        otherCost: row.otherCost,
        carrierCode: row.carrierCode,
        selectedPid: row.selectedPid,
        selectedPackageId: row.selectedPackageId,
        dimsL: row.dimsL,
        dimsW: row.dimsW,
        dimsH: row.dimsH,
        refUspsRate: row.refUspsRate,
        refUpsRate: row.refUpsRate,
        rateDimsL: row.rateDimsL,
        rateDimsW: row.rateDimsW,
        rateDimsH: row.rateDimsH,
        items: Array.isArray(row.orderItems) ? row.orderItems : [],
      };
    })
    .filter(
      (row) =>
        row.shipDate !== null &&
        (input.clientId === undefined || row.clientId === input.clientId)
    );

  if (!billableRows.length) {
    return {
      generated: 0,
      count: 0,
      total: 0,
      skipped: 0,
      message: 'No billable shipped orders or shipments found for this range.',
    };
  }

  // Rebuild the requested billing period only after we know the source query
  // has billable rows. That protects existing summaries if a transient query
  // problem happens during generation.
  await db.delete(billingLineItems).where(
    and(
      sql`${billingLineItems.shipDate} >= ${fromIso}::timestamptz`,
      sql`${billingLineItems.shipDate} <= ${toIso}::timestamptz`,
      input.clientId !== undefined
        ? eq(billingLineItems.clientId, input.clientId)
        : undefined
    )
  );

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
  const packagesByRoundedDims = new Map<string, PkgRow>();
  const dimsKey = (l: number, w: number, h: number): string =>
    `${l}×${w}×${h}`;
  const roundedDimsKey = (l: number, w: number, h: number): string =>
    `${Math.round(l)}x${Math.round(w)}x${Math.round(h)}`;
  for (const p of allPackages) {
    packagesById.set(p.id, p);
    if (p.packageCode) packagesByCode.set(p.packageCode, p);
    if (p.length > 0 && p.width > 0 && p.height > 0) {
      packagesByDims.set(dimsKey(p.length, p.width, p.height), p);
      packagesByRoundedDims.set(roundedDimsKey(p.length, p.width, p.height), p);
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

  const skuPackageRows = await db
    .select({
      clientId: inventory.clientId,
      sku: inventory.sku,
      packageId: inventory.packageId,
    })
    .from(inventory)
    .where(eq(inventory.active, true));
  const packageByClientSku = new Map<string, number>();
  const packageBySku = new Map<string, number>();
  for (const row of skuPackageRows) {
    if (row.packageId === null) continue;
    if (row.clientId !== null) {
      packageByClientSku.set(`${row.clientId}:${row.sku}`, row.packageId);
    }
    if (!packageBySku.has(row.sku)) packageBySku.set(row.sku, row.packageId);
  }

  function packageIdFromItems(items: unknown[], clientId: number): number | null {
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if ((it as { adjustment?: unknown }).adjustment === true) continue;
      const sku = (it as { sku?: unknown }).sku;
      if (typeof sku !== 'string' || !sku) continue;
      const packageId =
        packageByClientSku.get(`${clientId}:${sku}`) ?? packageBySku.get(sku);
      if (packageId != null && packagesById.has(packageId)) return packageId;
    }
    return null;
  }

  function resolvePackageId(s: {
    clientId: number;
    items: unknown[];
    selectedPid: number | null;
    selectedPackageId: string | null;
    dimsL: number | null;
    dimsW: number | null;
    dimsH: number | null;
    rateDimsL: number | null;
    rateDimsW: number | null;
    rateDimsH: number | null;
  }): number | null {
    // v2 resolves billed box cost from SKU first, then shipment dims, then
    // reference-rate dims. Selected package fields are only a v4 fallback.
    {
      const packageId = packageIdFromItems(s.items, s.clientId);
      if (packageId != null) return packageId;
    }
    if (s.dimsL != null && s.dimsW != null && s.dimsH != null) {
      const exact = packagesByDims.get(dimsKey(s.dimsL, s.dimsW, s.dimsH));
      if (exact) return exact.id;
      const rounded = packagesByRoundedDims.get(
        roundedDimsKey(s.dimsL, s.dimsW, s.dimsH)
      );
      if (rounded) return rounded.id;
    }
    if (s.rateDimsL != null && s.rateDimsW != null && s.rateDimsH != null) {
      const exact = packagesByDims.get(dimsKey(s.rateDimsL, s.rateDimsW, s.rateDimsH));
      if (exact) return exact.id;
      const rounded = packagesByRoundedDims.get(
        roundedDimsKey(s.rateDimsL, s.rateDimsW, s.rateDimsH)
      );
      if (rounded) return rounded.id;
    }
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
    const bySku = packageIdFromItems(s.items, s.clientId);
    if (bySku != null) return bySku;
    // 3. Exact dims match (v2 makeDimsKey parity — unsorted, verbatim).
    if (s.dimsL != null && s.dimsW != null && s.dimsH != null) {
      const match = packagesByDims.get(dimsKey(s.dimsL, s.dimsW, s.dimsH));
      if (match) return match.id;
    }
    return null;
  }

  let generated = 0;
  let skipped = 0;
  let total = 0;

  // Collect ALL line-item rows across every billable shipped order first, then run a
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

  for (const s of billableRows) {
    if (s.clientId === null) {
      skipped += 1;
      continue;
    }
    const clientId = s.clientId;
    const cfg = configByClient.get(clientId);
    if (!cfg) {
      skipped += 1;
      continue;
    }

    const rows: LineRow[] = [];

    const pickPackFee = toNum(cfg.pickPackFee);
    if (pickPackFee > 0) {
      rows.push({
        clientId,
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
    const items = Array.isArray(s.items) ? s.items : [];
    const totalUnits = totalUnitsFromItems(items);
    if (totalUnits > maxUnits && additionalUnitFee > 0) {
      const extraUnits = totalUnits - maxUnits;
      const extraCost = extraUnits * additionalUnitFee;
      rows.push({
        clientId,
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

    // v2 bills shipmentCost + otherCost from the synced shipment row. In v4
    // that source column is `cost`; `labelCost` is only a fallback for rows
    // created before the synced cost was available.
    const labelCost = (toNum(s.cost) || toNum(s.labelCost)) + toNum(s.otherCost);
    if (labelCost > 0) {
      let billedCost = labelCost;
      const billingMode = cfg.billingMode ?? 'label_cost';
      if (
        (billingMode === 'reference_rate' || billingMode === 'ss_ref_rate') &&
        !SS_BASELINE_CARRIER_CODES.has(s.carrierCode ?? '')
      ) {
        const referenceCandidates = [toNum(s.refUspsRate), toNum(s.refUpsRate)].filter(
          (value) => value > 0
        );
        if (referenceCandidates.length > 0) {
          billedCost = Math.max(labelCost, Math.min(...referenceCandidates));
        }
      }
      const pct = toNum(cfg.shippingMarkupPct);
      const flat = toNum(cfg.shippingMarkupFlat);
      const shipCost = billedCost * (1 + pct / 100) + flat;
      rows.push({
        clientId,
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
    const resolvedPkgId = resolvePackageId({ ...s, clientId });
    if (resolvedPkgId != null) {
      const basePrice = pricesByClient.get(clientId)?.get(resolvedPkgId);
      if (basePrice != null && basePrice > 0) {
        const markupPct = toNum(cfg.packageCostMarkup);
        const effectivePrice = basePrice * (1 + markupPct / 100);
        const pkgName =
          packagesById.get(resolvedPkgId)?.name ?? `Box #${resolvedPkgId}`;
        rows.push({
          clientId,
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
    for (const row of rows) {
      allRows.push(row);
      total += toNum(row.totalCost);
    }
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
      total += fee;
    } catch {
      skipped += 1;
    }
  }

  let billingSummaryMetricsRows: number | null = null;
  try {
    billingSummaryMetricsRows = await refreshBillingSummaryMetrics(
      new Date(input.dateFrom),
      new Date(input.dateTo)
    );
  } catch (err) {
    console.warn(
      '[billing] generated line items but failed to refresh summary metrics:',
      err instanceof Error ? err.message : err
    );
  }

  return {
    generated,
    count: generated,
    total,
    skipped,
    billingSummaryMetricsRows,
    message: `Generated ${generated} line items from ${billableRows.length} billable shipments/orders.`,
  };
}

export type BillingSummaryRow = {
  clientId: number;
  clientName: string;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  fulfillmentFeeTotal: number;
  orderCount: number;
  grandTotal: number;
  // Back-compat fields for legacy callers of the old shape.
  total: number;
  count: number;
  byType: Record<string, number>;
};

async function hasBillingLineItemsForSummary(input: GenerateInput): Promise<boolean> {
  const [row] = await db.execute<{ exists: boolean }>(sql`
    select exists (
      select 1
      from billing_line_items
      where ship_date >= ${input.dateFrom}::timestamptz
        and ship_date <= ${input.dateTo}::timestamptz
        ${input.clientId !== undefined ? sql`and client_id = ${input.clientId}` : sql``}
        and ${billingLineItemScopePredicate(input)}
      limit 1
    ) as exists
  `);
  return row?.exists === true;
}

export async function billingSummary(
  input: GenerateInput
): Promise<{ clients: BillingSummaryRow[]; grandTotal: number }> {
  let hasGeneratedRows: boolean | null = null;
  const hasLineItems = async () => {
    if (hasGeneratedRows === null) {
      hasGeneratedRows = await hasBillingLineItemsForSummary(input);
    }
    return hasGeneratedRows;
  };

  const metrics = await getFreshBillingSummaryMetrics({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    clientId: input.clientId,
    scopeClientIds: input.scopeClientIds,
    scopeStoreIds: input.scopeStoreIds,
    scopeRestricted: input.scopeRestricted,
    maxAgeMinutes: 45,
  }).catch((err) => {
    console.warn(
      '[billing] summary reporting metrics unavailable:',
      err instanceof Error ? err.message : err
    );
    return null;
  });
  if (metrics && billingSummaryHasValues(metrics)) return metrics;

  if (metrics && !(await hasLineItems())) return metrics;

  if (!metrics || !billingSummaryHasValues(metrics)) {
    if (await hasLineItems()) {
      try {
        await refreshBillingSummaryMetrics(
          new Date(input.dateFrom),
          new Date(input.dateTo)
        );
        const refreshedMetrics = await getFreshBillingSummaryMetrics({
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          clientId: input.clientId,
          scopeClientIds: input.scopeClientIds,
          scopeStoreIds: input.scopeStoreIds,
          scopeRestricted: input.scopeRestricted,
          maxAgeMinutes: 45,
        });
        if (refreshedMetrics) return refreshedMetrics;
      } catch (err) {
        console.warn(
          '[billing] failed to refresh stale summary metrics:',
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  const useLiveFallback =
    process.env.BILLING_SUMMARY_LIVE_FALLBACK === 'true' || (await hasLineItems());
  if (!useLiveFallback) {
    const clientRows = await db.execute<{
      client_id: number;
      client_name: string;
    }>(sql`
      select
        c.id as client_id,
        c.name as client_name
      from clients c
      where c.active = true
        and c.name not in ('Manual Orders', 'Rate Browser', 'Api Shipments')
        ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
        and ${billingClientScopePredicate(input)}
      order by c.name asc
    `);

    return {
      clients: clientRows.map((row) => ({
        clientId: row.client_id,
        clientName: row.client_name,
        pickPackTotal: 0,
        additionalTotal: 0,
        pickPackFeeTotal: 0,
        packageTotal: 0,
        shippingTotal: 0,
        storageTotal: 0,
        fulfillmentFeeTotal: 0,
        orderCount: 0,
        grandTotal: 0,
        total: 0,
        count: 0,
        byType: {
          pick_pack: 0,
          additional_unit: 0,
          package_cost: 0,
          shipping: 0,
          storage: 0,
        },
      })),
      grandTotal: 0,
    };
  }

  // v2-parity aggregation. Starts from `clients` with a LEFT JOIN to
  // billing_line_items so every active, non-system client surfaces — even
  // those with zero volume in the window (HUGRAB, KimlyParc, IntegrationTest,
  // the TEST_* sandboxes). The previous version aggregated from
  // billing_line_items alone, dropping zero-volume clients entirely and
  // causing the Summary grid to look half-empty vs. v2.
  //
  // Totals are filtered SUMs per line_type; orderCount counts distinct billed
  // orders from any order-backed line so clients with $0 pick/pack defaults
  // still show order volume when shipping lines were generated.
  const rows = await db.execute<{
    client_id: number;
    client_name: string;
    pickpack_total: string;
    additional_total: string;
    package_total: string;
    shipping_total: string;
    storage_total: string;
    order_count: number;
    grand_total: string;
  }>(sql`
    select
      c.id as client_id,
      c.name as client_name,
      coalesce(sum(case when b.line_type = 'pick_pack' then b.total_cost else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when b.line_type = 'additional_unit' then b.total_cost else 0 end), 0)::text as additional_total,
      coalesce(sum(case when b.line_type = 'package_cost' then b.total_cost else 0 end), 0)::text as package_total,
      coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::text as shipping_total,
      coalesce(sum(case when b.line_type = 'storage' then b.total_cost else 0 end), 0)::text as storage_total,
      count(distinct b.order_id)::int as order_count,
      coalesce(sum(b.total_cost), 0)::text as grand_total
    from clients c
    left join billing_line_items b
      on b.client_id = c.id
      and b.ship_date >= ${input.dateFrom}::timestamptz
      and b.ship_date <= ${input.dateTo}::timestamptz
    where c.active = true
      and c.name not in ('Manual Orders', 'Rate Browser', 'Api Shipments')
      ${input.clientId !== undefined ? sql`and c.id = ${input.clientId}` : sql``}
      and ${billingClientScopePredicate(input)}
    group by c.id, c.name
    order by c.name asc
  `);

  const clientsOut: BillingSummaryRow[] = rows.map((r) => {
    const pickPackTotal = toNum(r.pickpack_total);
    const additionalTotal = toNum(r.additional_total);
    const packageTotal = toNum(r.package_total);
    const shippingTotal = toNum(r.shipping_total);
    const storageTotal = toNum(r.storage_total);
    const grandTotal = toNum(r.grand_total);
    const pickPackFeeTotal = pickPackTotal + additionalTotal;
    const fulfillmentFeeTotal =
      shippingTotal + pickPackFeeTotal + packageTotal + storageTotal;
    return {
      clientId: r.client_id,
      clientName: r.client_name,
      pickPackTotal,
      additionalTotal,
      pickPackFeeTotal,
      packageTotal,
      shippingTotal,
      storageTotal,
      fulfillmentFeeTotal,
      orderCount: Number(r.order_count ?? 0),
      grandTotal,
      total: grandTotal,
      count: Number(r.order_count ?? 0),
      byType: {
        pick_pack: pickPackTotal,
        additional_unit: additionalTotal,
        package_cost: packageTotal,
        shipping: shippingTotal,
        storage: storageTotal,
      },
    };
  });

  return {
    clients: clientsOut,
    grandTotal: clientsOut.reduce((sum, c) => sum + c.grandTotal, 0),
  };
}

export async function billingDetails(input: GenerateInput & { limit?: number }) {
  const from = new Date(input.dateFrom);
  const to = new Date(input.dateTo);
  const rows = await db
    .select({
      id: billingLineItems.id,
      clientId: billingLineItems.clientId,
      orderId: billingLineItems.orderId,
      orderNumber: billingLineItems.orderNumber,
      shipmentId: billingLineItems.shipmentId,
      shipDate: billingLineItems.shipDate,
      lineType: billingLineItems.lineType,
      description: billingLineItems.description,
      qty: billingLineItems.qty,
      unitCost: billingLineItems.unitCost,
      totalCost: billingLineItems.totalCost,
      invoiced: billingLineItems.invoiced,
      createdAt: billingLineItems.createdAt,
      carrierCode: shipments.carrierCode,
      providerAccountId: shipments.providerAccountId,
      labelProvider: shipments.labelProvider,
      trackingNumber: shipments.trackingNumber,
      providerAccountNickname: shipments.providerAccountNickname,
      selectedRateJson: shipments.selectedRateJson,
      selectedPackageId: shipments.selectedPackageId,
      selectedPid: shipments.selectedPid,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
      labelCost: shipments.labelCost,
      cost: shipments.cost,
      otherCost: shipments.otherCost,
      orderItems: orders.items,
      refUspsRate: orderOverrides.refUspsRate,
      refUpsRate: orderOverrides.refUpsRate,
    })
    .from(billingLineItems)
    .leftJoin(shipments, eq(billingLineItems.shipmentId, shipments.id))
    .leftJoin(orders, eq(billingLineItems.orderId, orders.id))
    .leftJoin(orderOverrides, eq(billingLineItems.orderId, orderOverrides.orderId))
    .where(
      and(
        gte(billingLineItems.shipDate, from),
        lte(billingLineItems.shipDate, to),
        input.clientId !== undefined
          ? eq(billingLineItems.clientId, input.clientId)
          : undefined,
        billingLineItemScopePredicate(input)
      )
    )
    .orderBy(desc(billingLineItems.shipDate), desc(billingLineItems.id))
    .limit(input.limit ?? 2000);

  const packageRows = await db
    .select({
      id: packages.id,
      name: packages.name,
      packageCode: packages.packageCode,
      length: packages.length,
      width: packages.width,
      height: packages.height,
    })
    .from(packages);
  const packagesById = new Map(packageRows.map((pkg) => [pkg.id, pkg]));
  const packagesByCode = new Map(
    packageRows
      .filter((pkg) => pkg.packageCode)
      .map((pkg) => [pkg.packageCode!, pkg])
  );
  const packagesByDims = new Map(
    packageRows
      .map((pkg) => [dimsKey(pkg.length, pkg.width, pkg.height), pkg] as const)
      .filter((entry): entry is [string, (typeof packageRows)[number]] => Boolean(entry[0]))
  );
  const nicknameCache = new Map<string, Promise<string | null>>();

  return Promise.all(
    rows.map(async (row) => {
      const selectedRate =
        row.selectedRateJson && typeof row.selectedRateJson === 'object'
          ? (row.selectedRateJson as Record<string, unknown>)
          : null;

      const providerAccountId =
        row.providerAccountId ??
        row.labelProvider ??
        providerAccountIdOrNull(
          selectedRate?.providerAccountId ??
            selectedRate?.shippingProviderId ??
            selectedRate?.carrier_id
        );
      const carrierCode =
        row.carrierCode ??
        stringOrNull(selectedRate?.carrierCode ?? selectedRate?.carrier_code);
      const storedNickname =
        row.providerAccountNickname ??
        stringOrNull(
          selectedRate?.providerAccountNickname ??
            selectedRate?.carrierNickname ??
            selectedRate?.carrier_nickname
        );

      let carrierNickname = storedNickname;
      if (!carrierNickname && carrierCode) {
        const cacheKey = `${providerAccountId ?? 'none'}:${carrierCode}`;
        let pending = nicknameCache.get(cacheKey);
        if (!pending) {
          pending = resolveCarrierNickname(
            providerAccountId ?? null,
            carrierCode,
            row.trackingNumber,
            row.clientId
          );
          nicknameCache.set(cacheKey, pending);
        }
        carrierNickname = await pending;
      }

      const items = itemSummary(row.orderItems);
      const lineType = row.lineType ?? '';
      const isShippingLine = lineType === 'shipping';
      const labelCost =
        toFiniteNumber(row.labelCost) ??
        (() => {
          const cost = toFiniteNumber(row.cost);
          if (cost == null) return null;
          return cost + (toFiniteNumber(row.otherCost) ?? 0);
        })();
      const refUspsRate = toFiniteNumber(row.refUspsRate);
      const refUpsRate = toFiniteNumber(row.refUpsRate);
      const selectedPackageNumericId = providerAccountIdOrNull(row.selectedPackageId);
      const selectedPackage =
        (row.selectedPid != null ? packagesById.get(row.selectedPid) : undefined) ??
        (selectedPackageNumericId != null ? packagesById.get(selectedPackageNumericId) : undefined) ??
        (row.selectedPackageId ? packagesByCode.get(row.selectedPackageId) : undefined) ??
        (dimsKey(row.dimsL, row.dimsW, row.dimsH)
          ? packagesByDims.get(dimsKey(row.dimsL, row.dimsW, row.dimsH)!)
          : undefined);
      const packageName =
        selectedPackage?.name ??
        row.description.match(/^Box\s+\((.+)\)$/i)?.[1] ??
        dimsLabel(row.dimsL, row.dimsW, row.dimsH);

      const {
        selectedRateJson: _selectedRateJson,
        labelProvider: _labelProvider,
        orderItems: _orderItems,
        labelCost: _labelCost,
        cost: _cost,
        otherCost: _otherCost,
        selectedPackageId: _selectedPackageId,
        selectedPid: _selectedPid,
        dimsL: _dimsL,
        dimsW: _dimsW,
        dimsH: _dimsH,
        refUspsRate: _refUspsRate,
        refUpsRate: _refUpsRate,
        ...rest
      } = row;
      return {
        ...rest,
        carrierCode,
        providerAccountId,
        providerAccountNickname: carrierNickname,
        carrierNickname: carrierNickname ?? carrierCode,
        itemNames: items.itemNames,
        itemSkus: items.itemSkus,
        totalQty: items.totalQty,
        packageName,
        actualLabelCost: isShippingLine ? labelCost : null,
        actual_label_cost: isShippingLine ? labelCost : null,
        refUspsRate: isShippingLine ? refUspsRate : null,
        ref_usps_rate: isShippingLine ? refUspsRate : null,
        refUpsRate: isShippingLine ? refUpsRate : null,
        ref_ups_rate: isShippingLine ? refUpsRate : null,
      };
    })
  );
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
