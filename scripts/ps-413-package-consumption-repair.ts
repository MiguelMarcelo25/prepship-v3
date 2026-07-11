/**
 * PS-413 bounded historical package-consumption repair.
 *
 * Per user override unlock shipped data on 2026-07-11: this script may append
 * package ledger rows and decrement package stock. It never updates orders or
 * shipments, never calls a provider, and never buys/voids a label.
 *
 * Dry-run by default. Apply requires both --apply and --confirm-production.
 * Each shipment commits through its own canonical transaction. Larger approved
 * repairs use concurrency 4 and report independently verified 25-row groups.
 */
import 'dotenv/config';
import { desc, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { packageConsumptionReviews } from '../src/db/schema/package-consumption-reviews.js';
import { packageLedger } from '../src/db/schema/package-ledger.js';
import { shipments } from '../src/db/schema/shipments.js';
import {
  consumeOutboundPackage,
  isPackageAutoDeductEnabled,
  resolveOutboundPackageSelection,
  type OutboundPackageConsumptionInput,
} from '../src/services/package-consumption.js';

const MAX_BATCH_SIZE = 25;
const MAX_TOTAL_SIZE = 2_000;

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

type CandidateRow = Awaited<ReturnType<typeof loadRows>>[number];
type PlannedCandidate = {
  row: CandidateRow;
  input: OutboundPackageConsumptionInput;
  packageId: number;
  matchedBy: string;
};

async function loadRows(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  return db
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
      createdAt: shipments.createdAt,
      voided: shipments.voided,
      isReturn: shipments.isReturn,
    })
    .from(shipments)
    .where(sql`coalesce(${shipments.shipDate}, ${shipments.createDate}, ${shipments.createdAt}) >= ${since.toISOString()}::timestamptz`)
    .orderBy(desc(shipments.id));
}

function isTestRow(row: CandidateRow): boolean {
  return row.source === 'test_offline' ||
    Boolean(row.trackingNumber?.startsWith('TEST')) ||
    Boolean(row.trackingNumber?.startsWith('SHOPIFY-MOCK-')) ||
    Boolean(row.labelUrl?.startsWith('mock://'));
}

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

async function planCandidates(days: number, limit: number): Promise<PlannedCandidate[]> {
  const [rows, ledgerRows, reviewRows] = await Promise.all([
    loadRows(days),
    db.select({ shipmentId: packageLedger.shipmentId, note: packageLedger.note }).from(packageLedger),
    db.select({ shipmentId: packageConsumptionReviews.shipmentId }).from(packageConsumptionReviews),
  ]);

  const consumedShipmentIds = new Set(
    ledgerRows.map((row) => row.shipmentId).filter((value): value is number => value != null),
  );
  const legacyShipmentIds = new Set<number>();
  for (const row of ledgerRows) {
    const match = row.note?.match(/^Shipment (\d+) for order /);
    if (match?.[1]) legacyShipmentIds.add(Number(match[1]));
  }
  const reviewedShipmentIds = new Set(reviewRows.map((row) => row.shipmentId));

  const eligibleRows = rows.filter((row) => {
    if (row.voided || row.isReturn || isTestRow(row)) return false;
    if (consumedShipmentIds.has(row.id) || reviewedShipmentIds.has(row.id)) return false;
    return !legacyShipmentIds.has(row.id) &&
      (row.labelShipmentId == null || !legacyShipmentIds.has(row.labelShipmentId));
  });
  const selections = await mapWithConcurrency(eligibleRows, 4, (row) =>
    resolveOutboundPackageSelection({
      orderId: row.orderId,
      selectedPackageId: row.selectedPackageId,
      dimensions: { length: row.dimsL, width: row.dimsW, height: row.dimsH },
    }));

  const planned: PlannedCandidate[] = [];
  for (const [index, row] of eligibleRows.entries()) {
    const selection = selections[index]!;
    if (selection.status !== 'matched') continue;

    // Historical rows cannot reliably reconstruct the sync account identity.
    // Omit provider identity so idempotency uses immutable local shipment id.
    const input: OutboundPackageConsumptionInput = {
      shipmentId: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      source: row.source ?? 'historical_repair',
      effectiveAt: row.shipDate ?? row.createDate ?? row.createdAt,
      selectedPackageId: row.selectedPackageId,
      dimensions: { length: row.dimsL, width: row.dimsW, height: row.dimsH },
    };
    planned.push({ row, input, packageId: selection.packageId, matchedBy: selection.matchedBy });
    if (planned.length >= limit) break;
  }
  return planned;
}

