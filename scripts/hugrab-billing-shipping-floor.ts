/**
 * HUGRAB billing shipping floor.
 *
 * Rule: for HUGRAB billing shipping rows, when the backend-derived Selected Rate
 * is below $7.95, set the billed Shipping amount to $7.73.
 *
 * Dry-run by default. Apply/revert requires --expect from a fresh preview.
 *
 * Examples:
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts --date-from=2026-07-01 --date-to=2026-07-03
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts --apply --expect=465 --date-from=2026-07-01 --date-to=2026-07-03
 *   npx tsx scripts/hugrab-billing-shipping-floor.ts --revert --expect=465 --apply
 */

import {
  applyHugrabBillingShippingFloor,
  HUGRAB_BILLING_CLIENT_NAME,
  HUGRAB_SELECTED_RATE_BELOW,
  HUGRAB_SHIPPING_FLOOR_DEFAULT_LIMIT,
  HUGRAB_TARGET_SHIPPING,
  HugrabBillingShippingFloorCountMismatchError,
  listHugrabBillingShippingFloorCandidates,
  type HugrabBillingShippingFloorAction,
  type HugrabBillingShippingFloorPreview,
} from '../src/services/hugrab-billing-shipping-floor';
import { sql } from '../src/db/client';

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isoOrNull(name: string): string | null {
  const raw = argValue(name);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`--${name} must be a valid date`);
  return new Date(ms).toISOString();
}

function positiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function optionalNonnegativeInt(name: string): number | null {
  const raw = argValue(name);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a nonnegative integer`);
  }
  return parsed;
}

function money(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : '$0.00';
}

function usage(): void {
  console.log(`
HUGRAB billing shipping floor

Dry-run:
  npx tsx scripts/hugrab-billing-shipping-floor.ts

Apply after a fresh preview:
  npx tsx scripts/hugrab-billing-shipping-floor.ts --apply --expect=465

Revert the floor back to Selected Rate:
  npx tsx scripts/hugrab-billing-shipping-floor.ts --revert --expect=465 --apply

Optional:
  --date-from=YYYY-MM-DD   only billing ship_date on/after this date
  --date-to=YYYY-MM-DD     only billing ship_date before this date
  --limit=5000             max rows to inspect/update
  --expect=465             required for apply/revert; aborts unless row count matches

Rule:
  client = ${HUGRAB_BILLING_CLIENT_NAME}
  line_type = shipping
  selected_rate_cost < ${money(HUGRAB_SELECTED_RATE_BELOW)}
  current shipping > $0.00
  current shipping != ${money(HUGRAB_TARGET_SHIPPING)}
  set unit_cost and total_cost to ${money(HUGRAB_TARGET_SHIPPING)}
`);
}

function printSummary(summary: HugrabBillingShippingFloorPreview, apply: boolean): void {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${HUGRAB_BILLING_CLIENT_NAME} billing shipping ${summary.action === 'revert' ? 'floor revert' : 'floor'}`);
  console.log(`Rows matched: ${summary.count}`);
  console.log(`Current shipping total: ${money(summary.currentTotal)}`);
  console.log(`New shipping total:     ${money(summary.newTotal)}`);
  console.log(`Delta:                  ${money(summary.delta)}`);
  console.log('');

  console.table(
    summary.sampleRows.map((row) => ({
      billingLineId: row.billingLineId,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      shipDate: row.shipDate,
      selectedRate: money(row.selectedRateCost),
      from: money(row.currentShipping),
      to: money(row.nextShipping),
    })),
  );
  if (summary.count > summary.sampleRows.length) {
    console.log(`...${summary.count - summary.sampleRows.length} more row(s) not shown`);
  }
}

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    usage();
    return;
  }

  const apply = hasFlag('apply');
  const action: HugrabBillingShippingFloorAction = hasFlag('revert') ? 'revert' : 'floor';
  const dateFrom = isoOrNull('date-from') ?? new Date('1970-01-01T00:00:00.000Z').toISOString();
  const dateTo = isoOrNull('date-to') ?? new Date('2999-12-31T00:00:00.000Z').toISOString();
  const limit = positiveInt('limit', HUGRAB_SHIPPING_FLOOR_DEFAULT_LIMIT);
  const expectedCount = optionalNonnegativeInt('expect');

  const preview = await listHugrabBillingShippingFloorCandidates({ action, dateFrom, dateTo, limit });
  printSummary(preview, apply);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply --expect=<Rows matched> to update these billing rows.');
    await sql.end({ timeout: 5 });
    return;
  }

  if (expectedCount === null) {
    console.log('\nRefusing to update: --expect=<Rows matched> is required for apply/revert.');
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  const result = await applyHugrabBillingShippingFloor({ action, dateFrom, dateTo, limit, expectedCount });
  console.log(
    `\nUpdated ${result.updatedCount} billing shipping row(s) ${action === 'revert' ? 'back to Selected Rate' : `to ${money(HUGRAB_TARGET_SHIPPING)}`}.`,
  );
  await sql.end({ timeout: 5 });
}

main().catch(async (err) => {
  if (err instanceof HugrabBillingShippingFloorCountMismatchError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
