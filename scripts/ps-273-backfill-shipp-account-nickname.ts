import 'dotenv/config';
import { and, eq, isNull, like, or } from 'drizzle-orm';
import { db } from '../src/db/client';
import { shipments } from '../src/db/schema/shipments';
import { orders } from '../src/db/schema/orders';
import {
  planShippNicknameBackfillRow,
  summarizeShippNicknamePlans,
  SHIPP_BROKERED_ACCOUNT_LABEL,
  type ShippNicknameBackfillPlan,
  type ShippNicknameBackfillRow,
} from '../src/services/shipping-workflow/shipp-account-nickname-backfill';

/**
 * PS-273 — Shipp brokered-account nickname HISTORY backfill.
 *
 * THE BUG: a Shipp-brokered label stored only the synthetic provider id
 * (10_000_000 + carrier_accounts.id) and NO shipments.provider_account_nickname.
 * With no stored truth, readers fell back to carrier family and fabricated a
 * direct UPS account (GG6381 on order #1587 / client HUGRAB) the label was never
 * bought on. The forward fix writes "Shipp" at purchase; this corrects the past.
 *
 * SAFETY (per CLAUDE.md shipped/cancelled lockdown):
 *   - DRY-RUN by DEFAULT. Prints what WOULD change; writes NOTHING.
 *   - `--apply` is DOUBLE-GATED: it ALSO requires `--confirm-production`, so it
 *     can never mutate shipped rows by accident.
 *   - The write is DISPLAY-ACCOUNTING-ONLY: it sets shipments.provider_account_nickname
 *     = "Shipp" (and mirrors it into selectedRateJson.providerAccountNickname) for
 *     brokered Shipp labels that currently have NO nickname. It NEVER touches
 *     cost/labelCost, carrier/service/tracking, order status, dims, weight,
 *     package, items, or any non-Shipp row. It cannot change account IDENTITY —
 *     a Shipp label IS Shipp's broker account.
 *   - Idempotent: planShippNicknameBackfillRow marks rows that already carry a
 *     nickname as not affected, so re-running apply is a no-op.
 *   - No provider calls, no labels, no postage, no void, no marketplace notify.
 *   - No PII: prints order number, shipment id, service code, and the nickname.
 *   - main() runs only when invoked directly, so importing this module never connects.
 *
 * Per user override unlock shipped data on 2026-06-17 (PS-273): this is the ONLY
 * write path to shipped Shipp rows for this track and it is display-accounting-only.
 * AGENTS DO NOT RUN --apply. DJ runs the apply himself.
 *
 *   npx tsx scripts/ps-273-backfill-shipp-account-nickname.ts            # dry run
 *   npx tsx scripts/ps-273-backfill-shipp-account-nickname.ts --apply --confirm-production
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

/** Candidate rows: brokered Shipp labels (service_code shipp_* OR source='shipp')
 *  that currently have NO provider_account_nickname. The planner re-validates. */
async function loadCandidateRows(limit: number): Promise<ShippNicknameBackfillRow[]> {
  const rows = await db
    .select({
      shipmentId: shipments.id,
      orderId: shipments.orderId,
      orderNumber: shipments.orderNumber,
      serviceCode: shipments.serviceCode,
      source: shipments.source,
      providerAccountNickname: shipments.providerAccountNickname,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.voided, false),
        isNull(shipments.providerAccountNickname),
        // Broad brokered-Shipp candidate filter; the pure planner re-validates the
        // shipp_*-prefix / source='shipp' rule as the single source of truth.
        or(eq(shipments.source, 'shipp'), like(shipments.serviceCode, 'shipp\\_%')),
      ),
    )
    .limit(limit);

  return rows.map((row) => ({
    shipmentId: row.shipmentId,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    serviceCode: row.serviceCode,
    source: row.source,
    providerAccountNickname: row.providerAccountNickname,
  }));
}

