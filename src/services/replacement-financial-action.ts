/**
 * PS-502 AC-13 — durable replacement financial actions.
 *
 * Per user override `unlock shipped data` on 2026-08-19: a shipped replacement keeps its
 * lifecycle history. Financial reversal is a separate, replacement-scoped decision that
 * removes only editable lines and posts only replacement-attributed append-only credits.
 * No provider, label, inventory, package, marketplace, or original-order state is touched.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { billingLineItems } from '../db/schema/billing';
import {
  replacementActivityEvents,
  replacementFinancialActions,
  replacements,
  type ReplacementFinancialActionRow,
  type ReplacementRow,
} from '../db/schema/replacements';
import { cancelReplacementBillingInTransaction } from './replacement-billing-writer';
import { reconcileFinalizedBillingReplacementAdjustment } from './billing-finalization-policy';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;
const ACTION_PROCESSING_LEASE_MINUTES = 15;
const ACTION_BATCH_LIMIT = 25;

export const REPLACEMENT_BILLING_PERMISSION = 'replacements:billing';
export const FINANCIALS_WRITE_PERMISSION = 'financials:write';

export type ReplacementFinancialActionType =
  | 'pre_ship_cancellation_cleanup'
  | 'post_ship_financial_reversal';

export type ReplacementFinancialActionStatus =
  | 'pending'
  | 'processing'
  | 'retry'
  | 'completed'
  | 'review_required';

export type ReplacementFinancialActionErrorCode =
  | 'REPLACEMENT_FINANCIAL_FORBIDDEN'
  | 'REPLACEMENT_FINANCIAL_REASON_REQUIRED'
  | 'REPLACEMENT_FINANCIAL_IDEMPOTENCY_REQUIRED'
  | 'REPLACEMENT_FINANCIAL_SCHEMA_NOT_READY'
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_FINANCIAL_NOT_DISPATCHED'
  | 'REPLACEMENT_FINANCIAL_IDEMPOTENCY_CONFLICT'
  | 'REPLACEMENT_FINANCIAL_STATE_CONFLICT';

export class ReplacementFinancialActionError extends Error {
  constructor(
    readonly code: ReplacementFinancialActionErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 | 503 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementFinancialActionError';
  }
}

export type ReplacementFinancialActor = {
  email: string | null;
  type: string;
  permissions: readonly string[];
};

type FinancialActionDb = Pick<typeof db, 'transaction' | 'execute'>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function requiredText(
  value: string | null | undefined,
  code: 'REPLACEMENT_FINANCIAL_REASON_REQUIRED' | 'REPLACEMENT_FINANCIAL_IDEMPOTENCY_REQUIRED',
  label: string,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new ReplacementFinancialActionError(code, `${label} is required`, 400);
  }
  return normalized;
}

function requireFinancialPermissions(actor: ReplacementFinancialActor): void {
  const missing = [REPLACEMENT_BILLING_PERMISSION, FINANCIALS_WRITE_PERMISSION]
    .filter((permission) => !actor.permissions.includes(permission));
  if (missing.length > 0) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_FORBIDDEN',
      `financial reversal requires ${REPLACEMENT_BILLING_PERMISSION} and ${FINANCIALS_WRITE_PERMISSION}`,
      403,
      { missingPermissions: missing },
    );
  }
}

let defaultSchemaPresence: Promise<boolean> | null = null;

async function probeFinancialActionSchema(conn: Pick<typeof db, 'execute'>): Promise<boolean> {
  const requiredColumns = [
    'replacement_id', 'client_id', 'action_type', 'reason', 'idempotency_key',
    'requested_by_type', 'requested_by_email', 'status', 'attempts', 'editable_removed',
    'credits_settled', 'credited_amount', 'last_error', 'next_run_at', 'lease_expires_at',
    'completed_at', 'created_at', 'updated_at',
  ];
  const rows = resultRows<{ present: boolean }>(await conn.execute(sql`
    select (
      to_regclass('public.replacement_financial_actions') is not null
      and (
        select count(*)::int
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'replacement_financial_actions'
          and column_name in (${sql.join(requiredColumns.map((column) => sql`${column}`), sql`, `)})
      ) = ${requiredColumns.length}
    ) as present
  `));
  return rows[0]?.present === true;
}

/** Positive-only for the singleton; explicit connections are always probed. */
export async function replacementFinancialActionSchemaPresent(
  conn: Pick<typeof db, 'execute'> = db,
): Promise<boolean> {
  if (conn !== db) return probeFinancialActionSchema(conn);
  defaultSchemaPresence ??= probeFinancialActionSchema(conn)
    .then((present) => {
      if (!present) defaultSchemaPresence = null;
      return present;
    })
    .catch((error) => {
      defaultSchemaPresence = null;
      throw error;
    });
  return defaultSchemaPresence;
}

