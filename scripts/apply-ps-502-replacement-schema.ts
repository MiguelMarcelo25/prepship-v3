/**
 * PS-502 — migrations 0096-0103 runner: replacement schema, reporting, durable financial actions.
 *
 * WHY A RUNNER AND NOT `npm run migrate`
 *
 * Production execution belongs to the operator lane, not a developer session. This runs
 * inside the Render environment that already holds the production DATABASE_URL, so no
 * local credential is needed, minted, or passed through a workstation. Same shape as the
 * PS-488/0092 and PS-501/0095 lanes.
 *
 * WHAT THESE MIGRATIONS DO
 *
 *   0096-0101 create and harden replacement domain, money, label-intent and hold state
 *   0102      adds the three replacement columns to billing_summary_metrics
 *   0103      adds the durable AC-13 replacement financial-action ledger
 *
 * Purely additive. No existing column changes type or meaning and no row is rewritten. The
 * only reference to shipments is a FOREIGN KEY pointing AT it, which mutates nothing —
 * which is why the card places this inside the "no unlock" list.
 *
 * WHY IT STILL NEEDS A GATE
 *
 * billing_line_items is the money table. A partial unique index or a CHECK added with the
 * wrong predicate would either reject legitimate future writes or fail to prevent the
 * duplicate charge it exists to prevent. So: inspect is the default, apply demands the
 * exact token, and the read-back asserts the SHAPE of what landed — table presence, column
 * nullability, the index's uniqueness and partiality, and the CHECK's validated state —
 * rather than merely that the statements did not throw.
 *
 * ORDER MATTERS. Later migrations reference objects created earlier. This applies 0096-0103
 * in order inside ONE transaction so any failure rolls the entire lane back rather than
 * leaving a partial schema.
 *
 *   npx tsx scripts/apply-ps-502-replacement-schema.ts --digest96=<sha> ... --digest103=<sha>
 *   npx tsx scripts/apply-ps-502-replacement-schema.ts --digest96=<sha> ... --digest103=<sha> --apply --confirm=<token>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const SQL_0096 = 'drizzle/0096_ps502_replacements.sql';
const SQL_0097 = 'drizzle/0097_ps502_replacement_billing.sql';
// Added after Hermes found this lane stale at 8d0dcc5c: the create command already
// depended on request_signature (0099) and the RESTRICT contract (0098), neither of which
// this — the OFFICIAL deploy path — applied. A deploy would have produced a schema the
// shipped code cannot run against.
const SQL_0098 = 'drizzle/0098_ps502_replacement_financial_restrict.sql';
const SQL_0099 = 'drizzle/0099_ps502_replacement_request_signature.sql';
const SQL_0100 = 'drizzle/0100_ps502_replacement_operational_state.sql';
const SQL_0101 = 'drizzle/0101_ps502_replacement_original_order_holds.sql';
const SQL_0102 = 'drizzle/0102_billing_summary_metrics_replacement_totals.sql';
const SQL_0103 = 'drizzle/0103_ps502_replacement_financial_actions.sql';
const CONFIRM_TOKEN = 'APPLY-PS-502-REPLACEMENT-SCHEMA';
const EXPECTED_0096 = 'bee592ffbb801f37858ec3459fdf00889e2fb5391ce820798e4485c026f6d63a';
const EXPECTED_0097 = 'cfa70218831b0ec1377238610e4df2679da7bba4000af5bb57b4fcdfc97fbd91';
const EXPECTED_0098 = '56ea07a48cb95127a335cbf9dd748c1507eba3077a550e0decff17021b9a2d37';
const EXPECTED_0099 = '7a44f912b90c12e94bac255e331af0bd60e2f337ca842255b411949ca37dbdfe';
const EXPECTED_0100 = '6f1524aaba51240650f380fec4af03f29d048cd66d2df1ad0c8003f2d628f9b3';
const EXPECTED_0101 = 'fbd965fe230f44dbd34da5bf877473cd64f2ec694f71a5ba5f206f71069995a0';
const EXPECTED_0102 = '8a525f88070ccde10c862bb951b7461f0142ecc81bf9611fe55486afefa12bd8';
const EXPECTED_0103 = '3325c1b0c64463b40e02073e97620fa8b9c1ac2fbec18a9e492bdc9c5b4370ec';

const REVIEWED_MIGRATIONS = [
  { stage: 1, label: '0096', file: SQL_0096, expected: EXPECTED_0096, argName: 'digest96' },
  { stage: 2, label: '0097', file: SQL_0097, expected: EXPECTED_0097, argName: 'digest97' },
  { stage: 3, label: '0098', file: SQL_0098, expected: EXPECTED_0098, argName: 'digest98' },
  { stage: 4, label: '0099', file: SQL_0099, expected: EXPECTED_0099, argName: 'digest99' },
  { stage: 5, label: '0100', file: SQL_0100, expected: EXPECTED_0100, argName: 'digest100' },
  { stage: 6, label: '0101', file: SQL_0101, expected: EXPECTED_0101, argName: 'digest101' },
  { stage: 7, label: '0102', file: SQL_0102, expected: EXPECTED_0102, argName: 'digest102' },
  { stage: 8, label: '0103', file: SQL_0103, expected: EXPECTED_0103, argName: 'digest103' },
] as const;

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
function argValue(name: string): string | null {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

/** LF-normalised: this repo runs core.autocrlf=true, so raw bytes would vary by checkout. */
function normalisedDigest(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

type BillingSummaryReplacementColumnFacts = {
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  column_default: string | null;
};

type FinancialActionColumnFacts = {
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  is_identity: string;
  column_default: string | null;
};

type FinancialActionIndexFacts = {
  indexname: string;
  indexdef: string;
};

type FinancialActionConstraintFacts = {
  conname: string;
  contype: string;
  convalidated: boolean;
  confdeltype: string;
  target: string | null;
  definition: string;
};

type CatalogColumnFacts = {
  table_name: string;
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  is_identity: string;
  identity_generation: string | null;
  column_default: string | null;
  serial_sequence: string | null;
};

type CatalogIndexFacts = {
  tablename: string;
  indexname: string;
  indexdef: string;
  is_unique: boolean;
  is_primary: boolean;
  key_columns: string[];
  key_options: number[];
  predicate: string | null;
};

type CatalogConstraintFacts = {
  table_name: string;
  conname: string;
  contype: string;
  convalidated: boolean;
  confdeltype: string;
  target: string | null;
  definition: string;
  local_columns: string[];
  referenced_columns: string[];
};

type CatalogRlsFacts = { tablename: string; rls: boolean };
type CatalogPolicyFacts = { tablename: string; policyname: string };

type ReplacementSchemaState = {
  tables: {
    replacements: boolean;
    items: boolean;
    events: boolean;
    billing_summary_metrics: boolean;
    financial_actions: boolean;
  };
  cols: { table_name: string; is_nullable: string }[];
  metricCols: BillingSummaryReplacementColumnFacts[];
  idx: number;
  chk: { n: number; validated: boolean | null };
  financialColumns: FinancialActionColumnFacts[];
  financialIndexes: FinancialActionIndexFacts[];
  financialConstraints: FinancialActionConstraintFacts[];
  financialRls: boolean;
  catalogColumns: CatalogColumnFacts[];
  catalogIndexes: CatalogIndexFacts[];
  catalogConstraints: CatalogConstraintFacts[];
  catalogRls: CatalogRlsFacts[];
  catalogPolicies: CatalogPolicyFacts[];
};

function hasZeroDefault(value: string | null): boolean {
  return (value ?? '').trim() === '0';
}

type ExpectedDefault = 'none' | 'serial' | 'now' | 'zero' | 'one' | 'false'
  | 'requested' | 'operator' | 'provider_pending' | 'pending';
type ExpectedColumn = {
  type: string;
  nullable: boolean;
  default: ExpectedDefault;
  precision?: number;
  scale?: number;
  identity?: boolean;
};

const col = (
  type: string,
  nullable: boolean,
  defaultValue: ExpectedDefault = 'none',
  extra: Pick<ExpectedColumn, 'precision' | 'scale' | 'identity'> = {},
): ExpectedColumn => ({ type, nullable, default: defaultValue, ...extra });

/** Every column introduced by 0096-0103. Existing-table additions are listed separately. */
const EXPECTED_DOMAIN_COLUMNS: Record<string, Record<string, ExpectedColumn>> = {
  replacements: {
    id: col('integer', false, 'serial'),
    order_id: col('integer', false), client_id: col('integer', true),
    replacement_shipment_id: col('integer', true), reference: col('text', false),
    status: col('text', false, 'requested'), reason: col('text', false),
    billable: col('boolean', false, 'false'), liability_owner: col('text', false, 'operator'),
    request_idempotency_key: col('text', false), state_version: col('integer', false, 'zero'),
    review_reason: col('text', true), review_requested_at: col('timestamp with time zone', true),
    initiated_by: col('text', true), approved_by: col('text', true),
    admin_override: col('boolean', false, 'false'), admin_override_by: col('text', true),
    admin_override_reason: col('text', true), requested_at: col('timestamp with time zone', false, 'now'),
    label_created_at: col('timestamp with time zone', true), shipped_at: col('timestamp with time zone', true),
    completed_at: col('timestamp with time zone', true), rejected_at: col('timestamp with time zone', true),
    cancelled_at: col('timestamp with time zone', true), closed_at: col('timestamp with time zone', true),
    created_at: col('timestamp with time zone', false, 'now'),
    updated_at: col('timestamp with time zone', false, 'now'), request_signature: col('text', true),
  },
  replacement_items: {
    id: col('integer', false, 'serial'), replacement_id: col('integer', false),
    order_id: col('integer', false), order_line_index: col('integer', false),
    source_line_fingerprint: col('text', false), sku: col('text', false), name: col('text', true),
    original_ordered_quantity: col('integer', false), quantity: col('integer', false),
    created_at: col('timestamp with time zone', false, 'now'),
    updated_at: col('timestamp with time zone', false, 'now'),
  },
  replacement_activity_events: {
    id: col('integer', false, 'serial'), replacement_id: col('integer', false),
    shipment_id: col('integer', true), event_type: col('text', false),
    from_status: col('text', true), to_status: col('text', true), actor_type: col('text', false),
    actor_email: col('text', true), idempotency_key: col('text', false),
    event_at: col('timestamp with time zone', false, 'now'),
    created_at: col('timestamp with time zone', false, 'now'), detail: col('text', true),
  },
  replacement_label_purchase_intents: {
    id: col('integer', false, 'serial'), replacement_id: col('integer', false),
    replacement_shipment_id: col('integer', true), provider: col('text', false),
    provider_idempotency_key: col('text', false), request_fingerprint: col('text', false),
    purchase_attempt: col('integer', false, 'one'), state: col('text', false, 'provider_pending'),
    provider_transaction_id: col('text', true), provider_label_id: col('text', true),
    provider_shipment_id: col('text', true), resolved_request: col('jsonb', true),
    last_error: col('text', true), last_error_class: col('text', true),
    reconciliation_state: col('text', true), reconciled_at: col('timestamp with time zone', true),
    void_state: col('text', true), provider_void_id: col('text', true),
    voided_at: col('timestamp with time zone', true),
    created_at: col('timestamp with time zone', false, 'now'),
    updated_at: col('timestamp with time zone', false, 'now'),
    resolved_at: col('timestamp with time zone', true),
  },
  replacement_item_remaps: {
    id: col('integer', false, 'serial'), replacement_id: col('integer', false),
    replacement_item_id: col('integer', false), previous_order_line_index: col('integer', false),
    previous_source_line_fingerprint: col('text', false),
    resolved_order_line_index: col('integer', false),
    resolved_source_line_fingerprint: col('text', false), resolution: col('text', false),
    remap_version: col('integer', false, 'one'), actor_type: col('text', false),
    actor_email: col('text', true), reason: col('text', false), idempotency_key: col('text', false),
    created_at: col('timestamp with time zone', false, 'now'),
  },
  replacement_original_order_holds: {
    id: col('integer', false, 'serial'), replacement_id: col('integer', false),
    order_id: col('integer', false), trigger_kind: col('text', false),
    evidence_kind: col('text', false), order_lifecycle_event_id: col('integer', true),
    webhook_event_id: col('integer', true), declared_by: col('text', true), reason: col('text', false),
    phase: col('text', false), disposition: col('text', false), open_question: col('text', true),
    status_at_hold: col('text', false), state_version_at_hold: col('integer', false),
    resolved_at: col('timestamp with time zone', true), resolved_by: col('text', true),
    resolution: col('text', true), idempotency_key: col('text', false),
    created_at: col('timestamp with time zone', false, 'now'),
  },
  replacement_financial_actions: {
    id: col('bigint', false, 'none', { identity: true }),
    replacement_id: col('integer', false), client_id: col('integer', false),
    action_type: col('text', false), reason: col('text', false),
    idempotency_key: col('text', false), requested_by_type: col('text', false),
    requested_by_email: col('text', true), status: col('text', false, 'pending'),
    attempts: col('integer', false, 'zero'), editable_removed: col('integer', false, 'zero'),
    credits_settled: col('integer', false, 'zero'),
    credited_amount: col('numeric', false, 'zero', { precision: 12, scale: 2 }),
    last_error: col('text', true), next_run_at: col('timestamp with time zone', false, 'now'),
    lease_expires_at: col('timestamp with time zone', true),
    completed_at: col('timestamp with time zone', true),
    created_at: col('timestamp with time zone', false, 'now'),
    updated_at: col('timestamp with time zone', false, 'now'),
  },
};

const EXPECTED_EXISTING_ADDITIONS: Record<string, Record<string, ExpectedColumn>> = {
  billing_line_items: { replacement_id: col('integer', true) },
  billing_credit_notes: { replacement_id: col('integer', true) },
};

function defaultMatches(
  actual: string | null,
  expected: ExpectedDefault,
  table: string,
  column: string,
  serialSequence: string | null,
): boolean {
  const normalized = (actual ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (expected === 'none') return actual == null;
  if (expected === 'serial') {
    const sequence = `${table}_${column}_seq`;
    return serialSequence === `public.${sequence}`
      && (
        normalized === `nextval('${sequence}'::regclass)`
        || normalized === `nextval('public.${sequence}'::regclass)`
      );
  }
  if (expected === 'now') return normalized === 'now()';
  if (expected === 'zero') return hasZeroDefault(actual);
  if (expected === 'one') return normalized === '1';
  if (expected === 'false') return normalized === 'false';
  return normalized === `'${expected}'::text`;
}

function domainTableStage(table: string): number {
  if (table === 'replacement_financial_actions') return 8;
  if (table === 'replacement_original_order_holds') return 6;
  if (table === 'replacement_label_purchase_intents' || table === 'replacement_item_remaps') return 5;
  return 1;
}

function domainColumnStage(table: string, column: string): number {
  if (table === 'replacements' && column === 'request_signature') return 4;
  if (table === 'replacement_activity_events' && column === 'detail') return 3;
  return domainTableStage(table);
}

function validateColumns(
  snapshot: ReplacementSchemaState,
  problems: string[],
  stage = 8,
): void {
  for (const [table, expectedColumns] of Object.entries(EXPECTED_DOMAIN_COLUMNS)) {
    if (domainTableStage(table) > stage) continue;
    const expectedAtStage = Object.fromEntries(
      Object.entries(expectedColumns).filter(([name]) => domainColumnStage(table, name) <= stage),
    );
    const observed = snapshot.catalogColumns.filter((item) => item.table_name === table);
    if (observed.length === 0) {
      problems.push(`${table} is absent or has no columns`);
      continue;
    }
    if (observed.length !== Object.keys(expectedAtStage).length) {
      problems.push(`${table} has an unexpected column set`);
    }
    for (const [name, expected] of Object.entries(expectedAtStage)) {
      const actual = observed.find((item) => item.column_name === name);
      if (!actual) {
        problems.push(`${table}.${name} is absent`);
        continue;
      }
      if (actual.data_type !== expected.type) {
        problems.push(`${table}.${name} type is ${actual.data_type}, expected ${expected.type}`);
      }
      if ((actual.is_nullable === 'YES') !== expected.nullable) {
        problems.push(`${table}.${name} nullability is ${actual.is_nullable}`);
      }
      if (!defaultMatches(
        actual.column_default,
        expected.default,
        table,
        name,
        actual.serial_sequence,
      )) {
        problems.push(`${table}.${name} default is ${actual.column_default}, expected ${expected.default}`);
      }
      if ((actual.is_identity === 'YES') !== (expected.identity === true)) {
        problems.push(`${table}.${name} identity shape is ${actual.is_identity}`);
      }
      const expectedSequence = expected.default === 'serial' || expected.identity === true
        ? `public.${table}_${name}_seq`
        : null;
      if (actual.serial_sequence !== expectedSequence) {
        problems.push(
          `${table}.${name} owned sequence is ${actual.serial_sequence}, expected ${expectedSequence}`,
        );
      }
      if (
        expected.identity === true
        && actual.identity_generation !== 'ALWAYS'
      ) {
        problems.push(`${table}.${name} identity generation is ${actual.identity_generation}, expected ALWAYS`);
      }
      if (expected.precision != null && actual.numeric_precision !== expected.precision) {
        problems.push(`${table}.${name} precision is ${actual.numeric_precision}, expected ${expected.precision}`);
      }
      if (expected.scale != null && actual.numeric_scale !== expected.scale) {
        problems.push(`${table}.${name} scale is ${actual.numeric_scale}, expected ${expected.scale}`);
      }
    }
  }
  if (stage < 2) return;
  for (const [table, expectedColumns] of Object.entries(EXPECTED_EXISTING_ADDITIONS)) {
    for (const [name, expected] of Object.entries(expectedColumns)) {
      const actual = snapshot.catalogColumns.find(
        (item) => item.table_name === table && item.column_name === name,
      );
      if (!actual) problems.push(`${table}.${name} is absent`);
      else if (
        actual.data_type !== expected.type
        || (actual.is_nullable === 'YES') !== expected.nullable
        || !defaultMatches(
          actual.column_default,
          expected.default,
          table,
          name,
          actual.serial_sequence,
        )
      ) {
        problems.push(`${table}.${name} does not match the reviewed type/null/default shape`);
      }
    }
  }
}

type ExpectedConstraint = {
  table: string;
  name: string;
  type: 'p' | 'u' | 'f' | 'c';
  target?: string;
  deleteAction?: 'a' | 'r' | 'c' | 'n';
  fragments: string[];
};

const EXPECTED_DOMAIN_CONSTRAINTS: ExpectedConstraint[] = [
  { table: 'replacements', name: 'replacements_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacements', name: 'replacements_order_id_fkey', type: 'f', target: 'orders', deleteAction: 'r', fragments: ['foreign key (order_id)'] },
  { table: 'replacements', name: 'replacements_client_id_fkey', type: 'f', target: 'clients', deleteAction: 'a', fragments: ['foreign key (client_id)'] },
  { table: 'replacements', name: 'replacements_replacement_shipment_id_fkey', type: 'f', target: 'shipments', deleteAction: 'n', fragments: ['foreign key (replacement_shipment_id)'] },
  { table: 'replacements', name: 'replacements_reference_key', type: 'u', fragments: ['unique (reference)'] },
  { table: 'replacements', name: 'replacements_request_idempotency_key_key', type: 'u', fragments: ['unique (request_idempotency_key)'] },
  { table: 'replacements', name: 'replacements_status_check', type: 'c', fragments: ['requested', 'review', 'approved', 'label_created', 'label_failed', 'shipped', 'completed', 'rejected', 'cancelled'] },
  { table: 'replacements', name: 'replacements_admin_override_attribution_check', type: 'c', fragments: ['admin_override = false', 'admin_override_by is not null', 'admin_override_reason is not null'] },

  { table: 'replacement_items', name: 'replacement_items_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacement_items', name: 'replacement_items_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'c', fragments: ['foreign key (replacement_id)'] },
  { table: 'replacement_items', name: 'replacement_items_order_id_fkey', type: 'f', target: 'orders', deleteAction: 'r', fragments: ['foreign key (order_id)'] },
  { table: 'replacement_items', name: 'replacement_items_quantity_positive_check', type: 'c', fragments: ['quantity > 0'] },
  { table: 'replacement_items', name: 'replacement_items_line_unq', type: 'u', fragments: ['unique (replacement_id, order_line_index)'] },

  { table: 'replacement_activity_events', name: 'replacement_activity_events_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacement_activity_events', name: 'replacement_activity_events_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },
  { table: 'replacement_activity_events', name: 'replacement_activity_events_shipment_id_fkey', type: 'f', target: 'shipments', deleteAction: 'n', fragments: ['foreign key (shipment_id)'] },
  { table: 'replacement_activity_events', name: 'replacement_activity_events_idempotency_key_key', type: 'u', fragments: ['unique (idempotency_key)'] },

  { table: 'billing_line_items', name: 'billing_line_items_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },
  { table: 'billing_line_items', name: 'billing_li_replacement_identity_check', type: 'c', fragments: ['replace_postage', 'replace_pick_pack', 'shipment_id is not null', 'replacement_id is not null'] },
  { table: 'billing_credit_notes', name: 'billing_credit_notes_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },

  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_replacement_shipment_id_fkey', type: 'f', target: 'shipments', deleteAction: 'n', fragments: ['foreign key (replacement_shipment_id)'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_state_check', type: 'c', fragments: ['provider_pending', 'purchased', 'failed_pre_purchase', 'reconcile_required', 'voided'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_receipt_check', type: 'c', fragments: ['state <>', 'purchased', 'provider_transaction_id is not null', 'provider_label_id is not null'] },

  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_replacement_item_id_fkey', type: 'f', target: 'replacement_items', deleteAction: 'r', fragments: ['foreign key (replacement_item_id)'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_resolution_check', type: 'c', fragments: ['remapped', 'retained', 'rejected'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_version_positive_check', type: 'c', fragments: ['remap_version > 0'] },

  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_order_id_fkey', type: 'f', target: 'orders', deleteAction: 'r', fragments: ['foreign key (order_id)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_order_lifecycle_event_id_fkey', type: 'f', target: 'order_lifecycle_events', deleteAction: 'r', fragments: ['foreign key (order_lifecycle_event_id)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_webhook_event_id_fkey', type: 'f', target: 'webhook_events', deleteAction: 'r', fragments: ['foreign key (webhook_event_id)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_holds_trigger_kind_check', type: 'c', fragments: ['order_cancelled', 'order_refunded'] },
  { table: 'replacement_original_order_holds', name: 'replacement_holds_evidence_kind_check', type: 'c', fragments: ['order_lifecycle_event', 'webhook_event', 'operator_declaration'] },
  { table: 'replacement_original_order_holds', name: 'replacement_holds_phase_check', type: 'c', fragments: ['pre_dispatch', 'pre_dispatch_label_at_risk', 'post_dispatch', 'terminal_no_action'] },
  { table: 'replacement_original_order_holds', name: 'replacement_holds_disposition_check', type: 'c', fragments: ['cancelled', 'review', 'flagged_post_dispatch', 'no_action'] },
  { table: 'replacement_original_order_holds', name: 'replacement_holds_evidence_pointer_check', type: 'c', fragments: ['evidence_kind', 'order_lifecycle_event_id', 'webhook_event_id', 'declared_by'] },
  { table: 'replacement_original_order_holds', name: 'replacement_holds_resolution_check', type: 'c', fragments: ['resolved_at is null', 'resolved_by is not null', 'resolution is not null'] },

  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_pkey', type: 'p', fragments: ['primary key (id)'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_replacement_id_fkey', type: 'f', target: 'replacements', deleteAction: 'r', fragments: ['foreign key (replacement_id)'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_client_id_fkey', type: 'f', target: 'clients', deleteAction: 'r', fragments: ['foreign key (client_id)'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_type_check', type: 'c', fragments: ['pre_ship_cancellation_cleanup', 'post_ship_financial_reversal'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_status_check', type: 'c', fragments: ['pending', 'processing', 'retry', 'completed', 'review_required'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_reason_check', type: 'c', fragments: ['btrim(reason)', '> 0'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_idempotency_check', type: 'c', fragments: ['btrim(idempotency_key)', '> 0'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_attempts_check', type: 'c', fragments: ['attempts >= 0'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_results_check', type: 'c', fragments: ['editable_removed >= 0', 'credits_settled >= 0', 'credited_amount >= 0'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_completion_check', type: 'c', fragments: ['status =', 'completed_at is not null'] },
];

type ExpectedIndex = { table: string; name: string; fragments: string[] };
const EXPECTED_DOMAIN_INDEXES: ExpectedIndex[] = [
  { table: 'replacements', name: 'replacements_shipment_unq', fragments: ['create unique index', '(replacement_shipment_id)', 'where', 'replacement_shipment_id is not null'] },
  { table: 'replacements', name: 'replacements_order_idx', fragments: ['(order_id)'] },
  { table: 'replacements', name: 'replacements_client_status_idx', fragments: ['(client_id, status)'] },
  { table: 'replacement_items', name: 'replacement_items_replacement_idx', fragments: ['(replacement_id)'] },
  { table: 'replacement_items', name: 'replacement_items_order_idx', fragments: ['(order_id)'] },
  { table: 'replacement_activity_events', name: 'replacement_activity_events_replacement_idx', fragments: ['(replacement_id, event_at)'] },
  { table: 'billing_line_items', name: 'billing_li_replacement_line_unq', fragments: ['create unique index', '(replacement_id, line_type)', 'replacement_id is not null', 'replace_postage', 'replace_pick_pack'] },
  { table: 'billing_credit_notes', name: 'billing_credit_notes_replacement_idx', fragments: ['(finalization_id, replacement_id, created_at)', 'replacement_id is not null'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_key_unq', fragments: ['create unique index', '(provider_idempotency_key)'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_active_unq', fragments: ['create unique index', '(replacement_id)', 'provider_pending', 'reconcile_required'] },
  { table: 'replacement_label_purchase_intents', name: 'replacement_label_purchase_intents_replacement_idx', fragments: ['(replacement_id, created_at)'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_idempotency_unq', fragments: ['create unique index', '(idempotency_key)'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_item_version_unq', fragments: ['create unique index', '(replacement_item_id, remap_version)'] },
  { table: 'replacement_item_remaps', name: 'replacement_item_remaps_replacement_idx', fragments: ['(replacement_id, created_at)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_idempotency_unq', fragments: ['create unique index', '(idempotency_key)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_open_unq', fragments: ['create unique index', '(replacement_id)', 'resolved_at is null'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_order_idx', fragments: ['(order_id, created_at)'] },
  { table: 'replacement_original_order_holds', name: 'replacement_original_order_holds_open_queue_idx', fragments: ['(created_at desc)', 'resolved_at is null'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_idempotency_unq', fragments: ['create unique index', '(idempotency_key)'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_replacement_idx', fragments: ['(replacement_id, created_at)'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_client_idx', fragments: ['(client_id, created_at)'] },
  { table: 'replacement_financial_actions', name: 'replacement_financial_actions_due_idx', fragments: ['(next_run_at, id)', 'pending', 'processing', 'retry'] },
];

function normalizedDefinition(value: string): string {
  return value.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function literalSet(value: string): string[] {
  return [...value.matchAll(/'((?:''|[^'])*)'/g)]
    .map((match) => match[1]!.replace(/''/g, "'"))
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort();
}

const EXPECTED_CHECK_LITERALS: Record<string, string[]> = {
  replacements_status_check: ['requested', 'review', 'approved', 'label_created', 'label_failed', 'shipped', 'completed', 'rejected', 'cancelled'],
  replacement_label_purchase_intents_state_check: ['provider_pending', 'purchased', 'failed_pre_purchase', 'reconcile_required', 'voided'],
  replacement_label_purchase_intents_receipt_check: ['purchased'],
  replacement_item_remaps_resolution_check: ['remapped', 'retained', 'rejected'],
  replacement_holds_trigger_kind_check: ['order_cancelled', 'order_refunded'],
  replacement_holds_evidence_kind_check: ['order_lifecycle_event', 'webhook_event', 'operator_declaration'],
  replacement_holds_phase_check: ['pre_dispatch', 'pre_dispatch_label_at_risk', 'post_dispatch', 'terminal_no_action'],
  replacement_holds_disposition_check: ['cancelled', 'review', 'flagged_post_dispatch', 'no_action'],
  replacement_holds_evidence_pointer_check: ['order_lifecycle_event', 'webhook_event', 'operator_declaration'],
  replacement_financial_actions_type_check: ['pre_ship_cancellation_cleanup', 'post_ship_financial_reversal'],
  replacement_financial_actions_status_check: ['pending', 'processing', 'retry', 'completed', 'review_required'],
  replacement_financial_actions_completion_check: ['completed'],
};

type ExpectedConstraintKeyShape = { local: string[]; referenced?: string[] };
const EXPECTED_CONSTRAINT_KEY_SHAPES: Record<string, ExpectedConstraintKeyShape> = {
  replacements_pkey: { local: ['id'] },
  replacements_order_id_fkey: { local: ['order_id'], referenced: ['id'] },
  replacements_client_id_fkey: { local: ['client_id'], referenced: ['id'] },
  replacements_replacement_shipment_id_fkey: {
    local: ['replacement_shipment_id'], referenced: ['id'],
  },
  replacements_reference_key: { local: ['reference'] },
  replacements_request_idempotency_key_key: { local: ['request_idempotency_key'] },
  replacement_items_pkey: { local: ['id'] },
  replacement_items_replacement_id_fkey: { local: ['replacement_id'], referenced: ['id'] },
  replacement_items_order_id_fkey: { local: ['order_id'], referenced: ['id'] },
  replacement_items_line_unq: { local: ['replacement_id', 'order_line_index'] },
  replacement_activity_events_pkey: { local: ['id'] },
  replacement_activity_events_replacement_id_fkey: {
    local: ['replacement_id'], referenced: ['id'],
  },
  replacement_activity_events_shipment_id_fkey: { local: ['shipment_id'], referenced: ['id'] },
  replacement_activity_events_idempotency_key_key: { local: ['idempotency_key'] },
  billing_line_items_replacement_id_fkey: { local: ['replacement_id'], referenced: ['id'] },
  billing_credit_notes_replacement_id_fkey: { local: ['replacement_id'], referenced: ['id'] },
  replacement_label_purchase_intents_pkey: { local: ['id'] },
  replacement_label_purchase_intents_replacement_id_fkey: {
    local: ['replacement_id'], referenced: ['id'],
  },
  replacement_label_purchase_intents_replacement_shipment_id_fkey: {
    local: ['replacement_shipment_id'], referenced: ['id'],
  },
  replacement_item_remaps_pkey: { local: ['id'] },
  replacement_item_remaps_replacement_id_fkey: { local: ['replacement_id'], referenced: ['id'] },
  replacement_item_remaps_replacement_item_id_fkey: {
    local: ['replacement_item_id'], referenced: ['id'],
  },
  replacement_original_order_holds_pkey: { local: ['id'] },
  replacement_original_order_holds_replacement_id_fkey: {
    local: ['replacement_id'], referenced: ['id'],
  },
  replacement_original_order_holds_order_id_fkey: { local: ['order_id'], referenced: ['id'] },
  replacement_original_order_holds_order_lifecycle_event_id_fkey: {
    local: ['order_lifecycle_event_id'], referenced: ['id'],
  },
  replacement_original_order_holds_webhook_event_id_fkey: {
    local: ['webhook_event_id'], referenced: ['id'],
  },
  replacement_financial_actions_pkey: { local: ['id'] },
  replacement_financial_actions_replacement_id_fkey: {
    local: ['replacement_id'], referenced: ['id'],
  },
  replacement_financial_actions_client_id_fkey: { local: ['client_id'], referenced: ['id'] },
};

function textAny(column: string, values: readonly string[]): string {
  return `${column} = ANY (ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}])`;
}

/** Exact pg_get_constraintdef(..., true) expressions for every CHECK in 0096-0103. */
const EXPECTED_CHECK_DEFINITIONS: Record<string, string> = {
  replacements_status_check: `CHECK (${textAny('status', [
    'requested', 'review', 'approved', 'label_created', 'label_failed',
    'shipped', 'completed', 'rejected', 'cancelled',
  ])})`,
  replacements_admin_override_attribution_check:
    'CHECK (admin_override = false OR admin_override_by IS NOT NULL AND admin_override_reason IS NOT NULL)',
  replacement_items_quantity_positive_check: 'CHECK (quantity > 0)',
  billing_li_replacement_identity_check:
    "CHECK ((line_type <> ALL (ARRAY['replace_postage'::text, 'replace_pick_pack'::text])) "
      + 'OR shipment_id IS NOT NULL AND replacement_id IS NOT NULL)',
  replacement_label_purchase_intents_state_check: `CHECK (${textAny('state', [
    'provider_pending', 'purchased', 'failed_pre_purchase', 'reconcile_required', 'voided',
  ])})`,
  replacement_label_purchase_intents_receipt_check:
    "CHECK (state <> 'purchased'::text OR provider_transaction_id IS NOT NULL "
      + 'OR provider_label_id IS NOT NULL)',
  replacement_item_remaps_resolution_check: `CHECK (${textAny('resolution', [
    'remapped', 'retained', 'rejected',
  ])})`,
  replacement_item_remaps_version_positive_check: 'CHECK (remap_version > 0)',
  replacement_holds_trigger_kind_check: `CHECK (${textAny('trigger_kind', [
    'order_cancelled', 'order_refunded',
  ])})`,
  replacement_holds_evidence_kind_check: `CHECK (${textAny('evidence_kind', [
    'order_lifecycle_event', 'webhook_event', 'operator_declaration',
  ])})`,
  replacement_holds_phase_check: `CHECK (${textAny('phase', [
    'pre_dispatch', 'pre_dispatch_label_at_risk', 'post_dispatch', 'terminal_no_action',
  ])})`,
  replacement_holds_disposition_check: `CHECK (${textAny('disposition', [
    'cancelled', 'review', 'flagged_post_dispatch', 'no_action',
  ])})`,
  replacement_holds_evidence_pointer_check:
    "CHECK (evidence_kind = 'order_lifecycle_event'::text "
      + 'AND order_lifecycle_event_id IS NOT NULL AND webhook_event_id IS NULL AND declared_by IS NULL '
      + "OR evidence_kind = 'webhook_event'::text AND webhook_event_id IS NOT NULL "
      + 'AND order_lifecycle_event_id IS NULL AND declared_by IS NULL '
      + "OR evidence_kind = 'operator_declaration'::text AND declared_by IS NOT NULL "
      + 'AND order_lifecycle_event_id IS NULL AND webhook_event_id IS NULL)',
  replacement_holds_resolution_check:
    'CHECK (resolved_at IS NULL OR resolved_by IS NOT NULL AND resolution IS NOT NULL)',
  replacement_financial_actions_type_check: `CHECK (${textAny('action_type', [
    'pre_ship_cancellation_cleanup', 'post_ship_financial_reversal',
  ])})`,
  replacement_financial_actions_status_check: `CHECK (${textAny('status', [
    'pending', 'processing', 'retry', 'completed', 'review_required',
  ])})`,
  replacement_financial_actions_reason_check: 'CHECK (length(btrim(reason)) > 0)',
  replacement_financial_actions_idempotency_check:
    'CHECK (length(btrim(idempotency_key)) > 0)',
  replacement_financial_actions_attempts_check: 'CHECK (attempts >= 0)',
  replacement_financial_actions_results_check:
    'CHECK (editable_removed >= 0 AND credits_settled >= 0 AND credited_amount >= 0::numeric)',
  replacement_financial_actions_completion_check:
    "CHECK ((status = 'completed'::text) = (completed_at IS NOT NULL))",
};

function expectedConstraintDefinition(expected: ExpectedConstraint): string | null {
  if (expected.type === 'c') return EXPECTED_CHECK_DEFINITIONS[expected.name] ?? null;
  const keyShape = EXPECTED_CONSTRAINT_KEY_SHAPES[expected.name];
  if (!keyShape) return null;
  const local = keyShape.local.join(', ');
  if (expected.type === 'p') return `PRIMARY KEY (${local})`;
  if (expected.type === 'u') return `UNIQUE (${local})`;
  const deleteClause: Record<string, string> = {
    a: '', r: ' ON DELETE RESTRICT', c: ' ON DELETE CASCADE', n: ' ON DELETE SET NULL',
  };
  return `FOREIGN KEY (${local}) REFERENCES ${expected.target}(${keyShape.referenced!.join(', ')})`
    + deleteClause[expected.deleteAction ?? 'a'];
}

type ExpectedIndexShape = {
  unique: boolean;
  keys: string[];
  /** pg_index.indoption per key: 0 = ASC NULLS LAST, 3 = DESC NULLS FIRST. */
  keyOptions?: number[];
  predicate: string | null;
};

/** Exact key order/direction and exact pg_get_expr predicate for every non-constraint index. */
const EXPECTED_INDEX_SHAPES: Record<string, ExpectedIndexShape> = {
  replacements_shipment_unq: {
    unique: true, keys: ['replacement_shipment_id'], predicate: 'replacement_shipment_id IS NOT NULL',
  },
  replacements_order_idx: { unique: false, keys: ['order_id'], predicate: null },
  replacements_client_status_idx: { unique: false, keys: ['client_id', 'status'], predicate: null },
  replacement_items_replacement_idx: { unique: false, keys: ['replacement_id'], predicate: null },
  replacement_items_order_idx: { unique: false, keys: ['order_id'], predicate: null },
  replacement_activity_events_replacement_idx: {
    unique: false, keys: ['replacement_id', 'event_at'], predicate: null,
  },
  billing_li_replacement_line_unq: {
    unique: true,
    keys: ['replacement_id', 'line_type'],
    predicate: `replacement_id IS NOT NULL AND (${textAny('line_type', [
      'replace_postage', 'replace_pick_pack',
    ])})`,
  },
  billing_credit_notes_replacement_idx: {
    unique: false,
    keys: ['finalization_id', 'replacement_id', 'created_at'],
    predicate: 'replacement_id IS NOT NULL',
  },
  replacement_label_purchase_intents_key_unq: {
    unique: true, keys: ['provider_idempotency_key'], predicate: null,
  },
  replacement_label_purchase_intents_active_unq: {
    unique: true,
    keys: ['replacement_id'],
    predicate: textAny('state', ['provider_pending', 'reconcile_required']),
  },
  replacement_label_purchase_intents_replacement_idx: {
    unique: false, keys: ['replacement_id', 'created_at'], predicate: null,
  },
  replacement_item_remaps_idempotency_unq: {
    unique: true, keys: ['idempotency_key'], predicate: null,
  },
  replacement_item_remaps_item_version_unq: {
    unique: true, keys: ['replacement_item_id', 'remap_version'], predicate: null,
  },
  replacement_item_remaps_replacement_idx: {
    unique: false, keys: ['replacement_id', 'created_at'], predicate: null,
  },
  replacement_original_order_holds_idempotency_unq: {
    unique: true, keys: ['idempotency_key'], predicate: null,
  },
  replacement_original_order_holds_open_unq: {
    unique: true, keys: ['replacement_id'], predicate: 'resolved_at IS NULL',
  },
  replacement_original_order_holds_order_idx: {
    unique: false, keys: ['order_id', 'created_at'], predicate: null,
  },
  replacement_original_order_holds_open_queue_idx: {
    unique: false, keys: ['created_at'], keyOptions: [3], predicate: 'resolved_at IS NULL',
  },
  replacement_financial_actions_idempotency_unq: {
    unique: true, keys: ['idempotency_key'], predicate: null,
  },
  replacement_financial_actions_replacement_idx: {
    unique: false, keys: ['replacement_id', 'created_at'], predicate: null,
  },
  replacement_financial_actions_client_idx: {
    unique: false, keys: ['client_id', 'created_at'], predicate: null,
  },
  replacement_financial_actions_due_idx: {
    unique: false,
    keys: ['next_run_at', 'id'],
    predicate: textAny('status', ['pending', 'retry', 'processing']),
  },
};

const EXACT_DOMAIN_TABLES = [
  'replacements',
  'replacement_items',
  'replacement_activity_events',
  'replacement_label_purchase_intents',
  'replacement_item_remaps',
  'replacement_original_order_holds',
  'replacement_financial_actions',
] as const;

function constraintStage(expected: ExpectedConstraint): number {
  if (expected.table === 'replacement_financial_actions') return 8;
  if (expected.table === 'replacement_original_order_holds') return 6;
  if (
    expected.table === 'replacement_label_purchase_intents'
    || expected.table === 'replacement_item_remaps'
  ) return 5;
  if (expected.table === 'billing_line_items' || expected.table === 'billing_credit_notes') return 2;
  return 1;
}

function indexStage(expected: ExpectedIndex): number {
  if (expected.table === 'replacement_financial_actions') return 8;
  if (expected.table === 'replacement_original_order_holds') return 6;
  if (
    expected.table === 'replacement_label_purchase_intents'
    || expected.table === 'replacement_item_remaps'
  ) return 5;
  if (expected.table === 'billing_line_items' || expected.table === 'billing_credit_notes') return 2;
  return 1;
}

function validateConstraintsAndIndexes(
  snapshot: ReplacementSchemaState,
  problems: string[],
  stage = 8,
): void {
  for (const expected of EXPECTED_DOMAIN_CONSTRAINTS) {
    if (constraintStage(expected) > stage) continue;
    const effectiveExpected = stage === 2
      && (
        expected.name === 'billing_line_items_replacement_id_fkey'
        || expected.name === 'billing_credit_notes_replacement_id_fkey'
      )
      ? { ...expected, deleteAction: 'n' as const }
      : expected;
    const actual = snapshot.catalogConstraints.find(
      (item) => item.table_name.replace(/^public\./, '') === expected.table && item.conname === expected.name,
    );
    if (!actual || actual.contype !== expected.type || !actual.convalidated) {
      problems.push(`${expected.table}.${expected.name} is absent, wrong-type, or not validated`);
      continue;
    }
    const actualTarget = actual.target?.replace(/^public\./, '') ?? null;
    if (effectiveExpected.target && actualTarget !== effectiveExpected.target) {
      problems.push(`${expected.table}.${expected.name} targets ${actual.target}, expected ${effectiveExpected.target}`);
    }
    if (effectiveExpected.deleteAction && actual.confdeltype !== effectiveExpected.deleteAction) {
      problems.push(`${expected.table}.${expected.name} delete action is ${actual.confdeltype}`);
    }
    const definition = normalizedDefinition(actual.definition);
    const wantedDefinition = expectedConstraintDefinition(effectiveExpected);
    if (!wantedDefinition) {
      problems.push(`${expected.table}.${expected.name} has no reviewed exact definition`);
    } else if (definition !== normalizedDefinition(wantedDefinition)) {
      problems.push(
        `${expected.table}.${expected.name} definition is ${actual.definition}, `
          + `expected ${wantedDefinition}`,
      );
    }
    const keyShape = EXPECTED_CONSTRAINT_KEY_SHAPES[expected.name];
    if (expected.type !== 'c') {
      if (!keyShape) {
        problems.push(`${expected.table}.${expected.name} has no reviewed key-column shape`);
      } else {
        if (JSON.stringify(actual.local_columns) !== JSON.stringify(keyShape.local)) {
          problems.push(`${expected.table}.${expected.name} has the wrong local key columns`);
        }
        const wantedReferenced = keyShape.referenced ?? [];
        if (JSON.stringify(actual.referenced_columns) !== JSON.stringify(wantedReferenced)) {
          problems.push(`${expected.table}.${expected.name} has the wrong referenced key columns`);
        }
      }
    }
    const expectedLiterals = EXPECTED_CHECK_LITERALS[expected.name];
    if (expectedLiterals) {
      const observedLiterals = literalSet(definition);
      const wanted = [...expectedLiterals].sort();
      if (JSON.stringify(observedLiterals) !== JSON.stringify(wanted)) {
        problems.push(`${expected.table}.${expected.name} has the wrong exact value vocabulary`);
      }
    }
  }
  for (const expected of EXPECTED_DOMAIN_INDEXES) {
    if (indexStage(expected) > stage) continue;
    const actual = snapshot.catalogIndexes.find(
      (item) => item.tablename === expected.table && item.indexname === expected.name,
    );
    if (!actual) {
      problems.push(`${expected.name} is absent`);
      continue;
    }
    const shape = EXPECTED_INDEX_SHAPES[expected.name];
    if (!shape) {
      problems.push(`${expected.name} has no reviewed exact index shape`);
      continue;
    }
    if (actual.is_unique !== shape.unique || actual.is_primary) {
      problems.push(`${expected.name} has the wrong unique/primary shape`);
    }
    const actualKeys = actual.key_columns.map(normalizedDefinition);
    const wantedKeys = shape.keys.map(normalizedDefinition);
    if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys)) {
      problems.push(`${expected.name} has the wrong exact key order or direction`);
    }
    const wantedOptions = shape.keyOptions ?? shape.keys.map(() => 0);
    if (JSON.stringify(actual.key_options) !== JSON.stringify(wantedOptions)) {
      problems.push(`${expected.name} has the wrong exact sort/null options`);
    }
    const actualPredicate = actual.predicate == null
      ? null
      : normalizedDefinition(actual.predicate);
    const wantedPredicate = shape.predicate == null
      ? null
      : normalizedDefinition(shape.predicate);
    if (actualPredicate !== wantedPredicate) {
      problems.push(
        `${expected.name} predicate is ${actual.predicate ?? '(none)'}, `
          + `expected ${shape.predicate ?? '(none)'}`,
      );
    }
  }
  // New domain tables are pinned as complete object sets. An extra CHECK or index can be just
  // as harmful as a missing one, so inspect may not certify a superset by accident.
  for (const table of EXACT_DOMAIN_TABLES) {
    if (domainTableStage(table) > stage) continue;
    const expectedConstraintNames = EXPECTED_DOMAIN_CONSTRAINTS
      .filter((item) => item.table === table && constraintStage(item) <= stage)
      .map((item) => item.name)
      .sort();
    const observedConstraintNames = snapshot.catalogConstraints
      .filter((item) => item.table_name.replace(/^public\./, '') === table)
      .map((item) => item.conname)
      .sort();
    if (JSON.stringify(observedConstraintNames) !== JSON.stringify(expectedConstraintNames)) {
      problems.push(`${table} has an unexpected constraint set`);
    }
    const expectedIndexNames = [
      ...EXPECTED_DOMAIN_INDEXES
        .filter((item) => item.table === table && indexStage(item) <= stage)
        .map((item) => item.name),
      ...EXPECTED_DOMAIN_CONSTRAINTS
        .filter((item) => item.table === table
          && constraintStage(item) <= stage
          && (item.type === 'p' || item.type === 'u'))
        .map((item) => item.name),
    ].sort();
    const observedIndexNames = snapshot.catalogIndexes
      .filter((item) => item.tablename === table)
      .map((item) => item.indexname)
      .sort();
    if (JSON.stringify(observedIndexNames) !== JSON.stringify(expectedIndexNames)) {
      problems.push(`${table} has an unexpected index set`);
    }
  }
  for (const table of [
    'replacements',
    'replacement_items',
    'replacement_activity_events',
    'replacement_label_purchase_intents',
    'replacement_item_remaps',
    'replacement_original_order_holds',
    'replacement_financial_actions',
  ]) {
    if (domainTableStage(table) > stage) continue;
    const actual = snapshot.catalogRls.find((item) => item.tablename === table);
    const expectedRls = stage >= 8;
    if (!actual || actual.rls !== expectedRls) {
      problems.push(`${table} RLS is ${actual?.rls ?? 'absent'}, expected ${expectedRls}`);
    }
    const policies = snapshot.catalogPolicies
      .filter((item) => item.tablename === table)
      .map((item) => item.policyname);
    if (policies.length > 0) {
      problems.push(`${table} must have zero RLS policies; found ${policies.join(', ')}`);
    }
  }
}

/** Pure read-back validator shared by read-only inspect and post-apply certification. */
function validateReplacementSchema(snapshot: ReplacementSchemaState, stage = 8): string[] {
  const problems: string[] = [];
  validateColumns(snapshot, problems, stage);
  validateConstraintsAndIndexes(snapshot, problems, stage);
  if (stage >= 1) {
    if (!snapshot.tables.replacements) problems.push('replacements table is absent');
    if (!snapshot.tables.items) problems.push('replacement_items is absent');
    if (!snapshot.tables.events) problems.push('replacement_activity_events is absent');
  }
  if (stage >= 2) {
    for (const table of ['billing_line_items', 'billing_credit_notes']) {
      const col = snapshot.cols.find((candidate) => candidate.table_name === table);
      if (!col) problems.push(`${table}.replacement_id is absent`);
      // Nullable is CORRECT here: NULL means "not yet attributed", which is the documented
      // reading. A NOT NULL column would be wrong, so this asserts the intended shape
      // rather than assuming stricter is better.
      else if (col.is_nullable !== 'YES') problems.push(`${table}.replacement_id must be nullable`);
    }
    if (snapshot.idx !== 1) problems.push('billing_li_replacement_line_unq is absent');
    if (snapshot.chk.n !== 1) problems.push('billing_li_replacement_identity_check is absent');
    else if (snapshot.chk.validated !== true) {
      problems.push('billing_li_replacement_identity_check is NOT VALIDATED');
    }
  }

  if (stage >= 7) {
    if (!snapshot.tables.billing_summary_metrics) {
      problems.push('billing_summary_metrics is absent');
    }
    for (const name of ['replace_postage_total', 'replace_pick_pack_total'] as const) {
      const col = snapshot.metricCols.find((candidate) => candidate.column_name === name);
      if (!col) {
        problems.push(`billing_summary_metrics.${name} is absent`);
        continue;
      }
      if (col.data_type !== 'numeric') problems.push(`${name} type is ${col.data_type}, expected numeric`);
      if (col.numeric_precision !== 14) {
        problems.push(`${name} precision is ${col.numeric_precision}, expected 14`);
      }
      if (col.numeric_scale !== 2) problems.push(`${name} scale is ${col.numeric_scale}, expected 2`);
      if (col.is_nullable !== 'NO') problems.push(`${name} must be NOT NULL`);
      if (!hasZeroDefault(col.column_default)) {
        problems.push(`${name} default is ${col.column_default}, expected 0`);
      }
    }
    const replacementCount = snapshot.metricCols.find(
      (candidate) => candidate.column_name === 'replacement_count',
    );
    if (!replacementCount) {
      problems.push('billing_summary_metrics.replacement_count is absent');
    } else {
      if (replacementCount.data_type !== 'integer') {
        problems.push(`replacement_count type is ${replacementCount.data_type}, expected integer`);
      }
      if (replacementCount.is_nullable !== 'NO') problems.push('replacement_count must be NOT NULL');
      if (!hasZeroDefault(replacementCount.column_default)) {
        problems.push(`replacement_count default is ${replacementCount.column_default}, expected 0`);
      }
    }
  }

  if (stage >= 8 && !snapshot.tables.financial_actions) {
    problems.push('replacement_financial_actions is absent');
  } else if (stage >= 8) {
    const requiredFinancialColumns: Record<string, { type: string; nullable: boolean }> = {
      id: { type: 'bigint', nullable: false },
      replacement_id: { type: 'integer', nullable: false },
      client_id: { type: 'integer', nullable: false },
      action_type: { type: 'text', nullable: false },
      reason: { type: 'text', nullable: false },
      idempotency_key: { type: 'text', nullable: false },
      requested_by_type: { type: 'text', nullable: false },
      requested_by_email: { type: 'text', nullable: true },
      status: { type: 'text', nullable: false },
      attempts: { type: 'integer', nullable: false },
      editable_removed: { type: 'integer', nullable: false },
      credits_settled: { type: 'integer', nullable: false },
      credited_amount: { type: 'numeric', nullable: false },
      last_error: { type: 'text', nullable: true },
      next_run_at: { type: 'timestamp with time zone', nullable: false },
      lease_expires_at: { type: 'timestamp with time zone', nullable: true },
      completed_at: { type: 'timestamp with time zone', nullable: true },
      created_at: { type: 'timestamp with time zone', nullable: false },
      updated_at: { type: 'timestamp with time zone', nullable: false },
    };
    for (const [name, expected] of Object.entries(requiredFinancialColumns)) {
      const column = snapshot.financialColumns.find((candidate) => candidate.column_name === name);
      if (!column) {
        problems.push(`replacement_financial_actions.${name} is absent`);
        continue;
      }
      if (column.data_type !== expected.type) {
        problems.push(`replacement_financial_actions.${name} type is ${column.data_type}, expected ${expected.type}`);
      }
      if ((column.is_nullable === 'YES') !== expected.nullable) {
        problems.push(`replacement_financial_actions.${name} nullability is ${column.is_nullable}`);
      }
    }
    if (snapshot.financialColumns.length !== Object.keys(requiredFinancialColumns).length) {
      problems.push('replacement_financial_actions has an unexpected column set');
    }
    const id = snapshot.financialColumns.find((column) => column.column_name === 'id');
    if (id?.data_type !== 'bigint' || id.is_identity !== 'YES' || id.is_nullable !== 'NO') {
      problems.push('replacement_financial_actions.id must be BIGINT IDENTITY PRIMARY KEY');
    }
    const amount = snapshot.financialColumns.find(
      (column) => column.column_name === 'credited_amount',
    );
    if (
      amount?.data_type !== 'numeric'
      || amount.numeric_precision !== 12
      || amount.numeric_scale !== 2
      || amount.is_nullable !== 'NO'
      || !hasZeroDefault(amount.column_default)
    ) {
      problems.push('replacement_financial_actions.credited_amount must be NUMERIC(12,2) NOT NULL DEFAULT 0');
    }
    for (const name of ['attempts', 'editable_removed', 'credits_settled']) {
      const column = snapshot.financialColumns.find((candidate) => candidate.column_name === name);
      if (!column || !hasZeroDefault(column.column_default)) {
        problems.push(`replacement_financial_actions.${name} must have DEFAULT 0`);
      }
    }
    const statusColumn = snapshot.financialColumns.find((column) => column.column_name === 'status');
    if (!statusColumn?.column_default?.includes("'pending'")) {
      problems.push('replacement_financial_actions.status must have DEFAULT pending');
    }
    for (const name of ['next_run_at', 'created_at', 'updated_at']) {
      const column = snapshot.financialColumns.find((candidate) => candidate.column_name === name);
      if (!column?.column_default?.toLowerCase().includes('now()')) {
        problems.push(`replacement_financial_actions.${name} must have DEFAULT now()`);
      }
    }
    const requiredIndexes: Record<string, string[]> = {
      replacement_financial_actions_idempotency_unq: ['UNIQUE', '(idempotency_key)'],
      replacement_financial_actions_replacement_idx: ['(replacement_id, created_at)'],
      replacement_financial_actions_client_idx: ['(client_id, created_at)'],
      replacement_financial_actions_due_idx: ['(next_run_at, id)', ' WHERE '],
    };
    for (const [name, fragments] of Object.entries(requiredIndexes)) {
      const index = snapshot.financialIndexes.find((candidate) => candidate.indexname === name);
      if (!index) {
        problems.push(`${name} is absent`);
        continue;
      }
      for (const fragment of fragments) {
        if (!index.indexdef.includes(fragment)) problems.push(`${name} is missing ${fragment}`);
      }
    }
    const due = snapshot.financialIndexes.find(
      (index) => index.indexname === 'replacement_financial_actions_due_idx',
    );
    // PostgreSQL may deparse `IN (...)` as either an `ANY (ARRAY[...])` expression or an
    // equivalent boolean predicate depending on server/version. Pin the semantic partial
    // predicate without coupling the operator lane to one pretty-printer spelling.
    const whereAt = due?.indexdef.toUpperCase().indexOf(' WHERE ') ?? -1;
    const duePredicate = whereAt >= 0 ? due!.indexdef.slice(whereAt) : '';
    if (
      !due
      || !duePredicate
      || !['pending', 'retry', 'processing'].every((status) => duePredicate.includes(`'${status}'`))
      || /'completed'|'review_required'/.test(duePredicate)
    ) {
      problems.push('replacement_financial_actions_due_idx has the wrong partial predicate');
    }
    const requiredChecks: Record<string, string[]> = {
      replacement_financial_actions_type_check: [
        'pre_ship_cancellation_cleanup', 'post_ship_financial_reversal',
      ],
      replacement_financial_actions_status_check: [
        'pending', 'processing', 'retry', 'completed', 'review_required',
      ],
      replacement_financial_actions_reason_check: ['btrim(reason)', '> 0'],
      replacement_financial_actions_idempotency_check: ['btrim(idempotency_key)', '> 0'],
      replacement_financial_actions_attempts_check: ['attempts >= 0'],
      replacement_financial_actions_results_check: [
        'editable_removed >= 0', 'credits_settled >= 0', 'credited_amount >=',
      ],
      replacement_financial_actions_completion_check: ['status =', 'completed_at IS NOT NULL'],
    };
    for (const [name, fragments] of Object.entries(requiredChecks)) {
      const constraint = snapshot.financialConstraints.find((item) => item.conname === name);
      if (!constraint || constraint.contype !== 'c' || !constraint.convalidated) {
        problems.push(`${name} is absent or not validated`);
        continue;
      }
      for (const fragment of fragments) {
        if (!constraint.definition.includes(fragment)) problems.push(`${name} is missing ${fragment}`);
      }
    }
    for (const [target, name] of [
      ['replacements', 'replacement_financial_actions_replacement_id_fkey'],
      ['clients', 'replacement_financial_actions_client_id_fkey'],
    ] as const) {
      const constraint = snapshot.financialConstraints.find((item) => item.conname === name);
      if (
        !constraint
        || constraint.contype !== 'f'
        || constraint.target !== target
        || constraint.confdeltype !== 'r'
      ) {
        problems.push(`${name} must target ${target} ON DELETE RESTRICT`);
      }
    }
    if (!snapshot.financialRls) problems.push('replacement_financial_actions RLS is not enabled');
  }

  return problems;
}

type ReviewedPrefix = { stage: number; problems: string[] };

/**
 * Identify only contiguous reviewed migration prefixes.
 *
 * Missing suffixes are installable state, not drift. A partial object inside the next stage,
 * or any later object with an earlier stage missing, is drift and is refused before writes.
 */
function detectReviewedPrefix(snapshot: ReplacementSchemaState): ReviewedPrefix {
  const hasColumn = (table: string, column: string): boolean => snapshot.catalogColumns.some(
    (item) => item.table_name === table && item.column_name === column,
  );
  const constraints = (name: string) => snapshot.catalogConstraints.find(
    (item) => item.conname === name,
  );
  const baseMarkers = [snapshot.tables.replacements, snapshot.tables.items, snapshot.tables.events];
  const billingMarkers = [
    snapshot.cols.some((item) => item.table_name === 'billing_line_items'),
    snapshot.cols.some((item) => item.table_name === 'billing_credit_notes'),
    snapshot.idx === 1,
    snapshot.chk.n === 1,
  ];
  const restrictMarkers = [
    constraints('billing_line_items_replacement_id_fkey')?.confdeltype === 'r',
    constraints('billing_credit_notes_replacement_id_fkey')?.confdeltype === 'r',
    hasColumn('replacement_activity_events', 'detail'),
  ];
  const operationalMarkers = [
    snapshot.catalogColumns.some((item) => item.table_name === 'replacement_label_purchase_intents'),
    snapshot.catalogColumns.some((item) => item.table_name === 'replacement_item_remaps'),
  ];
  const holdMarkers = [
    snapshot.catalogColumns.some((item) => item.table_name === 'replacement_original_order_holds'),
  ];
  const metricNames = new Set(snapshot.metricCols.map((item) => item.column_name));
  const metricMarkers = [
    metricNames.has('replace_postage_total'),
    metricNames.has('replace_pick_pack_total'),
    metricNames.has('replacement_count'),
  ];
  const rlsMarkers = snapshot.catalogRls.map((item) => item.rls);
  const complete = [
    true,
    baseMarkers.every(Boolean),
    billingMarkers.every(Boolean),
    restrictMarkers.every(Boolean),
    hasColumn('replacements', 'request_signature'),
    operationalMarkers.every(Boolean),
    holdMarkers.every(Boolean),
    metricMarkers.every(Boolean),
    snapshot.tables.financial_actions && rlsMarkers.length === 7 && rlsMarkers.every(Boolean),
  ];
  const present = [
    false,
    baseMarkers.some(Boolean),
    billingMarkers.some(Boolean),
    restrictMarkers.some(Boolean),
    hasColumn('replacements', 'request_signature'),
    operationalMarkers.some(Boolean),
    holdMarkers.some(Boolean),
    metricMarkers.some(Boolean),
    snapshot.tables.financial_actions || rlsMarkers.some(Boolean),
  ];

  let stage = 0;
  while (stage < 8 && complete[stage + 1]) stage += 1;
  const highestPresent = present.reduce((highest, value, index) => value ? index : highest, 0);
  const problems: string[] = [];
  if (highestPresent > stage) {
    problems.push(
      `PS-502 schema is not a contiguous reviewed prefix: stage ${highestPresent} has objects `
        + `while exact stage ${stage + 1} is incomplete`,
    );
  }
  problems.push(...validateReplacementSchema(snapshot, stage));
  return { stage, problems };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. This runner is for the operator lane.');

  // Both files are pinned in this module AND supplied by the caller: the constants prove
  // the reviewed content, the arguments prove the archive arrived untampered. Either
  // mismatch stops before a connection is opened.
  for (const { file, expected, argName } of REVIEWED_MIGRATIONS) {
    const actual = normalisedDigest(file);
    if (actual !== expected) {
      throw new Error(`STOP: ${file} does not match the reviewed content.\n  actual:   ${actual}\n  expected: ${expected}`);
    }
    const supplied = argValue(argName);
    if (supplied !== expected) {
      throw new Error(`STOP: --${argName} does not match.\n  supplied: ${supplied}\n  expected: ${expected}`);
    }
    console.log(`ok   ${file} matches the reviewed digest`);
  }

  if (APPLY && argValue('confirm') !== CONFIRM_TOKEN) {
    throw new Error(`STOP: --apply requires --confirm=${CONFIRM_TOKEN}`);
  }

  // prepare: false — production reaches Postgres through Supavisor's TRANSACTION pooler
  // (aws-1-*.pooler.supabase.com:6543), which cannot carry a prepared statement across
  // statements: the 2026-08-21 PS-502 apply died on 'prepared statement "..." does not
  // exist' when the state() probes ran again inside the apply transaction. Every postgres()
  // call in src/ already sets this (db/client.ts:13, routes/health.ts:24,
  // lib/advisory-session-lock.ts:9); the operator lane was the one place that did not.
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    console.log(`     target host: ${new URL(databaseUrl).hostname}`);
    console.log(`     mode       : ${APPLY ? 'APPLY' : 'INSPECT (read-only)'}\n`);

    const state = async (executor: typeof sql = sql): Promise<ReplacementSchemaState> => {
      const [t] = await executor<{
        replacements: boolean;
        items: boolean;
        events: boolean;
        billing_summary_metrics: boolean;
        financial_actions: boolean;
      }[]>`
        select to_regclass('public.replacements') is not null as replacements,
               to_regclass('public.replacement_items') is not null as items,
               to_regclass('public.replacement_activity_events') is not null as events,
               to_regclass('public.billing_summary_metrics') is not null as billing_summary_metrics,
               to_regclass('public.replacement_financial_actions') is not null as financial_actions`;
      const cols = await executor<{ table_name: string; is_nullable: string }[]>`
        select table_name, is_nullable from information_schema.columns
        where table_schema = 'public' and column_name = 'replacement_id'
          and table_name in ('billing_line_items', 'billing_credit_notes')`;
      const metricCols = await executor<BillingSummaryReplacementColumnFacts[]>`
        select column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'billing_summary_metrics'
          and column_name in (
            'replace_postage_total',
            'replace_pick_pack_total',
            'replacement_count'
          )
        order by column_name`;
      const [idx] = await executor<{ n: number }[]>`
        select count(*)::int as n from pg_indexes
        where schemaname = 'public' and indexname = 'billing_li_replacement_line_unq'`;
      const [chk] = await executor<{ n: number; validated: boolean | null }[]>`
        select count(*)::int as n, bool_and(convalidated) as validated from pg_constraint
        where conname = 'billing_li_replacement_identity_check'`;
      const financialColumns = await executor<FinancialActionColumnFacts[]>`
        select column_name, data_type, numeric_precision, numeric_scale,
               is_nullable, is_identity, column_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'replacement_financial_actions'
        order by ordinal_position`;
      const financialIndexes = await executor<FinancialActionIndexFacts[]>`
        select indexname, indexdef
        from pg_indexes
        where schemaname = 'public'
          and tablename = 'replacement_financial_actions'
        order by indexname`;
      const financialConstraints = await executor<FinancialActionConstraintFacts[]>`
        select c.conname, c.contype, c.convalidated, c.confdeltype,
               case when c.confrelid = 0 then null else c.confrelid::regclass::text end as target,
               pg_get_constraintdef(c.oid, true) as definition
        from pg_constraint c
        where c.conrelid = to_regclass('public.replacement_financial_actions')
        order by c.conname`;
      const [financialSecurity] = await executor<{ rls: boolean }[]>`
        select coalesce(relrowsecurity, false) as rls
        from pg_class
        where oid = to_regclass('public.replacement_financial_actions')`;
      const catalogColumns = await executor<CatalogColumnFacts[]>`
        select table_name, column_name, data_type, numeric_precision, numeric_scale,
               is_nullable, is_identity, identity_generation, column_default,
               pg_get_serial_sequence(
                 format('%I.%I', table_schema, table_name), column_name
               ) as serial_sequence
        from information_schema.columns
        where table_schema = 'public'
          and table_name in (
            'replacements', 'replacement_items', 'replacement_activity_events',
            'replacement_label_purchase_intents', 'replacement_item_remaps',
            'replacement_original_order_holds', 'replacement_financial_actions',
            'billing_line_items', 'billing_credit_notes'
          )
        order by table_name, ordinal_position`;
      const catalogIndexes = await executor<CatalogIndexFacts[]>`
        select t.relname as tablename,
               idx.relname as indexname,
               pg_get_indexdef(i.indexrelid, 0, true) as indexdef,
               i.indisunique as is_unique,
               i.indisprimary as is_primary,
               array(
                 select pg_get_indexdef(i.indexrelid, key_position, true)
                 from generate_series(1, i.indnkeyatts) as key_position
                 order by key_position
               ) as key_columns,
               array(
                 select i.indoption[key_position - 1]::int
                 from generate_series(1, i.indnkeyatts) as key_position
                 order by key_position
               ) as key_options,
               pg_get_expr(i.indpred, i.indrelid, true) as predicate
        from pg_index i
        join pg_class idx on idx.oid = i.indexrelid
        join pg_class t on t.oid = i.indrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname in (
            'replacements', 'replacement_items', 'replacement_activity_events',
            'replacement_label_purchase_intents', 'replacement_item_remaps',
            'replacement_original_order_holds', 'replacement_financial_actions',
            'billing_line_items', 'billing_credit_notes'
          )
        order by t.relname, idx.relname`;
      const catalogConstraints = await executor<CatalogConstraintFacts[]>`
        select c.conrelid::regclass::text as table_name,
               c.conname, c.contype, c.convalidated, c.confdeltype,
               case when c.confrelid = 0 then null else c.confrelid::regclass::text end as target,
               pg_get_constraintdef(c.oid, true) as definition,
               coalesce((
                 select array_agg(a.attname order by key_position.ordinality)
                 from unnest(c.conkey) with ordinality as key_position(attnum, ordinality)
                 join pg_attribute a
                   on a.attrelid = c.conrelid and a.attnum = key_position.attnum
               ), array[]::text[]) as local_columns,
               coalesce((
                 select array_agg(a.attname order by key_position.ordinality)
                 from unnest(c.confkey) with ordinality as key_position(attnum, ordinality)
                 join pg_attribute a
                   on a.attrelid = c.confrelid and a.attnum = key_position.attnum
               ), array[]::text[]) as referenced_columns
        from pg_constraint c
        where c.conrelid in (
          to_regclass('public.replacements'),
          to_regclass('public.replacement_items'),
          to_regclass('public.replacement_activity_events'),
          to_regclass('public.replacement_label_purchase_intents'),
          to_regclass('public.replacement_item_remaps'),
          to_regclass('public.replacement_original_order_holds'),
          to_regclass('public.replacement_financial_actions'),
          to_regclass('public.billing_line_items'),
          to_regclass('public.billing_credit_notes')
        )
          and c.contype in ('p', 'u', 'f', 'c')
        order by table_name, c.conname`;
      const catalogRls = await executor<CatalogRlsFacts[]>`
        select c.relname as tablename, c.relrowsecurity as rls
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'replacements', 'replacement_items', 'replacement_activity_events',
            'replacement_label_purchase_intents', 'replacement_item_remaps',
            'replacement_original_order_holds', 'replacement_financial_actions'
          )
        order by c.relname`;
      const catalogPolicies = await executor<CatalogPolicyFacts[]>`
        select c.relname as tablename, p.polname as policyname
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'replacements', 'replacement_items', 'replacement_activity_events',
            'replacement_label_purchase_intents', 'replacement_item_remaps',
            'replacement_original_order_holds', 'replacement_financial_actions'
          )
        order by c.relname, p.polname`;
      return {
        tables: t!,
        cols,
        metricCols,
        idx: idx?.n ?? 0,
        chk: chk ?? { n: 0, validated: null },
        financialColumns,
        financialIndexes,
        financialConstraints,
        financialRls: financialSecurity?.rls ?? false,
        catalogColumns,
        catalogIndexes,
        catalogConstraints,
        catalogRls,
        catalogPolicies,
      };
    };

    const before = await state();
    console.log(`     replacements table      : ${before.tables.replacements}`);
    console.log(`     replacement_items       : ${before.tables.items}`);
    console.log(`     replacement_activity    : ${before.tables.events}`);
    console.log(`     replacement_id columns  : ${before.cols.map((c) => c.table_name).join(', ') || '(none)'}`);
    console.log(`     billing_li_replacement_line_unq : ${before.idx === 1}`);
    console.log(`     billing_li_replacement_identity_check : ${before.chk.n === 1}`);
    console.log(`     billing_summary_metrics : ${before.tables.billing_summary_metrics}`);
    console.log(`     replacement metric cols : ${before.metricCols.map((c) => c.column_name).join(', ') || '(none)'}`);
    console.log(`     replacement financial actions : ${before.tables.financial_actions}`);

    // Existing replacement rows, so an operator can see this is not a live-data change.
    if (before.tables.replacements) {
      const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from replacements`;
      console.log(`     existing replacement rows: ${rows?.n ?? 0}`);
    }

    const beforePrefix = detectReviewedPrefix(before);
    const beforeProblems = beforePrefix.problems;
    const prefixLabel = beforePrefix.stage === 0
      ? '(none)'
      : beforePrefix.stage === 1
        ? '0096'
        : `0096-${String(95 + beforePrefix.stage).padStart(4, '0')}`;
    console.log(`     reviewed migration prefix : ${prefixLabel}`);

    if (!APPLY) {
      const missing = [
        !before.tables.replacements && 'replacements',
        !before.tables.items && 'replacement_items',
        !before.tables.events && 'replacement_activity_events',
        before.cols.length < 2 && 'replacement_id column(s)',
        before.idx !== 1 && 'billing_li_replacement_line_unq',
        before.chk.n !== 1 && 'billing_li_replacement_identity_check',
        before.metricCols.length < 3 && 'billing_summary_metrics replacement column(s)',
        !before.tables.financial_actions && 'replacement_financial_actions',
      ].filter(Boolean);
      if (missing.length) console.log(`\n     WOULD CREATE: ${missing.join(', ')}`);
      if (beforeProblems.length) {
        throw new Error(
          `STOP: INSPECT found schema drift from the reviewed 0096-0103 shape (nothing was written):\n  - ${beforeProblems.join('\n  - ')}`,
        );
      }
      if (beforePrefix.stage < 8) {
        console.log(
          `\n     Exact reviewed prefix found; stages ${String(96 + beforePrefix.stage).padStart(4, '0')}-0103 are not installed.`,
        );
      } else {
        console.log('\n     Nothing to do — every inspected schema fact matches the reviewed shape.');
      }
      console.log(`\nINSPECT complete. Nothing was written.\nTo apply:\n  --apply --confirm=${CONFIRM_TOKEN}`);
      return;
    }

    // IF NOT EXISTS is safe only for a wholly absent lane or an already-exact replay. On a
    // partial/drifted installation it would silently preserve the malformed object, commit
    // later additive statements, and discover the problem only after the transaction. Refuse
    // before the first write; the operator needs an explicit repair plan for that state.
    if (beforeProblems.length > 0) {
      throw new Error(
        `STOP: APPLY target is partially present or drifted; nothing was written:\n  - ${beforeProblems.join('\n  - ')}`,
      );
    }
    if (beforePrefix.stage === 8) {
      console.log('\n     Already exact through 0103 — APPLY replay is a no-op. Nothing was written.');
      return;
    }

    const pendingMigrations = REVIEWED_MIGRATIONS.filter(
      (migration) => migration.stage > beforePrefix.stage,
    );
    const firstPending = pendingMigrations[0]!;
    const lastPending = pendingMigrations[pendingMigrations.length - 1]!;

    // Apply only the exact missing suffix. Replaying an already-installed prefix can run
    // destructive ALTER/validation blocks (notably 0098's FK hardening) and take needless
    // locks on live billing tables. The suffix still lands in one transaction and receives
    // a full 0096-0103 read-back before commit.
    console.log(`\napplying ${firstPending.label} -> ${lastPending.label} in one transaction...`);
    let appliedState: ReplacementSchemaState | null = null;
    await sql.begin(async (tx) => {
      for (const migration of pendingMigrations) {
        await tx.unsafe(readFileSync(migration.file, 'utf8'));
      }

      // Certification belongs INSIDE the transaction. A wrong IF NOT EXISTS shape or DDL
      // drift throws here and rolls back all eight files rather than reporting failure after
      // a partial lane has already committed.
      const transactionalState = await state(tx as unknown as typeof sql);
      const transactionalProblems = validateReplacementSchema(transactionalState);
      if (transactionalProblems.length) {
        throw new Error(
          `STOP: schema did not land as reviewed (transaction rolled back):\n  - ${transactionalProblems.join('\n  - ')}`,
        );
      }
      appliedState = transactionalState;
    });

    if (!appliedState) throw new Error('STOP: transactional schema read-back did not run');

    console.log('ok   three tables, two nullable replacement_id columns, the partial unique index,');
    console.log('ok   and a VALIDATED identity CHECK are all present.');
    console.log('ok   replacement reporting totals are exact-type, NOT NULL, DEFAULT 0 columns.');
    console.log('ok   replacement financial action columns, indexes, FKs, checks, and RLS are present.');
    console.log('\nPS-502 0096-0103 applied and verified.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
