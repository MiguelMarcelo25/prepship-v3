/**
 * PS-413 historical package-consumption audit. READ ONLY.
 * Produces review buckets; never writes ledger, stock, shipments, or orders.
 */
import { desc, sql } from 'drizzle-orm';
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
  .where(sql`coalesce(${shipments.shipDate}, ${shipments.createDate}, ${shipments.createdAt}) >= ${since.toISOString()}::timestamptz`)
  .orderBy(desc(shipments.id));

const ledgerIdentities = await db
  .select({ shipmentId: packageLedger.shipmentId, note: packageLedger.note })
  .from(packageLedger);
const consumedShipmentIds = new Set(
  ledgerIdentities
    .map((row) => row.shipmentId)
    .filter((value): value is number => value != null),
);
const legacyShipmentIds = new Set<number>();
for (const row of ledgerIdentities) {
  const match = row.note?.match(/^Shipment (\d+) for order /);
  if (match?.[1]) legacyShipmentIds.add(Number(match[1]));
}
const pendingReviews = await db
  .select({ shipmentId: packageConsumptionReviews.shipmentId, reason: packageConsumptionReviews.reason })
  .from(packageConsumptionReviews);
const pendingReviewByShipment = new Map(
  pendingReviews.map((row) => [row.shipmentId, row.reason] as const),
);

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

const summary: Record<string, number> = {};
const review: Array<Record<string, unknown>> = [];
const resolutionCandidates: Array<{
  row: (typeof rows)[number];
  pendingReviewReason?: string;
}> = [];
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
  if (consumedShipmentIds.has(row.id)) {
    summary.already_consumed = (summary.already_consumed ?? 0) + 1;
    continue;
  }
  const pendingReviewReason = pendingReviewByShipment.get(row.id);
  if (pendingReviewReason) {
    resolutionCandidates.push({ row, pendingReviewReason });
    continue;
  }
  const legacyIdentities = [...new Set([row.id, row.labelShipmentId].filter((value): value is number => value != null))];
  if (legacyIdentities.some((identity) => legacyShipmentIds.has(identity))) {
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
  resolutionCandidates.push({ row });
}

const resolutions = await mapWithConcurrency(resolutionCandidates, 4, ({ row }) =>
  resolveOutboundPackageSelection({
    orderId: row.orderId,
    selectedPackageId: row.selectedPackageId,
    dimensions: { length: row.dimsL, width: row.dimsW, height: row.dimsH },
  }));

for (const [index, candidate] of resolutionCandidates.entries()) {
  const { row, pendingReviewReason } = candidate;
  const selection = resolutions[index]!;
  if (pendingReviewReason) {
    const bucket = selection.status === 'matched' ? 'pending_now_eligible' : 'pending_still_blocked';
    summary[bucket] = (summary[bucket] ?? 0) + 1;
    review.push({
      shipmentId: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      source: row.source,
      previousReason: pendingReviewReason,
      current: selection,
    });
    continue;
  }
  const bucket = selection.status === 'matched'
    ? `eligible_${selection.matchedBy}`
    : `${selection.status}_${selection.reason}`;
  summary[bucket] = (summary[bucket] ?? 0) + 1;
  if (selection.status !== 'matched') {
    review.push({ shipmentId: row.id, orderId: row.orderId, orderNumber: row.orderNumber, source: row.source, result: selection });
  }
}

console.log(JSON.stringify({ mode: 'dry-run', days, since: since.toISOString(), scanned: rows.length, summary, review }, null, 2));
