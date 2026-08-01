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
      // PS-469 part 3. NOT item.id -- sync deletes and re-inserts order_items on
      // every pass, so the serial changes while the line does not. Measured
      // 2026-08-01: orders created 2026-07-20 and 2026-07-23 carried item ids
      // 2514791-2514799 stamped minutes earlier, allocated sequentially across
      // both orders in one batch. That surrogate key was inside the fact
      // document, so re-importing an unchanged line moved the revision.
      //
      // lineIndex is the line's stable identity within the order and is already
      // the sort key above. Nothing reads lineId -- the automation engine
      // declares it in contracts.ts and never consults it -- so this narrows
      // churn without changing any rule's meaning.
      lineId: String(item.lineIndex),
      sku: item.sku?.trim() || null,
      name: item.name?.trim() || null,
      quantity: finite(item.quantity),
    }));
  const itemSubtotal = input.items.reduce<number | null>((total, item) => {
    const lineTotal = finite(item.lineTotal);
    return lineTotal == null || total == null ? null : total + lineTotal;
  }, 0);
  const tags = sortedTags(input.override?.tags);
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
  // PS-469 part 2. The revision is a fingerprint of the FACTS, and nothing else.
  //
  // It used to also hash orderUpdatedAt, overrideUpdatedAt and latestItemUpdate.
  // Sync re-upserts rows that have not changed and Postgres bumps updated_at
  // regardless, so the revision moved on writes where every evaluated fact was
  // byte-identical -- which minted a new executionKey, missed findCompleted, and
  // re-ran the engine to compute the same answer. Measured on production
  // 2026-08-01: order 1801946 at 913 runs/day over 458 revisions, every sampled
  // result identical (zero intents, zero matches).
  //
  // Dropping them loses no change detection: every field a rule can read is
  // already inside factsWithoutRevision, which the guard pins with 16 separate
  // "the revision still CHANGES when X changes" checks. Those checks passed
  // BEFORE this change too -- the timestamps were never the thing detecting a
  // real edit, only the thing detecting a no-op one.
  //
  // hazmat.revision stays: order-hazmat.ts short-circuits a save whose
  // semanticHash is unchanged, so that counter is already content-gated and
  // does not churn.
  const revision = automationDocumentHash({
    facts: factsWithoutRevision,
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
