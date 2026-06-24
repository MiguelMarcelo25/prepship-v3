// PS-312/PS-317 (S2) — create + preview a combined shipment bundle (the durable SOT write). This
// NEVER buys real postage: createBundle only writes the additive shipment_bundles +
// shipment_bundle_members rows (status 'draft'). The ONE label is bought by the operator's existing
// queue/print flow on the PRIMARY order (processQueueSendOrder → createLabelV2, never duplicated);
// linkBundleShipment then stamps the shared label/tracking/rate/package onto the bundle so every
// child resolves to it. Validates the candidate (≥2 awaiting same-recipient orders, none already
// bundled) + the membership invariants before persisting. Billing data only — additive tables.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders } from '../../db/schema/orders.js';
import { shipmentBundles, shipmentBundleMembers } from '../../db/schema/shipment-bundles.js';
import { ensureShipmentBundlesSchema } from './ensure-shipment-bundles-schema.js';
import { validateBundleMembership, type BundleMemberInput } from './shipment-bundle-invariants.js';
import { isBundleEligible, normalizeRecipientIdentity, type BundleCandidateOrder } from './bundle-candidates.js';

export type BundlePreview = {
  valid: boolean;
  errors: string[];
  primaryOrderId: number | null;
  memberOrderIds: number[];
  recipientKey: string | null;
  clientId: number | null;
};

// Read the candidate rows + their existing-bundle membership (left join). Read-only.
async function fetchBundleOrderRows(orderIds: number[], conn: typeof db): Promise<BundleCandidateOrder[]> {
  if (orderIds.length === 0) return [];
  const rows = await conn
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      clientId: orders.clientId,
      storeId: orders.storeId,
      shipToName: orders.shipToName,
      shipToCity: orders.shipToCity,
      shipToState: orders.shipToState,
      shipToPostalCode: orders.shipToPostalCode,
      orderStatus: orders.orderStatus,
      existingBundleId: shipmentBundleMembers.bundleId,
    })
    .from(orders)
    .leftJoin(
      shipmentBundleMembers,
      and(eq(shipmentBundleMembers.orderId, orders.id), eq(shipmentBundleMembers.status, 'active')),
    )
    .where(inArray(orders.id, orderIds));
  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    clientId: r.clientId,
    storeId: r.storeId,
    shipToName: r.shipToName,
    shipToCity: r.shipToCity,
    shipToState: r.shipToState,
    shipToPostalCode: r.shipToPostalCode,
    orderStatus: r.orderStatus,
    hasActiveLabel: false, // S2: awaiting-status gate; the active-label exclusion is refined in S3.
    existingBundleId: r.existingBundleId ?? null,
  }));
}

/**
 * Dry-run validation of a proposed bundle (no write). A valid bundle is ≥2 orders that are all
 * eligible (awaiting, not already bundled, with a recipient) AND share the SAME client + store +
 * normalized ship-to recipient. The primary defaults to the lowest order id (deterministic).
 */
export async function previewBundle(
  orderIds: number[],
  explicitPrimaryOrderId: number | null = null,
  conn: typeof db = db,
): Promise<BundlePreview> {
  if (conn === db) await ensureShipmentBundlesSchema();
  const errors: string[] = [];
  const rows = await fetchBundleOrderRows(orderIds, conn);

  if (rows.length < 2) errors.push(`a bundle needs at least 2 orders (found ${rows.length})`);

  const ineligible = rows.filter((r) => !isBundleEligible(r));
  if (ineligible.length > 0) {
    errors.push(
      `ineligible orders: ${ineligible.map((r) => r.orderId).join(', ')} (shipped/cancelled/labelled/already-bundled/blank-recipient)`,
    );
  }

  const scopeKeys = new Set(rows.map((r) => `${r.clientId ?? 'null'}:${r.storeId ?? 'null'}:${normalizeRecipientIdentity(r)}`));
  if (rows.length > 0 && scopeKeys.size > 1) {
    errors.push('all bundle orders must share the same client, store, and ship-to recipient');
  }

  const memberOrderIds = rows.map((r) => r.orderId).sort((a, b) => a - b);
  const first = rows[0];
  const defaultPrimary = memberOrderIds[0] ?? null;
  let primaryOrderId = explicitPrimaryOrderId ?? defaultPrimary;
  if (explicitPrimaryOrderId != null && !memberOrderIds.includes(explicitPrimaryOrderId)) {
    errors.push(`the chosen primary order ${explicitPrimaryOrderId} is not one of the bundle orders`);
    primaryOrderId = null;
  }

  return {
    valid: errors.length === 0,
    errors,
    primaryOrderId: errors.length === 0 ? primaryOrderId : null,
    memberOrderIds,
    recipientKey: first ? normalizeRecipientIdentity(first) : null,
    clientId: first ? first.clientId : null,
  };
}