async function assertFinancialActionSchema(conn: Pick<typeof db, 'execute'>): Promise<void> {
  if (await replacementFinancialActionSchemaPresent(conn)) return;
  throw new ReplacementFinancialActionError(
    'REPLACEMENT_FINANCIAL_SCHEMA_NOT_READY',
    'replacement financial actions require migration 0103 before this operation can run',
    503,
  );
}

async function loadAction(
  conn: any,
  actionId: number,
): Promise<ReplacementFinancialActionRow | null> {
  const [row] = await conn
    .select()
    .from(replacementFinancialActions)
    .where(eq(replacementFinancialActions.id, actionId))
    .limit(1);
  return (row as ReplacementFinancialActionRow | undefined) ?? null;
}

function assertReplayMatches(
  existing: ReplacementFinancialActionRow,
  expected: {
    replacementId: number;
    clientId: number;
    actionType: ReplacementFinancialActionType;
    reason: string;
  },
): void {
  if (
    existing.replacementId !== expected.replacementId
    || existing.clientId !== expected.clientId
    || existing.actionType !== expected.actionType
    || existing.reason !== expected.reason
  ) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_IDEMPOTENCY_CONFLICT',
      'the idempotency key already belongs to a different replacement financial decision',
      409,
    );
  }
}

export type RequestReplacementFinancialReversalResult = {
  action: ReplacementFinancialActionRow;
  alreadyRequested: boolean;
};

