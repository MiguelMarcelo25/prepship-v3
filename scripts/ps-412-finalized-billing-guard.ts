/**
 * PS-412 â€” finalized billing is immutable at the database and service boundaries.
 *
 * Offline only: this test uses PGlite and source inspection. It never connects to
 * the configured database or regenerates real billing.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import * as schema from '../src/db/schema/index.js';
import { billingLineItems } from '../src/db/schema/billing.js';

const MIGRATION_PATH = 'drizzle/0059_billing_finalized_lock.sql';
const CLOSE_MIGRATION_PATH = 'drizzle/0065_billing_close_workflow.sql';
const POLICY_PATH = 'src/services/billing-finalization-policy.ts';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function expectFinalizedLock(
  name: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    check(name, false);
  } catch (error) {
    const code = error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
    check(
      name,
      code === 'BILLING_FINALIZED_LOCKED' ||
        (error instanceof Error && error.message.includes('BILLING_FINALIZED_LOCKED')),
    );
  }
}

async function expectErrorToken(
  name: string,
  token: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    check(name, false);
  } catch (error) {
    check(name, error instanceof Error && error.message.includes(token));
  }
}

async function main(): Promise<void> {
  // The policy imports the production db singleton for its default executor,
  // but this guard injects PGlite for every query. Provide inert parse-only env
  // values so the offline test never depends on developer or CI secrets.
  process.env.NODE_ENV ??= 'test';
  process.env.VERCEL ??= '1';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';
  const {
    assertBillingOrdersEditable,
    billingLineItemIsEditablePredicate,
    finalizedBillingOrderIdsForRange,
    isBillingFinalizedLockError,
    setBillingOrdersDirty,
  } = await import('../src/services/billing-finalization-policy.js');

  const migration = read(MIGRATION_PATH);
  const closeMigration = read(CLOSE_MIGRATION_PATH);
  const policy = read(POLICY_PATH);
  const invoiceTotals = read('src/services/billing-invoice-totals.ts');
  const billingService = read('src/services/billing.ts');
  const billingRoute = read('src/routes/billing.ts');
  const bulkService = read('src/services/billing-box-cost-bulk.ts');
  const byDimsService = read('src/services/billing-box-cost-by-dims.ts');
  const hugrabService = read('src/services/hugrab-billing-shipping-floor.ts');
  const apiClient = read('web/src/lib/v2-apiClient.ts');
  const billingView = read('web/src/components/Views/BillingView.tsx');
  const packageJson = read('package.json');

  check('finalized-lock migration exists', migration.length > 0);
  check('billing close workflow migration exists', closeMigration.length > 0);
  check('canonical billing finalization policy exists', policy.length > 0);
  const wrappedDatabaseError = new Error('Failed query');
  (wrappedDatabaseError as Error & { cause?: unknown }).cause = new Error(
    'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified',
  );
  check(
    'wrapped database errors retain the structured finalized-lock classification',
    isBillingFinalizedLockError(wrappedDatabaseError),
  );
  check(
    'migration blocks row mutation and finalized-order sibling writes',
    /BEFORE INSERT OR UPDATE OR DELETE/i.test(migration) &&
      /REFERENCING OLD TABLE AS billing_line_items_old/i.test(migration) &&
      /BILLING_FINALIZED_LOCKED/.test(migration) &&
      /order_id/.test(migration) &&
      /invoiced/i.test(migration),
  );
  check(
    'migration blocks TRUNCATE while finalized billing exists',
    /BEFORE TRUNCATE/i.test(migration) && /billing_line_items_block_finalized_truncate/i.test(migration),
  );
  check(
    'migration serializes each billing group across transactions',
    /billing_finalization_group_locks/i.test(migration) &&
      /billing_line_item_lock_group/i.test(migration) &&
      /ON CONFLICT \(group_key\) DO UPDATE/i.test(migration) &&
      /RETURNING finalized INTO was_finalized/i.test(migration),
  );
  check(
    'migration blocks finalization while sidecar regeneration is pending',
    /dirty boolean NOT NULL DEFAULT false/i.test(migration) &&
      /regenerate pending billing changes before finalization/i.test(migration),
  );
  check(
    'runtime policy delegates readiness to migration-owned transaction group locks',
    /assertRuntimeSchemaReady/.test(policy) &&
      !/CREATE TABLE|CREATE OR REPLACE FUNCTION|CREATE TRIGGER/i.test(policy),
  );
  check(
    'runtime schema ensure never drops an active finalized-billing trigger',
    !/DROP TRIGGER/i.test(policy),
  );
  check(
    'close workflow owns immutable periods and append-only credit notes',
    /CREATE TABLE IF NOT EXISTS billing_finalizations/i.test(closeMigration) &&
      /CREATE TABLE IF NOT EXISTS billing_credit_notes/i.test(closeMigration) &&
      /billing_line_items_closed_period_guard/.test(closeMigration) &&
      /billing_finalizations_no_update_delete/.test(closeMigration) &&
      /billing_credit_notes_no_update_delete/.test(closeMigration) &&
      /billing_finalizations_no_truncate/.test(closeMigration) &&
      /billing_credit_notes_no_truncate/.test(closeMigration) &&
      /billing_credit_notes_balance_guard/.test(closeMigration) &&
      /BILLING_CLOSE_IMMUTABLE/.test(closeMigration),
  );
  check(
    'close workflow serializes client periods and rejects overlaps',
    /pg_advisory_xact_lock\(36421/i.test(closeMigration) &&
      /tstzrange\(existing\.period_start, existing\.period_end, '\[\)'\)/i.test(closeMigration) &&
      /BILLING_PERIOD_FINALIZED/.test(closeMigration),
  );
  check(
    'policy finalizes exact invoice totals and exposes reasoned idempotent credits',
    /finalizeBillingPeriod/.test(policy) &&
      /billingInvoiceHeaderTotals/.test(policy) &&
      /createBillingCreditNote/.test(policy) &&
      /BILLING_CREDIT_EXCEEDS_BALANCE/.test(policy) &&
      /idempotencyKey/.test(policy) &&
      /reason\.trim/.test(policy),
  );
  check(
    'invoice and finalization share one backend totals owner',
    /export async function billingInvoiceHeaderTotals/.test(invoiceTotals) &&
      /billing-invoice-totals/.test(billingRoute) &&
      /billing-invoice-totals/.test(policy),
  );
  check(
    'billing generation compares finalized candidates but rebuilds only editable rows',
    /const calculationRows = allBillableRows/.test(billingService) &&
      /const editableRows = allRows\.filter/.test(billingService) &&
      /reconcileFinalizedBillingOrderAdjustments/.test(billingService) &&
      !/await assertBillingPeriodOpen\(/.test(billingService),
  );
  check(
    'billing routes expose scoped write-gated close and credit operations',
    /app\.post\([\s\S]*?'\/finalize'[\s\S]*?financials:write/.test(billingRoute) &&
      /app\.post\([\s\S]*?'\/credit-notes'[\s\S]*?financials:write/.test(billingRoute) &&
      /canAccessBillingClient/.test(billingRoute) &&
      /finalizeBillingPeriod/.test(billingRoute) &&
      /createBillingCreditNote/.test(billingRoute),
  );
  check(
    'policy owns order assertions and range finality reads',
    /assertBillingOrdersEditable/.test(policy) &&
      /finalizedBillingOrderIdsForRange/.test(policy) &&
      /BillingFinalizedLockError/.test(policy),
  );
  check(
    'sidecar assertions acquire the database group lock before row locks',
    /assertBillingOrdersEditable[\s\S]*billing_line_item_lock_group[\s\S]*for update/i.test(policy),
  );
  const setDirtyStart = policy.indexOf('export async function setBillingOrdersDirty');
  const assertEditableStart = policy.indexOf('export async function assertBillingOrdersEditable');
  const assertEditableEnd = policy.indexOf('export function asBillingCloseWorkflowError');
  const setDirtyPolicy = policy.slice(setDirtyStart, assertEditableStart);
  const assertEditablePolicy = policy.slice(assertEditableStart, assertEditableEnd);
  // Per user override unlock shipped data on 2026-07-15: the production timeout
  // came from one application/DB round trip per shipped-order billing group.
  // Pin the canonical policy to constant application-level query counts while
  // the migration-owned function/table protocol still locks every group inside
  // Postgres and finalized guards remain fail-closed.
  check(
    'billing group locks and dirty updates use constant application-level round trips',
    (setDirtyPolicy.match(/conn\.execute/g) ?? []).length === 1 &&
      (assertEditablePolicy.match(/conn\.execute/g) ?? []).length === 2 &&
      /upserted_groups\s+as\s+materialized/i.test(setDirtyPolicy) &&
      /on conflict \(group_key\) do update/i.test(setDirtyPolicy) &&
      /when locks\.finalized then locks\.dirty/i.test(setDirtyPolicy) &&
      /locked_groups\s+as\s+materialized/i.test(assertEditablePolicy) &&
      !/for\s*\(const group/.test(setDirtyPolicy) &&
      !/for\s*\(const group/.test(assertEditablePolicy),
  );
  check(
    'generator delegates to finalization policy',
    /ensureBillingFinalizationPolicySchema/.test(billingService) &&
      /finalizedBillingOrderIdsForRange/.test(billingService) &&
      /orderIds:\[\.\.\.newSet\(/.test(billingService.replace(/\s+/g, '')) &&
      /skippedFinalizedOrderCount/.test(billingService),
  );
  check(
    'generator atomically sweeps and rebuilds order lines before clearing dirty state',
    /db\.transaction\(async\(tx\)=>[\s\S]*assertBillingOrdersEditable[\s\S]*tx\.delete\(billingLineItems\)[\s\S]*tx[\s\S]*\.insert\(billingLineItems\)[\s\S]*setBillingOrdersDirty/.test(
      billingService.replace(/\s+/g, ''),
    ),
  );
  check(
    'generator delete excludes finalized rows and finalized-order siblings',
    /billingLineItems\.invoiced/.test(billingService) &&
      /billingLineItemIsEditablePredicate/.test(billingService),
  );
  check(
    'generator sweeps stale editable order lines even with no current candidates',
    /sql`\$\{billingLineItems\.orderId\} is not null`/.test(billingService) &&
      !/if \(editableOrderIds\.length > 0\)/.test(billingService),
  );
  check(
    'storage trigger conflicts are counted and surfaced as finalized skips',
    /skippedFinalizedStorageCount/.test(billingService) &&
      /isBillingFinalizedLockError\([^)]*\)/.test(billingService) &&
      /skippedFinalizedStorageCount/.test(billingView),
  );

  const detailStart = billingRoute.indexOf("app.patch('/details/:orderId");
  const detailEnd = billingRoute.indexOf('\napp.', detailStart + 1);
  const detailHandler = detailStart >= 0
    ? billingRoute.slice(detailStart, detailEnd > detailStart ? detailEnd : detailStart + 9000)
    : '';
  const flatDetail = detailHandler.replace(/\s+/g, '');
  check('detail PATCH exists', detailStart >= 0);
  check(
    'detail PATCH locks the order inside its transaction before writes',
    /db\.transaction\(async\(tx\)=>/.test(flatDetail) &&
      /assertBillingOrdersEditable\(/.test(flatDetail) &&
      flatDetail.indexOf('assertBillingOrdersEditable(') < flatDetail.indexOf('tx.update(billingLineItems)'),
  );
  const feeWaiverStart = billingRoute.indexOf("'/zero-shipping-review/");
  const feeWaiverEnd = billingRoute.indexOf('// PS-208:', feeWaiverStart);
  const feeWaiverHandler = feeWaiverStart >= 0
    ? billingRoute.slice(feeWaiverStart, feeWaiverEnd > feeWaiverStart ? feeWaiverEnd : feeWaiverStart + 9000)
    : '';
  const flatFeeWaiver = feeWaiverHandler.replace(/\s+/g, '');
  check(
    'fee-waiver review locks and writes on one transaction connection',
    /db\.transaction\(async\(tx\)=>/.test(flatFeeWaiver) &&
      flatFeeWaiver.indexOf('assertBillingOrdersEditable(') >= 0 &&
      flatFeeWaiver.indexOf('assertBillingOrdersEditable(') < flatFeeWaiver.indexOf('upsertBillingFeeWaiver(') &&
      /upsertBillingFeeWaiver\([\s\S]*?,tx\);/.test(flatFeeWaiver),
  );
  check(
    'billing routes map only finalized lock errors to a structured 409',
    /isBillingFinalizedLockError[\s\S]*code: lockError\.code[\s\S]*finalized: true[\s\S]*409/.test(billingRoute),
  );
  check(
    'bulk apply revalidates finality at the write transaction',
    /assertBillingOrdersEditable/.test(bulkService),
  );
  check(
    'dims apply/revert revalidate finality at the write transaction',
    /assertBillingOrdersEditable/.test(byDimsService),
  );
  check(
    'sidecar workflows mark bills dirty and HUGRAB delegates preview/apply finality',
    /setBillingOrdersDirty/.test(bulkService) &&
      /setBillingOrdersDirty/.test(byDimsService) &&
      /billingOrderHasNoFinalizedLineSql/.test(hugrabService) &&
      /assertBillingOrdersEditable/.test(hugrabService),
  );

  const generateStart = apiClient.indexOf('generateBilling(');
  const generateEnd = apiClient.indexOf('fetchBillingGenerationStatus(', generateStart);
  const generateClient = generateStart >= 0 && generateEnd > generateStart
    ? apiClient.slice(generateStart, generateEnd)
    : '';
  check(
    'frontend generate transport propagates finalized 409 errors',
    generateClient.length > 0 && !/\bsafe\s*\(/.test(generateClient),
  );
  check(
    'package.json wires the PS-412 guard',
    /test:ps-412-finalized-billing/.test(packageJson),
  );

  if (migration.length > 0) {
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE clients (id integer PRIMARY KEY);
      INSERT INTO clients (id) VALUES (1), (2);
      CREATE TABLE billing_line_items (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        order_id integer,
        ship_date timestamptz,
        billing_effective_date timestamptz,
        billing_policy_version text,
        source_finalization_id text,
        billing_adjustment_id text,
        line_type text NOT NULL,
        description text NOT NULL,
        qty numeric(10,2) NOT NULL DEFAULT 1,
        unit_cost numeric(10,2) NOT NULL,
        total_cost numeric(10,2) NOT NULL,
        package_id integer,
        invoiced boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pg.exec(migration);
    await pg.exec(closeMigration);

    await pg.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost, invoiced)
      VALUES
        (1, 100, '2026-07-01', 'pick_pack', 'Pick & Pack', 2, 2, false),
        (1, 100, '2026-07-01', 'shipping', 'Shipping', 8, 8, true),
        (1, 200, '2026-07-01', 'pick_pack', 'Editable', 1, 1, false);
    `);

    await expectFinalizedLock('mixed finalized order blocks sibling UPDATE', () =>
      pg.exec(`UPDATE billing_line_items SET total_cost = 3 WHERE order_id = 100 AND line_type = 'pick_pack'`),
    );
    await expectFinalizedLock('mixed finalized order blocks sibling DELETE', () =>
      pg.exec(`DELETE FROM billing_line_items WHERE order_id = 100 AND line_type = 'pick_pack'`),
    );
    await expectFinalizedLock('mixed finalized order blocks new charge INSERT', () =>
      pg.exec(`INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
        VALUES (1, 100, '2026-07-01', 'new_fee', 'New fee', 4, 4)`),
    );
    await expectFinalizedLock('finalized row blocks direct UPDATE', () =>
      pg.exec(`UPDATE billing_line_items SET invoiced = false WHERE order_id = 100 AND line_type = 'shipping'`),
    );

    await pg.exec(`UPDATE billing_line_items SET total_cost = 2 WHERE order_id = 200`);
    const editable = await pg.query<{ total_cost: string }>(
      `SELECT total_cost::text FROM billing_line_items WHERE order_id = 200`,
    );
    check('non-finalized order remains editable', editable.rows[0]?.total_cost === '2.00');
    await pg.exec(`UPDATE billing_line_items SET invoiced = true WHERE order_id = 200`);
    const finalizationLock = await pg.query<{ finalized: boolean }>(`
      SELECT finalized
      FROM billing_finalization_group_locks
      WHERE group_key = billing_line_item_group_key(1, 200, '2026-07-01', 'pick_pack')
    `);
    check(
      'pure finalization stamps the serialized group lock before commit',
      finalizationLock.rows[0]?.finalized === true,
    );
    await expectFinalizedLock('pure false-to-true finalization succeeds then freezes the row', () =>
      pg.exec(`UPDATE billing_line_items SET total_cost = 3 WHERE order_id = 200`),
    );

    await pg.exec(`INSERT INTO billing_line_items
      (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
      VALUES (1, 300, '2026-07-01', 'pick_pack', 'Draft', 1, 1)`);
    await expectFinalizedLock('finalization cannot change money in the same UPDATE', () =>
      pg.exec(`UPDATE billing_line_items SET invoiced = true, total_cost = 9 WHERE order_id = 300`),
    );

    await pg.exec(`INSERT INTO billing_line_items
      (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
      VALUES
        (1, 500, '2026-07-01', 'pick_pack', 'Bulk finalize one', 1, 1),
        (1, 500, '2026-07-01', 'shipping', 'Bulk finalize two', 2, 2)`);
    await pg.exec(`UPDATE billing_line_items SET invoiced = true WHERE order_id = 500`);
    const bulkFinalized = await pg.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM billing_line_items
      WHERE order_id = 500 AND invoiced = true
    `);
    check('one pure UPDATE can finalize every line in an order', bulkFinalized.rows[0]?.count === 2);

    await pg.exec(`INSERT INTO billing_line_items
      (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
      VALUES
        (1, 600, '2026-07-01', 'pick_pack', 'Mixed statement draft', 1, 1),
        (1, 600, '2026-07-01', 'shipping', 'Mixed statement finalize', 2, 2)`);
    await expectFinalizedLock('one statement cannot finalize a line while changing its sibling', () =>
      pg.exec(`UPDATE billing_line_items
        SET invoiced = CASE WHEN line_type = 'shipping' THEN true ELSE invoiced END,
            total_cost = CASE WHEN line_type = 'pick_pack' THEN 99 ELSE total_cost END
        WHERE order_id = 600`),
    );
    const mixedStatementRows = await pg.query<{ invoiced: boolean; total_cost: string }>(`
      SELECT invoiced, total_cost::text
      FROM billing_line_items
      WHERE order_id = 600
      ORDER BY line_type
    `);
    check(
      'rejected mixed finalization rolls back every sibling change',
      mixedStatementRows.rows.every((row) => row.invoiced === false) &&
        mixedStatementRows.rows.map((row) => row.total_cost).join(',') === '1.00,2.00',
    );

    await pg.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost, invoiced)
      VALUES (1, NULL, '2026-07-31', 'storage', 'Frozen storage', 1, 10, true)
    `);
    await expectFinalizedLock('finalized storage group blocks a replacement INSERT', () =>
      pg.exec(`INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
        VALUES (1, NULL, '2026-07-31', 'storage', 'Replacement storage', 1, 12)`),
    );
    await pg.exec(`INSERT INTO billing_line_items
      (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
      VALUES (1, NULL, '2026-08-31', 'storage', 'Next period', 1, 12)`);
    check('different non-finalized storage period remains writable', true);

    await expectFinalizedLock('TRUNCATE is blocked while finalized billing exists', () =>
      pg.exec('TRUNCATE billing_line_items'),
    );
    await expectFinalizedLock('client cascade delete cannot erase finalized billing', () =>
      pg.exec('DELETE FROM clients WHERE id = 1'),
    );

    await pg.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost, invoiced)
      VALUES
        (2, 400, '2026-08-15', 'pick_pack', 'Editable range row', 1, 1, false),
        (2, 401, '2026-08-15', 'pick_pack', 'Frozen sibling', 1, 1, false),
        (2, 401, '2026-08-15', 'shipping', 'Frozen line', 5, 5, true),
        (2, 402, '2026-08-15', 'pick_pack', 'Editable assertion row', 1, 1, false),
        (2, 403, '2026-08-15', 'pick_pack', 'Current-period sibling', 1, 1, false),
        (2, 403, '2026-07-15', 'shipping', 'Prior-period finalized line', 5, 5, true)
    `);
    const conn = drizzle(pg, { schema, casing: 'snake_case' });
    const finalizedIds = await finalizedBillingOrderIdsForRange(
      {
        clientId: 2,
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-09-01T00:00:00.000Z',
      },
      conn as unknown as Parameters<typeof finalizedBillingOrderIdsForRange>[1],
    );
    check(
      'canonical range read identifies the finalized order once',
      finalizedIds.size === 1 && finalizedIds.has(401),
    );
    const candidateFinalizedIds = await finalizedBillingOrderIdsForRange(
      {
        clientId: 2,
        dateFrom: '2026-08-01T00:00:00.000Z',
        dateTo: '2026-09-01T00:00:00.000Z',
        orderIds: [400, 401, 402, 403],
      },
      conn as unknown as Parameters<typeof finalizedBillingOrderIdsForRange>[1],
    );
    check(
      'candidate-order read finds finalized siblings outside the regeneration range',
      candidateFinalizedIds.size === 2 && candidateFinalizedIds.has(401) && candidateFinalizedIds.has(403),
    );
    await conn
      .delete(billingLineItems)
      .where(and(eq(billingLineItems.clientId, 2), billingLineItemIsEditablePredicate()));
    const rangeRows = await pg.query<{ order_id: number }>(`
      SELECT order_id FROM billing_line_items
      WHERE client_id = 2
      ORDER BY order_id, id
    `);
    check(
      'canonical editable predicate deletes drafts but preserves every mixed finalized-order row',
      rangeRows.rows.map((row) => row.order_id).join(',') === '401,401,403,403',
    );
    await expectFinalizedLock('canonical order assertion rejects a mixed finalized order', () =>
      assertBillingOrdersEditable(
        { orderIds: [401], clientId: 2 },
        conn as unknown as Parameters<typeof assertBillingOrdersEditable>[1],
      ),
    );
    await pg.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost, invoiced)
      VALUES (2, 404, '2026-08-15', 'pick_pack', 'Guard-only finalized order', 1, 1, false)
    `);
    await pg.exec(`
      UPDATE billing_finalization_group_locks
      SET finalized = true
      WHERE group_key = billing_line_item_group_key(2, 404, '2026-08-15', 'pick_pack')
    `);
    await expectFinalizedLock('canonical order assertion rejects a finalized group guard', () =>
      assertBillingOrdersEditable(
        { orderIds: [404], clientId: 2 },
        conn as unknown as Parameters<typeof assertBillingOrdersEditable>[1],
      ),
    );
    await pg.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost, invoiced)
      VALUES (2, 405, '2026-08-15', 'pick_pack', 'Pending sidecar regeneration', 1, 1, false)
    `);
    await setBillingOrdersDirty(
      { orderIds: [405], clientId: 2, dirty: true },
      conn as unknown as Parameters<typeof setBillingOrdersDirty>[1],
    );
    await expectFinalizedLock('dirty sidecar state blocks finalization until regeneration', () =>
      pg.exec(`UPDATE billing_line_items SET invoiced = true WHERE order_id = 405`),
    );
    await setBillingOrdersDirty(
      { orderIds: [405], clientId: 2, dirty: false },
      conn as unknown as Parameters<typeof setBillingOrdersDirty>[1],
    );
    await pg.exec(`UPDATE billing_line_items SET invoiced = true WHERE order_id = 405`);
    check('clearing dirty state permits pure finalization', true);

    await pg.exec(`
      INSERT INTO clients (id) VALUES (3);
      INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
      VALUES
        (3, 700, '2026-09-05', 'pick_pack', 'September prep', 2, 2),
        (3, 700, '2026-09-05', 'shipping', 'September shipping', 8, 8);
      UPDATE billing_line_items SET invoiced = true WHERE client_id = 3;
      INSERT INTO billing_finalizations
        (id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by)
      VALUES
        ('final-3-september', 3, '2026-09-01', '2026-10-01', 2, 1, 10, 'test-actor');
    `);
    await expectErrorToken('closed period blocks later line UPDATE', 'BILLING_PERIOD_FINALIZED', () =>
      pg.exec(`UPDATE billing_line_items SET total_cost = 9 WHERE client_id = 3`),
    );
    await expectErrorToken('closed period blocks later line DELETE', 'BILLING_PERIOD_FINALIZED', () =>
      pg.exec(`DELETE FROM billing_line_items WHERE client_id = 3`),
    );
    await expectErrorToken('closed period blocks later line INSERT', 'BILLING_PERIOD_FINALIZED', () =>
      pg.exec(`INSERT INTO billing_line_items
        (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
        VALUES (3, 701, '2026-09-20', 'pick_pack', 'Late charge', 2, 2)`),
    );
    await expectErrorToken('overlapping period finalization is rejected', 'BILLING_PERIOD_FINALIZED', () =>
      pg.exec(`INSERT INTO billing_finalizations
        (id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by)
        VALUES ('final-3-overlap', 3, '2026-09-15', '2026-10-15', 1, 1, 1, 'test-actor')`),
    );
    await pg.exec(`INSERT INTO billing_credit_notes
      (id, finalization_id, client_id, amount, reason, idempotency_key, created_by)
      VALUES ('credit-3-one', 'final-3-september', 3, 1.25, 'Carrier adjustment', 'credit-idem-0001', 'test-actor')`);
    await expectErrorToken('aggregate credits cannot exceed the frozen subtotal', 'BILLING_CREDIT_EXCEEDS_BALANCE', () =>
      pg.exec(`INSERT INTO billing_credit_notes
        (id, finalization_id, client_id, amount, reason, idempotency_key, created_by)
        VALUES ('credit-3-excess', 'final-3-september', 3, 9, 'Excess adjustment', 'credit-idem-excess', 'test-actor')`),
    );
    await expectErrorToken('finalization records are append-only', 'BILLING_CLOSE_IMMUTABLE', () =>
      pg.exec(`UPDATE billing_finalizations SET subtotal = 9 WHERE id = 'final-3-september'`),
    );
    await expectErrorToken('credit-note records are append-only', 'BILLING_CLOSE_IMMUTABLE', () =>
      pg.exec(`DELETE FROM billing_credit_notes WHERE id = 'credit-3-one'`),
    );
    await expectErrorToken('credit-note history cannot be truncated', 'BILLING_CLOSE_IMMUTABLE', () =>
      pg.exec('TRUNCATE billing_credit_notes'),
    );
    await expectErrorToken('credit idempotency is durable', 'billing_credit_notes_idempotency_unq', () =>
      pg.exec(`INSERT INTO billing_credit_notes
        (id, finalization_id, client_id, amount, reason, idempotency_key, created_by)
        VALUES ('credit-3-two', 'final-3-september', 3, 1, 'Another adjustment', 'credit-idem-0001', 'test-actor')`),
    );
    await pg.exec(`INSERT INTO billing_line_items
      (client_id, order_id, ship_date, line_type, description, unit_cost, total_cost)
      VALUES (3, 702, '2026-10-05', 'pick_pack', 'Next period remains open', 2, 2)`);
    check('a later non-finalized period remains writable', true);
    await pg.close();
  }

  if (failures > 0) {
    console.error(`\nFAIL PS-412 finalized billing guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-412 finalized billing guard');
}

main().catch((error) => {
  console.error('FAIL PS-412 finalized billing guard:', error);
  process.exit(1);
});