async function main(): Promise<void> {
  const apply = hasFlag('apply');
  const confirmProduction = hasFlag('confirm-production');
  const summaryOnly = hasFlag('summary');
  const days = Math.min(numberArg('days', 30), 365);
  const limit = numberArg('limit', MAX_BATCH_SIZE);
  const batchSize = numberArg('batch-size', MAX_BATCH_SIZE);
  if (limit > MAX_TOTAL_SIZE) throw new Error(`--limit cannot exceed repair cap ${MAX_TOTAL_SIZE}`);
  if (batchSize > MAX_BATCH_SIZE) throw new Error(`--batch-size cannot exceed ${MAX_BATCH_SIZE}`);

  const candidates = await planCandidates(days, limit);
  console.log(JSON.stringify({
    mode: apply && confirmProduction ? 'apply' : 'dry-run',
    days,
    limit,
    batchSize,
    candidateCount: candidates.length,
    candidates: summaryOnly ? undefined : candidates.map(({ row, packageId, matchedBy }) => ({
      shipmentId: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      packageId,
      matchedBy,
      source: row.source,
      effectiveAt: (row.shipDate ?? row.createDate ?? row.createdAt).toISOString(),
    })),
  }, null, 2));

  if (!apply) return;
  if (!confirmProduction) {
    throw new Error('Apply blocked: --confirm-production is also required');
  }
  if (!isPackageAutoDeductEnabled()) {
    throw new Error('Apply blocked: INVENTORY_AUTO_DEDUCT is disabled');
  }
  if (candidates.length === 0) return;

  const results = [];
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const batchResults = await mapWithConcurrency(batch, 4, async (candidate) => {
      const result = await consumeOutboundPackage(candidate.input);
      if (!['consumed', 'already_consumed'].includes(result.status)) {
        throw new Error(`Shipment ${candidate.row.id} became ineligible: ${result.status}`);
      }
      if (result.packageId !== candidate.packageId) {
        throw new Error(`Shipment ${candidate.row.id} package resolution changed during apply`);
      }
      return { shipmentId: candidate.row.id, ...result };
    });
    results.push(...batchResults);
    console.log(`Verified batch ${Math.floor(offset / batchSize) + 1}: ${batch.length} shipment(s)`);
  }

  const verification = await db
    .select({ shipmentId: packageLedger.shipmentId, packageId: packageLedger.packageId })
    .from(packageLedger)
    .where(inArray(packageLedger.shipmentId, candidates.map((candidate) => candidate.row.id)));
  const verified = new Map(verification.map((row) => [row.shipmentId, row.packageId]));
  for (const candidate of candidates) {
    if (verified.get(candidate.row.id) !== candidate.packageId) {
      throw new Error(`Post-apply verification failed for shipment ${candidate.row.id}`);
    }
  }

  console.log(JSON.stringify({
    mode: 'apply-complete',
    consumed: results.filter((result) => result.status === 'consumed').length,
    alreadyConsumed: results.filter((result) => result.status === 'already_consumed').length,
    verified: candidates.length,
  }, null, 2));
}

const invokedDirectly = process.argv[1] != null && /ps-413-package-consumption-repair\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[ps-413] repair failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

export { planCandidates };
