import { sql } from 'drizzle-orm';
import { classifyCustomerShippingMoney } from '../src/services/customer-shipping-money-classification';
import {
  buildCoverageReport,
  outboundCoveragePct,
  type CoverageExclusionReason,
  type CoverageRow,
} from '../src/services/customer-shipping-money-coverage';

// db/client and the money service are imported DYNAMICALLY, inside main(), and deliberately.
// Importing them at the top validates the database env at MODULE LOAD, so an operator who runs
// this without credentials gets an "Invalid environment variables" stack trace instead of the
// refusal below — the gate would be unreachable, and the first thing a gate must be is reached.
// Both modules above are pure and safe to import eagerly.

/**
 * PS-508 step 1 — the coverage and shadow-comparison audit. STRICTLY READ-ONLY.
 *
 * Answers the question the whole cutover is sized by: of the shipments that could carry an
 * outbound tuple, how many do, and where a tuple exists, does it agree with what billing would
 * charge today?
 *
 * ── READ-ONLY IS A PROPERTY, NOT AN INTENTION ───────────────────────────────────────────
 *
 * This issues SELECTs only. It never writes, never repairs, never freezes. The recompute side
 * goes through previewShipmentCustomerShippingMoney — the canonical read-only preview — rather
 * than a private reimplementation, because a second derivation of customer money written for an
 * audit is exactly the drift this ticket exists to remove. It costs one query per row; an audit
 * is allowed to be slow.
 *
 * ── OPERATOR GATE ───────────────────────────────────────────────────────────────────────
 *
 * DATABASE_URL in this repo can point at production. Even a read-only sweep against production is
 * an operator action, so it refuses to run without PS508_AUDIT_OPERATOR naming who is running it.
 * The name is recorded in the report header so the artifact says who produced it.
 */

type ShipmentRow = {
  id: number;
  clientId: number | null;
  source: string | null;
  isReturn: boolean;
  voided: boolean;
  selectedRateCost: string | number | null;
  selectedRateJson: unknown;
};

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Why a row cannot carry an ordinary outbound tuple. Order matters: a voided return is reported
 * as a return, because that is the reason a reader would look for first.
 */
function exclusionFor(row: ShipmentRow): CoverageExclusionReason | null {
  if (row.isReturn) return 'return';
  if (row.source === 'replacement') return 'replacement';
  if (row.voided) return 'voided';
  if (row.source === 'test_offline') return 'test_offline';
  const cost = finite(row.selectedRateCost);
  // No positive selected cost => nothing to bill shipping against, and the freeze fail-closes on
  // it. This is the honest home for external/`Ext. Label` rows, which the UI shows with no rate:
  // identifying them by cost is a fact, identifying them by a source string would be a guess.
  if (cost == null || cost <= 0) return 'no_billable_cost';
  return null;
}

function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