/** Persist the post-ship decision before any editable line or credit is touched. */
export async function requestReplacementFinancialReversal(
  input: {
    replacementId: number;
    actor: ReplacementFinancialActor;
    reason: string;
    idempotencyKey: string;
  },
  conn: FinancialActionDb = db,
): Promise<RequestReplacementFinancialReversalResult> {
  requireFinancialPermissions(input.actor);
  const reason = requiredText(
    input.reason,
    'REPLACEMENT_FINANCIAL_REASON_REQUIRED',
    'a written financial-reversal reason',
  );
  if (reason.length > 500) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_REASON_REQUIRED',
      'a financial-reversal reason must be 500 characters or fewer so the canonical credit can record it',
      400,
    );
  }
  const callerIdempotencyKey = requiredText(
    input.idempotencyKey,
    'REPLACEMENT_FINANCIAL_IDEMPOTENCY_REQUIRED',
    'a stable idempotency key',
  );
  await assertFinancialActionSchema(conn);

  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);
    const [replacement] = await tx
      .select()
      .from(replacements)
      .where(eq(replacements.id, input.replacementId))
      .limit(1);
    if (!replacement) {
      throw new ReplacementFinancialActionError(
        'REPLACEMENT_NOT_FOUND',
        `replacement ${input.replacementId} does not exist`,
        404,
      );
    }
    if (!Number.isInteger(replacement.clientId) || Number(replacement.clientId) <= 0) {
      throw new ReplacementFinancialActionError(
        'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
        `replacement ${replacement.reference} has no authoritative client identity`,
        409,
      );
    }

    // `shipped_at` is authoritative dispatch evidence. A finalized line is also accepted so
    // a historical pre-dispatch billing anomaly can be corrected without lifecycle-cancelling
    // or fabricating dispatch history.
    const [finalizedLine] = await tx
      .select({ id: billingLineItems.id })
      .from(billingLineItems)
      .where(and(
        eq(billingLineItems.replacementId, replacement.id),
        eq(billingLineItems.invoiced, true),
      ))
      .limit(1);
    if (replacement.shippedAt == null && !finalizedLine) {
      throw new ReplacementFinancialActionError(
        'REPLACEMENT_FINANCIAL_NOT_DISPATCHED',
        `replacement ${replacement.reference} is pre-ship with no finalized money; use lifecycle cancellation instead`,
        409,
      );
    }

    const expected = {
      replacementId: replacement.id,
      clientId: Number(replacement.clientId),
      actionType: 'post_ship_financial_reversal' as const,
      reason,
    };
    // 0103 keeps one global unique index for worker simplicity, but the caller owns only this
    // replacement's namespace. A common raw key can neither reserve another tenant's action
    // nor turn a collision into an identifier-enumeration oracle.
    const idempotencyKey = `replacement:${replacement.id}:financial-action:${callerIdempotencyKey}`;
    const inserted = await tx
      .insert(replacementFinancialActions)
      .values({
        ...expected,
        idempotencyKey,
        requestedByType: input.actor.type,
        requestedByEmail: input.actor.email,
      })
      .onConflictDoNothing({ target: replacementFinancialActions.idempotencyKey })
      .returning();

    if (inserted.length === 0) {
      const [existing] = await tx
        .select()
        .from(replacementFinancialActions)
        .where(eq(replacementFinancialActions.idempotencyKey, idempotencyKey))
        .limit(1);
      if (!existing) {
        throw new ReplacementFinancialActionError(
          'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
          'the financial action conflicted but could not be reread',
        );
      }
      assertReplayMatches(existing as ReplacementFinancialActionRow, expected);
      return { action: existing as ReplacementFinancialActionRow, alreadyRequested: true };
    }

    const action = inserted[0] as ReplacementFinancialActionRow;
    await tx.insert(replacementActivityEvents).values({
      replacementId: replacement.id,
      shipmentId: replacement.replacementShipmentId,
      eventType: 'replacement_financial_reversal_requested',
      fromStatus: replacement.status,
      toStatus: replacement.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${replacement.id}:financial-reversal:request:${action.id}`,
    });
    return { action, alreadyRequested: false };
  });
}

/**
 * Pre-ship lifecycle cancellation calls this inside the SAME transaction as its transition.
 * A process death therefore rolls back both cleanup and status rather than stranding money.
 */
export async function completePreShipCancellationCleanupInTransaction(
  tx: any,
  input: {
    replacement: ReplacementRow;
    actor: ReplacementFinancialActor;
    reason: string;
    idempotencyKey: string;
  },
): Promise<{ actionId: number; editableRemoved: number }> {
  const reason = requiredText(
    input.reason,
    'REPLACEMENT_FINANCIAL_REASON_REQUIRED',
    'a written cancellation reason',
  );
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    'REPLACEMENT_FINANCIAL_IDEMPOTENCY_REQUIRED',
    'a cancellation idempotency key',
  );
  if (input.replacement.shippedAt != null) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
      `replacement ${input.replacement.reference} has dispatch evidence and cannot be lifecycle-cancelled`,
      409,
    );
  }
  if (!Number.isInteger(input.replacement.clientId) || Number(input.replacement.clientId) <= 0) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
      `replacement ${input.replacement.reference} has no authoritative client identity`,
      409,
    );
  }

  // This explicit-connection probe is intentionally uncached. It prevents a flags-on request
  // from touching a partially applied 0103 table while flags-off old-schema boot stays safe.
  await assertFinancialActionSchema(tx);
  const removal = await cancelReplacementBillingInTransaction(tx, {
    replacementId: input.replacement.id,
  });
  if (removal.invoicedRetained > 0) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
      `replacement ${input.replacement.reference} has finalized money and cannot use pre-ship cancellation`,
      409,
      { invoicedRetained: removal.invoicedRetained },
    );
  }

  const expected = {
    replacementId: input.replacement.id,
    clientId: Number(input.replacement.clientId),
    actionType: 'pre_ship_cancellation_cleanup' as const,
    reason,
  };
  const inserted = await tx
    .insert(replacementFinancialActions)
    .values({
      ...expected,
      idempotencyKey,
      requestedByType: input.actor.type,
      requestedByEmail: input.actor.email,
      status: 'completed',
      editableRemoved: removal.editableRemoved,
      completedAt: new Date(),
    })
    .onConflictDoNothing({ target: replacementFinancialActions.idempotencyKey })
    .returning();

  if (inserted.length > 0) {
    return { actionId: Number(inserted[0]!.id), editableRemoved: removal.editableRemoved };
  }
  const [existing] = await tx
    .select()
    .from(replacementFinancialActions)
    .where(eq(replacementFinancialActions.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
      'the cancellation cleanup conflicted but could not be reread',
    );
  }
  assertReplayMatches(existing as ReplacementFinancialActionRow, expected);
  if (existing.status !== 'completed') {
    throw new ReplacementFinancialActionError(
      'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
      'the cancellation cleanup obligation exists but is not complete',
      409,
      { actionId: existing.id, status: existing.status },
    );
  }
  return { actionId: Number(existing.id), editableRemoved: Number(existing.editableRemoved) };
}

type ClaimedAction = {
  id: number;
  replacement_id: number;
  client_id: number;
  action_type: ReplacementFinancialActionType;
  reason: string;
  idempotency_key: string;
  requested_by_type: string;
  requested_by_email: string | null;
  status: ReplacementFinancialActionStatus;
  attempts: number;
  editable_removed: number;
};

async function claimOneAction(
  conn: FinancialActionDb,
  actionId?: number,
): Promise<ClaimedAction | null> {
  return conn.transaction(async (tx) => {
    const rows = resultRows<ClaimedAction>(await tx.execute(sql`
      with candidate as (
        select id
        from replacement_financial_actions
        where ${actionId == null ? sql`true` : sql`id = ${actionId}`}
          and (
            (status in ('pending', 'retry') and next_run_at <= now())
            or (status = 'processing' and lease_expires_at <= now())
          )
        order by next_run_at, id
        for update skip locked
        limit 1
      )
      update replacement_financial_actions action
      set status = 'processing',
          attempts = action.attempts + 1,
          lease_expires_at = now() + (${ACTION_PROCESSING_LEASE_MINUTES} || ' minutes')::interval,
          updated_at = now()
      from candidate
      where action.id = candidate.id
      returning action.id, action.replacement_id, action.client_id, action.action_type,
                action.reason, action.idempotency_key, action.requested_by_type,
                action.requested_by_email, action.status, action.attempts,
                action.editable_removed
    `));
    return rows[0] ?? null;
  });
}

async function completeClaimedAction(
  action: ClaimedAction,
  result: { editableRemoved: number; creditsSettled: number; creditedAmount: string },
  conn: FinancialActionDb,
): Promise<ReplacementFinancialActionRow> {
  return conn.transaction(async (tx) => {
    const updated = await tx
      .update(replacementFinancialActions)
      .set({
        status: 'completed',
        editableRemoved: result.editableRemoved,
        creditsSettled: result.creditsSettled,
        creditedAmount: result.creditedAmount,
        lastError: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacementFinancialActions.id, action.id),
        eq(replacementFinancialActions.status, 'processing'),
        // `attempts` is the lease generation. Once a later worker reclaims an expired lease,
        // an older process may reread the result but may never complete over the new owner.
        eq(replacementFinancialActions.attempts, action.attempts),
      ))
      .returning();
    if (updated.length === 0) {
      const existing = await loadAction(tx, action.id);
      // A newer lease generation owns every further state write. Returning its durable row is
      // the fenced stale-worker outcome; do not flip it to retry/review or overwrite results.
      if (existing) return existing;
      throw new ReplacementFinancialActionError(
        'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
        `financial action ${action.id} disappeared before completion`,
      );
    }

    const [replacement] = await tx
      .select({ status: replacements.status, shipmentId: replacements.replacementShipmentId })
      .from(replacements)
      .where(eq(replacements.id, action.replacement_id))
      .limit(1);
    if (replacement) {
      await tx
        .insert(replacementActivityEvents)
        .values({
          replacementId: action.replacement_id,
          shipmentId: replacement.shipmentId,
          eventType: action.action_type === 'post_ship_financial_reversal'
            ? 'replacement_financial_reversal_completed'
            : 'replacement_cancellation_cleanup_repaired',
          fromStatus: replacement.status,
          toStatus: replacement.status,
          actorType: action.requested_by_type,
          actorEmail: action.requested_by_email,
          detail: action.reason,
          idempotencyKey: `replacement:${action.replacement_id}:financial-action:complete:${action.id}`,
        })
        .onConflictDoNothing({ target: replacementActivityEvents.idempotencyKey });
    }
    return updated[0] as ReplacementFinancialActionRow;
  });
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(60 * 60, Math.max(30, 30 * (2 ** Math.min(7, Math.max(0, attempts - 1)))));
}

async function failClaimedAction(
  action: ClaimedAction,
  error: unknown,
  conn: FinancialActionDb,
  reviewRequired = false,
): Promise<void> {
  const lastError = String((error as Error)?.message ?? error).slice(0, 4000);
  const nextRunAt = new Date(Date.now() + retryDelaySeconds(action.attempts) * 1000);
  await conn.transaction(async (tx) => {
    const updated = await tx
      .update(replacementFinancialActions)
      .set({
        status: reviewRequired ? 'review_required' : 'retry',
        lastError,
        leaseExpiresAt: null,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacementFinancialActions.id, action.id),
        eq(replacementFinancialActions.status, 'processing'),
        eq(replacementFinancialActions.attempts, action.attempts),
      ))
      .returning({ id: replacementFinancialActions.id });
    if (updated.length === 0) {
      // Force a reread while still inside the transaction. Its value is intentionally ignored:
      // whichever later generation owns the row also owns its next status transition.
      await loadAction(tx, action.id);
    }
  });
}

async function processClaimedAction(
  action: ClaimedAction,
  conn: FinancialActionDb,
): Promise<ReplacementFinancialActionRow> {
  try {
    const removal = await conn.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
        select order_id from replacements where id = ${action.replacement_id}
      ))`);
      const [replacement] = await tx
        .select()
        .from(replacements)
        .where(eq(replacements.id, action.replacement_id))
        .limit(1);
      if (!replacement || Number(replacement.clientId) !== Number(action.client_id)) {
        throw new ReplacementFinancialActionError(
          'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
          `financial action ${action.id} no longer matches its replacement/client identity`,
          409,
        );
      }
      const removed = await cancelReplacementBillingInTransaction(tx, {
        replacementId: action.replacement_id,
      });
      // Persist the destructive step's result in the SAME transaction as the deletion. If the
      // worker dies before credit settlement/completion, the retry can recover the original
      // count instead of falsely completing with zero editable rows removed.
      const recorded = await tx
        .update(replacementFinancialActions)
        .set({
          editableRemoved: sql`${replacementFinancialActions.editableRemoved} + ${removed.editableRemoved}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(replacementFinancialActions.id, action.id),
          eq(replacementFinancialActions.status, 'processing'),
          // The deletion and this generation fence share one transaction. A stale worker that
          // loses here rolls the deletion back rather than recording another worker's result.
          eq(replacementFinancialActions.attempts, action.attempts),
        ))
        .returning({ id: replacementFinancialActions.id });
      if (recorded.length === 0) {
        throw new ReplacementFinancialActionError(
          'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
          `financial action ${action.id} lost its processing claim before editable cleanup`,
        );
      }
      return removed;
    });

    if (
      action.action_type === 'pre_ship_cancellation_cleanup'
      && removal.invoicedRetained > 0
    ) {
      const error = new ReplacementFinancialActionError(
        'REPLACEMENT_FINANCIAL_STATE_CONFLICT',
        `historical cancelled replacement ${action.replacement_id} has finalized money; human reversal is required`,
        409,
        { invoicedRetained: removal.invoicedRetained },
      );
      await failClaimedAction(action, error, conn, true);
      throw error;
    }

    const settled = action.action_type === 'post_ship_financial_reversal'
      ? await reconcileFinalizedBillingReplacementAdjustment({
        clientId: action.client_id,
        replacementId: action.replacement_id,
        actorId: action.requested_by_email ?? action.requested_by_type,
        actorEmail: action.requested_by_email,
        reason: action.reason,
        // The ledger id is already a stable, globally unique decision identity. Do not append
        // the caller's (up to 200-char) key: the canonical credit writer caps its derived key
        // at 100 chars, and an oversized key would turn a valid obligation into endless retry.
        idempotencyKey: `replacement-financial-action:${action.id}`,
      // 0103 processing has already probed the caller-supplied database. Keep the finalized
      // credit path on that same authority instead of invoking singleton runtime readiness.
      }, conn, async () => undefined)
      : { adjustedCount: 0, creditedAmount: '0.00' };

    return completeClaimedAction(action, {
      editableRemoved: action.editable_removed + removal.editableRemoved,
      creditsSettled: settled.adjustedCount,
      creditedAmount: settled.creditedAmount,
    }, conn);
  } catch (error) {
    const coded = error instanceof ReplacementFinancialActionError;
    const downstreamStatus = Number((error as { status?: unknown })?.status);
    const needsHuman = (coded && error.httpStatus < 500)
      || (Number.isInteger(downstreamStatus) && downstreamStatus >= 400 && downstreamStatus < 500);
    if (!(coded && error.details.invoicedRetained)) {
      // Canonical billing 4xx errors (for example a finalized-balance conflict) are durable
      // financial decisions, not transient infrastructure. Park them for review rather than
      // burning the retry lane forever; transport/5xx failures remain retryable.
      await failClaimedAction(action, error, conn, needsHuman);
    }
    throw error;
  }
}

export async function processReplacementFinancialAction(
  actionId: number,
  conn: FinancialActionDb = db,
): Promise<ReplacementFinancialActionRow | null> {
  await assertFinancialActionSchema(conn);
  const existing = await conn.transaction((tx) => loadAction(tx, actionId));
  if (!existing) return null;
  if (existing.status === 'completed' || existing.status === 'review_required') return existing;
  const claimed = await claimOneAction(conn, actionId);
  if (!claimed) return conn.transaction((tx) => loadAction(tx, actionId));
  return processClaimedAction(claimed, conn);
}

export async function enqueueStrandedReplacementCancellationCleanup(
  options: { limit?: number } = {},
  conn: FinancialActionDb = db,
): Promise<{ schemaReady: boolean; enqueued: number }> {
  if (!(await replacementFinancialActionSchemaPresent(conn))) {
    return { schemaReady: false, enqueued: 0 };
  }
  const limit = Math.min(250, Math.max(1, Math.trunc(options.limit ?? 100)));
  const rows = resultRows<{ id: number }>(await conn.execute(sql`
    insert into replacement_financial_actions (
      replacement_id, client_id, action_type, reason, idempotency_key,
      requested_by_type, requested_by_email, status, next_run_at, updated_at
    )
    select candidate.id, candidate.client_id, 'pre_ship_cancellation_cleanup',
           'Repair editable replacement billing left by the former post-commit cancellation flow',
           'replacement-cancellation-repair:' || candidate.id,
           'system:replacement-financial-repair', null, 'pending', now(), now()
    from (
      select replacement.id, replacement.client_id
      from replacements replacement
      where replacement.status = 'cancelled'
        and replacement.shipped_at is null
        and replacement.client_id is not null
        and exists (
          select 1 from billing_line_items line
          where line.replacement_id = replacement.id
        )
      order by replacement.id
      limit ${limit}
    ) candidate
    on conflict (idempotency_key) do nothing
    returning id
  `));
  return { schemaReady: true, enqueued: rows.length };
}

export async function processReplacementFinancialActionsOnce(
  options: { limit?: number } = {},
  conn: FinancialActionDb = db,
): Promise<{
  schemaReady: boolean;
  processed: number;
  succeeded: number;
  failed: number;
}> {
  if (!(await replacementFinancialActionSchemaPresent(conn))) {
    return { schemaReady: false, processed: 0, succeeded: 0, failed: 0 };
  }
  const limit = Math.min(ACTION_BATCH_LIMIT, Math.max(1, Math.trunc(options.limit ?? ACTION_BATCH_LIMIT)));
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  while (processed < limit) {
    const action = await claimOneAction(conn);
    if (!action) break;
    processed += 1;
    try {
      await processClaimedAction(action, conn);
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  return { schemaReady: true, processed, succeeded, failed };
}

export async function readReplacementFinancialAction(
  actionId: number,
  conn: FinancialActionDb = db,
): Promise<ReplacementFinancialActionRow | null> {
  await assertFinancialActionSchema(conn);
  return conn.transaction((tx) => loadAction(tx, actionId));
}
