/**
 * PS-412 â€” canonical finalized-billing mutation policy.
 *
 * One invoiced line freezes the entire client/order bill. Order-less billing
 * lines (currently storage) freeze their client + ship-date + line-type group.
 * Routes and workflows ask this owner; the database trigger is the final
 * backstop for scripts, cascades, races, and destructive maintenance paths.
 */
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db/client';
import { billingLineItems } from '../db/schema/billing';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

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

/** Migration 0059 owns the finalized-billing DB enforcement. */
export async function ensureBillingFinalizationPolicySchema(): Promise<void> {
  await assertRuntimeSchemaReady();
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
