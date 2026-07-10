/**
 * PS-413 historical package-consumption audit. READ ONLY.
 * Produces review buckets; never writes ledger, stock, shipments, or orders.
 */
import { desc, eq, like, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { packageLedger } from '../src/db/schema/package-ledger.js';
import { packageConsumptionReviews } from '../src/db/schema/package-consumption-reviews.js';
import { shipments } from '../src/db/schema/shipments.js';
import { resolveOutboundPackageSelection } from '../src/services/package-consumption.js';

const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const parsedDays = Number(daysArg?.split('=')[1] ?? 30);
const days = Number.isFinite(parsedDays) ? Math.max(1, Math.min(365, Math.floor(parsedDays))) : 30;
const since = new Date(Date.now() - days * 86_400_000);

const rows = await db
  .select({
    id: shipments.id,
    orderId: shipments.orderId,
    orderNumber: shipments.orderNumber,
    source: shipments.source,
    trackingNumber: shipments.trackingNumber,
    labelUrl: shipments.labelUrl,
    labelShipmentId: shipments.labelShipmentId,
    selectedPackageId: shipments.selectedPackageId,
    dimsL: shipments.dimsL,
    dimsW: shipments.dimsW,
    dimsH: shipments.dimsH,
    shipDate: shipments.shipDate,
    createDate: shipments.createDate,
    voided: shipments.voided,
    isReturn: shipments.isReturn,
  })
  .from(shipments)
  .where(sql`coalesce(${shipments.shipDate}, ${shipments.createDate}, ${shipments.createdAt}) >= ${since}`)
  .orderBy(desc(shipments.id));

const summary: Record<string, number> = {};
const review: Array<Record<string, unknown>> = [];
for (const row of rows) {
  if (row.voided) {
    summary.excluded_voided = (summary.excluded_voided ?? 0) + 1;
    continue;
  }
  if (row.isReturn) {
    summary.excluded_return = (summary.excluded_return ?? 0) + 1;
    continue;
  }
  if (
    row.source === 'test_offline' ||
    row.trackingNumber?.startsWith('TEST') ||
    row.trackingNumber?.startsWith('SHOPIFY-MOCK-') ||
    row.labelUrl?.startsWith('mock://')
  ) {
    summary.excluded_test = (summary.excluded_test ?? 0) + 1;
    continue;
  }
  const [existing] = await db
    .select({ id: packageLedger.id })
    .from(packageLedger)
    .where(eq(packageLedger.shipmentId, row.id))
    .limit(1);
  if (existing) {
    summary.already_consumed = (summary.already_consumed ?? 0) + 1;
    continue;
  }
  const [pendingReview] = await db
    .select({ reason: packageConsumptionReviews.reason })
    .from(packageConsumptionReviews)
    .where(eq(packageConsumptionReviews.shipmentId, row.id))
    .limit(1);
  if (pendingReview) {
    const current = await resolveOutboundPackageSelection({
      orderId: row.orderId,
      selectedPackageId: row.selectedPackageId,
      dimensions: { length: row.dimsL, width: row.dimsW, height: row.dimsH },
    });
    const bucket = current.status === 'matched' ? 'pending_now_eligible' : 'pending_still_blocked';
    summary[bucket] = (summary[bucket] ?? 0) + 1;
    review.push({
      shipmentId: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      source: row.source,
      previousReason: pendingReview.reason,
      current,
    });
    continue;
  }
  let legacy: { id: number } | undefined;
  const legacyIdentities = [...new Set([row.id, row.labelShipmentId].filter((value): value is number => value != null))];
  for (const identity of legacyIdentities) {
    [legacy] = await db
      .select({ id: packageLedger.id })
      .from(packageLedger)
      .where(like(packageLedger.note, `Shipment ${identity} for order %`))
      .limit(1);
    if (legacy) break;
  }
  if (legacy) {
    summary.legacy_note_only_collision = (summary.legacy_note_only_collision ?? 0) + 1;
    review.push({
      shipmentId: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      source: row.source,
      result: 'legacy_note_only_collision',
    });
    continue;
  }
  const selection = await resolveOutboundPackageSelection({
    orderId: row.orderId,
    selectedPackageId: row.selectedPackageId,
    dimensions: { length: row.dimsL, width: row.dimsW, height: row.dimsH },
  });
  const bucket = selection.status === 'matched'
    ? `eligible_${selection.matchedBy}`
    : `${selection.status}_${selection.reason}`;
  summary[bucket] = (summary[bucket] ?? 0) + 1;
  if (selection.status !== 'matched') {
    review.push({ shipmentId: row.id, orderId: row.orderId, orderNumber: row.orderNumber, source: row.source, result: selection });
  }
}

console.log(JSON.stringify({ mode: 'dry-run', days, since: since.toISOString(), scanned: rows.length, summary, review }, null, 2));
