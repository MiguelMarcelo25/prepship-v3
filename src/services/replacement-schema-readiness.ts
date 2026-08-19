import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * PS-502 — can the original-order HOLD workflow run on THIS database?
 *
 * Migrations are not applied by deploy in this repo, so code routinely reaches production
 * before 0096-0101. The ordinary order-cancellation and upstream-reconciliation paths must not
 * crash while that schema is absent, even with every replacement flag off.
 *
 * This is deliberately NOT a general "replacement schema" answer. Each pre-existing caller
 * probes only the relation or column it actually needs: finalized billing uses the canonical
 * billing-column probe, while this module owns the larger dependency set touched by the AC-16
 * hold sweep. An unrelated absent hold table must never suppress valid finalized money.
 *
 * REPLACEMENTS_ENABLED answers whether operators may use the feature. This answers whether the
 * hold query is structurally safe to execute. A fully migrated database must still record holds
 * with the feature surface off, while an unmigrated database must safely skip the fan-out.
 */

/**
 * Only a TRUE answer is remembered.
 *
 * The first version cached both. A process that booted before the migration lane ran cached
 * `false` and kept returning it after the migration landed — so upstream cancellation
 * reconciliation and the finalized billing fold stayed silently disabled on a fully migrated
 * database until someone restarted the app. The comment above it worried about caching a
 * THROWN error as absent and missed the ordinary false.
 *
 * Presence is permanent — migrations here are forward-only, and nothing drops these tables —
 * so remembering `true` is safe. Absence is a transient state that a migration ends, so it is
 * re-checked every time. The cost of that is one indexed catalogue lookup on a database where
 * the feature does not exist yet.
 */
let present: Promise<boolean> | null = null;
let shipmentSyncPresent: Promise<boolean> | null = null;

type SchemaProbeConn = Pick<typeof db, 'execute'>;

/**
 * The sync router has a deliberately smaller dependency boundary than the AC-16 hold sweep.
 *
 * Migration 0100 is enough to route a provider row into the dedicated replacement vessel.
 * Requiring the later hold table or billing column here would turn a healthy 0096+0100
 * database into a dangerous false negative: the row would fall through ordinary shipment
 * insertion simply because an unrelated financial/hold slice had not landed yet.
 */
async function probeShipmentSync(conn: SchemaProbeConn): Promise<boolean> {
  const result = await conn.execute(sql`
    select
      to_regclass('replacements') is not null as has_replacements,
      to_regclass('replacement_label_purchase_intents') is not null as has_label_intents,
      to_regclass('shipments') is not null as has_shipments,
      not exists (
        select 1
        from (values
          ('replacements', 'id'),
          ('replacements', 'client_id'),
          ('replacements', 'order_id'),
          ('replacements', 'reference'),
          ('replacements', 'replacement_shipment_id'),
          ('replacement_label_purchase_intents', 'replacement_id'),
          ('replacement_label_purchase_intents', 'replacement_shipment_id'),
          ('replacement_label_purchase_intents', 'state'),
          ('replacement_label_purchase_intents', 'provider_idempotency_key'),
          ('replacement_label_purchase_intents', 'request_fingerprint'),
          ('replacement_label_purchase_intents', 'purchase_attempt'),
          ('replacement_label_purchase_intents', 'resolved_request'),
          ('replacement_label_purchase_intents', 'provider_shipment_id'),
          ('shipments', 'id'),
          ('shipments', 'order_id'),
          ('shipments', 'client_id'),
          ('shipments', 'order_number'),
          ('shipments', 'source'),
          ('shipments', 'label_shipment_id'),
          ('shipments', 'voided'),
          ('shipments', 'tracking_number'),
          ('shipments', 'label_tracking'),
          ('shipments', 'label_carrier'),
          ('shipments', 'label_service'),
          ('shipments', 'label_ship_date'),
          ('shipments', 'ship_date'),
          ('shipments', 'carrier_code'),
          ('shipments', 'service_code'),
          ('shipments', 'provider_account_id'),
          ('shipments', 'selected_package_id'),
          ('shipments', 'weight_oz'),
          ('shipments', 'dims_l'),
          ('shipments', 'dims_w'),
          ('shipments', 'dims_h'),
          ('shipments', 'updated_at')
        ) as required(table_name, column_name)
        left join information_schema.columns actual
          on actual.table_schema = current_schema()
         and actual.table_name = required.table_name
         and actual.column_name = required.column_name
        where actual.column_name is null
      ) as has_required_columns
  `);
  const rows = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as {
      has_replacements: boolean;
      has_label_intents: boolean;
      has_shipments: boolean;
      has_required_columns: boolean;
    }[];
  const row = rows[0];
  return Boolean(
    row?.has_replacements
      && row.has_label_intents
      && row.has_shipments
      && row.has_required_columns,
  );
}

