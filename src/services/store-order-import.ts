import { and, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { replaceOrderItemsForOrders } from './order-items';
import { materializePackageFactsForImportedOrderIds } from './combo-package-defaults';
import { enqueueBackfillBestRatesForOrderIds } from './rates-backfill';
import type { NormalizedOrderSource } from './normalized-order-persistence';
import {
  retainOrderRawForPersistence,
  retainOrderRawSourcePayloadForPersistence,
} from './order-raw-payload-policy';
import {
  legacyExternalOrderIdForSource,
  buildOrderSourceIdentity,
  legacyOrderSourceCompatibilityPredicate,
  orderSourceIdentityKey,
  orderSourceIdentitiesPredicate,
} from './order-source-identity';
import { enqueueInventoryDeduction } from './fulfillment/inventory-deduction-outbox';

export type NormalizedStoreOrder = {
  source: NormalizedOrderSource;
  externalOrderId?: string | null;
  orderNumber: string;
  orderStatus: string;
  orderDate: Date | null;
  clientId: number | null;
  storeId: number | null;
  customerEmail?: string | null;
  shipToName?: string | null;
  shipToCity?: string | null;
  shipToState?: string | null;
  shipToPostalCode?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  weightOz?: number | null;
  orderTotal?: string;
  shippingAmount?: string;
  items?: unknown[];
  raw: Record<string, unknown>;
  externallyShipped?: boolean;
};

function compatibilityExternalOrderId(order: NormalizedStoreOrder): string {
  if (order.externalOrderId) return order.externalOrderId;
  const identity = buildOrderSourceIdentity(order.source);
  if (!identity) {
    throw new Error('Cannot derive compatibility externalOrderId without a complete source identity');
  }
  return legacyExternalOrderIdForSource(identity);
}

export function dedupeNormalizedStoreOrdersForImport(
  ordersIn: NormalizedStoreOrder[],
): NormalizedStoreOrder[] {
  const passthrough: NormalizedStoreOrder[] = [];
  const bySourceIdentity = new Map<string, NormalizedStoreOrder>();

  for (const order of ordersIn) {
    const identity = buildOrderSourceIdentity(order.source);
    if (!identity) {
      passthrough.push(order);
      continue;
    }

    bySourceIdentity.set(orderSourceIdentityKey(identity), order);
  }

  return [...passthrough, ...bySourceIdentity.values()];
}

type ImportedOrderTotalSource =
  | 'shopify_current_total'
  | 'shopify_total'
  | 'provider_order_total'
  | 'existing_positive_preserved'
  | 'item_subtotal_fallback'
  | 'zero_proven'
  | 'zero_unproven';

export type ImportedOrderTotalResolutionInput = {
  incomingOrderTotal?: unknown;
  existingOrderTotal?: unknown;
  items?: unknown[] | null;
  raw?: unknown;
  rawSourcePayload?: unknown;
  orderStatus?: string | null;
};

export type ImportedOrderTotalResolution = {
  orderTotal: string;
  source: ImportedOrderTotalSource;
  suspiciousZero: boolean;
  preservedExistingPositive: boolean;
  itemSubtotal: string | null;
};

const MONEY_TEXT = /^-?\d+(?:\.\d+)?$/;
const TRUE_TEXT = new Set(['true', 't', '1', 'yes']);

const SHOPIFY_CURRENT_TOTAL_PATHS = [
  ['current_total_price'],
  ['currentTotalPrice'],
  ['current_total_price_set', 'shop_money', 'amount'],
  ['current_total_price_set', 'presentment_money', 'amount'],
  ['currentTotalPriceSet', 'shopMoney', 'amount'],
  ['currentTotalPriceSet', 'presentmentMoney', 'amount'],
] as const;

const SHOPIFY_TOTAL_PATHS = [
  ['total_price'],
  ['totalPrice'],
  ['total_price_set', 'shop_money', 'amount'],
  ['total_price_set', 'presentment_money', 'amount'],
  ['totalPriceSet', 'shopMoney', 'amount'],
  ['totalPriceSet', 'presentmentMoney', 'amount'],
] as const;

const ORDER_DISCOUNT_PATHS = [
  ['current_total_discounts'],
  ['currentTotalDiscounts'],
  ['total_discounts'],
  ['totalDiscounts'],
  ['current_total_discounts_set', 'shop_money', 'amount'],
  ['current_total_discounts_set', 'presentment_money', 'amount'],
  ['currentTotalDiscountsSet', 'shopMoney', 'amount'],
  ['currentTotalDiscountsSet', 'presentmentMoney', 'amount'],
  ['total_discounts_set', 'shop_money', 'amount'],
  ['total_discounts_set', 'presentment_money', 'amount'],
  ['totalDiscountsSet', 'shopMoney', 'amount'],
  ['totalDiscountsSet', 'presentmentMoney', 'amount'],
] as const;

function centsFromMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[$,]/g, '');
  if (!MONEY_TEXT.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function moneyFromCents(cents: number): string {
  return (Math.max(0, cents) / 100).toFixed(2);
}

function numberFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!MONEY_TEXT.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function pathValue(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    const record = recordValue(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function firstCentsFromPaths(raws: unknown[], paths: readonly (readonly string[])[]): number | null {
  for (const raw of raws) {
    for (const path of paths) {
      const cents = centsFromMoney(pathValue(raw, path));
      if (cents !== null) return cents;
    }
  }
  return null;
}

function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return TRUE_TEXT.has(value.trim().toLowerCase());
  return false;
}

function rawTextValue(raws: unknown[], keys: readonly string[]): string {
  for (const raw of raws) {
    const record = recordValue(raw);
    if (!record) continue;
    const value = firstDefined(record, keys);
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return '';
}

function rawBooleanValue(raws: unknown[], keys: readonly string[]): boolean {
  for (const raw of raws) {
    const record = recordValue(raw);
    if (!record) continue;
    if (boolValue(firstDefined(record, keys))) return true;
  }
  return false;
}

function positiveItemSubtotalCents(items: unknown[] | null | undefined): number | null {
  if (!Array.isArray(items)) return null;
  let total = 0;

  for (const rawItem of items) {
    const item = recordValue(rawItem);
    if (!item) continue;
    if (boolValue(item.adjustment)) continue;

    const quantity = Math.max(0, numberFromValue(firstDefined(item, ['quantity', 'qty'])) ?? 1);
    if (quantity <= 0) continue;

    const explicitLineTotal = centsFromMoney(
      firstDefined(item, ['lineTotal', 'line_total', 'total', 'extendedPrice', 'extended_price']),
    );
    const unitPrice = centsFromMoney(firstDefined(item, ['unitPrice', 'unit_price', 'price']));
    const lineTotal = explicitLineTotal ?? (unitPrice === null ? 0 : Math.round(unitPrice * quantity));
    if (lineTotal > 0) total += lineTotal;
  }

  return total > 0 ? total : null;
}

function hasExplicitZeroTotalProof(input: ImportedOrderTotalResolutionInput, raws: unknown[], itemSubtotalCents: number | null): boolean {
  const status = (input.orderStatus ?? '').trim().toLowerCase();
  if (status === 'cancelled') return true;
  if (rawBooleanValue(raws, ['test', 'isTest', 'is_test'])) return true;
  if (rawTextValue(raws, ['financial_status', 'financialStatus']) === 'refunded') return true;
  if (rawTextValue(raws, ['financial_status', 'financialStatus']) === 'voided') return true;
  if (rawTextValue(raws, ['cancelled_at', 'cancelledAt'])) return true;

  const discountCents = firstCentsFromPaths(raws, ORDER_DISCOUNT_PATHS);
  return itemSubtotalCents !== null && discountCents !== null && discountCents >= itemSubtotalCents;
}

export function resolveImportedOrderTotal(
  input: ImportedOrderTotalResolutionInput,
): ImportedOrderTotalResolution {
  const raws = [input.rawSourcePayload, input.raw].filter((value) => recordValue(value) !== null);
  const itemSubtotalCents = positiveItemSubtotalCents(input.items);
  const itemSubtotal = itemSubtotalCents === null ? null : moneyFromCents(itemSubtotalCents);
  const existingCents = centsFromMoney(input.existingOrderTotal);
  const providerCents = centsFromMoney(input.incomingOrderTotal);
  const shopifyCurrentCents = firstCentsFromPaths(raws, SHOPIFY_CURRENT_TOTAL_PATHS);
  const shopifyTotalCents = firstCentsFromPaths(raws, SHOPIFY_TOTAL_PATHS);
  const hasZeroCandidate =
    providerCents === 0 || shopifyCurrentCents === 0 || shopifyTotalCents === 0;
  const zeroIsProven = hasZeroCandidate && hasExplicitZeroTotalProof(input, raws, itemSubtotalCents);

  const choose = (
    cents: number,
    source: ImportedOrderTotalSource,
    extra: Partial<ImportedOrderTotalResolution> = {},
  ): ImportedOrderTotalResolution => ({
    orderTotal: moneyFromCents(cents),
    source,
    suspiciousZero: false,
    preservedExistingPositive: false,
    itemSubtotal,
    ...extra,
  });

  // Shopify's current total is the canonical paid/current value when Shopify
  // raw data is available. Fall back to total_price only if the current field
  // is absent; ShipStation's orderTotal is just the provider-normalized value.
  if (shopifyCurrentCents !== null && (shopifyCurrentCents > 0 || zeroIsProven)) {
    return choose(shopifyCurrentCents, shopifyCurrentCents > 0 ? 'shopify_current_total' : 'zero_proven');
  }
  if (shopifyTotalCents !== null && (shopifyTotalCents > 0 || zeroIsProven)) {
    return choose(shopifyTotalCents, shopifyTotalCents > 0 ? 'shopify_total' : 'zero_proven');
  }
  if (providerCents !== null && providerCents > 0) {
    return choose(providerCents, 'provider_order_total');
  }
  if (hasZeroCandidate && existingCents !== null && existingCents > 0 && !zeroIsProven) {
    return choose(existingCents, 'existing_positive_preserved', {
      suspiciousZero: true,
      preservedExistingPositive: true,
    });
  }
  if (hasZeroCandidate && itemSubtotalCents !== null && itemSubtotalCents > 0 && !zeroIsProven) {
    return choose(itemSubtotalCents, 'item_subtotal_fallback', { suspiciousZero: true });
  }
  if (zeroIsProven) {
    return choose(0, 'zero_proven');
  }
  if (existingCents !== null && existingCents > 0 && providerCents === null) {
    return choose(existingCents, 'existing_positive_preserved', {
      suspiciousZero: true,
      preservedExistingPositive: true,
    });
  }

  return choose(0, 'zero_unproven');
}

type ExistingImportOrderFacts = {
  orderTotalsByIdentity: Map<string, string>;
  sourceIdentityKeys: Set<string>;
};

async function loadExistingOrderFactsForImport(
  rows: Array<typeof orders.$inferInsert>,
): Promise<ExistingImportOrderFacts> {
  const identities = rows.map((row) => buildOrderSourceIdentity(row));
  const predicate = orderSourceIdentitiesPredicate(identities);
  if (!predicate) {
    return { orderTotalsByIdentity: new Map(), sourceIdentityKeys: new Set() };
  }

  const existingRows = await db
    .select({
      sourceProvider: orders.sourceProvider,
      sourceAccountId: orders.sourceAccountId,
      sourceOrderId: orders.sourceOrderId,
      orderTotal: orders.orderTotal,
    })
    .from(orders)
    .where(predicate);

  const byIdentity = new Map<string, string>();
  const sourceIdentityKeys = new Set<string>();
  for (const row of existingRows) {
    const identity = buildOrderSourceIdentity(row);
    if (!identity) continue;
    const key = orderSourceIdentityKey(identity);
    byIdentity.set(key, row.orderTotal);
    sourceIdentityKeys.add(key);
  }
  return { orderTotalsByIdentity: byIdentity, sourceIdentityKeys };
}

async function claimLegacyOrderSourceIdentities(rows: Array<typeof orders.$inferInsert>): Promise<void> {
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = buildOrderSourceIdentity(row);
    if (!identity || !row.externalOrderId) continue;
    const key = `${orderSourceIdentityKey(identity)}:${row.externalOrderId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const legacyPredicate = legacyOrderSourceCompatibilityPredicate([row.externalOrderId], {
      includeUnqualifiedShipStation: identity.sourceProvider === 'shipstation',
    });
    if (!legacyPredicate) continue;

    // Per user override unlock shipped data on 2026-07-06: PS-388 may claim
    // an exact legacy external_order_id row into the composite source identity
    // before the authoritative upsert. This only fills identity/provenance
    // fields and lets the existing terminal-status preservation below keep
    // shipped/cancelled protections intact.
    await db
      .update(orders)
      .set({
        sourceProvider: identity.sourceProvider,
        sourceAccountId: identity.sourceAccountId,
        sourceOrderId: identity.sourceOrderId,
        sourceOrderNumber: row.sourceOrderNumber ?? null,
        rawSourcePayload: row.rawSourcePayload ?? null,
      })
      .where(
        and(
          legacyPredicate,
          sql`not exists (
            select 1
            from orders source_conflict
            where source_conflict.source_provider = ${identity.sourceProvider}
              and source_conflict.source_account_id = ${identity.sourceAccountId}
              and source_conflict.source_order_id = ${identity.sourceOrderId}
              and source_conflict.id <> ${orders.id}
          )`,
        ),
      );
  }
}

export async function upsertNormalizedStoreOrders(
  ordersIn: NormalizedStoreOrder[],
  options: { inventoryDeductionSource?: string } = {},
): Promise<number> {
  if (!ordersIn.length) return 0;

  // Per user override unlock shipped data on 2026-07-06: source imports can
  // include the same provider order twice in one page; de-dupe before the
  // authoritative bulk upsert so one repeated source identity cannot reject the
  // whole batch. The terminal-status preservation below remains unchanged.
  const importOrders = dedupeNormalizedStoreOrdersForImport(ordersIn);

  type Row = typeof orders.$inferInsert;
  // Per user override unlock shipped data on 2026-07-15: Audit 5.6 makes
  // this shared importer delegate raw JSONB retention to one bounded policy.
  // Full provider data remains available above for normalization/total
  // resolution, while persistence keeps one operational copy and does not
  // change terminal-status preservation, shipment history, or side effects.
  const rows: Row[] = importOrders.map((order) => ({
    externalOrderId: compatibilityExternalOrderId(order),
    sourceProvider: order.source.sourceProvider,
    sourceAccountId: order.source.sourceAccountId,
    sourceOrderId: order.source.sourceOrderId,
    sourceOrderNumber: order.source.sourceOrderNumber,
    rawSourcePayload: retainOrderRawSourcePayloadForPersistence(order.source.rawSourcePayload),
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    orderDate: order.orderDate,
    clientId: order.clientId,
    storeId: order.storeId,
    customerEmail: order.customerEmail ?? null,
    shipToName: order.shipToName ?? null,
    shipToCity: order.shipToCity ?? null,
    shipToState: order.shipToState ?? null,
    shipToPostalCode: order.shipToPostalCode ?? null,
    carrierCode: order.carrierCode ?? null,
    serviceCode: order.serviceCode ?? null,
    weightOz: order.weightOz ?? null,
    orderTotal: order.orderTotal ?? '0',
    shippingAmount: order.shippingAmount ?? '0',
    items: order.items ?? [],
    raw: retainOrderRawForPersistence({
      sourceProvider: order.source.sourceProvider,
      raw: order.raw,
    }),
    externallyShipped: order.externallyShipped === true,
    updatedAt: new Date(),
  }));

  await claimLegacyOrderSourceIdentities(rows);
  const existingOrderFacts = await loadExistingOrderFactsForImport(rows);
  const existingOrderTotals = existingOrderFacts.orderTotalsByIdentity;
  const newSourceIdentityKeys = new Set(
    rows
      .map((row) => buildOrderSourceIdentity(row))
      .filter((identity) => identity != null)
      .map((identity) => orderSourceIdentityKey(identity))
      .filter((key) => !existingOrderFacts.sourceIdentityKeys.has(key)),
  );
  let suspiciousZeroTotals = 0;
  let preservedPositiveTotals = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const order = importOrders[i];
    if (!row || !order) continue;

    const identity = buildOrderSourceIdentity(row);
    const existingOrderTotal = identity
      ? existingOrderTotals.get(orderSourceIdentityKey(identity))
      : undefined;
    const resolution = resolveImportedOrderTotal({
      incomingOrderTotal: order.orderTotal,
      existingOrderTotal,
      items: order.items,
      raw: order.raw,
      rawSourcePayload: order.source.rawSourcePayload,
      orderStatus: order.orderStatus,
    });
    row.orderTotal = resolution.orderTotal;
    if (resolution.suspiciousZero) suspiciousZeroTotals += 1;
    if (resolution.preservedExistingPositive) preservedPositiveTotals += 1;
  }

  // Per user override unlock shipped data on 2026-07-07: PS-401 changes
  // imported order-total resolution only. It never changes terminal-status
  // preservation; it only prevents a provider zero from replacing a known
  // positive order total or an item-derived positive subtotal.
  if (suspiciousZeroTotals > 0) {
    console.warn(
      `[store-order-import] corrected ${suspiciousZeroTotals} suspicious zero order total(s); ` +
        `preserved ${preservedPositiveTotals} existing positive total(s)`,
    );
  }

  const persistedRows = await db.transaction(async (tx) => {
    const persisted = await tx
      .insert(orders)
      .values(rows)
      .onConflictDoUpdate({
        target: [orders.sourceProvider, orders.sourceAccountId, orders.sourceOrderId],
        targetWhere: sql`${orders.sourceProvider} is not null and ${orders.sourceAccountId} is not null and ${orders.sourceOrderId} is not null`,
        set: {
        externalOrderId: sql`excluded.external_order_id`,
        orderNumber: sql`excluded.order_number`,
        sourceProvider: sql`excluded.source_provider`,
        sourceAccountId: sql`excluded.source_account_id`,
        sourceOrderId: sql`excluded.source_order_id`,
        sourceOrderNumber: sql`excluded.source_order_number`,
        rawSourcePayload: sql`excluded.raw_source_payload`,
        // Per user override unlock shipped data on 2026-05-25: preserve
        // existing terminal local statuses while moving import persistence to
        // a store-connector-first helper. This keeps shipped/cancelled
        // protections intact and avoids reopening labels during provider lag.
        // Per user override unlock shipped data on 2026-07-06: PS-388 changes
        // the import identity key only. Existing terminal local rows stay
        // terminal; imports cannot rewrite shipped/cancelled state.
        orderStatus: sql`case
          when ${orders.orderStatus} in ('shipped', 'cancelled') then ${orders.orderStatus}
          else excluded.order_status
        end`,
        orderDate: sql`excluded.order_date`,
        clientId: sql`excluded.client_id`,
        storeId: sql`excluded.store_id`,
        customerEmail: sql`excluded.customer_email`,
        shipToName: sql`excluded.ship_to_name`,
        shipToCity: sql`excluded.ship_to_city`,
        shipToState: sql`excluded.ship_to_state`,
        shipToPostalCode: sql`excluded.ship_to_postal_code`,
        carrierCode: sql`excluded.carrier_code`,
        serviceCode: sql`excluded.service_code`,
        weightOz: sql`excluded.weight_oz`,
        orderTotal: sql`excluded.order_total`,
        shippingAmount: sql`excluded.shipping_amount`,
        items: sql`excluded.items`,
        raw: sql`excluded.raw`,
        // Per user override unlock shipped data on 2026-07-14 (Audit SY-6):
        // Shopify may echo PrepShip's own marketplace confirmation as
        // fulfilled. A linked, active outbound shipment is the canonical proof
        // that the fulfillment is local, so the provider echo must not become
        // the one-way externally_shipped latch that blocks a relabel after void.
        externallyShipped: sql`case
          when excluded.externally_shipped = true and exists (
            select 1
            from ${shipments}
            where ${shipments.orderId} = ${orders.id}
              and coalesce(${shipments.voided}, false) = false
              and coalesce(${shipments.isReturn}, false) = false
          ) then false
          when excluded.externally_shipped = true then true
          else ${orders.externallyShipped}
        end`,
        updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({
        id: orders.id,
        items: orders.items,
        clientId: orders.clientId,
        storeId: orders.storeId,
        orderStatus: orders.orderStatus,
        orderDate: orders.orderDate,
        sourceProvider: orders.sourceProvider,
        sourceAccountId: orders.sourceAccountId,
        sourceOrderId: orders.sourceOrderId,
      });

    if (options.inventoryDeductionSource) {
      // Per user override unlock shipped data on 2026-07-15: the shipped-only
      // hydration caller opts into this boundary so a newly imported terminal
      // row and its durable deduction intent commit atomically. Other import
      // callers remain unchanged and terminal-status preservation stays intact.
      for (const row of persisted) {
        if (row.orderStatus !== 'shipped') continue;
        await enqueueInventoryDeduction(
          row,
          { source: options.inventoryDeductionSource },
          tx,
        );
      }
    }
    return persisted;
  });

  await replaceOrderItemsForOrders(persistedRows);
  const persistedOrderIds = persistedRows.map((row) => row.id);

  // PS-205: imported package facts are FALLBACK ONLY. After every import batch
  // (this is the single persistence helper all order sources flow through),
  // saved client combo defaults are materialized onto mutable awaiting rows
  // that carry no operator/package-fact overrides — so a ShipStation re-import
  // of a stale 35 oz can never out-rank the operator's saved 31 oz / 12x10x3
  // combo default at any rating/label/list read site. Best-effort: a
  // materialization failure never fails the sync itself.
  try {
    await materializePackageFactsForImportedOrderIds(persistedOrderIds);
  } catch (err) {
    console.warn(
      '[store-order-import] package-facts materialization skipped:',
      err instanceof Error ? err.message : err,
    );
  }

  // Per user override unlock shipped data on 2026-07-15: terminal-preserving
  // import has already committed above. Admit only genuinely new rows whose
  // persisted status is still awaiting_shipment; shipped/cancelled rows never
  // enter rating, and the background owner remains cache-first and label-free.
  const rateOnIngestOrderIds = persistedRows
    .filter((row) => {
      if (row.orderStatus !== 'awaiting_shipment') return false;
      const identity = buildOrderSourceIdentity(row);
      return identity ? newSourceIdentityKeys.has(orderSourceIdentityKey(identity)) : false;
    })
    .map((row) => row.id);
  await enqueueBackfillBestRatesForOrderIds(
    rateOnIngestOrderIds,
    undefined,
    'rate-on-ingest',
  );

  return rows.length;
}
