import {
  asSSUpstreamOrderId,
  ssMarkOrderShippedV1,
} from '../../lib/shipstation/labels.js';
import { ShipStationError } from '../../lib/shipstation/client.js';
import { ssV1Request } from '../../lib/shipstation/v1-client.js';
import { formatShipStationV1DateParam, parseShipStationV1Date } from '../../lib/shipstation/v1-date.js';
import { buildShipStationOrderSource } from '../../services/normalized-order-persistence.js';
import type {
  ConfirmationResult,
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  ShipmentConfirmationInput,
  StoreOrderImportInput,
  StoreConnector,
} from '../../domain/fulfillment/types.js';

type SSOrder = {
  orderId: number;
  orderNumber: string;
  orderKey?: string;
  orderStatus: string;
  orderDate?: string;
  modifyDate?: string;
  customerEmail?: string | null;
  shipTo?: {
    name?: string;
    company?: string | null;
    street1?: string;
    street2?: string | null;
    street3?: string | null;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    phone?: string | null;
    residential?: boolean | null;
  };
  weight?: { value: number; units: 'ounces' | 'pounds' | 'grams'; WeightUnits?: number };
  carrierCode?: string | null;
  serviceCode?: string | null;
  orderTotal?: number | null;
  shippingAmount?: number | null;
  items?: unknown[];
  externallyFulfilled?: boolean | null;
  externally_shipped?: boolean | null;
  advancedOptions?: {
    storeId?: number | null;
    nonMachinable?: boolean | null;
    // PS-491: ShipStation's split/merge provenance. Declared here because these decide
    // whether two `orders` rows sharing an order number are one order ingested twice or a
    // genuine split with two real shipments. Persisted via ORDER_IDENTITY_EVIDENCE_KEYS.
    mergedOrSplit?: boolean | null;
    parentId?: number | null;
    mergedIds?: number[] | null;
  } | null;
};

type SSOrdersList = {
  orders: SSOrder[];
  total: number;
  page: number;
  pages: number;
};

