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
// PS-491: the finalized amount must exclude duplicate order copies, same as the invoice.
import { loadDuplicateOrderDecisions } from './billing-duplicate-order-loader.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';
import { env } from '../lib/env.js';
import {
  assertBillingWeekdayOperationAllowed,
  billingLosAngelesDayForInstant,
  billingLineEffectiveDaySql,
  resolveBillingCalendarDay,
} from './billing-calendar-policy.js';

export const BILLING_FINALIZED_LOCK_CODE = 'BILLING_FINALIZED_LOCKED';
export const BILLING_PERIOD_FINALIZED_CODE = 'BILLING_PERIOD_FINALIZED';
const billingFinalizationEffectiveDay = billingLineEffectiveDaySql(
  billingLineItems.billingEffectiveDate,
  billingLineItems.shipDate,
);

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
  debitedAmount: string;
  signedAdjustmentAmount: string;
  balance: string;
  finalizedBy: string;
  finalizedByEmail: string | null;
  finalizedAt: string;
};

export type BillingAdjustmentKind = 'credit' | 'debit';

export type BillingCreditNoteDto = {
  id: string;
  finalizationId: string;
  clientId: number;
  amount: string;
  signedAmount: string;
  adjustmentKind: BillingAdjustmentKind;
  adjustmentSource: 'manual' | 'regeneration';
  sourceOrderId: number | null;
  postingVersion: 'legacy_credit_v1' | 'current_period_v2';
  effectiveDate: string | null;
  billingPolicyVersion: string | null;
  billingLineItemId: number | null;
  sourceFinalizationId: string;
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
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid money value: ${value}`);
  const whole = match[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = BigInt(whole || '0') * 100n + BigInt(fraction || '0');
  return match[1] === '-' ? -cents : cents;
}

function centsMoney(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const magnitude = cents < 0n ? -cents : cents;
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
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
  debitedAmount: string;
  signedAdjustmentAmount: string;
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
    debitedAmount: Number(row.debitedAmount).toFixed(2),
    signedAdjustmentAmount: Number(row.signedAdjustmentAmount).toFixed(2),
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
      coalesce(sum(${billingCreditNotes.amount}) filter (
        where ${billingCreditNotes.adjustmentKind} = 'credit'
      ), 0)::text as "creditedAmount",
      coalesce(sum(${billingCreditNotes.amount}) filter (
        where ${billingCreditNotes.adjustmentKind} = 'debit'
      ), 0)::text as "debitedAmount",
      coalesce(sum(case
        when ${billingCreditNotes.adjustmentKind} = 'credit' then -${billingCreditNotes.amount}
        else ${billingCreditNotes.amount}
      end), 0)::text as "signedAdjustmentAmount",
      (${billingFinalizations.subtotal} + coalesce(sum(case
        when ${billingCreditNotes.adjustmentKind} = 'credit' then -${billingCreditNotes.amount}
        else ${billingCreditNotes.amount}
      end), 0))::text as "balance",
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
      coalesce(sum(${billingCreditNotes.amount}) filter (
        where ${billingCreditNotes.adjustmentKind} = 'credit'
      ), 0)::text as "creditedAmount",
      coalesce(sum(${billingCreditNotes.amount}) filter (
        where ${billingCreditNotes.adjustmentKind} = 'debit'
      ), 0)::text as "debitedAmount",
      coalesce(sum(case
        when ${billingCreditNotes.adjustmentKind} = 'credit' then -${billingCreditNotes.amount}
        else ${billingCreditNotes.amount}
      end), 0)::text as "signedAdjustmentAmount",
      (${billingFinalizations.subtotal} + coalesce(sum(case
        when ${billingCreditNotes.adjustmentKind} = 'credit' then -${billingCreditNotes.amount}
        else ${billingCreditNotes.amount}
      end), 0))::text as "balance",
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
  // Per user override unlock shipped data on 2026-07-16: PS-434 keeps the
  // shipped-derived billing close boundary weekday-only after the approved
  // cutoff. This changes no order or shipment source data.
  assertBillingWeekdayOperationAllowed({
    effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
  });
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
          and ${billingFinalizationEffectiveDay} >= ${input.dateFrom}::timestamptz
          and ${billingFinalizationEffectiveDay} < ${input.dateTo}::timestamptz
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
              ${billingFinalizationEffectiveDay} >= ${input.dateFrom}::timestamptz
              and ${billingFinalizationEffectiveDay} < ${input.dateTo}::timestamptz
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

      // PS-491: load the duplicate-order decisions on the SAME transaction that is about
      // to stamp `invoiced = true`, so the snapshot cannot suppress a copy that another
      // writer invoiced in between. The finalized amount must equal the invoice the
      // customer receives.
      const totals = await billingInvoiceHeaderTotals(
        input.clientId,
        input.dateFrom,
        input.dateTo,
        tx,
        await loadDuplicateOrderDecisions(input.clientId, input.dateFrom, input.dateTo, tx),
      );
      const lineIds = lines.map((line) => Number(line.id));
      await tx.execute(sql`
        update ${billingLineItems}
        set invoiced = true
        where ${billingLineItems.id} in (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
          and ${billingLineItems.invoiced} = false
      `);

      const finalizationId = randomUUID();
      await tx.execute(sql`
        insert into ${billingFinalizations} (
          id,
          client_id,
          period_start,
          period_end,
          line_count,
          order_count,
          subtotal,
          finalized_by,
          finalized_by_email
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

type BillingAdjustmentPosting = {
  id: string;
  clientId: number;
  finalizationId: string;
  adjustmentKind: BillingAdjustmentKind;
  adjustmentSource: 'manual' | 'regeneration';
  sourceOrderId: number | null;
  /**
   * PS-502 correction C. Which replacement this adjustment belongs to.
   *
   * Without it, cancelling ONE of two replacements on an order cannot be attributed: the
   * order reconciler is order-grained, so original + replacement A + replacement B collapse
   * into one number and the credit for A alone has nowhere to point. A deterministic
   * idempotency key is not a substitute — parsing identity out of `reason` is the mistake
   * PS-488 rejected.
   */
  replacementId: number | null;
  amount: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorEmail: string | null;
  activityDate: Date;
  effectiveDate: Date;
  billingPolicyVersion: string;
};

async function appendBillingAdjustmentProjection(
  input: BillingAdjustmentPosting,
  conn: BillingPolicyExecutor,
): Promise<void> {
  const signedAmount = input.adjustmentKind === 'credit' ? `-${input.amount}` : input.amount;
  await conn.execute(sql`
    insert into ${billingCreditNotes} (
      id,
      finalization_id,
      client_id,
      amount,
      adjustment_kind,
      adjustment_source,
      source_order_id,
      replacement_id,
      posting_version,
      effective_date,
      billing_policy_version,
      reason,
      idempotency_key,
      created_by,
      created_by_email
    ) values (
      ${input.id},
      ${input.finalizationId},
      ${input.clientId},
      ${input.amount},
      ${input.adjustmentKind},
      ${input.adjustmentSource},
      ${input.sourceOrderId},
      ${input.replacementId},
      ${'current_period_v2'},
      ${input.effectiveDate.toISOString()}::timestamptz,
      ${input.billingPolicyVersion},
      ${input.reason},
      ${input.idempotencyKey},
      ${input.actorId},
      ${input.actorEmail}
    )
  `);
  await conn.execute(sql`
    insert into ${billingLineItems} (
      client_id,
      order_id,
      order_number,
      shipment_id,
      ship_date,
      billing_effective_date,
      billing_policy_version,
      line_type,
      description,
      qty,
      unit_cost,
      total_cost,
      package_id,
      source_finalization_id,
      billing_adjustment_id,
      invoiced
    ) values (
      ${input.clientId},
      null,
      null,
      null,
      ${input.activityDate.toISOString()}::timestamptz,
      ${input.effectiveDate.toISOString()}::timestamptz,
      ${input.billingPolicyVersion},
      ${'billing_adjustment'},
      ${`${input.adjustmentKind === 'credit' ? 'Credit' : 'Debit'} adjustment ${input.id} for finalized invoice ${input.finalizationId}${input.sourceOrderId == null ? '' : `, order ${input.sourceOrderId}`}: ${input.reason}`},
      ${'1.00'},
      ${signedAmount},
      ${signedAmount},
      null,
      ${input.finalizationId},
      ${input.id},
      false
    )
  `);
  await conn.execute(sql`
    delete from billing_summary_metrics
    where client_id = ${input.clientId}
      and period_from <= ${input.effectiveDate.toISOString()}::date
      and period_to > ${input.effectiveDate.toISOString()}::date
  `);
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
    adjustmentKind: BillingAdjustmentKind;
    adjustmentSource: 'manual' | 'regeneration';
    sourceOrderId: number | null;
    postingVersion: 'legacy_credit_v1' | 'current_period_v2';
    effectiveDate: string | null;
    billingPolicyVersion: string | null;
    billingLineItemId: number | null;
    sourceFinalizationId: string;
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
      ${billingCreditNotes.adjustmentKind} as "adjustmentKind",
      ${billingCreditNotes.adjustmentSource} as "adjustmentSource",
      ${billingCreditNotes.sourceOrderId} as "sourceOrderId",
      ${billingCreditNotes.postingVersion} as "postingVersion",
      ${billingCreditNotes.effectiveDate}::text as "effectiveDate",
      ${billingCreditNotes.billingPolicyVersion} as "billingPolicyVersion",
      ${billingLineItems.id} as "billingLineItemId",
      ${billingCreditNotes.finalizationId} as "sourceFinalizationId",
      ${billingCreditNotes.reason} as "reason",
      ${billingCreditNotes.idempotencyKey} as "idempotencyKey",
      ${billingCreditNotes.createdBy} as "createdBy",
      ${billingCreditNotes.createdByEmail} as "createdByEmail",
      ${billingCreditNotes.createdAt}::text as "createdAt"
    from ${billingCreditNotes}
    left join ${billingLineItems}
      on ${billingLineItems.billingAdjustmentId} = ${billingCreditNotes.id}
    where ${billingCreditNotes.clientId} = ${input.clientId}
      and ${billingCreditNotes.finalizationId} = ${input.finalizationId}
    order by ${billingCreditNotes.createdAt}, ${billingCreditNotes.id}
  `));
  return rows.map((row) => ({
    ...row,
    clientId: Number(row.clientId),
    amount: Number(row.amount).toFixed(2),
    signedAmount: (
      row.adjustmentKind === 'credit' ? -Number(row.amount) : Number(row.amount)
    ).toFixed(2),
    billingLineItemId: row.billingLineItemId == null ? null : Number(row.billingLineItemId),
    sourceOrderId: row.sourceOrderId == null ? null : Number(row.sourceOrderId),
    effectiveDate: row.effectiveDate == null ? null : new Date(row.effectiveDate).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

export async function createBillingCreditNote(input: {
  clientId: number;
  finalizationId: string;
  adjustmentKind?: BillingAdjustmentKind;
  /** PS-502: relational replacement attribution, carried to the projection. */
  replacementId?: number | null;
  amount: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
  actorEmail?: string | null;
  now?: Date;
}, conn: BillingPolicyDatabase = db): Promise<{
  creditNote: BillingCreditNoteDto;
  finalization: BillingFinalizationDto;
  alreadyCreated: boolean;
}> {
  const amount = normalizeCreditAmount(input.amount);
  const adjustmentKind = input.adjustmentKind ?? 'credit';
  if (adjustmentKind !== 'credit' && adjustmentKind !== 'debit') {
    throw new BillingCloseWorkflowError(
      'BILLING_ADJUSTMENT_KIND_INVALID',
      'Adjustment kind must be credit or debit.',
      400,
    );
  }
  const reason = input.reason.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const postingInstant = input.now ?? new Date();
  if (!Number.isFinite(postingInstant.getTime())) {
    throw new BillingCloseWorkflowError(
      'BILLING_ADJUSTMENT_POSTING_TIME_INVALID',
      'A valid backend posting time is required.',
      400,
    );
  }
  const calendar = resolveBillingCalendarDay({
    actualActivityDay: billingLosAngelesDayForInstant(postingInstant),
    effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
  });
  const activityDate = new Date(`${calendar.actualActivityDay}T00:00:00.000Z`);
  const effectiveDate = new Date(`${calendar.billingEffectiveDay}T00:00:00.000Z`);
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
        adjustmentKind: BillingAdjustmentKind;
        reason: string;
      }>(await tx.execute(sql`
        select
          ${billingCreditNotes.id} as "id",
          ${billingCreditNotes.finalizationId} as "finalizationId",
          ${billingCreditNotes.clientId} as "clientId",
          ${billingCreditNotes.amount}::text as "amount",
          ${billingCreditNotes.adjustmentKind} as "adjustmentKind",
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
          existing.adjustmentKind !== adjustmentKind ||
          existing.reason !== reason
        ) {
          throw new BillingCloseWorkflowError(
            'BILLING_CREDIT_IDEMPOTENCY_CONFLICT',
            'Adjustment idempotencyKey was already used for a different request.',
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

      // PS-449 lock order: global idempotency key, current client period, then
      // the original finalization row. This serializes posting against close
      // and regeneration without creating a second money authority.
      await tx.execute(sql`select pg_advisory_xact_lock(36421, ${input.clientId})`);

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
      if (
        adjustmentKind === 'credit' &&
        moneyCents(amount) > moneyCents(summaryBefore.balance)
      ) {
        throw new BillingCloseWorkflowError(
          'BILLING_CREDIT_EXCEEDS_BALANCE',
          'Credit amount exceeds the adjusted finalized balance.',
          409,
          { balance: summaryBefore.balance },
        );
      }

      const creditId = randomUUID();
      await appendBillingAdjustmentProjection({
        id: creditId,
        clientId: input.clientId,
        finalizationId: input.finalizationId,
        adjustmentKind,
        adjustmentSource: 'manual',
        sourceOrderId: null,
        replacementId: input.replacementId ?? null,
        amount,
        reason,
        idempotencyKey,
        actorId: input.actorId,
        actorEmail: input.actorEmail ?? null,
        activityDate,
        effectiveDate,
        billingPolicyVersion: calendar.policyVersion,
      }, tx);
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

export type BillingRegenerationCandidate = {
  orderId: number;
  currentTotal: string;
};

export type BillingRegenerationAdjustmentResult = {
  finalizedOrderCount: number;
  adjustedOrderCount: number;
  untouchedOrderCount: number;
  creditCount: number;
  debitCount: number;
};

export function resolveBillingRegenerationAdjustment(input: {
  currentTotal: string;
  frozenTotal: string;
  existingSignedTotal: string;
}): { adjustmentKind: BillingAdjustmentKind; amount: string; signedAmount: string } | null {
  const deltaCents = moneyCents(input.currentTotal)
    - moneyCents(input.frozenTotal)
    - moneyCents(input.existingSignedTotal);
  if (deltaCents === 0n) return null;
  const adjustmentKind: BillingAdjustmentKind = deltaCents < 0n ? 'credit' : 'debit';
  const amount = centsMoney(deltaCents < 0n ? -deltaCents : deltaCents);
  return {
    adjustmentKind,
    amount,
    signedAmount: centsMoney(deltaCents),
  };
}

/**
 * PS-449 canonical reconciliation boundary. The generator supplies freshly
 * computed per-order totals; this owner locks the client, compares them with
 * immutable finalized lines and prior signed corrections, then appends only
 * the remaining delta in the backend-selected current period.
 */
/**
 * PS-502 correction C — the REPLACEMENT-grained sibling of the order reconciler.
 *
 * A sibling rather than a parameter on the order reconciler, because the two answer
 * different questions. `reconcileFinalizedBillingOrderAdjustments` takes
 * `{ orderId, currentTotal }` and asks "what is this ORDER now worth". With original $20 +
 * replacement A $8 + replacement B $10 on one order, that number cannot express "credit only
 * A", and teaching it to would give one function two grains and two meanings.
 *
 * IDENTITY IS RELATIONAL. Invoiced lines are found by `replacement_id`, prior adjustments by
 * `replacement_id`, and the credit carries `replacement_id`. A deterministic key is not a
 * substitute for a queryable column — parsing identity out of `reason` is exactly the mistake
 * PS-488 rejected.
 *
 * THE DELTA, NOT THE TOTAL. Frozen replacement total, minus what prior replacement-specific
 * adjustments already corrected, gives what is still owed. Re-crediting the whole total on a
 * retry is how a cancellation becomes a refund twice over.
 *
 * Lock order is unchanged: the same client lock the order reconciler takes, then the
 * idempotency-key lock inside the low-level owner.
 */
export async function reconcileFinalizedBillingReplacementAdjustment(input: {
  clientId: number;
  replacementId: number;
  actorId: string;
  actorEmail?: string | null;
  reason: string;
  /** Includes the cancellation event, so two cancellations are two adjustments. */
  idempotencyKey: string;
  now?: Date;
}, conn: BillingPolicyDatabase = db): Promise<{
  finalizationCount: number;
  adjustedCount: number;
  creditedAmount: string;
}> {
  await ensureBillingFinalizationPolicySchema();

  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(36421, ${input.clientId})`);

    // Invoiced lines for THIS replacement, grouped by the finalization that froze them.
    const frozenRows = resultRows<{ finalizationId: string; frozenTotal: string }>(
      await tx.execute(sql`
        select ${billingLineItems.sourceFinalizationId} as "finalizationId",
               coalesce(sum(${billingLineItems.totalCost}), 0)::text as "frozenTotal"
        from ${billingLineItems}
        where ${billingLineItems.replacementId} = ${input.replacementId}
          and ${billingLineItems.invoiced} = true
          and ${billingLineItems.sourceFinalizationId} is not null
        group by ${billingLineItems.sourceFinalizationId}
      `),
    );
    if (frozenRows.length === 0) {
      return { finalizationCount: 0, adjustedCount: 0, creditedAmount: '0.00' };
    }

    let adjustedCount = 0;
    let creditedCents = 0n;

    for (const frozen of frozenRows) {
      // What replacement-specific adjustments have ALREADY corrected, relationally.
      const prior = resultRows<{ signedTotal: string }>(
        await tx.execute(sql`
          select coalesce(sum(case
            when ${billingCreditNotes.adjustmentKind} = 'credit' then -${billingCreditNotes.amount}
            else ${billingCreditNotes.amount}
          end), 0)::text as "signedTotal"
          from ${billingCreditNotes}
          where ${billingCreditNotes.replacementId} = ${input.replacementId}
            and ${billingCreditNotes.finalizationId} = ${frozen.finalizationId}
        `),
      );

      const frozenCents = moneyCents(frozen.frozenTotal);
      const priorCents = moneyCents(prior[0]?.signedTotal ?? '0');
      // Cancelled: the canonical total for this replacement is now zero, so what remains owed
      // is the frozen total less whatever prior adjustments already removed.
      const outstandingCents = frozenCents + priorCents;
      if (outstandingCents <= 0n) continue;

      await createBillingCreditNote({
        clientId: input.clientId,
        finalizationId: frozen.finalizationId,
        adjustmentKind: 'credit',
        replacementId: input.replacementId,
        amount: centsMoney(outstandingCents),
        reason: input.reason,
        idempotencyKey: `${input.idempotencyKey}:finalization:${frozen.finalizationId}`,
        actorId: input.actorId,
        actorEmail: input.actorEmail ?? null,
        now: input.now,
      }, conn);

      adjustedCount += 1;
      creditedCents += outstandingCents;
    }

    return {
      finalizationCount: frozenRows.length,
      adjustedCount,
      creditedAmount: centsMoney(creditedCents),
    };
  });
}

export async function reconcileFinalizedBillingOrderAdjustments(input: {
  clientId: number;
  dateFrom: string;
  dateTo: string;
  candidates: BillingRegenerationCandidate[];
  actorId?: string | null;
  actorEmail?: string | null;
  now?: Date;
}, conn: BillingPolicyDatabase = db, ensureSchema: () => Promise<void> = ensureBillingFinalizationPolicySchema): Promise<BillingRegenerationAdjustmentResult> {
  assertPeriod(input.dateFrom, input.dateTo);
  const candidateTotals = new Map<number, string>();
  for (const candidate of input.candidates) {
    if (!Number.isInteger(candidate.orderId) || candidate.orderId <= 0) continue;
    candidateTotals.set(candidate.orderId, centsMoney(moneyCents(candidate.currentTotal)));
  }
  if (candidateTotals.size === 0) {
    return {
      finalizedOrderCount: 0,
      adjustedOrderCount: 0,
      untouchedOrderCount: 0,
      creditCount: 0,
      debitCount: 0,
    };
  }
  const postingInstant = input.now ?? new Date();
  if (!Number.isFinite(postingInstant.getTime())) {
    throw new BillingCloseWorkflowError(
      'BILLING_ADJUSTMENT_POSTING_TIME_INVALID',
      'A valid backend posting time is required.',
      400,
    );
  }
  const calendar = resolveBillingCalendarDay({
    actualActivityDay: billingLosAngelesDayForInstant(postingInstant),
    effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
  });
  const activityDate = new Date(`${calendar.actualActivityDay}T00:00:00.000Z`);
  const effectiveDate = new Date(`${calendar.billingEffectiveDay}T00:00:00.000Z`);
  const orderIds = [...candidateTotals.keys()].sort((a, b) => a - b);
  await ensureSchema();

  try {
    return await conn.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(36421, ${input.clientId})`);
      const lockedFinalizations = resultRows<{ id: string }>(await tx.execute(sql`
        select ${billingFinalizations.id} as "id"
        from ${billingFinalizations}
        where ${billingFinalizations.clientId} = ${input.clientId}
          and ${billingFinalizations.periodStart} < ${input.dateTo}::timestamptz
          and ${billingFinalizations.periodEnd} > ${input.dateFrom}::timestamptz
        order by ${billingFinalizations.periodStart}
        for update
      `));
      if (lockedFinalizations.length === 0) {
        return {
          finalizedOrderCount: 0,
          adjustedOrderCount: 0,
          untouchedOrderCount: 0,
          creditCount: 0,
          debitCount: 0,
        };
      }

      const frozenRows = resultRows<{
        finalizationId: string;
        orderId: number;
        frozenTotal: string;
        existingSignedTotal: string;
      }>(await tx.execute(sql`
        select
          closed.id as "finalizationId",
          line.order_id as "orderId",
          sum(line.total_cost)::text as "frozenTotal",
          coalesce((
            select sum(case
              when note.adjustment_kind = 'credit' then -note.amount
              else note.amount
            end)
            from billing_credit_notes note
            where note.finalization_id = closed.id
              and note.client_id = closed.client_id
              and note.adjustment_source = 'regeneration'
              and note.source_order_id = line.order_id
          ), 0)::text as "existingSignedTotal"
        from billing_line_items line
        join billing_finalizations closed
          on closed.client_id = line.client_id
          and coalesce(line.billing_effective_date, line.ship_date) >= closed.period_start
          and coalesce(line.billing_effective_date, line.ship_date) < closed.period_end
        where line.client_id = ${input.clientId}
          and line.invoiced = true
          and line.order_id in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
          and closed.period_start < ${input.dateTo}::timestamptz
          and closed.period_end > ${input.dateFrom}::timestamptz
        group by closed.id, closed.client_id, line.order_id
        order by line.order_id
      `));

      let adjustedOrderCount = 0;
      let creditCount = 0;
      let debitCount = 0;
      for (const frozen of frozenRows) {
        const currentTotal = candidateTotals.get(Number(frozen.orderId));
        if (currentTotal == null) continue;
        const decision = resolveBillingRegenerationAdjustment({
          currentTotal,
          frozenTotal: frozen.frozenTotal,
          existingSignedTotal: frozen.existingSignedTotal,
        });
        if (!decision) continue;

        if (decision.adjustmentKind === 'credit') {
          const summary = await billingFinalizationSummary(
            frozen.finalizationId,
            input.clientId,
            tx,
          );
          if (!summary || moneyCents(decision.amount) > moneyCents(summary.balance)) {
            throw new BillingCloseWorkflowError(
              'BILLING_CREDIT_EXCEEDS_BALANCE',
              'Regeneration credit exceeds the adjusted finalized balance.',
              409,
              { finalizationId: frozen.finalizationId, orderId: Number(frozen.orderId) },
            );
          }
        }

        const adjustmentId = randomUUID();
        await appendBillingAdjustmentProjection({
          id: adjustmentId,
          clientId: input.clientId,
          finalizationId: frozen.finalizationId,
          adjustmentKind: decision.adjustmentKind,
          adjustmentSource: 'regeneration',
          sourceOrderId: Number(frozen.orderId),
          // The ORDER reconciler is order-grained by design; a replacement-attributed
          // adjustment comes from its sibling below, never from here.
          replacementId: null,
          amount: decision.amount,
          reason: `Regeneration correction for order ${frozen.orderId}: canonical ${Number(currentTotal).toFixed(2)}, frozen ${Number(frozen.frozenTotal).toFixed(2)}`,
          idempotencyKey: `billing-regen:${adjustmentId}`,
          actorId: input.actorId?.trim() || 'system:billing-regeneration',
          actorEmail: input.actorEmail ?? null,
          activityDate,
          effectiveDate,
          billingPolicyVersion: calendar.policyVersion,
        }, tx);
        adjustedOrderCount += 1;
        if (decision.adjustmentKind === 'credit') creditCount += 1;
        else debitCount += 1;
      }

      return {
        finalizedOrderCount: frozenRows.length,
        adjustedOrderCount,
        untouchedOrderCount: frozenRows.length - adjustedOrderCount,
        creditCount,
        debitCount,
      };
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
    sql`${billingLineItems.billingAdjustmentId} is null`,
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
            and ${billingFinalizationEffectiveDay} >= ${input.dateFrom}::timestamptz
            and ${billingFinalizationEffectiveDay} < ${input.dateTo}::timestamptz
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
  // Per user override unlock shipped data on 2026-07-15: lock every derived
  // billing group and update its dirty guard inside one Postgres statement.
  // This is the set form of billing_line_item_lock_group's migration-owned
  // INSERT ... ON CONFLICT row-lock protocol, extended to change `dirty` only
  // when the latest committed guard is not finalized. Calling that one-row
  // function and then updating the same tuple in one command is forbidden by
  // Postgres. Orders and shipments remain read-only.
  const lockedGroups = resultRows<{ orderId: number; finalized: boolean }>(await conn.execute(sql`
    with target_groups as materialized (
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
    ),
    upserted_groups as materialized (
      insert into billing_finalization_group_locks as locks (group_key, finalized, dirty)
      select target_groups."groupKey", false, ${input.dirty}
      from target_groups
      order by target_groups."groupKey"
      on conflict (group_key) do update
      set
        group_key = excluded.group_key,
        dirty = case
          when locks.finalized then locks.dirty
          else excluded.dirty
        end
      returning locks.group_key as "groupKey", locks.finalized
    )
    select target_groups."orderId", upserted_groups.finalized
    from target_groups
    inner join upserted_groups
      on upserted_groups."groupKey" = target_groups."groupKey"
    order by target_groups."groupKey"
  `));
  const finalizedIds = lockedGroups
    .filter((group) => group.finalized === true)
    .map((group) => Number(group.orderId));
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

  // Per user override unlock shipped data on 2026-07-15: acquire the same
  // migration-owned transaction locks as one ordered set. Finalized detection
  // remains fail-closed before the existing FOR UPDATE row boundary.
  const lockedGroups = resultRows<{ orderId: number; finalized: boolean }>(await conn.execute(sql`
    with target_groups as materialized (
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
    ),
    locked_groups as materialized (
      select
        target_groups."orderId",
        target_groups."groupKey",
        billing_line_item_lock_group(target_groups."groupKey") as finalized
      from target_groups
      order by target_groups."groupKey"
    )
    select locked_groups."orderId", locked_groups.finalized
    from locked_groups
    order by locked_groups."groupKey"
  `));
  const finalizedGuardIds = lockedGroups
    .filter((group) => group.finalized === true)
    .map((group) => Number(group.orderId));
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
