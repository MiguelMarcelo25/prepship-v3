/**
 * PS-412 â€” canonical finalized-billing mutation policy.
 *
 * One invoiced line freezes the entire client/order bill. Order-less billing
 * lines (currently storage) freeze their client + ship-date + line-type group.
 * Routes and workflows ask this owner; the database trigger is the final
 * backstop for scripts, cascades, races, and destructive maintenance paths.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db/client';
import {
  billingCreditNotes,
  billingFinalizations,
  billingLineItems,
} from '../db/schema/billing';
import { billingInvoiceHeaderTotals } from './billing-invoice-totals.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export const BILLING_FINALIZED_LOCK_CODE = 'BILLING_FINALIZED_LOCKED';
export const BILLING_PERIOD_FINALIZED_CODE = 'BILLING_PERIOD_FINALIZED';

export class BillingCloseWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BillingCloseWorkflowError';
  }
}

export class BillingPeriodFinalizedError extends BillingCloseWorkflowError {
  constructor(clientIds: number[] = [], finalizationId?: string) {
    const uniqueClientIds = [...new Set(clientIds)].sort((a, b) => a - b);
    super(
      BILLING_PERIOD_FINALIZED_CODE,
      uniqueClientIds.length === 1
        ? `Billing period for client ${uniqueClientIds[0]} is finalized and cannot be regenerated.`
        : 'One or more billing periods are finalized and cannot be regenerated.',
      409,
      {
        clientIds: uniqueClientIds,
        ...(finalizationId ? { finalizationId } : {}),
      },
    );
    this.name = 'BillingPeriodFinalizedError';
  }
}

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
type BillingPolicyDatabase = Pick<typeof db, 'transaction'>;

export type BillingFinalizationDto = {
  id: string;
  clientId: number;
  periodStart: string;
  periodEnd: string;
  lineCount: number;
  orderCount: number;
  subtotal: string;
  creditedAmount: string;
  balance: string;
  finalizedBy: string;
  finalizedByEmail: string | null;
  finalizedAt: string;
};

export type BillingCreditNoteDto = {
  id: string;
  finalizationId: string;
  clientId: number;
  amount: string;
  signedAmount: string;
  reason: string;
  idempotencyKey: string;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** Migrations 0059 and 0065 own the finalized-billing DB enforcement. */
export async function ensureBillingFinalizationPolicySchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

function assertPeriod(dateFrom: string, dateTo: string): void {
  const from = Date.parse(dateFrom);
  const to = Date.parse(dateTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new BillingCloseWorkflowError(
      'BILLING_FINALIZATION_INVALID_PERIOD',
      'A valid billing period with dateFrom before dateTo is required.',
      400,
    );
  }
}

function decimalCents(value: string): bigint {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new BillingCloseWorkflowError(
      'BILLING_CREDIT_AMOUNT_INVALID',
      'Credit amount must be a positive decimal with at most two places.',
      400,
    );
  }
  const whole = match[1]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return BigInt(whole || '0') * 100n + BigInt(fraction || '0');
}

