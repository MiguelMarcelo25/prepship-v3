import { and, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { orderOverrides, orders } from '../src/db/schema/orders';

type Args = {
  apply: boolean;
  json: boolean;
  limit: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 500;
  return {
    apply: args.includes('--apply'),
    json: args.includes('--json'),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500,
  };
}

function toPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDimsLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value
    .trim()
    .toLowerCase()
    .split('x')
    .map((part) => Number(part.trim()));
  if (parts.length !== 3) return null;
  if (!parts.every((part) => Number.isFinite(part) && part > 0)) return null;
  return parts.join('x');
}

function getCurrentDimsLabel(row: {
  rateDimsL: number | null;
  rateDimsW: number | null;
  rateDimsH: number | null;
  raw: Record<string, unknown> | null;
}): string | null {
  const rawDims =
    row.raw?.dimensions && typeof row.raw.dimensions === 'object'
      ? row.raw.dimensions as Record<string, unknown>
      : {};
  const length = toPositiveNumber(row.rateDimsL) ?? toPositiveNumber(rawDims.length);
  const width = toPositiveNumber(row.rateDimsW) ?? toPositiveNumber(rawDims.width);
  const height = toPositiveNumber(row.rateDimsH) ?? toPositiveNumber(rawDims.height);
  if (length == null || width == null || height == null) return null;
  return [length, width, height].join('x');
}

const args = parseArgs();

const rows = await db
  .select({
    orderId: orders.id,
    orderNumber: orders.orderNumber,
    orderStatus: orders.orderStatus,
    raw: orders.raw,
    rateDimsL: orderOverrides.rateDimsL,
    rateDimsW: orderOverrides.rateDimsW,
    rateDimsH: orderOverrides.rateDimsH,
    bestRateDims: orderOverrides.bestRateDims,
  })
  .from(orderOverrides)
  .innerJoin(orders, eq(orders.id, orderOverrides.orderId))
  .where(
    and(
      eq(orders.orderStatus, 'awaiting_shipment'),
      sql`${orderOverrides.bestRateJson} is not null`,
    ),
  )
  .limit(args.limit);

const invalid = rows
  .map((row) => {
    const currentDims = getCurrentDimsLabel(row);
    const savedDims = normalizeDimsLabel(row.bestRateDims);
    return {
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      orderStatus: row.orderStatus,
      currentDims,
      savedDims,
      reason: !currentDims
        ? 'missing-current-dims'
        : !savedDims
          ? 'missing-best-rate-dims'
          : savedDims !== currentDims
            ? 'mismatched-best-rate-dims'
            : null,
    };
  })
  .filter((row) => row.reason != null);

if (args.apply) {
  const now = new Date();
  for (const row of invalid) {
    await db
      .update(orderOverrides)
      .set({
        bestRateJson: null,
        bestRateAt: null,
        bestRateDims: null,
        updatedAt: now,
      })
      .where(eq(orderOverrides.orderId, row.orderId));
  }
}

const summary = {
  mode: args.apply ? 'apply' : 'dry-run',
  scanned: rows.length,
  invalid: invalid.length,
  cleared: args.apply ? invalid.length : 0,
  rows: invalid,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Best-rate dims cleanup ${summary.mode}`);
  console.log(`Scanned: ${summary.scanned}`);
  console.log(`Invalid awaiting best rates: ${summary.invalid}`);
  if (args.apply) console.log(`Cleared: ${summary.cleared}`);
  for (const row of invalid.slice(0, 50)) {
    console.log(
      `- order ${row.orderId} (${row.orderNumber}): ${row.reason}; current=${row.currentDims ?? 'none'} saved=${row.savedDims ?? 'none'}`,
    );
  }
}
