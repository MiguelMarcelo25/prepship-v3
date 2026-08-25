/**
 * PS-497 shipment fulfillment lines guard.
 *
 * Offline: the REAL loader against in-process PGlite, so the query and its fallback rules
 * are executed rather than described. No provider, no postage, no production.
 *
 * WHAT BROKE. Automatic inventory deduction stopped on 2026-07-16 and did not run for 22
 * days: 1,193 orders shipped, ZERO `inventory_ledger` rows of type 'ship', and 2,651
 * claims piled into `fulfillment_line_claims` with status='review' that nothing consumes.
 *
 * WHY. PS-424 correctly requires every shipped caller to supply `kind: 'exact'` lines or a
 * review-only `kind: 'unavailable'` receipt. The ShipStation/direct label path had no line
 * source in scope, so it hardcoded `unavailable` — and because normalizeFulfillmentFacts
 * stamps `reviewReason: 'fulfillment_lines_unavailable'` on that receipt, the enqueue
 * condition `fulfilledLines.some((line) => line.sku && !line.reviewReason)` could never be
 * true. 100% of label purchases routed to review. It was NOT the INVENTORY_AUTO_DEDUCT
 * kill switch: package_ledger kept writing throughout, gated by that same flag.
 *
 * THE assertion here is the fallback. Every case where the lines are not certain must
 * still return null so the caller emits the old review receipt. A loader that returns a
 * partial or optimistic list would deduct the wrong quantity — strictly worse than the bug
 * it replaces, because a wrong deduction is silent while a review row is at least a record.
 */
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const { PGlite } = await import('@electric-sql/pglite');
const { drizzle } = await import('drizzle-orm/pglite');
const { loadWholeOrderShipmentLines } = await import('../src/services/shipment-fulfillment-lines');
const { normalizeFulfilledLines } = await import('../src/services/order-lifecycle-command');

const client = new PGlite();
await client.exec(`
  create table order_items (
    id serial primary key,
    order_id integer not null,
    line_index integer not null default 0,
    sku text not null,
    name text,
    quantity numeric(12,3) not null default '0',
    unit_price numeric(12,2) not null default '0',
    line_total numeric(12,2) not null default '0',
    image_url text,
    client_id integer,
    store_id integer,
    order_status text not null default 'shipped',
    order_date timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`);
// casing: 'snake_case' matches src/db/client.ts. Without it drizzle emits camelCase
// identifiers and the query silently fails against the real column names.
const tx = drizzle(client, { casing: 'snake_case' }) as never;

const seed = async (rows: Array<[number, number, string, string | null, string]>) => {
  await client.exec('delete from order_items;');
  for (const [orderId, lineIndex, sku, name, qty] of rows) {
    await client.query(
      'insert into order_items (order_id, line_index, sku, name, quantity, order_status) values ($1,$2,$3,$4,$5,$6)',
      [orderId, lineIndex, sku, name, qty, 'shipped'],
    );
  }
};

// ── the happy path: real lines, real deduction ─────────────────────────────
await seed([[1, 0, 'SKU-A', 'Widget', '2'], [1, 1, 'SKU-B', 'Gadget', '1']]);
const lines = await loadWholeOrderShipmentLines(1, tx);
check('an order with clean lines returns them', lines?.length === 2, lines);
check('quantities are numbers, not the numeric() strings drizzle returns',
  lines?.[0]?.quantity === 2 && lines?.[1]?.quantity === 1, lines);
check('SKUs are carried — without a sku the deduction enqueue skips the line',
  lines?.every((l) => !!l.sku), lines);

// PS-469: sync DELETES and re-inserts order_items every pass, so the serial id changes
// while the line does not. Keying a durable claim on the serial breaks idempotency the
// moment a sync runs between two attempts at the same purchase.
check('lineKey is the stable lineIndex, never the order_items serial',
  lines?.[0]?.lineKey === '0' && lines?.[1]?.lineKey === '1', lines);