function normalizeCreditAmount(value: string): string {
  const cents = decimalCents(value);
  if (cents <= 0n) {
    throw new BillingCloseWorkflowError(
      'BILLING_CREDIT_AMOUNT_INVALID',
      'Credit amount must be greater than zero.',
      400,
    );
  }
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function moneyCents(value: string): bigint {
  return decimalCents(value);
}

type FinalizationSummaryRow = {
  id: string;
  clientId: number;
  periodStart: string;
  periodEnd: string;
  lineCount: number;
  orderCount: number;
  subtotal: string;
  creditedAmount: string;
  balance: string;
  finalizedBy: string;
  finalizedByEmail: string | null;
  finalizedAt: string;
};

function finalizationDto(row: FinalizationSummaryRow): BillingFinalizationDto {
  return {
    id: row.id,
    clientId: Number(row.clientId),
    periodStart: new Date(row.periodStart).toISOString(),
    periodEnd: new Date(row.periodEnd).toISOString(),
    lineCount: Number(row.lineCount),
    orderCount: Number(row.orderCount),
    subtotal: Number(row.subtotal).toFixed(2),
    creditedAmount: Number(row.creditedAmount).toFixed(2),
    balance: Number(row.balance).toFixed(2),
    finalizedBy: row.finalizedBy,
    finalizedByEmail: row.finalizedByEmail,
    finalizedAt: new Date(row.finalizedAt).toISOString(),
  };
}

async function billingFinalizationSummary(
  finalizationId: string,
  clientId: number,
  conn: BillingPolicyExecutor,
): Promise<BillingFinalizationDto | null> {
  const rows = resultRows<FinalizationSummaryRow>(await conn.execute(sql`
    select
      ${billingFinalizations.id} as "id",
      ${billingFinalizations.clientId} as "clientId",
      ${billingFinalizations.periodStart}::text as "periodStart",
      ${billingFinalizations.periodEnd}::text as "periodEnd",
      ${billingFinalizations.lineCount} as "lineCount",
      ${billingFinalizations.orderCount} as "orderCount",
      ${billingFinalizations.subtotal}::text as "subtotal",
      coalesce(sum(${billingCreditNotes.amount}), 0)::text as "creditedAmount",
      (${billingFinalizations.subtotal} - coalesce(sum(${billingCreditNotes.amount}), 0))::text as "balance",
      ${billingFinalizations.finalizedBy} as "finalizedBy",
      ${billingFinalizations.finalizedByEmail} as "finalizedByEmail",
      ${billingFinalizations.finalizedAt}::text as "finalizedAt"
    from ${billingFinalizations}
    left join ${billingCreditNotes}
      on ${billingCreditNotes.finalizationId} = ${billingFinalizations.id}
    where ${billingFinalizations.id} = ${finalizationId}
      and ${billingFinalizations.clientId} = ${clientId}
    group by ${billingFinalizations.id}
  `));
  return rows[0] ? finalizationDto(rows[0]) : null;
}

export async function finalizedBillingClientIdsForRange(input: {
  dateFrom: string;
  dateTo: string;
  clientId?: number;
}, conn: BillingPolicyExecutor = db): Promise<Set<number>> {
  assertPeriod(input.dateFrom, input.dateTo);
  const rows = resultRows<{ clientId: number }>(await conn.execute(sql`
    select distinct ${billingFinalizations.clientId} as "clientId"
    from ${billingFinalizations}
    where ${billingFinalizations.periodStart} < ${input.dateTo}::timestamptz
      and ${billingFinalizations.periodEnd} > ${input.dateFrom}::timestamptz
      ${input.clientId !== undefined
        ? sql`and ${billingFinalizations.clientId} = ${input.clientId}`
        : sql``}
  `));
  return new Set(rows.map((row) => Number(row.clientId)));
}

export async function assertBillingPeriodOpen(input: {
  dateFrom: string;
  dateTo: string;
  clientId?: number;
}, conn: BillingPolicyExecutor = db): Promise<void> {
  const finalizedClientIds = await finalizedBillingClientIdsForRange(input, conn);
  if (finalizedClientIds.size > 0) {
    throw new BillingPeriodFinalizedError([...finalizedClientIds]);
  }
}

export async function listBillingFinalizations(input: {
  clientId: number;
  dateFrom?: string;
  dateTo?: string;
}, conn: BillingPolicyExecutor = db): Promise<BillingFinalizationDto[]> {
  if ((input.dateFrom == null) !== (input.dateTo == null)) {
    throw new BillingCloseWorkflowError(
      'BILLING_FINALIZATION_INVALID_PERIOD',
      'dateFrom and dateTo must be provided together.',
      400,
    );
  }
  if (input.dateFrom && input.dateTo) assertPeriod(input.dateFrom, input.dateTo);
  const rows = resultRows<FinalizationSummaryRow>(await conn.execute(sql`
    select
      ${billingFinalizations.id} as "id",
      ${billingFinalizations.clientId} as "clientId",
      ${billingFinalizations.periodStart}::text as "periodStart",
      ${billingFinalizations.periodEnd}::text as "periodEnd",
      ${billingFinalizations.lineCount} as "lineCount",
      ${billingFinalizations.orderCount} as "orderCount",
      ${billingFinalizations.subtotal}::text as "subtotal",
      coalesce(sum(${billingCreditNotes.amount}), 0)::text as "creditedAmount",
      (${billingFinalizations.subtotal} - coalesce(sum(${billingCreditNotes.amount}), 0))::text as "balance",
      ${billingFinalizations.finalizedBy} as "finalizedBy",
      ${billingFinalizations.finalizedByEmail} as "finalizedByEmail",
      ${billingFinalizations.finalizedAt}::text as "finalizedAt"
    from ${billingFinalizations}
    left join ${billingCreditNotes}
      on ${billingCreditNotes.finalizationId} = ${billingFinalizations.id}
    where ${billingFinalizations.clientId} = ${input.clientId}
      ${input.dateFrom && input.dateTo
        ? sql`
            and ${billingFinalizations.periodStart} < ${input.dateTo}::timestamptz
            and ${billingFinalizations.periodEnd} > ${input.dateFrom}::timestamptz
          `
        : sql``}
    group by ${billingFinalizations.id}
    order by ${billingFinalizations.periodStart} desc
  `));
  return rows.map(finalizationDto);
}

export async function finalizeBillingPeriod(input: {
  clientId: number;
  dateFrom: string;
  dateTo: string;
  actorId: string;
  actorEmail?: string | null;
}, conn: BillingPolicyDatabase = db): Promise<{
  finalization: BillingFinalizationDto;
  alreadyFinalized: boolean;
}> {
  assertPeriod(input.dateFrom, input.dateTo);
  await ensureBillingFinalizationPolicySchema();
  try {
    return await conn.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(36421, ${input.clientId})`);
      const existing = resultRows<{ id: string }>(await tx.execute(sql`
        select ${billingFinalizations.id} as "id"
        from ${billingFinalizations}
        where ${billingFinalizations.clientId} = ${input.clientId}
          and ${billingFinalizations.periodStart} = ${input.dateFrom}::timestamptz
          and ${billingFinalizations.periodEnd} = ${input.dateTo}::timestamptz
        limit 1
      `))[0];
      if (existing) {
        const summary = await billingFinalizationSummary(existing.id, input.clientId, tx);
        if (!summary) throw new Error('Existing billing finalization could not be read');
        return { finalization: summary, alreadyFinalized: true };
      }

      const overlap = resultRows<{ id: string }>(await tx.execute(sql`
        select ${billingFinalizations.id} as "id"
        from ${billingFinalizations}
        where ${billingFinalizations.clientId} = ${input.clientId}
          and ${billingFinalizations.periodStart} < ${input.dateTo}::timestamptz
          and ${billingFinalizations.periodEnd} > ${input.dateFrom}::timestamptz
        limit 1
      `))[0];
      if (overlap) throw new BillingPeriodFinalizedError([input.clientId], overlap.id);

      const lines = resultRows<{ id: number; orderId: number | null }>(await tx.execute(sql`
        select
          ${billingLineItems.id} as "id",
          ${billingLineItems.orderId} as "orderId"
        from ${billingLineItems}
        where ${billingLineItems.clientId} = ${input.clientId}
          and ${billingLineItems.shipDate} >= ${input.dateFrom}::timestamptz
          and ${billingLineItems.shipDate} < ${input.dateTo}::timestamptz
        order by ${billingLineItems.id}
        for update
      `));
      if (lines.length === 0) {
        throw new BillingCloseWorkflowError(
          'BILLING_FINALIZATION_EMPTY',
          'Generate billing line items before finalizing this period.',
          409,
        );
      }

      const orderIds = [...new Set(
        lines.map((line) => Number(line.orderId)).filter((id) => Number.isInteger(id) && id > 0),
      )];
      if (orderIds.length > 0) {
        const outside = resultRows<{ orderId: number }>(await tx.execute(sql`
          select distinct ${billingLineItems.orderId} as "orderId"
          from ${billingLineItems}
          where ${billingLineItems.clientId} = ${input.clientId}
            and ${billingLineItems.orderId} in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
            and not (
              ${billingLineItems.shipDate} >= ${input.dateFrom}::timestamptz
              and ${billingLineItems.shipDate} < ${input.dateTo}::timestamptz
            )
        `));
        if (outside.length > 0) {
          throw new BillingCloseWorkflowError(
            'BILLING_FINALIZATION_RANGE_CONFLICT',
            'One or more orders have billing lines outside the requested period; regenerate the period before finalizing.',
            409,
            { orderIds: outside.map((row) => Number(row.orderId)).sort((a, b) => a - b) },
          );
        }
      }

      const totals = await billingInvoiceHeaderTotals(
        input.clientId,
        input.dateFrom,
        input.dateTo,
        tx,
      );
      const lineIds = lines.map((line) => Number(line.id));
      await tx.execute(sql`
        update ${billingLineItems}
        set ${billingLineItems.invoiced} = true
        where ${billingLineItems.id} in (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
          and ${billingLineItems.invoiced} = false
      `);

      const finalizationId = randomUUID();
      await tx.execute(sql`
        insert into ${billingFinalizations} (
          ${billingFinalizations.id},
          ${billingFinalizations.clientId},
          ${billingFinalizations.periodStart},
          ${billingFinalizations.periodEnd},
          ${billingFinalizations.lineCount},
          ${billingFinalizations.orderCount},
          ${billingFinalizations.subtotal},
          ${billingFinalizations.finalizedBy},
          ${billingFinalizations.finalizedByEmail}
        ) values (
          ${finalizationId},
          ${input.clientId},
          ${input.dateFrom}::timestamptz,
          ${input.dateTo}::timestamptz,
          ${lines.length},
          ${orderIds.length},
          ${totals.grandTotal.toFixed(2)},
          ${input.actorId},
          ${input.actorEmail ?? null}
        )
      `);
      const summary = await billingFinalizationSummary(finalizationId, input.clientId, tx);
      if (!summary) throw new Error('Billing finalization could not be read after insert');
      return { finalization: summary, alreadyFinalized: false };
    });
  } catch (error) {
    const closeError = asBillingCloseWorkflowError(error);
    if (closeError) throw closeError;
    if (isBillingFinalizedLockError(error)) rethrowAsBillingFinalizedLock(error);
    throw error;
  }
}

export async function listBillingCreditNotes(input: {
  clientId: number;
  finalizationId: string;
}, conn: BillingPolicyExecutor = db): Promise<BillingCreditNoteDto[]> {
  const rows = resultRows<{
    id: string;
    finalizationId: string;
    clientId: number;
    amount: string;
    reason: string;
    idempotencyKey: string;
    createdBy: string;
    createdByEmail: string | null;
    createdAt: string;
  }>(await conn.execute(sql`
    select
      ${billingCreditNotes.id} as "id",
      ${billingCreditNotes.finalizationId} as "finalizationId",
      ${billingCreditNotes.clientId} as "clientId",
      ${billingCreditNotes.amount}::text as "amount",
      ${billingCreditNotes.reason} as "reason",
      ${billingCreditNotes.idempotencyKey} as "idempotencyKey",
      ${billingCreditNotes.createdBy} as "createdBy",
      ${billingCreditNotes.createdByEmail} as "createdByEmail",
      ${billingCreditNotes.createdAt}::text as "createdAt"
    from ${billingCreditNotes}
    where ${billingCreditNotes.clientId} = ${input.clientId}
      and ${billingCreditNotes.finalizationId} = ${input.finalizationId}
    order by ${billingCreditNotes.createdAt}, ${billingCreditNotes.id}
  `));
  return rows.map((row) => ({
    ...row,
    clientId: Number(row.clientId),
    amount: Number(row.amount).toFixed(2),
    signedAmount: (-Number(row.amount)).toFixed(2),
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

export async function createBillingCreditNote(input: {
  clientId: number;
  finalizationId: string;
  amount: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorEmail?: string | null;
}, conn: BillingPolicyDatabase = db): Promise<{
  creditNote: BillingCreditNoteDto;
  finalization: BillingFinalizationDto;
  alreadyCreated: boolean;
}> {
  const amount = normalizeCreditAmount(input.amount);
  const reason = input.reason.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new BillingCloseWorkflowError(
      'BILLING_CREDIT_REASON_INVALID',
      'Credit reason must be between 3 and 500 characters.',
      400,
    );
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100) {
    throw new BillingCloseWorkflowError(
      'BILLING_CREDIT_IDEMPOTENCY_INVALID',
      'Credit idempotencyKey must be between 8 and 100 characters.',
      400,
    );
  }
  await ensureBillingFinalizationPolicySchema();

  try {
    return await conn.transaction(async (tx) => {
      // Global idempotency keys need their own cross-process admission point:
      // locking only the finalization leaves a race when one key is retried
      // against different finalizations.
      await tx.execute(sql`
        select pg_advisory_xact_lock(36422, hashtext(${idempotencyKey}))
      `);
      const existing = resultRows<{
        id: string;
        finalizationId: string;
        clientId: number;
        amount: string;
        reason: string;
      }>(await tx.execute(sql`
        select
          ${billingCreditNotes.id} as "id",
          ${billingCreditNotes.finalizationId} as "finalizationId",
          ${billingCreditNotes.clientId} as "clientId",
          ${billingCreditNotes.amount}::text as "amount",
          ${billingCreditNotes.reason} as "reason"
        from ${billingCreditNotes}
        where ${billingCreditNotes.idempotencyKey} = ${idempotencyKey}
        limit 1
      `))[0];
      if (existing) {
        if (
          existing.finalizationId !== input.finalizationId ||
          Number(existing.clientId) !== input.clientId ||
          Number(existing.amount).toFixed(2) !== amount ||
          existing.reason !== reason
        ) {
          throw new BillingCloseWorkflowError(
            'BILLING_CREDIT_IDEMPOTENCY_CONFLICT',
            'Credit idempotencyKey was already used for a different request.',
            409,
          );
        }
        const notes = await listBillingCreditNotes(
          { clientId: input.clientId, finalizationId: input.finalizationId },
          tx,
        );
        const summary = await billingFinalizationSummary(input.finalizationId, input.clientId, tx);
        const creditNote = notes.find((note) => note.id === existing.id);
        if (!summary || !creditNote) throw new Error('Existing credit note could not be read');
        return { creditNote, finalization: summary, alreadyCreated: true };
      }

      const locked = resultRows<{ id: string }>(await tx.execute(sql`
        select ${billingFinalizations.id} as "id"
        from ${billingFinalizations}
        where ${billingFinalizations.id} = ${input.finalizationId}
          and ${billingFinalizations.clientId} = ${input.clientId}
        for update
      `))[0];
      if (!locked) {
        throw new BillingCloseWorkflowError(
          'BILLING_FINALIZATION_NOT_FOUND',
          'Billing finalization not found.',
          404,
        );
      }

      const summaryBefore = await billingFinalizationSummary(input.finalizationId, input.clientId, tx);
      if (!summaryBefore) throw new Error('Billing finalization could not be read');
      if (moneyCents(amount) > moneyCents(summaryBefore.balance)) {
        throw new BillingCloseWorkflowError(
          'BILLING_CREDIT_EXCEEDS_BALANCE',
          'Credit amount exceeds the remaining finalized balance.',
          409,
          { balance: summaryBefore.balance },
        );
      }

      const creditId = randomUUID();
      await tx.execute(sql`
        insert into ${billingCreditNotes} (
          ${billingCreditNotes.id},
          ${billingCreditNotes.finalizationId},
          ${billingCreditNotes.clientId},
          ${billingCreditNotes.amount},
          ${billingCreditNotes.reason},
          ${billingCreditNotes.idempotencyKey},
          ${billingCreditNotes.createdBy},
          ${billingCreditNotes.createdByEmail}
        ) values (
          ${creditId},
          ${input.finalizationId},
          ${input.clientId},
          ${amount},
          ${reason},
          ${idempotencyKey},
          ${input.actorId},
          ${input.actorEmail ?? null}
        )
      `);
      const notes = await listBillingCreditNotes(
        { clientId: input.clientId, finalizationId: input.finalizationId },
        tx,
      );
      const creditNote = notes.find((note) => note.id === creditId);
      const summaryAfter = await billingFinalizationSummary(input.finalizationId, input.clientId, tx);
      if (!creditNote || !summaryAfter) throw new Error('Credit note could not be read after insert');
      return { creditNote, finalization: summaryAfter, alreadyCreated: false };
    });
  } catch (error) {
    const closeError = asBillingCloseWorkflowError(error);
    if (closeError) throw closeError;
    throw error;
  }
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

export function asBillingCloseWorkflowError(
  error: unknown,
): BillingCloseWorkflowError | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current)) {
    if (current instanceof BillingCloseWorkflowError) return current;
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(BILLING_PERIOD_FINALIZED_CODE)) {
      return new BillingPeriodFinalizedError();
    }
    if (message.includes('BILLING_CLOSE_IMMUTABLE')) {
      return new BillingCloseWorkflowError(
        'BILLING_CLOSE_IMMUTABLE',
        'Billing close records are append-only.',
        409,
      );
    }
    if (message.includes('BILLING_CREDIT_EXCEEDS_BALANCE')) {
      return new BillingCloseWorkflowError(
        'BILLING_CREDIT_EXCEEDS_BALANCE',
        'Credit amount exceeds the remaining finalized balance.',
        409,
      );
    }
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return null;
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
