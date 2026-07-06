import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../src/db/client';
import { shipments } from '../src/db/schema/shipments';
import { ensureShipmentsSelectedRateCostColumn } from '../src/db/ensure-shipments-selected-rate-cost';
import {
  planSelectedRateCostBackfillRow,
  summarizeSelectedRateCostBackfill,
  type SelectedRateCostBackfillPlan,
  type SelectedRateCostBackfillRow,
} from '../src/services/shipping-workflow/selected-rate-cost-backfill';

/**
 * PS-370 Phase 2 — shipments.selected_rate_cost HISTORY backfill.
 *
 * Phase 1 added the additive column + made every reader PREFER it (exact prior
 * derivation for NULL rows). This materializes that SAME derived value into the
 * column for existing (incl. shipped) rows, so the read-time fallback becomes
 * NULL-safety only afterward.
 *
 * SAFETY (per CLAUDE.md shipped/cancelled lockdown):
 *   - Per user override unlock shipped data on 2026-07-06: PS-381 is authorized
 *     to write ONLY shipments.selected_rate_cost after dry-run review.
 *   - DRY-RUN by DEFAULT. Prints what WOULD change; writes NOTHING.
 *   - `--apply` is DOUBLE-GATED: it ALSO requires `--confirm-production`, so it
 *     can never mutate shipped rows by accident.
 *   - A row is only written when the backend selected-rate resolver can prove a
 *     durable cost from selected-rate JSON total or from cost/labelCost + otherCost.
 *     Rows with no durable proof are SKIPPED and left NULL for review.
 *   - Writes ONLY shipments.selected_rate_cost, ONLY where it is currently NULL.
 *     NEVER touches cost/labelCost/otherCost/selectedRateJson, carrier/service/
 *     tracking, order status, dims, weight, package, items, or any other row.
 *   - Idempotent: already-set rows are skipped, so re-running apply is a no-op.
 *   - No provider calls, no labels, no postage, no void, no marketplace notify, no PII.
 *   - main() runs only when invoked directly, so importing this module never connects.
 *
 * Phase 2 requires DJ's `unlock shipped data` + review of the dry-run first.
 * AGENTS DO NOT RUN --apply. DJ runs the apply himself after reviewing the dry run.
 * PRECONDITION: Phase 1 must be DEPLOYED (the column must exist in the target DB).
 *
 *   npx tsx scripts/ps-370-selected-rate-cost-backfill.ts                       # dry run
 *   npx tsx scripts/ps-370-selected-rate-cost-backfill.ts --apply --confirm-production
 */

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

/** Candidate rows: shipments whose selected_rate_cost is still NULL. The pure
 *  planner re-validates the byte-identity gate as the single source of truth. */
async function loadCandidateRows(limit: number): Promise<SelectedRateCostBackfillRow[]> {
  const rows = await db
    .select({
      shipmentId: shipments.id,
      orderNumber: shipments.orderNumber,
      cost: shipments.cost,
      labelCost: shipments.labelCost,
      otherCost: shipments.otherCost,
      selectedRateJson: shipments.selectedRateJson,
      selectedRateCost: shipments.selectedRateCost,
    })
    .from(shipments)
    .where(isNull(shipments.selectedRateCost))
    .limit(limit);

  return rows.map((row) => ({
    shipmentId: row.shipmentId,
    orderNumber: row.orderNumber,
    cost: row.cost,
    labelCost: row.labelCost,
    otherCost: row.otherCost,
    selectedRateJson: row.selectedRateJson,
    selectedRateCost: row.selectedRateCost,
  }));
}

// The ONLY write path. Sets shipments.selected_rate_cost for a byte-identical,
// currently-NULL row. Touches nothing else. Guards on isNull() again so a
// concurrently-backfilled row is never overwritten.
async function applyBackfill(plan: SelectedRateCostBackfillPlan): Promise<boolean> {
  if (!plan.affected || plan.value == null) return false;
  const result = await db
    .update(shipments)
    .set({ selectedRateCost: plan.value.toFixed(2) })
    .where(and(eq(shipments.id, plan.shipmentId), isNull(shipments.selectedRateCost)))
    .returning({ id: shipments.id });
  return result.length > 0;
}

async function main(): Promise<void> {
  const apply = hasFlag('apply');
  const confirmProduction = hasFlag('confirm-production');
  const asJson = hasFlag('json');
  const limit = Number(argValue('limit') ?? '5000') || 5000;

  // Phase 1's additive ensure — the column must exist before we read/write it.
  await ensureShipmentsSelectedRateCostColumn();

  const rows = await loadCandidateRows(limit);
  const plans = rows.map((row) => planSelectedRateCostBackfillRow(row));
  const affected = plans.filter((plan) => plan.affected);
  const summary = summarizeSelectedRateCostBackfill(plans);
  const willApply = apply && confirmProduction;
  const modeLabel = willApply
    ? 'APPLY (writes shipments.selected_rate_cost ONLY, on NULL rows)'
    : 'DRY RUN (no writes)';

  if (asJson) {
    console.log(JSON.stringify({ mode: willApply ? 'apply' : 'dry-run', summary, sample: affected.slice(0, 25) }, null, 2));
  } else {
    console.log(`PS-370 Phase 2 selected_rate_cost backfill — ${modeLabel}\n`);
    console.log(
      `Scanned ${summary.total} NULL-column shipment(s): ${summary.affected} byte-identical to backfill, ` +
        `${summary.alreadySet} already set, ${summary.noRecordedCost} no recorded cost (left NULL), ` +
        `${summary.readerDivergent} reader-divergent (left NULL).`,
    );
    for (const plan of affected.slice(0, 50)) {
      console.log(
        `order ${plan.orderNumber ?? '?'} (shipment ${plan.shipmentId}): ` +
          `${willApply ? 'setting' : 'would set'} selected_rate_cost -> ${plan.value?.toFixed(2)}`,
      );
    }
    if (affected.length > 50) console.log(`… and ${affected.length - 50} more.`);
    if (!affected.length) console.log('No byte-identical shipments need a selected_rate_cost backfill.');
  }

  // ── Apply gating ────────────────────────────────────────────────────────────
  if (!apply) {
    process.exit(0);
  }
  if (!confirmProduction) {
    console.error(
      [
        '',
        'PS-370 Phase 2 apply is DOUBLE-GATED and did NOT write anything.',
        'It sets shipments.selected_rate_cost on SHIPPED rows, so it also requires',
        '--confirm-production. Review the dry-run plan above, then re-run:',
        '  npx tsx scripts/ps-370-selected-rate-cost-backfill.ts --apply --confirm-production',
        'Authorized only under DJ`s `unlock shipped data` + dry-run review.',
      ].join('\n'),
    );
    process.exit(2);
  }

  // Confirmed apply — DJ-gated `unlock shipped data`, byte-identical, column-only.
  let updated = 0;
  for (const plan of affected) {
    try {
      if (await applyBackfill(plan)) updated += 1;
    } catch (err) {
      console.error(`[ps-370] apply failed for shipment ${plan.shipmentId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nAPPLY complete: ${updated}/${affected.length} shipment(s) backfilled (selected_rate_cost only).`);
  process.exit(updated === affected.length ? 0 : 1);
}

// Only run when invoked directly so importing this module in a test never connects.
const invokedDirectly =
  process.argv[1] != null && /ps-370-selected-rate-cost-backfill\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[ps-370] backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { planSelectedRateCostBackfillRow };
