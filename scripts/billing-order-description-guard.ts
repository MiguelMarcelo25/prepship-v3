/**
 * PS-498 — the per-order billing DESCRIPTION owner, tested by EXECUTION.
 *
 * The rule this guard exists to protect is narrow and easy to break by accident:
 * a later manual edit through the Edit Billing Detail modal sends `reason` and no
 * description, and it must NOT overwrite the description an import wrote. Every
 * sibling note column in billing (billing_manual_overrides.note,
 * billing_box_resolutions.note, billing_fee_waivers.note) is deliberately
 * synthesized from `reason` on every save — so "the description behaves like the
 * others" is precisely the bug.
 *
 * Everything below drives the REAL functions against in-memory Postgres (PGlite),
 * and the schema is created by executing drizzle/0091_billing_order_descriptions.sql
 * so the migration file itself is what is under test — not a hand-copied DDL that
 * can drift away from what production runs.
 *
 * Deliberately NOT asserted by reading source text. This repo has repeatedly shipped
 * guards that stayed green while behaviour died (a predicate widened, `and false`
 * appended, a copied safety check drifting from the real one). The one remaining
 * source assertion — that the ROUTE calls this owner — lives in
 * scripts/billing-bulk-import-guard.ts with an explicit slice-length floor, because
 * standing the full PATCH up here (auth, clients, line items, finalization policy,
 * audit) is out of scope. All the POLICY it could hide is in this file and executed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import {
  applyBillingOrderDescriptionPatch,
  decideBillingOrderDescriptionWrite,
  readBillingOrderDescriptions,
  type BillingOrderDescriptionExecutor,
} from '../src/services/billing-order-descriptions';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';
import { BILLING_DETAIL_COLUMNS } from '../web/src/components/Views/billing-parity';
import { INVOICE_CSV_HEADERS, renderInvoiceCsvRow } from '../src/routes/billing-invoice-csv';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const DESCRIPTION = 'DHL eCommerce Parcel Direct to Gatineau, Quebec';

async function main(): Promise<void> {
  const client = new PGlite();
  const pg = drizzle(client);
  const exec = pg as unknown as BillingOrderDescriptionExecutor;

  // orders(id) is the FK target; the migration references it, so it must exist.
  await pg.execute(sql`CREATE TABLE orders (id integer primary key)`);
  await pg.execute(sql`INSERT INTO orders (id) VALUES (1), (2), (3)`);
  await pg.execute(sql`CREATE TABLE billing_line_items (
    id serial primary key,
    order_id integer,
    line_type text not null,
    total_cost numeric(10,2) not null default '0'
  )`);

  // Execute the REAL migration. If the DDL in the file is wrong, everything below
  // fails — which is the point of not hand-writing the schema here.
  const migration = readFileSync('drizzle/0091_billing_order_descriptions.sql', 'utf8')
    // PGlite has no RLS; the statement is production-only posture, not behaviour.
    .replace(/ALTER TABLE billing_order_descriptions ENABLE ROW LEVEL SECURITY;/, '');
  await pg.execute(sql.raw(migration));

  // ---- T1: the clobber replay. The reason this feature has its own table. ----
  await checkAsync(
    'a later edit that sends no description leaves the stored one byte-identical',
    async () => {
      const wrote = await applyBillingOrderDescriptionPatch(
        { orderId: 1, orderDescription: DESCRIPTION, savedBy: 'importer@drprepperusa.com' },
        exec,
      );
      assert.equal(wrote, true, 'the import must write');

      const beforeRows = await readBillingOrderDescriptions([1], exec);
      const before = beforeRows.get(1)!;

      // Exactly what the Edit Billing Detail modal sends: a reason, no description.
      const wroteAgain = await applyBillingOrderDescriptionPatch(
        { orderId: 1, savedBy: 'operator@drprepperusa.com' },
        exec,
      );
      assert.equal(wroteAgain, false, 'an absent description must write NOTHING');

      const after = (await readBillingOrderDescriptions([1], exec)).get(1)!;
      assert.equal(after.description, before.description, 'description must not change');
      assert.equal(after.savedBy, 'importer@drprepperusa.com', 'author must not be reattributed');
      assert.equal(after.savedAt, before.savedAt, 'timestamp must not be re-stamped');
    },
  );

  // ---- T2: the owner refuses to blank, and refuses loudly. ----
  await checkAsync('blank, whitespace and over-long descriptions are refused', async () => {
    for (const bad of ['', '   ', 'x'.repeat(501)]) {
      await assert.rejects(
        () => applyBillingOrderDescriptionPatch({ orderId: 1, orderDescription: bad, savedBy: 'a@b.c' }, exec),
        `"${bad.slice(0, 12)}…" must be refused, not silently ignored`,
      );
    }
    const still = (await readBillingOrderDescriptions([1], exec)).get(1)!;
    assert.equal(still.description, DESCRIPTION, 'a refused write must leave the row alone');
  });

  check(
    'the write decision is pure and says NO to an absent field',
    decideBillingOrderDescriptionWrite(undefined).write === false,
  );
  check(
    'the write decision trims and says YES to real text',
    JSON.stringify(decideBillingOrderDescriptionWrite('  Canada re-ship  ')) ===
      JSON.stringify({ write: true, description: 'Canada re-ship' }),
  );
  // Asserted on the PURE decision, not through the database. The DB CHECK also
  // rejects a blank, so a test that only goes through Postgres stays green when
  // the owner's own refusal is deleted — verified: that exact mutation survived
  // until this assertion existed. Both layers now have to hold independently.
  check(
    'the write decision itself refuses blank, whitespace and over-long text',
    (() => {
      for (const bad of ['', '   ', '\t\n ', 'x'.repeat(501)]) {
        let threw = false;
        try {
          decideBillingOrderDescriptionWrite(bad);
        } catch {
          threw = true;
        }
        if (!threw) return false;
      }
      return true;
    })(),
    'the owner must not delegate its blank rule to the database',
  );

  // ---- T3: the DB refuses to blank, even around the service. ----
  await checkAsync('the CHECK constraint rejects a blank written around the service', async () => {
    await assert.rejects(
      () => pg.execute(sql`UPDATE billing_order_descriptions SET description = '' WHERE order_id = 1`),
      'billing_order_descriptions_description_chk must reject an empty description',
    );
    await assert.rejects(
      () => pg.execute(sql`UPDATE billing_order_descriptions SET description = '   ' WHERE order_id = 1`),
      'and must reject whitespace-only, or the CHECK is decorative',
    );
  });

  // ---- T4: read-back shape. savedAt MUST be a string, not a Date. ----
  await checkAsync('read-back returns only matching orders, with an ISO string timestamp', async () => {
    const map = await readBillingOrderDescriptions([1, 2, 3], exec);
    assert.equal(map.size, 1, 'orders with no description must not appear');
    const row = map.get(1)!;
    assert.equal(row.description, DESCRIPTION, 'commas and spacing survive verbatim');
    assert.equal(typeof row.savedAt, 'string', 'a Date would be silently dropped by carryText');
    assert.equal(typeof row.savedBy, 'string');
    assert.equal((await readBillingOrderDescriptions([], exec)).size, 0);
  });

  // ---- T5: regeneration must not touch it. ----
  await checkAsync('a billing_line_items wipe (what regeneration does) leaves it standing', async () => {
    await pg.execute(sql`INSERT INTO billing_line_items (order_id, line_type) VALUES (1, 'shipping')`);
    await pg.execute(sql`DELETE FROM billing_line_items WHERE order_id = 1`);
    const row = (await readBillingOrderDescriptions([1], exec)).get(1);
    assert.ok(row, 'the description must survive a regenerate');
    assert.equal(row!.description, DESCRIPTION);
  });

  // ---- T6: the carry table, not the accident of which line sorts first. ----
  check(
    'the collapsed order row carries the description even from a LATER line',
    (() => {
      const collapsed = toBillingDetailOrderRows([
        { orderId: 1, orderNumber: '2515', lineType: 'pick_pack', totalCost: '2.50' },
        {
          orderId: 1,
          orderNumber: '2515',
          lineType: 'shipping',
          totalCost: '20.83',
          orderDescription: DESCRIPTION,
          orderDescriptionSavedBy: 'importer@drprepperusa.com',
          orderDescriptionSavedAt: '2026-08-11T00:00:00.000Z',
        },
        { orderId: 2, orderNumber: '2521', lineType: 'shipping', totalCost: '20.72' },
      ] as never);
      const first = collapsed.find((row) => Number(row.orderId) === 1);
      const second = collapsed.find((row) => Number(row.orderId) === 2);
      return (
        first?.orderDescription === DESCRIPTION &&
        first?.orderDescriptionSavedBy === 'importer@drprepperusa.com' &&
        first?.orderDescriptionSavedAt === '2026-08-11T00:00:00.000Z' &&
        second?.orderDescription == null
      );
    })(),
    'TEXT_CARRY_FIELDS must own this, not the first-line spread',
  );

  // Why the reader casts saved_at to text. carryText is `typeof === 'string'`
  // gated, so a Date is DROPPED by the carry — it would survive today only by the
  // accident of the first-line spread and vanish the moment the merge path
  // mattered. This proves the hazard is real; PGlite happens to return timestamptz
  // as text, so the cast itself is pinned by the source assertion below rather
  // than by this in-memory driver.
  check(
    'a Date timestamp would be DROPPED by the carry — which is why the reader casts',
    (() => {
      const collapsed = toBillingDetailOrderRows([
        { orderId: 9, orderNumber: '9', lineType: 'pick_pack', totalCost: '1.00' },
        {
          orderId: 9,
          orderNumber: '9',
          lineType: 'shipping',
          totalCost: '2.00',
          orderDescription: DESCRIPTION,
          orderDescriptionSavedAt: new Date('2026-08-11T00:00:00.000Z'),
        },
      ] as never);
      return collapsed.find((row) => Number(row.orderId) === 9)?.orderDescriptionSavedAt == null;
    })(),
  );

  check(
    'the reader casts saved_at to text',
    /saved_at::text AS "savedAt"/.test(
      readFileSync('src/services/billing-order-descriptions.ts', 'utf8'),
    ),
    'without the cast the production driver returns a Date and the carry drops it',
  );

  // ---- T8/T9: no leak. EXECUTED, not grepped — a differently-named column
  // carrying the same data would slip past a source search. ----
  check(
    'no Description column exists in the billing detail table',
    !BILLING_DETAIL_COLUMNS.some(
      (column) =>
        /description/i.test(String(column.id)) || /description/i.test(String(column.label)),
    ),
  );

  check(
    'the invoice CSV row is unchanged in width and carries no operator note',
    (() => {
      const line = renderInvoiceCsvRow({
        orderDescription: DESCRIPTION,
        orderDescriptionSavedBy: 'importer@drprepperusa.com',
      } as never);
      // Naive split is fine here: the assertion is that the description is absent,
      // and INVOICE_CSV_HEADERS is the width contract.
      return !line.includes('Gatineau') && line.split(',').length === INVOICE_CSV_HEADERS.length;
    })(),
    'operator notes must never reach a customer invoice',
  );

  await client.close();
}

main()
  .then(() => {
    if (failures) {
      console.error(`\nFAIL billing order description guard (${failures} failing)`);
      process.exit(1);
    }
    console.log('\nPASS billing order description guard');
  })
  .catch((error) => {
    console.error(`FAIL billing order description guard: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