/**
 * Every PS-502 object the hold sweep can touch, not merely its headline table.
 *
 * A bare Drizzle `select()` from `replacements` emits request_signature (0099); lifecycle
 * annotations write replacement_activity_events.detail (0098); classification reads the
 * replacement-scoped label-intent table (0100) and billing_line_items.replacement_id (0097);
 * and the receipt itself lands in replacement_original_order_holds (0101).
 *
 * `to_regclass` and current_schema() respect the active search_path. An unqualified
 * information_schema lookup could otherwise accept a same-named object in another schema.
 */
async function probe(conn: SchemaProbeConn): Promise<boolean> {
  const result = await conn.execute(sql`
    select
      to_regclass('replacements') is not null as has_replacements,
      to_regclass('replacement_activity_events') is not null as has_activity_events,
      to_regclass('replacement_label_purchase_intents') is not null as has_label_intents,
      to_regclass('replacement_original_order_holds') is not null as has_holds,
      exists (
        select 1 from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'replacements'
           and column_name = 'request_signature'
      ) as has_request_signature,
      exists (
        select 1 from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'replacement_activity_events'
           and column_name = 'detail'
      ) as has_activity_detail,
      exists (
        select 1 from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'billing_line_items'
           and column_name = 'replacement_id'
      ) as has_replacement_id
  `);
  const rows = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as {
      has_replacements: boolean;
      has_activity_events: boolean;
      has_label_intents: boolean;
      has_holds: boolean;
      has_request_signature: boolean;
      has_activity_detail: boolean;
      has_replacement_id: boolean;
    }[];
  const row = rows[0];
  return Boolean(
    row?.has_replacements
      && row.has_activity_events
      && row.has_label_intents
      && row.has_holds
      && row.has_request_signature
      && row.has_activity_detail
      && row.has_replacement_id,
  );
}

/**
 * An explicit connection is queried every time and never cached: the singleton points at
 * production while the harness runs embedded, and one shared memo would let a test answer
 * for the real database.
 */
export function replacementSchemaPresent(conn?: SchemaProbeConn): Promise<boolean> {
  // Per user override unlock shipped data on 2026-08-19: this fail-safe capability gate
  // protects the shipped-original hold path without weakening any lifecycle/status guard.
  if (conn) return probe(conn);
  present ??= probe(db)
    .then((found) => {
      // Forget a NEGATIVE immediately, so the next call re-checks. Remembering it is what
      // kept a migrated database looking unmigrated for the life of the process.
      if (!found) present = null;
      return found;
    })
    .catch((error) => { present = null; throw error; });
  return present;
}

/**
 * Can shipment sync safely inspect and update the dedicated replacement vessel?
 *
 * This answer intentionally excludes the hold and billing migrations. Like the broader
 * probe, only TRUE is memoized: a worker that started before 0100 must notice the migration
 * without a restart. An explicit harness connection is never allowed to seed the singleton.
 */
export function replacementShipmentSyncSchemaPresent(
  conn?: SchemaProbeConn,
): Promise<boolean> {
  if (conn) return probeShipmentSync(conn);
  shipmentSyncPresent ??= probeShipmentSync(db)
    .then((found) => {
      if (!found) shipmentSyncPresent = null;
      return found;
    })
    .catch((error) => { shipmentSyncPresent = null; throw error; });
  return shipmentSyncPresent;
}

/** Test seam: the memo must not leak between harness databases. */
export function resetReplacementSchemaPresence(): void {
  present = null;
  shipmentSyncPresent = null;
}
