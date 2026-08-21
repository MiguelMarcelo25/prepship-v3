/**
 * PS-509 behavioural fixtures — the contract's acceptance evidence, executed.
 *
 * In-memory PGlite only. No production database, no provider, no label, no postage.
 * Nothing here reaches a network. Migration 0103 is applied AS WRITTEN (the real file),
 * proving it creates every owned relation on an empty database and replays as a no-op.
 *
 * What executes here: first ingestion, replay-no-reprice, durable outcomes for every
 * ineligibility class, late-link freeze-once in the link transaction, the
 * unexpected-freeze-failure ABORT (and the savepoint counterexample showing exactly the
 * permanent tuple-less gap the accepted contract forbids), receipt-revision detection,
 * void exclusion, outcome/revision durability triggers, and the retry sweep.
 *
 * WHAT THIS DOES NOT PROVE. PGlite is a single backend: the one-shot race between two
 * concurrent freezes stays unproven (same limitation PS-508 recorded). It also does not
 * drive upsertShipmentsBatch/order-sync end to end — the call-site wiring (freeze inside
 * the INSERT transaction with no savepoint, link+freeze in one transaction) is pinned
 * structurally in ps-509-sync-ingress-freeze-guard.ts.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const DDL = `
create table clients (
  id serial primary key,
  store_ids integer[] default '{}',
  is_test boolean default false
);
create table orders (
  id serial primary key,
  client_id integer,
  store_id integer
);
create table billing_config (
  client_id integer primary key,
  active boolean default true,
  billing_mode text default 'per_shipment',
  shipping_markup_pct numeric default 0,
  shipping_markup_flat numeric default 0,
  house_account_enabled boolean default false,
  hugrab_shipping_rate_override_enabled boolean default false,
  hugrab_shipping_rate_override_threshold numeric,
  hugrab_shipping_rate_override_amount numeric,
  updated_at timestamptz not null default now()
);
create table order_overrides (
  order_id integer primary key,
  best_rate_json jsonb,
  ref_usps_rate numeric,
  ref_ups_rate numeric
);
create table shipments (
  id serial primary key,
  order_id integer,
  client_id integer,
  order_number text,
  label_shipment_id bigint,
  is_return boolean default false,
  voided boolean default false,
  source text,
  cost numeric,
  other_cost numeric default 0,
  selected_rate_cost numeric,
  selected_rate_json jsonb,
  carrier_code text,
  provider_account_id integer,
  updated_at timestamptz
);
`;

const SEED = `
insert into clients (id, store_ids) values (1, '{1}');
insert into clients (id, store_ids) values (2, '{2}');
insert into clients (id, store_ids, is_test) values (3, '{3}', true);
insert into orders (id, client_id, store_id) values (100, 1, 1);
insert into orders (id, client_id, store_id) values (200, 2, 2);
insert into orders (id, client_id, store_id) values (300, 3, 3);
insert into billing_config (client_id, active, billing_mode, shipping_markup_pct)
  values (1, true, 'per_shipment', 20);
insert into billing_config (client_id, active, billing_mode, shipping_markup_pct)
  values (2, false, 'per_shipment', 20);
insert into billing_config (client_id, active, billing_mode, shipping_markup_pct)
  values (3, true, 'per_shipment', 20);
`;

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  delete process.env.BILLING_PER_ACCOUNT_MARKUP;

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { freezeSyncIngressCustomerShippingMoney, recordSyncIngressFreezeRetry } =
    await import('../src/services/customer-shipping-money-sync-ingress');
  const { sweepSyncIngressFreezeRetries } =
    await import('../src/services/customer-shipping-money-sync-retry-sweep');
  const { detectReceiptRevisionsAfterFreeze } =
    await import('../src/services/customer-shipping-money-receipt-revision');
  const { ensureCustomerShippingMoneySyncSchema, resetCustomerShippingMoneySyncReadinessForTests } =
    await import('../src/services/customer-shipping-money-sync-readiness');
  const { readFrozenCustomerShippingMoney, ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS } =
    await import('../src/services/customer-shipping-money-snapshot');
  const { classifyCustomerShippingMoney } =
    await import('../src/services/customer-shipping-money-classification');

  const client = new PGlite();
  await client.exec(DDL);
  await client.exec(SEED);
  // The db.transaction / insert / update surface of the real client, backed by PGlite —
  // same cast idiom as the PS-508 fixtures (scripts/ are not typechecked; tsx strips types).
  const dbx = drizzle(client, { casing: 'snake_case' }) as never;

  const freeze = (
    shipmentId: number,
    boundary: 'sync_insert' | 'orphan_link' | 'retry_sweep',
    exec: unknown = dbx,
  ) => freezeSyncIngressCustomerShippingMoney(shipmentId, { boundary, exec: exec as never });

  // ── 0. The readiness gate refuses to run before migration 0103 ──────────────────────────

  let readinessError: Error | null = null;
  await ensureCustomerShippingMoneySyncSchema(dbx).catch((e: Error) => { readinessError = e; });
  check('readiness gate REFUSES before migration 0103 and names the migration',
    readinessError != null && /0103_ps509_customer_shipping_money_sync/.test(String(readinessError)),
    String(readinessError));

  const migrationSql = readFileSync('drizzle/0103_ps509_customer_shipping_money_sync.sql', 'utf8');
  await client.exec(migrationSql);
  resetCustomerShippingMoneySyncReadinessForTests();
  let readyAfter = true;
  await ensureCustomerShippingMoneySyncSchema(dbx).catch(() => { readyAfter = false; });
  check('migration 0103 applies on an empty database and readiness passes', readyAfter);

  await client.exec(migrationSql);
  check('migration 0103 REPLAYS as a no-op (idempotent DDL)', true);

  // ── 1. First ingestion: eligible insert freezes the v509 tuple ──────────────────────────

  await client.exec(`
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, other_cost, selected_rate_cost)
      values (900, 100, 1, 'ON-900', 77900, 'shipstation', 10.00, 0, 10.00);
  `);
  const first = await freeze(900, 'sync_insert');
  const firstFrozen = first.outcome === 'frozen' ? first.frozen : null;
  check('first ingestion freezes carrier-markup money (10.00 + 20% = 12.00)',
    firstFrozen?.cShippingRateAmount === 12
    && firstFrozen?.customerRateSource === 'carrier_markup_customer_shipping_rate',
    JSON.stringify(first));
  check('the tuple is stamped ps-509-v1 with sync receipt-cost basis and capture source',
    firstFrozen?.customerShippingMoneyPolicyVersion === 'ps-509-v1'
    && firstFrozen?.rateCostSource === 'shipstation_sync_receipt_cost'
    && firstFrozen?.customerShippingMoneyCaptureSource === 'shipstation_sync_ingestion',
    JSON.stringify(firstFrozen));
  check('the tuple carries the billing description suffix (line identity, not just amount)',
    typeof firstFrozen?.billingDescriptionSuffix === 'string'
    && firstFrozen.billingDescriptionSuffix.length > 0,
    JSON.stringify(firstFrozen?.billingDescriptionSuffix));

  const storedJson = await client.query<{ selected_rate_json: unknown }>(
    'select selected_rate_json from shipments where id = 900');
  const stored = storedJson.rows[0]?.selected_rate_json;
  check('STAGING: the v509 tuple is INVISIBLE to the default (ps-437-only) reader',
    readFrozenCustomerShippingMoney(stored) === null);
  check('the v509 tuple reads when a consumer explicitly accepts the version',
    readFrozenCustomerShippingMoney(stored, {
      accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
    })?.cShippingRateAmount === 12);
  check('the classifier reports valid_ps509',
    classifyCustomerShippingMoney(stored).kind === 'valid_ps509');

  const outcome900 = await client.query<{ outcome: string; boundary: string; policy_contract: string; evaluation_count: number }>(
    'select outcome, boundary, policy_contract, evaluation_count from customer_shipping_money_sync_outcomes where shipment_id = 900');
  check('a durable frozen outcome row exists (boundary sync_insert, contract ps-509-v1)',
    outcome900.rows.length === 1
    && outcome900.rows[0].outcome === 'frozen'
    && outcome900.rows[0].boundary === 'sync_insert'
    && outcome900.rows[0].policy_contract === 'ps-509-v1',
    JSON.stringify(outcome900.rows));

  // ── 2. Replay never reprices, even after policy changes ─────────────────────────────────

  await client.exec('update billing_config set shipping_markup_pct = 50 where client_id = 1;');
  const replay = await freeze(900, 'sync_insert');
  check('replay reports frozen money as already frozen and does NOT reprice under the new markup',
    replay.outcome === 'frozen' && replay.alreadyFrozen === true
    && replay.frozen.cShippingRateAmount === 12,
    JSON.stringify(replay));
  const outcome900b = await client.query<{ evaluation_count: number; outcome: string }>(
    'select evaluation_count, outcome from customer_shipping_money_sync_outcomes where shipment_id = 900');
  check('the outcome row is ONE row per shipment, with the evaluation counted',
    outcome900b.rows.length === 1 && outcome900b.rows[0].evaluation_count === 2
    && outcome900b.rows[0].outcome === 'frozen',
    JSON.stringify(outcome900b.rows));
  await client.exec('update billing_config set shipping_markup_pct = 20 where client_id = 1;');

  // ── 3. Every ineligibility class persists its durable named outcome ─────────────────────

  await client.exec(`
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost, voided)
      values (901, 100, 1, 'ON-901', 77901, 'shipstation', 9.00, 9.00, true);
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost, is_return)
      values (902, 100, 1, 'ON-902', 77902, 'shipstation', 9.00, 9.00, true);
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
      values (903, 300, 3, 'ON-903', 77903, 'shipstation', 9.00, 9.00);
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
      values (904, 200, 2, 'ON-904', 77904, 'shipstation', 9.00, 9.00);
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
      values (905, 100, 1, 'ON-905', 77905, 'shipstation', 0.00, 0.00);
    insert into shipments (id, order_number, label_shipment_id, source, cost, selected_rate_cost)
      values (906, 'ON-906', 77906, 'shipstation', 9.00, 9.00);
  `);
  const expectations: Array<[number, string]> = [
    [901, 'voided'], [902, 'return'], [903, 'test'],
    [904, 'billing_inactive'], [905, 'no_billable_cost'], [906, 'no_order'],
  ];
  for (const [id, expected] of expectations) {
    const result = await freeze(id, 'sync_insert');
    const persisted = await client.query<{ outcome: string }>(
      `select outcome from customer_shipping_money_sync_outcomes where shipment_id = ${id}`);
    check(`ineligibility persists durably: shipment ${id} -> ${expected}`,
      result.outcome === expected && persisted.rows[0]?.outcome === expected,
      `${JSON.stringify(result)} / ${JSON.stringify(persisted.rows)}`);
  }
  const noTuples = await client.query<{ n: number }>(
    `select count(*)::int as n from shipments
     where id between 901 and 906 and coalesce(selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion'`);
  check('skips never write a money policy-version key', noTuples.rows[0]?.n === 0);

  // ── 4. Late link: durable no_order -> freeze EXACTLY ONCE in the link transaction ───────

  await client.exec('update billing_config set shipping_markup_pct = 30 where client_id = 1;');
  const linked = await (dbx as unknown as { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> })
    .transaction(async (tx) => {
      const t = tx as { execute: (q: unknown) => Promise<unknown> };
      const { sql } = await import('drizzle-orm');
      await t.execute(sql`update shipments set order_id = 100, client_id = 1, updated_at = now()
        where order_id is null and order_number = 'ON-906'`);
      return freeze(906, 'orphan_link', tx);
    });
  const linkedResult = linked as { outcome: string; alreadyFrozen?: boolean; frozen?: { cShippingRateAmount: number } };
  check('late link freezes in the link transaction (9.00 + 30% = 11.70)',
    linkedResult.outcome === 'frozen' && linkedResult.alreadyFrozen === false
    && linkedResult.frozen?.cShippingRateAmount === 11.7,
    JSON.stringify(linkedResult));
  const outcome906 = await client.query<{ outcome: string; boundary: string; evaluation_count: number }>(
    'select outcome, boundary, evaluation_count from customer_shipping_money_sync_outcomes where shipment_id = 906');
  check('the durable outcome transitioned no_order -> frozen in ONE row (link boundary recorded)',
    outcome906.rows.length === 1 && outcome906.rows[0].outcome === 'frozen'
    && outcome906.rows[0].boundary === 'orphan_link' && outcome906.rows[0].evaluation_count === 2,
    JSON.stringify(outcome906.rows));
  await client.exec('update billing_config set shipping_markup_pct = 45 where client_id = 1;');
  const linkReplay = await freeze(906, 'orphan_link');
  check('replaying the link freeze does not reprice (still 11.70 under a changed markup)',
    linkReplay.outcome === 'frozen' && linkReplay.alreadyFrozen === true
    && linkReplay.frozen.cShippingRateAmount === 11.7,
    JSON.stringify(linkReplay));
  await client.exec('update billing_config set shipping_markup_pct = 20 where client_id = 1;');

  // ── 5. THE TRANSACTION RULE: unexpected freeze failure ABORTS the eligible insert ────────

  await client.exec('alter table customer_shipping_money_sync_outcomes rename to csm_outcomes_hidden;');
  let abortError: unknown = null;
  try {
    await (dbx as unknown as { transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void> })
      .transaction(async (tx) => {
        const { sql } = await import('drizzle-orm');
        const t = tx as { execute: (q: unknown) => Promise<unknown> };
        await t.execute(sql`insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
          values (910, 100, 1, 'ON-910', 77910, 'shipstation', 8.00, 8.00)`);
        await freeze(910, 'sync_insert', tx);
      });
  } catch (error) {
    abortError = error;
  }
  const abortedRow = await client.query<{ n: number }>(
    'select count(*)::int as n from shipments where id = 910');
  check('an unexpected freeze failure on an eligible fresh insert ABORTS the insert transaction',
    abortError != null && abortedRow.rows[0]?.n === 0,
    `error=${String(abortError).slice(0, 120)} rows=${abortedRow.rows[0]?.n}`);

  // The counterexample the contract names: a savepoint would commit the row TUPLE-LESS.
  let savepointParentCommitted = false;
  await (dbx as unknown as { transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void> })
    .transaction(async (tx) => {
      const { sql } = await import('drizzle-orm');
      const t = tx as {
        execute: (q: unknown) => Promise<unknown>;
        transaction: (fn: (sp: unknown) => Promise<void>) => Promise<void>;
      };
      await t.execute(sql`insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
        values (911, 100, 1, 'ON-911', 77911, 'shipstation', 8.00, 8.00)`);
      try {
        await t.transaction(async (sp) => { await freeze(911, 'sync_insert', sp); });
      } catch {
        // swallowed, exactly as the forbidden savepoint shape would
      }
      savepointParentCommitted = true;
    });
  const savepointRow = await client.query<{ n: number; tupleless: number }>(
    `select count(*)::int as n,
            count(*) filter (where not coalesce(selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion')::int as tupleless
     from shipments where id = 911`);
  check('COUNTEREXAMPLE: the savepoint shape commits the shipment WITHOUT its tuple — the permanent gap the contract forbids',
    savepointParentCommitted && savepointRow.rows[0]?.n === 1 && savepointRow.rows[0]?.tupleless === 1,
    JSON.stringify(savepointRow.rows));
  await client.exec('delete from shipments where id = 911;');
  await client.exec('alter table csm_outcomes_hidden rename to customer_shipping_money_sync_outcomes;');

  // Retry after the failure: the same insert succeeds and nothing was double-priced.
  const retried = await (dbx as unknown as { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> })
    .transaction(async (tx) => {
      const { sql } = await import('drizzle-orm');
      const t = tx as { execute: (q: unknown) => Promise<unknown> };
      await t.execute(sql`insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
        values (910, 100, 1, 'ON-910', 77910, 'shipstation', 8.00, 8.00)`);
      return freeze(910, 'sync_insert', tx);
    });
  const retriedResult = retried as { outcome: string; alreadyFrozen?: boolean };
  const retriedOutcome = await client.query<{ outcome: string }>(
    'select outcome from customer_shipping_money_sync_outcomes where shipment_id = 910');
  check('the retry (fresh INSERT next sync) succeeds with tuple + outcome committed together',
    retriedResult.outcome === 'frozen' && retriedResult.alreadyFrozen === false
    && retriedOutcome.rows[0]?.outcome === 'frozen',
    JSON.stringify({ retriedResult, rows: retriedOutcome.rows }));

  // ── 6. receipt_revised_after_freeze: detected, durable, never auto-repriced ─────────────

  await client.exec('update shipments set cost = 11.00 where id = 900;');
  const detect1 = await detectReceiptRevisionsAfterFreeze([900, 901, 905], { database: dbx });
  const revision = await client.query<{
    review_class: string; policy_version: string; previous_frozen_selected_cost: string;
    delta_signed: string; delta_abs: string; reconciliation_state: string; detection_count: number;
  }>('select review_class, policy_version, previous_frozen_selected_cost, delta_signed, delta_abs, reconciliation_state, detection_count from customer_shipping_money_receipt_revisions where shipment_id = 900');
  check('a post-freeze receipt revision becomes a durable open review record with signed and absolute deltas',
    detect1.revised === 1 && revision.rows.length === 1
    && revision.rows[0].review_class === 'receipt_revised_after_freeze'
    && revision.rows[0].policy_version === 'ps-509-v1'
    && Number(revision.rows[0].previous_frozen_selected_cost) === 10
    && Number(revision.rows[0].delta_signed) === 1
    && Number(revision.rows[0].delta_abs) === 1
    && revision.rows[0].reconciliation_state === 'open',
    JSON.stringify(revision.rows));
  const detect2 = await detectReceiptRevisionsAfterFreeze([900], { database: dbx });
  const revisionAgain = await client.query<{ detection_count: number }>(
    'select detection_count from customer_shipping_money_receipt_revisions where shipment_id = 900');
  check('re-detection updates the ONE open record (no duplicate rows)',
    detect2.revised === 1 && revisionAgain.rows.length === 1
    && revisionAgain.rows[0].detection_count === 2,
    JSON.stringify(revisionAgain.rows));
  const frozenAfterRevision = await client.query<{ v: string | null }>(
    `select selected_rate_json->>'cShippingRateAmount' as v from shipments where id = 900`);
  check('the frozen money is NEVER auto-repriced by a receipt revision',
    frozenAfterRevision.rows[0]?.v === '12');

  // ── 7. Void exclusion: a void arriving AFTER the freeze never demotes the money ─────────

  await client.exec('update shipments set voided = true where id = 900;');
  const voidReplay = await freeze(900, 'sync_insert');
  const voidOutcome = await client.query<{ outcome: string }>(
    'select outcome from customer_shipping_money_sync_outcomes where shipment_id = 900');
  check('void-after-freeze preserves the tuple and the frozen outcome (exclusion is downstream)',
    voidReplay.outcome === 'frozen' && voidReplay.alreadyFrozen === true
    && voidOutcome.rows[0]?.outcome === 'frozen',
    JSON.stringify({ voidReplay, rows: voidOutcome.rows }));

  // ── 8. Durability triggers: outcomes and review evidence cannot vanish ──────────────────

  let deleteBlocked = false;
  try { await client.exec('delete from customer_shipping_money_sync_outcomes where shipment_id = 900;'); }
  catch { deleteBlocked = true; }
  let demoteBlocked = false;
  try { await client.exec(`update customer_shipping_money_sync_outcomes set outcome = 'no_order' where shipment_id = 900;`); }
  catch { demoteBlocked = true; }
  let revisionDeleteBlocked = false;
  try { await client.exec('delete from customer_shipping_money_receipt_revisions where shipment_id = 900;'); }
  catch { revisionDeleteBlocked = true; }
  check('outcome rows cannot be deleted, frozen cannot be demoted, review evidence cannot be deleted',
    deleteBlocked && demoteBlocked && revisionDeleteBlocked,
    JSON.stringify({ deleteBlocked, demoteBlocked, revisionDeleteBlocked }));
  let resolveAllowed = true;
  try {
    await client.exec(`update customer_shipping_money_receipt_revisions
      set reconciliation_state = 'resolved', resolved_at = now(), resolved_by = 'fixture'
      where shipment_id = 900;`);
  } catch { resolveAllowed = false; }
  check('reconciliation transitions stay possible (resolve is an UPDATE, identity fields untouched)',
    resolveAllowed);

  // ── 9. The retry sweep closes the UPDATE-relink lane ─────────────────────────────────────

  await client.exec(`
    insert into shipments (id, order_number, label_shipment_id, source, cost, selected_rate_cost)
      values (920, 'ON-920', 77920, 'shipstation', 6.00, 6.00);
  `);
  const orphaned = await freeze(920, 'sync_insert');
  check('the orphan insert records a durable no_order outcome', orphaned.outcome === 'no_order');
  // The relink lane the boundaries cannot see: shipment-sync's UPDATE branch re-resolves
  // the order and writes the link with no transaction and no freeze.
  await client.exec('update shipments set order_id = 100, client_id = 1 where id = 920;');
  const swept = await sweepSyncIngressFreezeRetries({ database: dbx });
  const sweptOutcome = await client.query<{ outcome: string; boundary: string }>(
    'select outcome, boundary from customer_shipping_money_sync_outcomes where shipment_id = 920');
  check('the sweep freezes the relinked orphan (boundary retry_sweep, durable outcome frozen)',
    swept.frozen === 1 && sweptOutcome.rows[0]?.outcome === 'frozen'
    && sweptOutcome.rows[0]?.boundary === 'retry_sweep',
    JSON.stringify({ swept, rows: sweptOutcome.rows }));

  // ── 10. needs_retry is recordable outside a failed transaction, and swept back in ───────

  await client.exec(`
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost)
      values (930, 100, 1, 'ON-930', 77930, 'shipstation', 5.00, 5.00);
  `);
  await recordSyncIngressFreezeRetry(930, {
    boundary: 'orphan_link',
    failureClassification: 'late_attributed',
    detail: 'fixture: simulated link transaction abort',
    database: dbx,
  });
  const retryRow = await client.query<{ outcome: string; failure_classification: string }>(
    'select outcome, failure_classification from customer_shipping_money_sync_outcomes where shipment_id = 930');
  check('a failed link+freeze records needs_retry with the late_attributed classification',
    retryRow.rows[0]?.outcome === 'needs_retry'
    && retryRow.rows[0]?.failure_classification === 'late_attributed',
    JSON.stringify(retryRow.rows));
  const swept2 = await sweepSyncIngressFreezeRetries({ database: dbx });
  const retryAfter = await client.query<{ outcome: string }>(
    'select outcome from customer_shipping_money_sync_outcomes where shipment_id = 930');
  check('the sweep re-drives needs_retry to frozen',
    swept2.frozen === 1 && retryAfter.rows[0]?.outcome === 'frozen',
    JSON.stringify({ swept2, rows: retryAfter.rows }));

  // ── 11. Malformed and unknown pre-existing snapshots stay review-only ────────────────────

  await client.exec(`
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost, selected_rate_json)
      values (940, 100, 1, 'ON-940', 77940, 'shipstation', 9.00, 9.00, '{
        "selectedRateCost": 9, "cShippingRateAmount": 11, "shippingMarginAmount": 5,
        "shippingMarginPct": 18.2, "rateCostSource": "shipstation_sync_receipt_cost",
        "customerShippingMoneyCaptureSource": "shipstation_sync_ingestion",
        "customerRateSource": "carrier_markup_customer_shipping_rate",
        "customerShippingMoneyPolicyVersion": "ps-509-v1" }'::jsonb);
    insert into shipments (id, order_id, client_id, order_number, label_shipment_id, source, cost, selected_rate_cost, selected_rate_json)
      values (941, 100, 1, 'ON-941', 77941, 'shipstation', 9.00, 9.00,
        '{"customerShippingMoneyPolicyVersion": "ps-999-v9"}'::jsonb);
  `);
  const malformed = await freeze(940, 'sync_insert');
  const unknown = await freeze(941, 'sync_insert');
  const reviewRows = await client.query<{ shipment_id: number; outcome: string; failure_classification: string }>(
    'select shipment_id, outcome, failure_classification from customer_shipping_money_sync_outcomes where shipment_id in (940, 941) order by shipment_id');
  check('malformed and unknown snapshots persist needs_review outcomes and are never rewritten',
    malformed.outcome === 'needs_review' && unknown.outcome === 'needs_review'
    && reviewRows.rows.length === 2
    && reviewRows.rows[0].failure_classification === 'malformed_known_version'
    && reviewRows.rows[1].failure_classification === 'unknown_version',
    JSON.stringify(reviewRows.rows));
  const untouched = await client.query<{ m: string | null; u: string | null }>(
    `select
      (select selected_rate_json->>'shippingMarginAmount' from shipments where id = 940) as m,
      (select selected_rate_json->>'customerShippingMoneyPolicyVersion' from shipments where id = 941) as u`);
  check('NEITHER bad snapshot was overwritten — evidence survives',
    untouched.rows[0]?.m === '5' && untouched.rows[0]?.u === 'ps-999-v9',
    JSON.stringify(untouched.rows));

  // ── 12. A non-shipstation row is outside this ingress and gets NO sync outcome ──────────

  await client.exec(`
    insert into shipments (id, order_id, client_id, order_number, source, cost, selected_rate_cost)
      values (950, 100, 1, 'ON-950', 'prepship_v2', 9.00, 9.00);
  `);
  const foreign = await freeze(950, 'orphan_link');
  const foreignOutcome = await client.query<{ n: number }>(
    'select count(*)::int as n from customer_shipping_money_sync_outcomes where shipment_id = 950');
  check('a prepship-created row is not_sync_ingress: no freeze, no sync outcome row',
    foreign.outcome === 'not_sync_ingress' && foreignOutcome.rows[0]?.n === 0,
    JSON.stringify({ foreign, n: foreignOutcome.rows[0]?.n }));

  if (failures > 0) {
    console.log(`\nFAIL PS-509 behavioural fixtures (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPS-509 behavioural fixtures passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
