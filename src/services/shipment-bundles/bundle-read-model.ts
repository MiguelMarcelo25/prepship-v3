// PS-312/PS-317 (S3) — bundle READ-MODEL DTO. The backend resolves an order that belongs to a
// combined-shipment bundle to the bundle's SHARED label/tracking/status + its role (primary/child)
// and members. This is what the Shipped-tab UI (S4) renders so a CHILD order shows the primary's
// shared shipment instead of "Shipment sync error". Pure read — no writes, no postage, no provider
// calls. The FE consumes this DTO; it never re-derives membership from names/addresses.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shipmentBundles, shipmentBundleMembers } from '../../db/schema/shipment-bundles.js';
import { ensureShipmentBundlesSchema } from './ensure-shipment-bundles-schema.js';

export type BundleRole = 'primary' | 'child';

export type BundleRowDto = {
  bundleId: number;
  role: BundleRole;
  status: string;
  primaryOrderId: number;
  memberOrderIds: number[];
  memberCount: number;
  // Shared shipment facts — populated once the primary's ONE label is bought (linkBundleShipment).
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  labelUrl: string | null;
  labelShipmentId: string | null;
  packageId: number | null;
  primaryShipmentId: number | null;
};

/**
 * For each given order that is an ACTIVE member of a bundle, return its BundleRowDto (its role +
 * the bundle's shared facts + the full member list). Orders not in any active bundle are simply
 * absent from the map. Batched so the Orders table can resolve many rows in one round-trip.
 */
export async function getBundlesForOrders(
  orderIds: number[],
  conn: typeof db = db,
): Promise<Map<number, BundleRowDto>> {
  const result = new Map<number, BundleRowDto>();
  if (orderIds.length === 0) return result;
  if (conn === db) await ensureShipmentBundlesSchema();

  // 1) Which bundle (+ role) is each requested order an active member of?
  const memberRows = await conn
    .select({
      orderId: shipmentBundleMembers.orderId,
      bundleId: shipmentBundleMembers.bundleId,
      role: shipmentBundleMembers.role,
    })
    .from(shipmentBundleMembers)
    .where(
      and(
        inArray(shipmentBundleMembers.orderId, orderIds),
        // Only ACTIVE memberships resolve — matches the member-list build below so a removed
        // member can never still resolve as a bundle member (PS-312 adversarial-review fix).
        eq(shipmentBundleMembers.status, 'active'),
      ),
    );
  const active = memberRows.filter((m) => m.bundleId != null);
  if (active.length === 0) return result;

  const bundleIds = Array.from(new Set(active.map((m) => m.bundleId)));

  // 2) The shared facts for those bundles.
  const bundleRows = await conn
    .select()
    .from(shipmentBundles)
    .where(inArray(shipmentBundles.id, bundleIds));
  const bundleById = new Map(bundleRows.map((b) => [b.id, b]));

  // 3) ALL active members of those bundles (to build each bundle's member list once).
  const allMembers = await conn
    .select({ bundleId: shipmentBundleMembers.bundleId, orderId: shipmentBundleMembers.orderId, status: shipmentBundleMembers.status })
    .from(shipmentBundleMembers)
    .where(inArray(shipmentBundleMembers.bundleId, bundleIds));
  const membersByBundle = new Map<number, number[]>();
  for (const m of allMembers) {
    if ((m.status ?? 'active') !== 'active') continue;
    const list = membersByBundle.get(m.bundleId) ?? [];
    list.push(m.orderId);
    membersByBundle.set(m.bundleId, list);
  }

  // 4) Build one DTO per requested member order.
  for (const m of active) {
    const bundle = bundleById.get(m.bundleId);
    if (!bundle || bundle.primaryOrderId == null) continue;
    const memberOrderIds = (membersByBundle.get(m.bundleId) ?? []).slice().sort((a, b) => a - b);
    result.set(m.orderId, {
      bundleId: m.bundleId,
      role: m.role === 'primary' ? 'primary' : 'child',
      status: bundle.status,
      primaryOrderId: bundle.primaryOrderId,
      memberOrderIds,
      memberCount: memberOrderIds.length,
      trackingNumber: bundle.trackingNumber ?? null,
      carrierCode: bundle.carrierCode ?? null,
      serviceCode: bundle.serviceCode ?? null,
      labelUrl: bundle.labelUrl ?? null,
      labelShipmentId: bundle.labelShipmentId ?? null,
      packageId: bundle.packageId ?? null,
      primaryShipmentId: bundle.primaryShipmentId ?? null,
    });
  }
  return result;
}

/** Single-order convenience: the bundle DTO for one order, or null if it isn't bundled. */
export async function getBundleForOrder(orderId: number, conn: typeof db = db): Promise<BundleRowDto | null> {
  const map = await getBundlesForOrders([orderId], conn);
  return map.get(orderId) ?? null;
}