async function main(): Promise<void> {
  const operator = process.env.PS508_AUDIT_OPERATOR;
  if (!operator) {
    console.error(
      'REFUSED: set PS508_AUDIT_OPERATOR to the person running this.\n'
      + '  DATABASE_URL here can point at production. This audit writes nothing, but reading\n'
      + '  production is still an operator action and the report must record who produced it.',
    );
    process.exit(2);
  }

  const days = Number(arg('days') ?? '30');
  const limit = Number(arg('limit') ?? '5000');
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit must be a positive number');

  // Only now — after the gate — touch anything that opens a database connection.
  const { db } = await import('../src/db/client');
  const { previewShipmentCustomerShippingMoney } =
    await import('../src/services/customer-shipping-money');

  const result = await db.execute<ShipmentRow>(sql`
    select
      s.id as "id",
      s.client_id as "clientId",
      s.source as "source",
      coalesce(s.is_return, false) as "isReturn",
      coalesce(s.voided, false) as "voided",
      s.selected_rate_cost as "selectedRateCost",
      s.selected_rate_json as "selectedRateJson"
    from shipments s
    where s.create_date >= now() - ${`${days} days`}::interval
    order by s.id desc
    limit ${limit}
  `);
  const shipments = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as ShipmentRow[];

  const rows: CoverageRow[] = [];
  for (const shipment of shipments) {
    const excluded = exclusionFor(shipment);
    const classification = classifyCustomerShippingMoney(shipment.selectedRateJson);
    const tupleAmount = classification.kind === 'valid_ps508' || classification.kind === 'valid_ps437'
      ? classification.frozen.cShippingRateAmount
      : null;

    let recomputeAmount: number | null = null;
    if (!excluded && tupleAmount != null) {
      // Only recomputed where there is something to compare. A throw here is a real answer —
      // "billing cannot price this row" — not an error to swallow.
      try {
        recomputeAmount = (await previewShipmentCustomerShippingMoney(shipment.id)).cShippingRateAmount;
      } catch {
        recomputeAmount = null;
      }
    }

    rows.push({
      shipmentId: shipment.id,
      clientId: shipment.clientId,
      source: shipment.source,
      excluded,
      kind: classification.kind,
      tupleAmount,
      recomputeAmount,
    });
  }

  const report = buildCoverageReport(rows);
  const pct = outboundCoveragePct(report);

  console.log('PS-508 coverage + shadow comparison');
  console.log(`operator: ${operator}   window: last ${days} day(s)   limit: ${limit}`);
  console.log('READ-ONLY: this run issued SELECTs only.\n');

  console.log(`POPULATION  ${report.total} shipment(s)`);
  console.log(`  excluded (cannot carry an outbound tuple): ${report.excludedTotal}`);
  for (const [reason, count] of Object.entries(report.excluded)) {
    if (count > 0) console.log(`      ${reason.padEnd(18)} ${count}`);
  }
  console.log(`  IN SCOPE: ${report.inScope}\n`);

  console.log('CLASSIFICATION (in-scope only)');
  for (const [kind, count] of Object.entries(report.byKind)) {
    const share = report.inScope > 0 ? ` (${((count / report.inScope) * 100).toFixed(1)}%)` : '';
    console.log(`  ${kind.padEnd(24)} ${String(count).padStart(6)}${share}`);
  }
  console.log(`\n  outbound coverage: ${pct == null ? 'n/a' : `${pct}%`} of in-scope rows carry ps-508-v1\n`);

  console.log('SHADOW COMPARISON (valid tuple vs what billing would charge today)');
  console.log(`  compared:            ${report.compared}`);
  console.log(`  differing:           ${report.differing}`);
  console.log(`  signed total:        ${money(report.signedDollars)}`);
  console.log(`  absolute total:      ${money(report.absoluteDollars)}`);
  console.log(`  max single delta:    ${report.maxAbsoluteDelta
    ? `${money(report.maxAbsoluteDelta.delta)} (shipment ${report.maxAbsoluteDelta.shipmentId})`
    : 'none'}`);
  console.log(`  uncomparable:        ${report.uncomparable}`);

  if (report.byClient.length) {
    console.log('\n  by client (largest absolute first)');
    for (const b of report.byClient.slice(0, 15)) {
      console.log(`    client ${b.key.padEnd(10)} rows ${String(b.rows).padStart(5)}  differing ${String(b.differing).padStart(5)}  signed ${money(b.signedDollars).padStart(12)}  abs ${money(b.absoluteDollars)}`);
    }
  }
  if (report.bySource.length) {
    console.log('\n  by source');
    for (const b of report.bySource) {
      console.log(`    ${b.key.padEnd(18)} rows ${String(b.rows).padStart(5)}  differing ${String(b.differing).padStart(5)}  signed ${money(b.signedDollars).padStart(12)}  abs ${money(b.absoluteDollars)}`);
    }
  }

  if (report.activationBlockers.length) {
    console.log('\nACTIVATION BLOCKERS — tuple precedence must NOT be enabled over this population:');
    for (const blocker of report.activationBlockers) console.log(`  - ${blocker}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nNo activation blockers in this population.');
  console.log('This does NOT authorise activation on its own — the plan review also requires a');
  console.log('finalized-period dry run and an approved disposition for every non-zero divergence.');
}

main().catch((err) => { console.error(err); process.exit(1); });
