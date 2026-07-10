/**
 * PS-412 â€” canonical finalized-billing mutation policy.
 *
 * One invoiced line freezes the entire client/order bill. Order-less billing
 * lines (currently storage) freeze their client + ship-date + line-type group.
 * Routes and workflows ask this owner; the database trigger is the final
 * backstop for scripts, cascades, races, and destructive maintenance paths.
 */
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db, sql as pg } from '../db/client';
import { billingLineItems } from '../db/schema/billing';

export const BILLING_FINALIZED_LOCK_CODE = 'BILLING_FINALIZED_LOCKED';

export class BillingFinalizedLockError extends Error {
  readonly status = 409;
  readonly code = BILLING_FINALIZED_LOCK_CODE;
  readonly finalizedOrderIds: number[];

  constructor(orderIds: number[] = []) {
    const uniqueIds = [...new Set(orderIds)].sort((a, b) => a - b);
    super(
      uniqueIds.length === 1
        ? `Billing for order ${uniqueIds[0]} is finalized and cannot be modified.`
        : uniqueIds.length > 1
          ? `${uniqueIds.length} finalized orders were left unchanged.`
          : 'Finalized billing cannot be modified.',
    );
    this.name = 'BillingFinalizedLockError';
    this.finalizedOrderIds = uniqueIds;
  }
}

type BillingPolicyExecutor = Pick<typeof db, 'execute'>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

let schemaEnsured: Promise<void> | null = null;

