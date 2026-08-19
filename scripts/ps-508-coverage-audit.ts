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
 * ── WHERE THIS IS MEANT TO RUN ──────────────────────────────────────────────────────────
 *
 * As a RENDER ONE-OFF JOB, dispatched from
 * .github/workflows/render-one-off-ps-508-coverage-audit.yml — not from a workstation.
 *
 * The first cut of this script was built to be run locally against DATABASE_URL. That is the wrong
 * shape and the repo already knew it: the BILL-DUP-OUTBOUND-CHARGE lane says so in its header.
 * Running locally means a production database credential sits on a workstation, where it can leak
 * and has to be rotated. The Render job runs inside the environment that already holds one, so no
 * local secret needs to exist at all.
 *
 * ── OPERATOR GATE ───────────────────────────────────────────────────────────────────────
 *
 * PS508_AUDIT_OPERATOR must name who is running this, and the report header records it.
 *
 * On the Render lane that value is `github.actor` — an AUTHENTICATED identity that the person
 * dispatching cannot forge. Set by hand on a workstation it is worth much less: an env var is
 * whatever its setter types, so a local run records an assertion, not a fact. That is the reason
 * the lane, not the env var, is the real gate.
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

/**
 * Every report line carries this tag, and that is what makes the report RETRIEVABLE.
 *
 * A Render one-off job writes into the same log stream as the web service it runs beside, and that
 * service emits a /health/ready line every few seconds. Fetching by service and time window buries
 * the report in health checks — proven, on the first working retrieval. Filtering the logs API by
 * an instance id did not work either: a job id is not an instance id.
 *
 * Tagging every line sidesteps the question. The lane filters server-side on this exact token, so
 * it gets the report and nothing else, without depending on API filter semantics I cannot verify
 * from here. It also makes the report greppable in the Render dashboard by hand.
 */
const TAG = 'PS508|';
function say(line = ''): void {
  // EVERY physical line, not just the first. Several report strings embed \n for spacing, so
  // prefixing only the head would emit untagged continuation lines — and those are content, not
  // blanks (`\n  outbound coverage: ...`). They would then be dropped by the tag filter and the
  // report would arrive quietly incomplete, which is worse than not arriving.
  console.log(String(line).split('\n').map((part) => `${TAG}${part}`).join('\n'));
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
  const { db, sql: pg } = await import('../src/db/client');
  const { previewShipmentCustomerShippingMoney } =
    await import('../src/services/customer-shipping-money');

  // Read-only enforced by the SERVER, not by my reading of the code. The guard proves the source
  // contains no write; this makes the database refuse one anyway. Belt and braces, because the
  // recompute path calls into the money service and I do not want its correctness resting on my
  // having traced every query it might issue.
  //
  // Caveat stated rather than hidden: this pins the SESSION, and postgres-js holds a pool, so it
  // binds the connection it runs on. It is the same mechanism the BILL-DUP-OUTBOUND-CHARGE lane
  // uses; the guarantee that carries the weight is still the no-write proof in the guard.
  await pg.unsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

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

  say('PS-508 coverage + shadow comparison');
  say(`operator: ${operator}   window: last ${days} day(s)   limit: ${limit}`);
  say('READ-ONLY: this run issued SELECTs only.\n');

  say(`POPULATION  ${report.total} shipment(s)`);
  say(`  excluded (cannot carry an outbound tuple): ${report.excludedTotal}`);
  for (const [reason, count] of Object.entries(report.excluded)) {
    if (count > 0) say(`      ${reason.padEnd(18)} ${count}`);
  }
  say(`  IN SCOPE: ${report.inScope}\n`);

  say('CLASSIFICATION (in-scope only)');
  for (const [kind, count] of Object.entries(report.byKind)) {
    const share = report.inScope > 0 ? ` (${((count / report.inScope) * 100).toFixed(1)}%)` : '';
    say(`  ${kind.padEnd(24)} ${String(count).padStart(6)}${share}`);
  }
  say(`\n  outbound coverage: ${pct == null ? 'n/a' : `${pct}%`} of in-scope rows carry ps-508-v1\n`);

  say('SHADOW COMPARISON (valid tuple vs what billing would charge today)');
  say(`  compared:            ${report.compared}`);
  say(`  differing:           ${report.differing}`);
  say(`  signed total:        ${money(report.signedDollars)}`);
  say(`  absolute total:      ${money(report.absoluteDollars)}`);
  say(`  max single delta:    ${report.maxAbsoluteDelta
    ? `${money(report.maxAbsoluteDelta.delta)} (shipment ${report.maxAbsoluteDelta.shipmentId})`
    : 'none'}`);
  say(`  uncomparable:        ${report.uncomparable}`);

  if (report.byClient.length) {
    say('\n  by client (largest absolute first)');
    for (const b of report.byClient.slice(0, 15)) {
      say(`    client ${b.key.padEnd(10)} rows ${String(b.rows).padStart(5)}  differing ${String(b.differing).padStart(5)}  signed ${money(b.signedDollars).padStart(12)}  abs ${money(b.absoluteDollars)}`);
    }
  }
  if (report.bySource.length) {
    say('\n  by source');
    for (const b of report.bySource) {
      say(`    ${b.key.padEnd(18)} rows ${String(b.rows).padStart(5)}  differing ${String(b.differing).padStart(5)}  signed ${money(b.signedDollars).padStart(12)}  abs ${money(b.absoluteDollars)}`);
    }
  }

  if (report.activationBlockers.length) {
    say('\nACTIVATION BLOCKERS — tuple precedence must NOT be enabled over this population:');
    for (const blocker of report.activationBlockers) say(`  - ${blocker}`);
    process.exitCode = 1;
    return;
  }
  say('\nNo activation blockers in this population.');
  say('This does NOT authorise activation on its own — the plan review also requires a');
  say('finalized-period dry run and an approved disposition for every non-zero divergence.');
}

main().catch((err) => { console.error(err); process.exit(1); });
