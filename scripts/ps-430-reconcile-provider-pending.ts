/**
 * PS-430 bounded operator reconciliation.
 *
 * Dry-run is the default and always rolls back. Apply requires an explicit
 * expected count. The SQL updates only Print Queue item sidecars after proving
 * an existing canonical shipment/provider receipt; this script imports no
 * label, carrier, marketplace, order, or shipment mutation service.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

type ReconciliationSummary = {
  guard_passed: boolean;
  pending_count: number | string;
  order_count: number | string;
  job_count: number | string;
  durable_receipt_count: number | string;
  matching_queue_entry_count: number | string;
  unresolved_purchase_intent_count: number | string;
  updated_count: number | string;
  reconciled_queued_count: number | string;
  reconciled_shipment_persisted_count: number | string;
};

type NormalizedSummary = {
  guardPassed: boolean;
  pendingCount: number;
  orderCount: number;
  jobCount: number;
  durableReceiptCount: number;
  matchingQueueEntryCount: number;
  unresolvedPurchaseIntentCount: number;
  updatedCount: number;
  reconciledQueuedCount: number;
  reconciledShipmentPersistedCount: number;
};

class DryRunRollback extends Error {}

function numeric(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('Invalid reconciliation count');
  return parsed;
}

function normalize(row: ReconciliationSummary | undefined): NormalizedSummary {
  if (!row) throw new Error('Reconciliation returned no summary');
  return {
    guardPassed: row.guard_passed,
    pendingCount: numeric(row.pending_count),
    orderCount: numeric(row.order_count),
    jobCount: numeric(row.job_count),
    durableReceiptCount: numeric(row.durable_receipt_count),
    matchingQueueEntryCount: numeric(row.matching_queue_entry_count),
    unresolvedPurchaseIntentCount: numeric(row.unresolved_purchase_intent_count),
    updatedCount: numeric(row.updated_count),
    reconciledQueuedCount: numeric(row.reconciled_queued_count),
    reconciledShipmentPersistedCount: numeric(row.reconciled_shipment_persisted_count),
  };
}

function expectedCountFromArgs(args: string[]): number | null {
  const raw = args.find((arg) => arg.startsWith('--expected-count='))?.split('=', 2)[1];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const expectedCount = expectedCountFromArgs(args);
if (apply && expectedCount === null) {
  throw new Error('Apply requires --expected-count=<positive integer>');
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const statement = readFileSync(
  'docs/final-review/evidence/PS-430-provider-pending-reconciliation.sql',
  'utf8',
);
const sql = postgres(databaseUrl, { max: 1, prepare: false, max_pipeline: 1 });
let summary: NormalizedSummary | null = null;

try {
  summary = await sql.begin(async (tx) => {
    const rows = await tx.unsafe<ReconciliationSummary[]>(statement);
    const result = normalize(rows[0]);
    if (!result.guardPassed) throw new Error('Incident guard did not pass; zero rows are eligible');
    if (expectedCount !== null && result.pendingCount !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} pending sidecars, found ${result.pendingCount}; transaction rolled back`,
      );
    }
    if (result.updatedCount !== result.pendingCount) {
      throw new Error('Reconciliation did not update every guarded sidecar; transaction rolled back');
    }
    if (!apply) {
      summary = result;
      throw new DryRunRollback('Dry-run rollback');
    }
    return result;
  });
} catch (error) {
  if (!(error instanceof DryRunRollback)) throw error;
} finally {
  await sql.end();
}

if (!summary) throw new Error('Reconciliation summary was not captured');
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run-rolled-back', ...summary }, null, 2));