/** Runtime mirror of drizzle/0059 so an API deploy fails closed during migration lag. */
export async function ensureBillingFinalizationPolicySchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS billing_finalization_group_locks (
        group_key text PRIMARY KEY,
        finalized boolean NOT NULL DEFAULT false,
        dirty boolean NOT NULL DEFAULT false
      )
    `;
    await pg`
      ALTER TABLE billing_finalization_group_locks
      ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT false
    `;
    await pg`ALTER TABLE billing_finalization_group_locks ENABLE ROW LEVEL SECURITY`;
    await pg`
      CREATE OR REPLACE FUNCTION billing_line_item_group_key(
        p_client_id integer,
        p_order_id integer,
        p_ship_date timestamptz,
        p_line_type text
      ) RETURNS text AS $$
        SELECT CASE
          WHEN p_order_id IS NOT NULL THEN
            jsonb_build_array('order', p_client_id, p_order_id)::text
          ELSE
            jsonb_build_array(
              'orderless',
              p_client_id,
              extract(epoch FROM p_ship_date),
              p_line_type
            )::text
        END
      $$ LANGUAGE sql IMMUTABLE
    `;
    await pg`
      CREATE OR REPLACE FUNCTION billing_line_item_lock_group(p_group_key text)
      RETURNS boolean AS $$
      DECLARE
        was_finalized boolean;
      BEGIN
        INSERT INTO billing_finalization_group_locks (group_key, finalized)
        VALUES (p_group_key, false)
        ON CONFLICT (group_key) DO UPDATE
          SET group_key = EXCLUDED.group_key
        RETURNING finalized INTO was_finalized;
        RETURN was_finalized;
      END;
      $$ LANGUAGE plpgsql VOLATILE
    `;
    await pg`
      INSERT INTO billing_finalization_group_locks (group_key, finalized)
      SELECT DISTINCT
        billing_line_item_group_key(client_id, order_id, ship_date, line_type),
        true
      FROM billing_line_items
      WHERE invoiced = true
      ON CONFLICT (group_key) DO UPDATE SET finalized = true
    `;
    await pg`
      CREATE OR REPLACE FUNCTION billing_line_item_group_is_finalized(
        p_id integer,
        p_client_id integer,
        p_order_id integer,
        p_ship_date timestamptz,
        p_line_type text
      ) RETURNS boolean AS $$
        SELECT EXISTS (
          SELECT 1
          FROM billing_line_items finalized
          WHERE finalized.invoiced = true
            AND (p_id IS NULL OR finalized.id <> p_id)
            AND (
              (
                p_order_id IS NOT NULL
                AND finalized.client_id = p_client_id
                AND finalized.order_id = p_order_id
              )
              OR
              (
                p_order_id IS NULL
                AND finalized.order_id IS NULL
                AND finalized.client_id = p_client_id
                AND finalized.line_type = p_line_type
                AND finalized.ship_date IS NOT DISTINCT FROM p_ship_date
              )
            )
        )
      $$ LANGUAGE sql VOLATILE
    `;
    await pg`
      CREATE OR REPLACE FUNCTION billing_line_items_block_finalized_mutation()
      RETURNS trigger AS $$
      DECLARE
        old_group_key text;
        new_group_key text;
        lock_key text;
        lock_was_finalized boolean;
        old_group_was_finalized boolean := false;
        new_group_was_finalized boolean := false;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          old_group_key := billing_line_item_group_key(
            OLD.client_id, OLD.order_id, OLD.ship_date, OLD.line_type
          );
        END IF;
        IF TG_OP <> 'DELETE' THEN
          new_group_key := billing_line_item_group_key(
            NEW.client_id, NEW.order_id, NEW.ship_date, NEW.line_type
          );
        END IF;

        FOR lock_key IN
          SELECT DISTINCT candidate_key
          FROM unnest(ARRAY[old_group_key, new_group_key]) AS keys(candidate_key)
          WHERE candidate_key IS NOT NULL
          ORDER BY candidate_key
        LOOP
          lock_was_finalized := billing_line_item_lock_group(lock_key);
          IF lock_key = old_group_key THEN
            old_group_was_finalized := lock_was_finalized;
          END IF;
          IF lock_key = new_group_key THEN
            new_group_was_finalized := lock_was_finalized;
          END IF;
        END LOOP;

        IF TG_OP = 'DELETE' THEN
          IF old_group_was_finalized OR OLD.invoiced = true OR billing_line_item_group_is_finalized(
            OLD.id, OLD.client_id, OLD.order_id, OLD.ship_date, OLD.line_type
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
          END IF;
          RETURN OLD;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF OLD.invoiced = false AND NEW.invoiced = true THEN
            IF (to_jsonb(NEW) - 'invoiced') IS DISTINCT FROM (to_jsonb(OLD) - 'invoiced') THEN
              RAISE EXCEPTION USING
                ERRCODE = 'P0001',
                MESSAGE = 'BILLING_FINALIZED_LOCKED: finalization cannot change billing values';
            END IF;
            IF EXISTS (
              SELECT 1 FROM billing_finalization_group_locks
              WHERE group_key = new_group_key AND dirty = true
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = 'P0001',
                MESSAGE = 'BILLING_FINALIZED_LOCKED: regenerate pending billing changes before finalization';
            END IF;
            UPDATE billing_finalization_group_locks
            SET finalized = true
            WHERE group_key = new_group_key;
            RETURN NEW;
          END IF;
          IF old_group_was_finalized OR new_group_was_finalized OR
             OLD.invoiced = true OR billing_line_item_group_is_finalized(
            OLD.id, OLD.client_id, OLD.order_id, OLD.ship_date, OLD.line_type
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
          END IF;
          IF billing_line_item_group_is_finalized(
            NEW.id, NEW.client_id, NEW.order_id, NEW.ship_date, NEW.line_type
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
          END IF;
          RETURN NEW;
        END IF;

        IF new_group_was_finalized OR billing_line_item_group_is_finalized(
          NULL, NEW.client_id, NEW.order_id, NEW.ship_date, NEW.line_type
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing cannot be modified';
        END IF;
        IF NEW.invoiced = true THEN
          IF EXISTS (
            SELECT 1 FROM billing_finalization_group_locks
            WHERE group_key = new_group_key AND dirty = true
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001',
              MESSAGE = 'BILLING_FINALIZED_LOCKED: regenerate pending billing changes before finalization';
          END IF;
          UPDATE billing_finalization_group_locks
          SET finalized = true
          WHERE group_key = new_group_key;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await pg`
      CREATE OR REPLACE FUNCTION billing_line_items_block_mixed_finalization_statement()
      RETURNS trigger AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM billing_line_items_old old_row
          INNER JOIN billing_line_items_new new_row USING (id)
          WHERE old_row.invoiced = false AND new_row.invoiced = true
        ) AND EXISTS (
          SELECT 1
          FROM billing_line_items_old old_row
          INNER JOIN billing_line_items_new new_row USING (id)
          WHERE (to_jsonb(new_row) - 'invoiced') IS DISTINCT FROM
                (to_jsonb(old_row) - 'invoiced')
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'BILLING_FINALIZED_LOCKED: finalization statement cannot change billing values';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `;
    await pg`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'billing_line_items_finalized_guard'
            AND tgrelid = 'billing_line_items'::regclass
        ) THEN
          CREATE TRIGGER billing_line_items_finalized_guard
            BEFORE INSERT OR UPDATE OR DELETE ON billing_line_items
            FOR EACH ROW EXECUTE FUNCTION billing_line_items_block_finalized_mutation();
        END IF;
      END;
      $$
    `;
    await pg`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'billing_line_items_mixed_finalization_guard'
            AND tgrelid = 'billing_line_items'::regclass
        ) THEN
          CREATE TRIGGER billing_line_items_mixed_finalization_guard
            AFTER UPDATE ON billing_line_items
            REFERENCING OLD TABLE AS billing_line_items_old
                        NEW TABLE AS billing_line_items_new
            FOR EACH STATEMENT
            EXECUTE FUNCTION billing_line_items_block_mixed_finalization_statement();
        END IF;
      END;
      $$
    `;
    await pg`
      CREATE OR REPLACE FUNCTION billing_line_items_block_finalized_truncate()
      RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM billing_line_items WHERE invoiced = true) THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'BILLING_FINALIZED_LOCKED: finalized billing prevents truncate';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `;
    await pg`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'billing_line_items_finalized_truncate_guard'
            AND tgrelid = 'billing_line_items'::regclass
        ) THEN
          CREATE TRIGGER billing_line_items_finalized_truncate_guard
            BEFORE TRUNCATE ON billing_line_items
            FOR EACH STATEMENT EXECUTE FUNCTION billing_line_items_block_finalized_truncate();
        END IF;
      END;
      $$
    `;
  })().catch((error) => {
    schemaEnsured = null;
    throw error;
  });
  return schemaEnsured;
}

export function billingLineItemIsEditablePredicate(): SQL {
  return and(
    eq(billingLineItems.invoiced, false),
    sql`not exists (
      select 1
      from billing_line_items finalized
      where finalized.invoiced = true
        and (
          (
            ${billingLineItems.orderId} is not null
            and finalized.client_id = ${billingLineItems.clientId}
            and finalized.order_id = ${billingLineItems.orderId}
          )
          or
          (
            ${billingLineItems.orderId} is null
            and finalized.order_id is null
            and finalized.client_id = ${billingLineItems.clientId}
            and finalized.line_type = ${billingLineItems.lineType}
            and finalized.ship_date is not distinct from ${billingLineItems.shipDate}
          )
        )
    )`,
  )!;
}

/** Correlated order-level predicate for workflows that use raw billing SQL. */
export function billingOrderHasNoFinalizedLineSql(
  clientId: SQLWrapper,
  orderId: SQLWrapper,
): SQL {
  return sql`not exists (
    select 1
    from billing_line_items finalized
    where finalized.invoiced = true
      and finalized.client_id = ${clientId}
      and finalized.order_id = ${orderId}
  )`;
}

export async function finalizedBillingOrderIdsForRange(input: {
  dateFrom: string;
  dateTo: string;
  orderIds?: number[];
  clientId?: number;
  scopePredicate?: SQL;
}, conn: BillingPolicyExecutor = db): Promise<Set<number>> {
  const candidateOrderIds = input.orderIds === undefined
    ? undefined
    : [...new Set(input.orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (candidateOrderIds?.length === 0) return new Set();

  const result = await conn.execute<{ orderId: number }>(sql`
    select ${billingLineItems.orderId} as "orderId"
    from ${billingLineItems}
    where ${billingLineItems.invoiced} = true
      and ${billingLineItems.orderId} is not null
      ${candidateOrderIds !== undefined
        ? sql`and ${billingLineItems.orderId} in (${sql.join(candidateOrderIds.map((id) => sql`${id}`), sql`, `)})`
        : sql`
            and ${billingLineItems.shipDate} >= ${input.dateFrom}::timestamptz
            and ${billingLineItems.shipDate} < ${input.dateTo}::timestamptz
          `}
      ${input.clientId !== undefined ? sql`and ${billingLineItems.clientId} = ${input.clientId}` : sql``}
      and ${input.scopePredicate ?? sql`true`}
  `);
  return new Set(
    resultRows<{ orderId: number }>(result)
      .map((row) => Number(row.orderId))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

/**
 * Mark durable sidecar decisions as pending regeneration, or clear that state
 * after the canonical generator has rebuilt the order lines in the same tx.
 */
export async function setBillingOrdersDirty(input: {
  orderIds: number[];
  dirty: boolean;
  clientId?: number;
  scopePredicate?: SQL;
}, conn: BillingPolicyExecutor = db): Promise<void> {
  const orderIds = [...new Set(input.orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!orderIds.length) return;
  const groups = resultRows<{ orderId: number; groupKey: string }>(await conn.execute(sql`
    select distinct
      ${billingLineItems.orderId} as "orderId",
      billing_line_item_group_key(
        ${billingLineItems.clientId},
        ${billingLineItems.orderId},
        ${billingLineItems.shipDate},
        ${billingLineItems.lineType}
      ) as "groupKey"
    from ${billingLineItems}
    where ${billingLineItems.orderId} in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
      ${input.clientId !== undefined ? sql`and ${billingLineItems.clientId} = ${input.clientId}` : sql``}
      and ${input.scopePredicate ?? sql`true`}
    order by "groupKey"
  `));
  const finalizedIds: number[] = [];
  for (const group of groups) {
    const [guard] = resultRows<{ finalized: boolean }>(await conn.execute(sql`
      select billing_line_item_lock_group(${group.groupKey}) as finalized
    `));
    if (guard?.finalized === true) {
      finalizedIds.push(Number(group.orderId));
      continue;
    }
    await conn.execute(sql`
      update billing_finalization_group_locks
      set dirty = ${input.dirty}
      where group_key = ${group.groupKey}
    `);
  }
  if (finalizedIds.length) throw new BillingFinalizedLockError(finalizedIds);
}

/**
 * Lock each target billing group through the same database protocol used by
 * the row trigger, then lock its current rows and reject when either boundary
 * says it is finalized. Call inside the caller's write transaction.
 */
export async function assertBillingOrdersEditable(input: {
  orderIds: number[];
  clientId?: number;
  scopePredicate?: SQL;
}, conn: BillingPolicyExecutor = db): Promise<void> {
  const orderIds = [...new Set(input.orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!orderIds.length) return;

  const groupResult = await conn.execute<{ orderId: number; groupKey: string }>(sql`
    select distinct
      ${billingLineItems.orderId} as "orderId",
      billing_line_item_group_key(
        ${billingLineItems.clientId},
        ${billingLineItems.orderId},
        ${billingLineItems.shipDate},
        ${billingLineItems.lineType}
      ) as "groupKey"
    from ${billingLineItems}
    where ${billingLineItems.orderId} in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
      ${input.clientId !== undefined ? sql`and ${billingLineItems.clientId} = ${input.clientId}` : sql``}
      and ${input.scopePredicate ?? sql`true`}
    order by "groupKey"
  `);
  const finalizedGuardIds: number[] = [];
  for (const group of resultRows<{ orderId: number; groupKey: string }>(groupResult)) {
    const [guard] = resultRows<{ finalized: boolean }>(await conn.execute(sql`
      select billing_line_item_lock_group(${group.groupKey}) as finalized
    `));
    if (guard?.finalized === true) finalizedGuardIds.push(Number(group.orderId));
  }
  if (finalizedGuardIds.length) throw new BillingFinalizedLockError(finalizedGuardIds);

  const result = await conn.execute<{ orderId: number; invoiced: boolean }>(sql`
    select
      ${billingLineItems.orderId} as "orderId",
      ${billingLineItems.invoiced} as "invoiced"
    from ${billingLineItems}
    where ${billingLineItems.orderId} in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
      ${input.clientId !== undefined ? sql`and ${billingLineItems.clientId} = ${input.clientId}` : sql``}
      and ${input.scopePredicate ?? sql`true`}
    order by ${billingLineItems.orderId}, ${billingLineItems.id}
    for update
  `);
  const finalizedIds = resultRows<{ orderId: number; invoiced: boolean }>(result)
    .filter((row) => row.invoiced === true)
    .map((row) => Number(row.orderId));
  if (finalizedIds.length) throw new BillingFinalizedLockError(finalizedIds);
}

function containsBillingFinalizedLock(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current)) {
    if (current instanceof BillingFinalizedLockError) return true;
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(BILLING_FINALIZED_LOCK_CODE)) return true;
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

export function rethrowAsBillingFinalizedLock(error: unknown): never {
  if (error instanceof BillingFinalizedLockError) throw error;
  if (containsBillingFinalizedLock(error)) {
    throw new BillingFinalizedLockError();
  }
  throw error;
}

export function isBillingFinalizedLockError(error: unknown): boolean {
  return containsBillingFinalizedLock(error);
}
