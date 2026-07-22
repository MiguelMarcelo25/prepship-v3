import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { inventoryLedger } from '../src/db/schema/inventory';
import { parseShipStationV1Date } from '../src/lib/shipstation/v1-date';

type Candidate = {
  id: number;
  orderNumber: string | null;
  externalOrderId: string | null;
  orderDate: Date | null;
  rawOrderDate: string | null;
  correctedOrderDate: Date;
  ledgerRows: number;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function sameSecond(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
}

function legacyStampedDate(raw: string | null): Date | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(' ', 'T');
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
  if (!match) return null;
  return new Date(`${match[1]}T${match[2]}.000Z`);
}

const apply = hasFlag('apply');
const approved = hasFlag('approved');
const limit = Math.max(1, Math.min(50_000, Number(argValue('limit') ?? 500)));
const storeId = argValue('store-id');
const status = argValue('status');
const orderNumbers = (argValue('order-numbers') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (apply && !approved) {
  throw new Error('Refusing to apply without --approved. Run dry-run first, then re-run with --apply --approved.');
}

const filters = [
  eq(orders.sourceProvider, 'shipstation'),
  sql`${orders.raw}->>'orderDate' is not null`,
  storeId ? eq(orders.storeId, Number(storeId)) : undefined,
  status ? eq(orders.orderStatus, status) : undefined,
  orderNumbers.length ? inArray(orders.orderNumber, orderNumbers) : undefined,
].filter((value): value is NonNullable<typeof value> => Boolean(value));

const rows = await db
  .select({
    id: orders.id,
    orderNumber: orders.orderNumber,
    externalOrderId: orders.externalOrderId,
    orderDate: orders.orderDate,
    rawOrderDate: sql<string | null>`${orders.raw}->>'orderDate'`,
  })
  .from(orders)
  .where(and(...filters))
  .limit(limit);

const candidates: Candidate[] = [];
for (const row of rows) {
  const rawLegacy = legacyStampedDate(row.rawOrderDate);
  const corrected = parseShipStationV1Date(row.rawOrderDate);
  if (!sameSecond(row.orderDate, rawLegacy) || !corrected || sameSecond(row.orderDate, corrected)) {
    continue;
  }
  candidates.push({
    ...row,
    correctedOrderDate: corrected,
    ledgerRows: 0,
  });
}

const candidateIds = candidates.map((candidate) => candidate.id);
if (candidateIds.length) {
  const ledgerCounts = await db
    .select({
      orderId: inventoryLedger.orderId,
      count: sql<number>`count(*)::int`,
    })
    .from(inventoryLedger)
    .where(and(inArray(inventoryLedger.orderId, candidateIds), eq(inventoryLedger.type, 'ship')))
    .groupBy(inventoryLedger.orderId);
  const countsByOrder = new Map(ledgerCounts.map((row) => [row.orderId, Number(row.count ?? 0)]));
  for (const candidate of candidates) {
    candidate.ledgerRows = countsByOrder.get(candidate.id) ?? 0;
  }
}

if (apply) {
  // Per user override unlock shipped data on 2026-07-21: immutable shipped
  // movement history cannot be timestamp-rewritten by this legacy repair.
  throw new Error('PS462_INVENTORY_LEDGER_IMMUTABLE: timestamp repair is report-only; use a separately reviewed append-only correction design');
}

console.log(`ShipStation legacy timestamp repair ${apply ? 'apply' : 'dry-run'}`);
console.log(`Scanned orders: ${rows.length}`);
console.log(`Would update orders: ${candidates.length}`);
console.log(`Would update order-linked ship ledger rows: ${candidates.reduce((sum, row) => sum + row.ledgerRows, 0)}`);
for (const candidate of candidates.slice(0, 50)) {
  console.log(
    `- order=${candidate.orderNumber ?? candidate.id} id=${candidate.id} raw=${candidate.rawOrderDate} current=${candidate.orderDate?.toISOString() ?? 'null'} -> corrected=${candidate.correctedOrderDate.toISOString()} ledgerRows=${candidate.ledgerRows}`,
  );
}
if (candidates.length > 50) console.log(`... ${candidates.length - 50} more`);
console.log('Report-only: immutable inventory movement timestamps are never updated in place.');
