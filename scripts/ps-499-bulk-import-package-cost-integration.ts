/**
 * PS-499 Step 10 (partial) — REAL persistence test for the server-side package-cost
 * adapter, against in-memory Postgres (PGlite).
 *
 * This is the behavioural proof Hermes's Blocker 4 asked for, and it covers the
 * pricing half of case C plus cases K, L and M: the adapter is driven against real
 * tables and real rows, not stubs, so it proves what a bulk box import will actually
 * be billed — including that it agrees with GENERATION for identical facts.
 *
 * Deliberately NOT covered here (no seam exists yet): the HTTP route boundary and
 * the sidecar snapshots — cases A-J and N-P. `src/routes/billing.ts` builds its
 * queries on the `db` singleton from `src/db/client.ts`, which is constructed at
 * import time from env.DATABASE_URL, so the route cannot be pointed at PGlite the
 * way this adapter can. See the note at the end of this file.
 *
 * Offline + deterministic: PGlite is a WASM Postgres. Nothing here touches a real
 * database, calls a carrier, regenerates billing, or mutates an invoice.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { resolveBulkImportPackageCost } from '../src/services/billing-bulk-import-package-cost.js';
import { decidePackageCostLine, NO_CHARGE_BOX_SOURCE } from '../src/services/billing-box-policy.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

const CLIENT_PRICED = 17;
const CLIENT_NO_BOX_PRICING = 18;
const CLIENT_NO_CONFIG_ROW = 19;

const PKG_PRICED = 42;
const PKG_UNPRICED = 43;
const PKG_NO_CHARGE = 44;
const PKG_UNKNOWN = 999;

async function main(): Promise<void> {
  const client = new PGlite();
  const pg = drizzle(client, { casing: 'snake_case' });
  const exec = pg as unknown as Parameters<typeof resolveBulkImportPackageCost>[0];

  // Minimal real schema — only the columns the adapter reads.
  await pg.execute(sql`CREATE TABLE packages (
    id integer primary key,
    name text,
    package_code text,
    length real not null default 0,
    width real not null default 0,
    height real not null default 0,
    source text not null default 'custom'
  )`);
  await pg.execute(sql`CREATE TABLE client_package_prices (
    client_id integer not null,
    package_id integer not null,
    price numeric(10,2) not null
  )`);
  await pg.execute(sql`CREATE TABLE billing_config (
    client_id integer primary key,
    package_cost_markup numeric(5,2) not null default '0'
  )`);

  await pg.execute(sql`INSERT INTO packages (id, name, package_code, source) VALUES
    (${PKG_PRICED}, '9x6x3', 'P9X6X3', 'custom'),
    (${PKG_UNPRICED}, '12x10x3', 'P12X10X3', 'custom'),
    (${PKG_NO_CHARGE}, 'Factory Mailer', 'PFACT', ${NO_CHARGE_BOX_SOURCE})`);

  // Client 17 is billed for boxes: it has a configured price for PKG_PRICED only.
  await pg.execute(sql`INSERT INTO client_package_prices (client_id, package_id, price) VALUES
    (${CLIENT_PRICED}, ${PKG_PRICED}, '5.00')`);
  // 10% package-cost markup, so a $5.00 box bills at $5.50.
  await pg.execute(sql`INSERT INTO billing_config (client_id, package_cost_markup) VALUES
    (${CLIENT_PRICED}, '10.00'),
    (${CLIENT_NO_BOX_PRICING}, '10.00')`);

  // Client 19 is billed for boxes but has NO billing_config row at all.
  await pg.execute(sql`INSERT INTO client_package_prices (client_id, package_id, price) VALUES
    (${CLIENT_NO_CONFIG_ROW}, ${PKG_PRICED}, '5.00')`);

  const at = (clientId: number, packageId: number) =>
    resolveBulkImportPackageCost(exec, { clientId, packageId });

  const priced = await at(CLIENT_PRICED, PKG_PRICED);
  const unknown = await at(CLIENT_PRICED, PKG_UNKNOWN);
  const noBoxPricing = await at(CLIENT_NO_BOX_PRICING, PKG_PRICED);
  const unpriced = await at(CLIENT_PRICED, PKG_UNPRICED);
  const noCharge = await at(CLIENT_PRICED, PKG_NO_CHARGE);
  const noConfigRow = await at(CLIENT_NO_CONFIG_ROW, PKG_PRICED);

  check('a configured box resolves to configured price PLUS the config markup', () => {
    assertEqual(priced.kind, 'line', 'a priced box must produce a line');
    if (priced.kind !== 'line') return;
    // 5.00 + 10% = 5.50. The frontend used to submit the raw 5.00, under-billing
    // the markup on every imported row — this pins the amount, not just the shape.
    assertEqual(priced.amount, 5.5, 'amount must include the package-cost markup');
    assertEqual(priced.packageId, PKG_PRICED, 'the resolved packageId must be the pasted one');
  });

  check('the adapter agrees with GENERATION for identical facts', () => {
    // Hermes required parity: bulk PATCH and regeneration must not disagree, or an
    // imported row would silently change amount at the next regenerate.
    const generated = decidePackageCostLine({
      resolution: {
        status: 'resolved',
        source: 'operator',
        packageId: PKG_PRICED,
        pkg: { id: PKG_PRICED, name: '9x6x3', packageCode: 'P9X6X3', length: 0, width: 0, height: 0, source: 'custom' },
        customDims: null,
        overridePrice: null,
        note: null,
      },
      clientHasBoxPricing: true,
      configuredPrice: 5,
      markupPct: 10,
    });
    assertEqual(generated.kind, 'line', 'generation must also emit a line');
    if (generated.kind !== 'line' || priced.kind !== 'line') return;
    assertEqual(priced.amount, generated.amount, 'bulk import and generation must bill the same amount');
  });

  check('K — an unknown package fails closed', () => {
    // Never invent a price and never keep the previous box's cost.
    const decision = unknown;
    assertEqual(decision.kind, 'unresolved', 'an unknown package must not resolve');
    if (decision.kind !== 'unresolved') return;
    assertEqual(decision.reason, 'unknown_package', 'reason must name the cause');
  });

  check('L — a client with no box pricing at all fails closed', () => {
    const decision = noBoxPricing;
    assertEqual(decision.kind, 'unresolved', 'no box pricing must not silently resolve');
    if (decision.kind !== 'unresolved') return;
    assertEqual(decision.reason, 'client_has_no_box_pricing', 'reason must distinguish this from a missing price');
  });

  check('M — a priced client with no configured price for THIS box fails closed', () => {
    const decision = unpriced;
    assertEqual(decision.kind, 'unresolved', 'an unpriced box must not resolve to 0');
    if (decision.kind !== 'unresolved') return;
    assertEqual(decision.reason, 'no_configured_price', 'reason must distinguish this from no pricing program');
  });

  check('a canonical no-charge box succeeds with an explicit $0 line', () => {
    // PS-222b: a flagged factory box is genuinely free and must show an explicit
    // $0.00 line, NOT fail closed and NOT vanish (which would re-trigger the
    // missing-box-cost review).
    const decision = noCharge;
    assertEqual(decision.kind, 'line', 'a no-charge box must still produce a line');
    if (decision.kind !== 'line') return;
    assertEqual(decision.amount, 0, 'a no-charge box bills exactly $0.00');
  });

  check('a missing billing_config row is treated as zero markup, not a failure', () => {
    const decision = noConfigRow;
    assertEqual(decision.kind, 'line', 'a missing config row must not fail the import');
    if (decision.kind !== 'line') return;
    assertEqual(decision.amount, 5, 'with no config row the markup is 0, so the raw configured price bills');
  });

  if (failures) {
    console.error(`\nFAIL ps-499 bulk import package cost integration (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS ps-499 bulk import package cost integration');
}

await main();