type ShipStationV1RequestOptions = {
  apiKey?: string;
  apiSecret?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ShipStationConfirmationDependencies = {
  loadOrder?: (
    orderId: number,
    credentials: { apiKey?: string; apiSecret?: string },
  ) => Promise<{ orderStatus?: string | null }>;
  markOrderShipped?: typeof ssMarkOrderShippedV1;
};

type ShipStationStore = {
  storeId: number;
  storeName: string;
  marketplaceName?: string;
  accountName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  active?: boolean;
};

type ShipStationWarehouse = {
  warehouseId: number;
  warehouseName: string;
  isDefault?: boolean;
  originAddress?: {
    name?: string;
    company?: string | null;
    street1?: string;
    street2?: string | null;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    phone?: string | null;
  };
};

type ShipStationProductsList<TProduct = unknown> = {
  products: TProduct[];
  total: number;
  page: number;
  pages: number;
};

function toOunces(w?: SSOrder['weight']): number | null {
  if (!w || typeof w.value !== 'number') return null;
  switch (w.units) {
    case 'ounces':
      return w.value;
    case 'pounds':
      return w.value * 16;
    case 'grams':
      return w.value / 28.3495;
    default:
      return w.value;
  }
}

function parseShipStationDate(value?: string): Date | null {
  return parseShipStationV1Date(value);
}

function toNumericString(n?: number | null): string {
  return Number.isFinite(n as number) ? (n as number).toFixed(2) : '0';
}

/**
 * Does the PROVIDER say somebody else fulfilled this order?
 *
 * PS-489: `advancedOptions.nonMachinable` used to be ORed in here. It is a USPS
 * PARCEL-SHAPE flag — it says the parcel is irregular (odd dimensions, rigidity,
 * aspect ratio), not that the order was fulfilled outside PrepShip. Conflating a
 * packaging attribute with fulfilment ownership inflated `orders.externally_shipped`,
 * which is the exact population PS-489 is scoped by and the population billing's
 * `shipping_missing` branch keys on.
 *
 * Model-independent: this correction holds whichever canonical representation DJ
 * rules for, so it lands ahead of that decision (v2-parity note: the legacy import
 * carried the same conflation, so this is a deliberate divergence from it).
 *
 * Blast radius measured 2026-08-22, read-only: of 73,541 orders, ZERO carry
 * `nonMachinable: true` in retained raw, so no stored row changes classification.
 * Note the retention policy strips `advancedOptions` sub-keys, so that zero cannot
 * by itself prove the flag never fired historically — it proves only that nothing
 * recoverable depends on it now.
 */
function externallyShippedFromRaw(o: SSOrder): boolean {
  return Boolean(o.externallyFulfilled === true || o.externally_shipped === true);
}

export async function listShipStationStores(
  options: ShipStationV1RequestOptions = {},
): Promise<ShipStationStore[]> {
  return ssV1Request<ShipStationStore[]>('/stores', {
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    dedupeKey: options.dedupeKey ?? 'stores:list',
    timeoutMs: options.timeoutMs,
  });
}

export async function listShipStationWarehouses(
  options: ShipStationV1RequestOptions = {},
): Promise<ShipStationWarehouse[]> {
  return ssV1Request<ShipStationWarehouse[]>('/warehouses', {
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    dedupeKey: options.dedupeKey ?? 'warehouses:list',
    timeoutMs: options.timeoutMs,
  });
}

export async function listShipStationProducts<TProduct = unknown>(
  input: ShipStationV1RequestOptions & { page: number; pageSize: number },
): Promise<ShipStationProductsList<TProduct>> {
  const q = new URLSearchParams({
    pageSize: String(input.pageSize),
    page: String(input.page),
  });
  return ssV1Request<ShipStationProductsList<TProduct>>(`/products?${q.toString()}`, {
    apiKey: input.apiKey,
    apiSecret: input.apiSecret,
    dedupeKey: input.dedupeKey,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}

export async function listShipStationOrders<TList = SSOrdersList>(
  query: URLSearchParams,
  options: ShipStationV1RequestOptions = {},
): Promise<TList> {
  return ssV1Request<TList>(`/orders?${query.toString()}`, {
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    dedupeKey: options.dedupeKey,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export async function getShipStationOrderExistence(
  orderId: string,
  options: ShipStationV1RequestOptions = {},
): Promise<'exists' | 'deleted'> {
  try {
    await ssV1Request<SSOrder>(`/orders/${encodeURIComponent(orderId)}`, {
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      dedupeKey: options.dedupeKey,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return 'exists';
  } catch (error) {
    if (error instanceof ShipStationError && error.status === 404) return 'deleted';
    throw error;
  }
}

export async function listShipStationShipments<TList>(
  query: URLSearchParams,
  options: ShipStationV1RequestOptions = {},
): Promise<TList> {
  // Per user override unlock shipped data on 2026-07-14: forward worker
  // cancellation at the provider boundary; this changes no shipment fields.
  return ssV1Request<TList>(`/shipments?${query.toString()}`, {
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    dedupeKey: options.dedupeKey,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function normalizeShipStationOrder(raw: unknown): NormalizedOrder {
  const o = raw as SSOrder;
  const storeId = o.advancedOptions?.storeId ?? null;
  const source = buildShipStationOrderSource({
    orderId: o.orderId,
    orderNumber: o.orderNumber,
    storeId,
    raw: o as unknown as Record<string, unknown>,
  });

  return {
    sourceProvider: 'shipstation',
    sourceAccountId: source.sourceAccountId,
    sourceOrderId: source.sourceOrderId,
    sourceOrderNumber: source.sourceOrderNumber,
    marketplace: 'shipstation',
    storeId: storeId == null ? null : String(storeId),
    canonicalStatus: o.orderStatus === 'cancelled'
      ? 'cancelled'
      : o.orderStatus === 'shipped'
        ? 'shipped'
        : 'awaiting_shipment',
    orderDate: parseShipStationDate(o.orderDate),
    customerName: o.shipTo?.name ?? null,
    customerEmail: o.customerEmail ?? null,
    shipToCity: o.shipTo?.city ?? null,
    shipToState: o.shipTo?.state ?? null,
    shipToPostalCode: o.shipTo?.postalCode ?? null,
    carrierCode: o.carrierCode ?? null,
    serviceCode: o.serviceCode ?? null,
    weightOz: toOunces(o.weight),
    orderTotal: toNumericString(o.orderTotal),
    shippingPaid: Number(toNumericString(o.shippingAmount)),
    items: (o.items as unknown[]) ?? [],
    externallyShipped: externallyShippedFromRaw(o),
    rawPayload: o as unknown as Record<string, unknown>,
  };
}

export function createShipStationStoreConnector(
  confirmationDependencies: ShipStationConfirmationDependencies = {},
): StoreConnector {
  if (
    (confirmationDependencies.loadOrder || confirmationDependencies.markOrderShipped) &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new Error('ShipStation confirmation dependencies may only be injected in tests');
  }
  return {
    provider: 'shipstation',
    capabilities: ['orders.import', 'orders.statusSync', 'shipment.confirm', 'products.import'],
    async importOrders(input: StoreOrderImportInput): Promise<NormalizedStoreOrderImportResult> {
      if (!input.orderStatus || input.sinceMs == null || input.pageSize == null || input.page == null) {
        throw new Error('ShipStation importOrders requires orderStatus, sinceMs, pageSize, and page');
      }

      const q = new URLSearchParams({
        orderStatus: input.orderStatus,
        modifyDateStart: formatShipStationV1DateParam(input.sinceMs),
        pageSize: String(input.pageSize),
        page: String(input.page),
        sortBy: 'ModifyDate',
        sortDir: input.sortDir === 'DESC' ? 'DESC' : 'ASC',
      });
      if (input.untilMs != null) {
        q.set('modifyDateEnd', formatShipStationV1DateParam(input.untilMs));
      }
      if (input.storeId !== undefined) q.set('storeId', String(input.storeId));

      const res = await listShipStationOrders<SSOrdersList>(q, {
        apiKey: input.credentials?.apiKey ?? undefined,
        apiSecret: input.credentials?.apiSecret ?? undefined,
        dedupeKey: input.dedupeKey,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });

      return {
        provider: 'shipstation',
        accountId: input.accountId,
        orders: res.orders.map((order) => normalizeShipStationOrder(order)),
        page: res.page,
        pages: res.pages,
        total: res.total,
      };
    },
    normalizeOrder: normalizeShipStationOrder,
    async confirmShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      const upstreamOrderId = asSSUpstreamOrderId(input.externalOrderId);
      if (!upstreamOrderId) {
        return {
          ok: false,
          provider: 'shipstation',
          retryable: false,
          message: `externalOrderId="${input.externalOrderId ?? '(null)'}" is missing or not a ShipStation order id`,
        };
      }

      // Per user override unlock shipped data on 2026-07-15: ShipStation's
      // markasshipped endpoint has no request idempotency key. Re-read the
      // upstream order immediately before dispatch so a worker retry after a
      // provider ACK/local-settlement crash treats the already-shipped state as
      // success and does not notify the marketplace a second time.
      const credentials = {
        apiKey: input.credentials?.apiKey ?? undefined,
        apiSecret: input.credentials?.apiSecret ?? undefined,
        signal: input.signal,
      };
      // Per user override unlock shipped data on 2026-07-15: injected provider
      // calls let the offline retry test simulate an ACK/local-crash boundary.
      // The default production path remains the same ShipStation functions.
      const upstreamOrder = confirmationDependencies.loadOrder
        ? await confirmationDependencies.loadOrder(upstreamOrderId, credentials)
        : await ssV1Request<SSOrder>(
            `/orders/${encodeURIComponent(String(upstreamOrderId))}`,
            credentials,
          );
      if (String(upstreamOrder.orderStatus ?? '').trim().toLowerCase() === 'shipped') {
        return {
          ok: true,
          provider: 'shipstation',
          message: 'ShipStation order is already shipped; confirmation retry settled idempotently.',
        };
      }

      await (confirmationDependencies.markOrderShipped ?? ssMarkOrderShippedV1)(
        {
          orderId: upstreamOrderId,
          carrierCode: input.carrierCode,
          trackingNumber: input.trackingNumber,
          shipDate: input.shipDate,
          notifyCustomer: input.notifyCustomer ?? false,
          notifySalesChannel: input.notifyMarketplace ?? true,
        },
        credentials,
      );

      return { ok: true, provider: 'shipstation' };
    },
  };
}

export const shipStationStoreConnector = createShipStationStoreConnector();