// Per user override unlock shipped data on 2026-06-17 (PS-273): the ONLY write
// path. DISPLAY-ACCOUNTING-ONLY — sets provider_account_nickname = "Shipp" and
// mirrors it into selectedRateJson.providerAccountNickname for a brokered Shipp
// row that has none. Touches nothing else.
async function applyNicknameBackfill(plan: ShippNicknameBackfillPlan): Promise<boolean> {
  if (!plan.affected || !plan.nickname) return false;
  const [row] = await db
    .select({ selectedRateJson: shipments.selectedRateJson })
    .from(shipments)
    .where(eq(shipments.id, plan.shipmentId));
  const existing =
    row?.selectedRateJson && typeof row.selectedRateJson === 'object' && !Array.isArray(row.selectedRateJson)
      ? (row.selectedRateJson as Record<string, unknown>)
      : {};
  const mergedRate = { ...existing, providerAccountNickname: plan.nickname };
  await db
    .update(shipments)
    .set({ providerAccountNickname: plan.nickname, selectedRateJson: mergedRate })
    .where(eq(shipments.id, plan.shipmentId));
  return true;
}

async function main(): Promise<void> {
  const apply = hasFlag('apply');
  const confirmProduction = hasFlag('confirm-production');
  const asJson = hasFlag('json');
  const limit = Number(argValue('limit') ?? '1000') || 1000;

  const rows = await loadCandidateRows(limit);
  const plans = rows.map((row) => planShippNicknameBackfillRow(row));
  const affected = plans.filter((plan) => plan.affected);
  const summary = summarizeShippNicknamePlans(plans);
  const willApply = apply && confirmProduction;
  const modeLabel = willApply
    ? 'APPLY (writes shipments.provider_account_nickname + selectedRateJson)'
    : 'DRY RUN (no writes)';

  if (asJson) {
    console.log(JSON.stringify({ mode: willApply ? 'apply' : 'dry-run', summary, affected }, null, 2));
  } else {
    console.log(`PS-273 Shipp brokered-account nickname backfill — ${modeLabel}\n`);
    console.log(
      `Scanned ${summary.total} candidate shipment(s): ${summary.affected} brokered Shipp label(s) ` +
        `missing a nickname, ${summary.skipped} skipped (not brokered or already set).`,
    );
    console.log(`Nickname that ${willApply ? 'is being' : 'would be'} written: "${SHIPP_BROKERED_ACCOUNT_LABEL}"\n`);
    for (const plan of affected) {
      console.log(
        `order ${plan.orderNumber ?? '?'} (shipment ${plan.shipmentId}): ` +
          `${willApply ? 'setting' : 'would set'} provider_account_nickname -> "${plan.nickname}"`,
      );
    }
    if (!affected.length) console.log('No brokered Shipp shipments need a nickname backfill.');
  }

  // ── Apply gating ────────────────────────────────────────────────────────────
  if (!apply) {
    process.exit(0);
  }
  if (!confirmProduction) {
    console.error(
      [
        '',
        'PS-273 apply is DOUBLE-GATED and did NOT write anything.',
        'It sets shipments.provider_account_nickname on SHIPPED Shipp rows, so it',
        'also requires --confirm-production. Review the plan above, then re-run:',
        '  npx tsx scripts/ps-273-backfill-shipp-account-nickname.ts --apply --confirm-production',
        'Authorized only under: Per user override unlock shipped data on 2026-06-17.',
      ].join('\n'),
    );
    process.exit(2);
  }

  // Confirmed apply — Per user override unlock shipped data on 2026-06-17.
  let updated = 0;
  for (const plan of affected) {
    try {
      if (await applyNicknameBackfill(plan)) updated += 1;
    } catch (err) {
      console.error(
        `[ps-273] apply failed for shipment ${plan.shipmentId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  console.log(
    `\nAPPLY complete: ${updated}/${affected.length} shipment(s) backfilled (provider_account_nickname only).`,
  );
  process.exit(updated === affected.length ? 0 : 1);
}

// Only run when invoked directly so importing this module in a test never connects.
const invokedDirectly =
  process.argv[1] != null && /ps-273-backfill-shipp-account-nickname\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[ps-273] backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { planShippNicknameBackfillRow };
