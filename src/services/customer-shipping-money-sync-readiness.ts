import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { textArraySql } from '../lib/scope-sql.js';

// PS-509 — runtime readiness for the sync-ingress customer-money contract.
//
// Migration 0103 owns the two durable relations (outcomes and receipt revisions),
// their partial indexes and their mutation-guard triggers. This module only VERIFIES
// they exist — it performs no schema mutation of any kind, matching the repo rule
// that production runtime contains no DDL.
//
// WHY ITS OWN GATE rather than joining REQUIRED_RELATIONS in runtime-schema-readiness:
// that global list fails readiness for EVERY caller (labels, billing, sync) the moment
// a deploy outruns the operator migration lane. PS-509's writer is the only consumer
// of these relations, so the blast radius of a lagging migration must be exactly the
// sync-ingress freeze: the sync run fails loudly and retries next cycle (the upstream
// receipt is durable in ShipStation), while every unrelated path keeps working. The
// relations join the global readiness list as part of the deployment step, once 0103
// is applied in production — the same staging PS-502 used.

const REQUIRED = [
  { kind: 'relation', name: 'customer_shipping_money_sync_outcomes' },
  { kind: 'relation', name: 'customer_shipping_money_receipt_revisions' },
] as const;

// A table present without its mutation guard is a silently weaker guarantee (the
// PS-498 lesson): durable outcomes that can be deleted are not durable. Verified
// by trigger name, exactly like runtime-schema-readiness does.
const REQUIRED_TRIGGERS = [
  'csm_sync_outcomes_mutation_guard',
  'csm_sync_outcomes_no_truncate',
  'csm_receipt_revisions_mutation_guard',
  'csm_receipt_revisions_no_truncate',
] as const;

let readiness: Promise<void> | null = null;

export function resetCustomerShippingMoneySyncReadinessForTests(): void {
  readiness = null;
}

/**
 * Throws (and stays retryable) until migration 0103 is applied. Callers sit at the
 * sync boundaries only: an aborted sync run is the designed failure mode — loud,
 * externally replayable, and incapable of committing a shipment row whose eligibility
 * evaluation was never persisted.
 *
 * Takes the caller's executor so the check runs against the database the caller is
 * actually about to write (fixtures verify their own PGlite instance). Memoized only
 * for the default production client — an explicit executor verifies fresh every time.
 */
export function ensureCustomerShippingMoneySyncSchema(
  exec: Pick<typeof db, 'execute'> = db,
): Promise<void> {
  if (exec !== db) return verify(exec);
  readiness ??= verify(db).catch((error) => {
    readiness = null;
    throw error;
  });
  return readiness;
}

function rowsOf<T>(result: unknown): T[] {
  // Shape-tolerant on purpose: drizzle over postgres-js hands back a bare array; over an
  // embedded PGlite connection it hands back `{ rows }`.
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as T[];
}

async function verify(exec: Pick<typeof db, 'execute'>): Promise<void> {
  const missing: string[] = [];

  const relationNames = REQUIRED.map((entry) => entry.name);
  const relationResult = await exec.execute<{ relation_name: string }>(sql`
    select relation_name
    from unnest(${textArraySql(relationNames)}) as required(relation_name)
    where to_regclass('public.' || relation_name) is not null
  `);
  const present = new Set(
    rowsOf<{ relation_name: string }>(relationResult).map((row) => String(row.relation_name)),
  );
  for (const entry of REQUIRED) {
    if (!present.has(entry.name)) missing.push(`${entry.kind}:${entry.name}`);
  }

  const triggerResult = await exec.execute<{ tgname: string }>(sql`
    select tgname
    from pg_trigger
    where not tgisinternal
      and tgenabled <> 'D'
      and tgname = any(${textArraySql([...REQUIRED_TRIGGERS])})
  `);
  const presentTriggers = new Set(
    rowsOf<{ tgname: string }>(triggerResult).map((row) => String(row.tgname)),
  );
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!presentTriggers.has(trigger)) missing.push(`trigger:${trigger}`);
  }

  if (missing.length > 0) {
    throw new Error(
      'PS-509 sync-ingress customer-money schema is not migration-ready. Apply ' +
        'drizzle/0103_ps509_customer_shipping_money_sync.sql before this deploy ' +
        `serves sync traffic. Missing: ${missing.join(', ')}`,
    );
  }
}
