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
const limit = Math.max(1, Math.min(10_000, Number(argValue('limit') ?? 500)));
const storeId = argValue('store-id');
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
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryLedger)
    .where(and(eq(inventoryLedger.orderId, row.id), eq(inventoryLedger.type, 'ship')));
  candidates.push({
    ...row,
    correctedOrderDate: corrected,
    ledgerRows: Number(count ?? 0),
  });
}

let updatedOrders = 0;
let updatedLedgerRows = 0;

if (apply) {
  for (const candidate of candidates) {
    // Per user override unlock shipped data on 2026-05-29: repair only the
    // timestamp semantics for ShipStation rows that were stored as legacy
    // naive-PT-stamped-Z. No order status, shipment history, labels, postage,
    // or marketplace notifications are changed.
    await db
      .update(orders)
      .set({ orderDate: candidate.correctedOrderDate, updatedAt: new Date() })
      .where(eq(orders.id, candidate.id));
    updatedOrders += 1;

    const ledger = await db
      .update(inventoryLedger)
      .set({ createdAt: candidate.correctedOrderDate })
      .where(and(eq(inventoryLedger.orderId, candidate.id), eq(inventoryLedger.type, 'ship')))
      .returning({ id: inventoryLedger.id });
    updatedLedgerRows += ledger.length;
  }
}

console.log(`ShipStation legacy timestamp repair ${apply ? 'apply' : 'dry-run'}`);
console.log(`Scanned orders: ${rows.length}`);
console.log(`Would update orders: ${candidates.length}`);
console.log(`Would update order-linked ship ledger rows: ${candidates.reduce((sum, row) => sum + row.ledgerRows, 0)}`);
if (apply) {
  console.log(`Updated orders: ${updatedOrders}`);
  console.log(`Updated order-linked ship ledger rows: ${updatedLedgerRows}`);
}
for (const candidate of candidates.slice(0, 50)) {
  console.log(
    `- order=${candidate.orderNumber ?? candidate.id} id=${candidate.id} raw=${candidate.rawOrderDate} current=${candidate.orderDate?.toISOString() ?? 'null'} -> corrected=${candidate.correctedOrderDate.toISOString()} ledgerRows=${candidate.ledgerRows}`,
  );
}
if (candidates.length > 50) console.log(`... ${candidates.length - 50} more`);
console.log('Default dry-run is read-only. Apply mode changes only orders.order_date and order-linked ship inventory_ledger.created_at.');