export type CreateBundleResult = {
  bundleId: number;
  primaryOrderId: number;
  memberOrderIds: number[];
};

/**
 * Persist the bundle SOT in ONE transaction: a shipment_bundles row (status 'draft') + one member
 * per order (exactly one 'primary', the rest 'child'), after re-validating the preview + the
 * membership invariants. Does NOT buy postage — the primary's label is bought by the existing
 * operator flow, then linkBundleShipment stamps the shared facts. Refuses an invalid bundle.
 */
export async function createBundle(
  orderIds: number[],
  resolvedBy: string | null,
  explicitPrimaryOrderId: number | null = null,
  conn: typeof db = db,
): Promise<CreateBundleResult> {
  if (conn === db) await ensureShipmentBundlesSchema();
  const preview = await previewBundle(orderIds, explicitPrimaryOrderId, conn);
  if (!preview.valid || preview.primaryOrderId == null) {
    throw new Error(`cannot create bundle: ${preview.errors.join('; ')}`);
  }
  const primaryOrderId = preview.primaryOrderId;
  const members: BundleMemberInput[] = preview.memberOrderIds.map((id) => ({
    orderId: id,
    role: id === primaryOrderId ? 'primary' : 'child',
  }));
  const validation = validateBundleMembership(members);
  if (!validation.valid) throw new Error(`invalid bundle membership: ${validation.errors.join('; ')}`);

  return conn.transaction(async (tx) => {
    const inserted = await tx
      .insert(shipmentBundles)
      .values({ clientId: preview.clientId, primaryOrderId, status: 'draft', createdBy: resolvedBy })
      .returning({ id: shipmentBundles.id });
    const bundleId = inserted[0]?.id;
    if (bundleId == null) throw new Error('bundle insert returned no id');
    await tx
      .insert(shipmentBundleMembers)
      .values(members.map((m) => ({ bundleId, orderId: m.orderId, role: m.role, status: 'active' })));
    return { bundleId, primaryOrderId, memberOrderIds: preview.memberOrderIds };
  });
}

export type BundleLabelFacts = {
  primaryShipmentId?: number | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  labelUrl?: string | null;
  labelShipmentId?: string | null;
  packageId?: number | null;
};

/**
 * Stamp the shared label/tracking/rate/package facts onto the bundle AFTER the operator's existing
 * flow bought the ONE label for the primary order, and flip status → 'labeled'. The children then
 * resolve to these shared facts via the S3 read-model (instead of "Shipment sync error").
 */
export async function linkBundleShipment(
  bundleId: number,
  facts: BundleLabelFacts,
  conn: typeof db = db,
): Promise<void> {
  // Verify the bundle exists, and never regress a later lifecycle state (e.g. shipped/voided)
  // back to 'labeled' — only a draft/labeled bundle advances to 'labeled'.
  const existing = await conn
    .select({ status: shipmentBundles.status })
    .from(shipmentBundles)
    .where(eq(shipmentBundles.id, bundleId));
  const current = existing[0]?.status;
  if (current == null) throw new Error(`linkBundleShipment: bundle ${bundleId} not found`);
  const nextStatus = current === 'draft' || current === 'labeled' ? 'labeled' : current;
  await conn
    .update(shipmentBundles)
    .set({
      primaryShipmentId: facts.primaryShipmentId ?? undefined,
      trackingNumber: facts.trackingNumber ?? undefined,
      carrierCode: facts.carrierCode ?? undefined,
      serviceCode: facts.serviceCode ?? undefined,
      labelUrl: facts.labelUrl ?? undefined,
      labelShipmentId: facts.labelShipmentId ?? undefined,
      packageId: facts.packageId ?? undefined,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(eq(shipmentBundles.id, bundleId));
}