// The whole point: these lines must survive into a deductible claim.
{
  const normalized = normalizeFulfilledLines(lines as never);
  check('normalizeFulfilledLines accepts them without stamping a reviewReason',
    normalized.length === 2 && normalized.every((l) => !('reviewReason' in l) || !l.reviewReason),
    normalized);
  // This is the exact predicate in applyOrderLifecycleCommandInTransaction that gates
  // enqueueInventoryClaimDeduction. If it is false, nothing deducts — the 22-day bug.
  check('THE enqueue predicate is now TRUE for a label purchase',
    normalized.some((l) => l.sku && !l.reviewReason), normalized);
}

// ── THE fallback: uncertain means null, never a guess ──────────────────────
await seed([]);
check('an order with no lines returns null (caller keeps the review receipt)',
  (await loadWholeOrderShipmentLines(1, tx)) === null);

await seed([[2, 0, 'SKU-A', null, '0']]);
check('a zero quantity returns null', (await loadWholeOrderShipmentLines(2, tx)) === null);

await seed([[3, 0, 'SKU-A', null, '-1']]);
check('a negative quantity returns null', (await loadWholeOrderShipmentLines(3, tx)) === null);

await seed([[4, 0, 'SKU-A', null, '1.500']]);
check('a FRACTIONAL quantity returns null rather than truncating stock',
  (await loadWholeOrderShipmentLines(4, tx)) === null);

// The important one: one bad line poisons the whole list. Deducting the good lines and
// silently reviewing the bad one is harder to reconcile than deducting nothing, because
// nothing records what was skipped.
await seed([[5, 0, 'SKU-A', null, '2'], [5, 1, 'SKU-B', null, '0']]);
check('ONE uncertain line makes the WHOLE order fall back, not a partial deduction',
  (await loadWholeOrderShipmentLines(5, tx)) === null);

// Scoping.
await seed([[6, 0, 'SKU-A', null, '1'], [7, 0, 'SKU-Z', null, '9']]);
const scoped = await loadWholeOrderShipmentLines(6, tx);
check('only the requested order is loaded',
  scoped?.length === 1 && scoped[0]!.sku === 'SKU-A', scoped);

await client.close();

// ── wiring ─────────────────────────────────────────────────────────────────
const labels = readFileSync('src/services/labels.ts', 'utf8').replace(/\r\n/g, '\n');
const owner = readFileSync('src/services/shipment-fulfillment-lines.ts', 'utf8').replace(/\r\n/g, '\n');
const labelsCode = labels
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

check('the label path loads real shipped lines',
  /const shippedLines = await loadWholeOrderShipmentLines\(order\.id, tx\)/.test(labelsCode));
check('the lines are read on the SAME tx as the lifecycle write',
  /loadWholeOrderShipmentLines\(order\.id, tx\)/.test(labelsCode),
  'a different connection could read lines that change before the claim is written');
// PS-497 Release B: the label path reads the order's whole-order lines under requireNoActiveOutboundShipment
// (sole outbound), so the exact facts carry evidence='whole_order_fallback' + soleOutbound=true — the
// disposition owner then treats a sole-outbound whole-order fallback as deductible.
check('exact facts (whole-order fallback, sole outbound) are used when the lines are known',
  /fulfillmentFacts: shippedLines\?\.length\s*\n?\s*\? \{ kind: 'exact', evidence: 'whole_order_fallback', soleOutbound: true, lines: shippedLines \}/.test(labelsCode));
check('the review receipt is still emitted when they are not',
  /kind: 'unavailable',\s*\n\s*description: 'Label purchase request did not identify shipped line quantities'/.test(labelsCode));

// The preconditions that make reading the order's lines correct here. If either is ever
// dropped, this label may no longer be the order's only shipment and the order's lines
// stop being the shipment's contents.
check('the lifecycle call still requires the order to be AWAITING',
  /requireAwaitingOrderStatus: true,/.test(labelsCode));
check('the lifecycle call still requires NO other active outbound shipment',
  /requireNoActiveOutboundShipment: true,/.test(labelsCode));

check('the owner keys lines on lineIndex, not the serial id',
  /lineKey: String\(row\.lineIndex\)/.test(owner) && !/orderItems\.id/.test(owner));
check('the owner is read-only',
  !/\b(insert|update|delete)\b/i.test(owner.replace(/\/\*[\s\S]*?\*\//g, '')));

if (failures > 0) {
  console.error(`\nFAIL PS-497 shipment fulfillment lines guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-497 shipment fulfillment lines guard');
