import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderItems } from '../../db/schema/order-items.js';
import { orderOverrides, orders } from '../../db/schema/orders.js';
import type { ClientStoreScope } from '../../lib/client-store-scope.js';
import { assertResourceInScope } from '../../lib/scope-predicates.js';
import { getOrderHazmatForShipping } from '../order-hazmat.js';
import { automationDocumentHash, type AutomationFacts } from './contracts.js';

type CanonicalOrderRow = Pick<typeof orders.$inferSelect,
  | 'id'
  | 'clientId'
  | 'storeId'
  | 'sourceProvider'
  | 'orderStatus'
  | 'orderTotal'
  | 'shippingAmount'
  | 'shipToState'
  | 'shipToPostalCode'
  | 'weightOz'
  | 'createdAt'
  | 'updatedAt'
>;

type CanonicalItemRow = Pick<typeof orderItems.$inferSelect,
  'id' | 'lineIndex' | 'sku' | 'name' | 'quantity' | 'lineTotal' | 'updatedAt'
>;

type CanonicalOverrideRow = Pick<typeof orderOverrides.$inferSelect,
  'residential' | 'tags' | 'notes' | 'rateWeightOz' | 'selectedPid' | 'selectedPackageId' | 'bestRateJson' | 'updatedAt'
> | null;

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((tag) => tag.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function buildAutomationFactsSnapshot(input: {
  order: CanonicalOrderRow;
  items: CanonicalItemRow[];
  override: CanonicalOverrideRow;
  hazmat?: {
    declaration: { status: 'active' | 'clear' } | null;
    revision: number;
    semanticHash: string | null;
  };
}): AutomationFacts {
  const lines = [...input.items]
    .sort((left, right) => left.lineIndex - right.lineIndex || left.id - right.id)
    .map((item) => ({
      lineId: String(item.id),
      sku: item.sku?.trim() || null,
      name: item.name?.trim() || null,
      quantity: finite(item.quantity),
    }));
  const itemSubtotal = input.items.reduce<number | null>((total, item) => {
    const lineTotal = finite(item.lineTotal);
    return lineTotal == null || total == null ? null : total + lineTotal;
  }, 0);
  const tags = sortedTags(input.override?.tags);
  const latestItemUpdate = input.items.reduce<number>(
    (latest, item) => Math.max(latest, item.updatedAt?.getTime() ?? 0),
    0,
  );
  const factsWithoutRevision: Omit<AutomationFacts, 'revision'> = {
    order: {
      id: input.order.id,
      clientId: input.order.clientId,
      storeId: input.order.storeId,
      sourceProvider: input.order.sourceProvider,
      status: input.order.orderStatus,
      orderTotal: finite(input.order.orderTotal),
      itemSubtotal: itemSubtotal == null ? null : Number(itemSubtotal.toFixed(2)),
      customerShipping: finite(input.order.shippingAmount),
      tags,
      createdAt: input.order.createdAt.toISOString(),
    },
    lines,
    destination: {
      // No canonical country/address-line column exists on orders in the PS-466
      // base. Keep unavailable facts unknown instead of consulting orders.raw or
      // inventing a US default.
      country: null,
      state: input.order.shipToState?.trim() || null,
      postalCode: input.order.shipToPostalCode?.trim() || null,
      residential: input.override?.residential ?? null,
      poBox: null,
    },
    package: {
      weightOz: finite(input.override?.rateWeightOz ?? input.order.weightOz),
      presetId: input.override?.selectedPackageId?.trim() || null,
    },
    workflow: {
      hasSelectedRate: Boolean(input.override?.bestRateJson || input.override?.selectedPid),
      holdForReview: tags.some((tag) => ['hold', 'hold_for_review', 'review'].includes(tag.toLowerCase())),
      // PS-465 is the sole owner. Callers without its canonical declaration
      // evidence stay unknown; tags, text, and provider payloads never infer it.
      hazmatState: input.hazmat === undefined
        ? 'unknown'
        : input.hazmat.declaration?.status === 'active' ? 'active' : 'none',
    },
    completeness: {
      identity: input.order.clientId != null || input.order.storeId != null,
      lines: input.items.length > 0 && input.items.every((item) => Boolean(item.sku?.trim())),
      destination: Boolean(input.order.shipToState?.trim() && input.order.shipToPostalCode?.trim()),
      package: input.order.weightOz != null || Boolean(input.override?.selectedPackageId),
      workflow: true,
    },
  };
  const revision = automationDocumentHash({
    facts: factsWithoutRevision,
    orderUpdatedAt: input.order.updatedAt?.toISOString() ?? null,
    overrideUpdatedAt: input.override?.updatedAt?.toISOString() ?? null,
    latestItemUpdate,
    hazmat: input.hazmat === undefined
      ? null
      : {
          revision: input.hazmat.revision,
          semanticHash: input.hazmat.semanticHash,
          status: input.hazmat.declaration?.status ?? null,
        },
  });
  return { revision, ...factsWithoutRevision };
}

export async function loadAutomationFacts(orderId: number, scope: ClientStoreScope): Promise<AutomationFacts> {
  const [row] = await db
    .select({ order: orders, override: orderOverrides })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) throw new Error('Order not found');
  assertResourceInScope(scope, row.order, 'Order not found');
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.lineIndex), asc(orderItems.id));
  const hazmat = await getOrderHazmatForShipping(orderId);
  return buildAutomationFactsSnapshot({ order: row.order, items, override: row.override, hazmat });
}

export function isTerminalAutomationStatus(status: string): boolean {
  return ['shipped', 'cancelled'].includes(status.trim().toLowerCase());
}
