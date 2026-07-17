import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, sql as pg } from '../db/client.js';
import {
  externalOperations,
  type ExternalOperation,
} from '../db/schema/external-operations.js';
import { runDurableWorkerAttempt } from './durable-worker-attempt.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';

export type FulfillmentOperationKind =
  | 'forward_label'
  | 'shopify_label'
  | 'return_label'
  | 'void_label'
  | 'marketplace_confirmation';

type OperationDatabase = typeof db;
type OperationTransaction = Parameters<Parameters<OperationDatabase['transaction']>[0]>[0];

export type FulfillmentOperationDependencies = {
  database?: OperationDatabase;
  ensureSchema?: () => Promise<void>;
  now?: () => Date;
  randomToken?: () => string;
};

export type FulfillmentOperationLease = {
  operationId: number;
  operationKey: string;
  generation: number;
  leaseToken: string;
  idempotencyKey: string;
};

export type FulfillmentOperationAcquireResult =
  | { kind: 'dispatch'; operation: ExternalOperation; lease: FulfillmentOperationLease }
  | { kind: 'resume_receipt'; operation: ExternalOperation; receipt: Record<string, unknown> }
  | { kind: 'consumed'; operation: ExternalOperation; localResult: Record<string, unknown> | null }
  | { kind: 'in_progress'; operation: ExternalOperation }
  | { kind: 'reconcile_required'; operation: ExternalOperation };

const DEFAULT_LEASE_MS = 3 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_JSON_BYTES = 256 * 1024;

function dependenciesFor(input: FulfillmentOperationDependencies): Required<FulfillmentOperationDependencies> {
  if ((input.database || input.ensureSchema || input.now || input.randomToken) && process.env.NODE_ENV !== 'test') {
    throw new Error('Fulfillment operation dependencies may only be injected in tests');
  }
  return {
    database: input.database ?? db,
    ensureSchema: input.ensureSchema ?? assertRuntimeSchemaReady,
    now: input.now ?? (() => new Date()),
    randomToken: input.randomToken ?? randomUUID,
  };
}

function nonEmpty(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate == null || typeof candidate !== 'object') return candidate;
    if (candidate instanceof Date) return candidate.toISOString();
    if (Array.isArray(candidate)) return candidate.map(normalize);
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

export function hashFulfillmentOperationRequest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function buildFulfillmentOperationKey(input: {
  kind: FulfillmentOperationKind;
  provider: string;
  subjectType: string;
  subjectId: string | number;
  semanticGeneration?: number;
}): string {
  const semanticGeneration = Math.trunc(input.semanticGeneration ?? 1);
  if (semanticGeneration <= 0) throw new Error('semanticGeneration must be positive');
  return [
    'ps423',
    input.kind,
    encodeURIComponent(nonEmpty(input.provider, 'provider').toLowerCase()),
    encodeURIComponent(nonEmpty(input.subjectType, 'subjectType').toLowerCase()),
    encodeURIComponent(nonEmpty(input.subjectId, 'subjectId')),
    `g${semanticGeneration}`,
  ].join(':');
}

export function buildFulfillmentOperationIdempotencyKey(operationKey: string): string {
  return `psop_${createHash('sha256').update(operationKey).digest('hex').slice(0, 48)}`;
}

function safeJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (candidate: unknown, depth = 0): unknown => {
    if (depth > 12) return '[truncated]';
    if (candidate == null || typeof candidate !== 'object') return candidate;
    if (candidate instanceof Date) return candidate.toISOString();
    if (Array.isArray(candidate)) return candidate.map((child) => redact(child, depth + 1));
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).map(([key, child]) => [
        key,
        /authorization|api[_-]?key|secret|password|credential|token/i.test(key)
          ? '[redacted]'
          : redact(child, depth + 1),
      ]),
    );
  };
  const sanitized = redact(value) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new Error(`Fulfillment operation JSON exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return sanitized;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'Unknown provider error'))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}

export class FulfillmentOperationFenceLostError extends Error {
  readonly code = 'FULFILLMENT_OPERATION_FENCE_LOST' as const;
  constructor(operationId: number) {
    super(`Fulfillment operation ${operationId} lost its generation fence`);
    this.name = 'FulfillmentOperationFenceLostError';
  }
}

export class FulfillmentOperationHeldError extends Error {
  readonly code = 'FULFILLMENT_OPERATION_RECONCILE_REQUIRED' as const;
  constructor(
    public readonly operation: Pick<ExternalOperation, 'operationKey' | 'state'> & Partial<ExternalOperation>,
  ) {
    super(
      `Provider operation ${operation.operationKey} is ${operation.state}; ` +
        'automatic retry is blocked until provider reconciliation or explicit operator resolution.',
    );
    this.name = 'FulfillmentOperationHeldError';
  }
}

export async function acquireFulfillmentOperation(
  input: {
    kind: FulfillmentOperationKind;
    provider: string;
    subjectType: string;
    subjectId: string | number;
    semanticGeneration?: number;
    request: unknown;
    leaseMs?: number;
  },
  injected: FulfillmentOperationDependencies = {},
): Promise<FulfillmentOperationAcquireResult> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const database = dependencies.database;
  const now = dependencies.now();
  const semanticGeneration = Math.trunc(input.semanticGeneration ?? 1);
  const operationKey = buildFulfillmentOperationKey({ ...input, semanticGeneration });
  const requestHash = hashFulfillmentOperationRequest(input.request);
  const idempotencyKey = buildFulfillmentOperationIdempotencyKey(operationKey);
  const provider = nonEmpty(input.provider, 'provider').toLowerCase();
  const subjectType = nonEmpty(input.subjectType, 'subjectType').toLowerCase();
  const subjectId = nonEmpty(input.subjectId, 'subjectId');

  await database
    .insert(externalOperations)
    .values({
      operationKey,
      kind: input.kind,
      provider,
      subjectType,
      subjectId,
      semanticGeneration,
      requestHash,
      idempotencyKey,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: externalOperations.operationKey });

  return database.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.operationKey, operationKey))
      .limit(1)
      .for('update');
    if (!current) throw new Error('Fulfillment operation could not be prepared');
    if (
      current.requestHash !== requestHash ||
      current.kind !== input.kind ||
      current.provider !== provider ||
      current.subjectType !== subjectType ||
      current.subjectId !== subjectId ||
      current.semanticGeneration !== semanticGeneration
    ) {
      throw new Error(`Fulfillment operation key conflict for ${operationKey}`);
    }

    if (current.state === 'consumed') {
      return { kind: 'consumed', operation: current, localResult: current.localResult };
    }
    if (current.state === 'receipt_recorded') {
      if (!current.providerReceipt) throw new Error('Receipt-recorded operation is missing its receipt');
      return { kind: 'resume_receipt', operation: current, receipt: current.providerReceipt };
    }
    if (current.state === 'reconcile_required') {
      return { kind: 'reconcile_required', operation: current };
    }
    if (current.state === 'in_flight') {
      if (current.leaseExpiresAt && current.leaseExpiresAt.getTime() > now.getTime()) {
        return { kind: 'in_progress', operation: current };
      }
      const [held] = await tx
        .update(externalOperations)
        .set({
          state: 'reconcile_required',
          lastError: current.lastError ?? 'Provider attempt lease expired before a durable receipt was recorded',
          updatedAt: now,
        })
        .where(and(eq(externalOperations.id, current.id), eq(externalOperations.generation, current.generation)))
        .returning();
      return { kind: 'reconcile_required', operation: held ?? current };
    }
    if (!['prepared', 'failed_pre_dispatch'].includes(current.state)) {
      throw new Error(`Unsupported fulfillment operation state ${current.state}`);
    }

    const generation = current.generation + 1;
    const leaseToken = dependencies.randomToken();
    const boundedLeaseMs = Math.max(30_000, Math.min(30 * 60_000, input.leaseMs ?? DEFAULT_LEASE_MS));
    const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs);
    const [claimed] = await tx
      .update(externalOperations)
      .set({
        state: 'in_flight',
        generation,
        leaseToken,
        leaseExpiresAt,
        attemptCount: current.attemptCount + 1,
        lastError: null,
        cancellationRequestedAt: null,
        cancellationAcknowledgedAt: null,
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalOperations.id, current.id),
          eq(externalOperations.generation, current.generation),
          inArray(externalOperations.state, ['prepared', 'failed_pre_dispatch']),
        ),
      )
      .returning();
    if (!claimed) throw new Error('Fulfillment operation claim raced with another worker');
    return {
      kind: 'dispatch',
      operation: claimed,
      lease: {
        operationId: claimed.id,
        operationKey,
        generation,
        leaseToken,
        idempotencyKey,
      },
    };
  });
}

async function heartbeatFulfillmentOperation(
  lease: FulfillmentOperationLease,
  leaseMs: number,
  injected: FulfillmentOperationDependencies,
): Promise<boolean> {
  const dependencies = dependenciesFor(injected);
  const now = dependencies.now();
  const [updated] = await dependencies.database
    .update(externalOperations)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(
      and(
        eq(externalOperations.id, lease.operationId),
        eq(externalOperations.generation, lease.generation),
        eq(externalOperations.leaseToken, lease.leaseToken),
        eq(externalOperations.state, 'in_flight'),
      ),
    )
    .returning({ id: externalOperations.id });
  return !!updated;
}

async function markCancellation(
  lease: FulfillmentOperationLease,
  field: 'requested' | 'acknowledged',
  injected: FulfillmentOperationDependencies,
): Promise<void> {
  const dependencies = dependenciesFor(injected);
  const now = dependencies.now();
  await dependencies.database
    .update(externalOperations)
    .set(
      field === 'requested'
        ? { cancellationRequestedAt: now, updatedAt: now }
        : { cancellationAcknowledgedAt: now, updatedAt: now },
    )
    .where(
      and(
        eq(externalOperations.id, lease.operationId),
        eq(externalOperations.generation, lease.generation),
        eq(externalOperations.leaseToken, lease.leaseToken),
      ),
    );
}

export async function recordFulfillmentOperationReceipt(
  lease: FulfillmentOperationLease,
  input: {
    receipt: Record<string, unknown>;
    providerOperationId?: string | number | null;
    providerResultId?: string | number | null;
  },
  injected: FulfillmentOperationDependencies = {},
): Promise<void> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const now = dependencies.now();
  const receipt = safeJsonRecord(input.receipt);
  const [updated] = await dependencies.database
    .update(externalOperations)
    .set({
      state: 'receipt_recorded',
      providerOperationId: input.providerOperationId == null ? null : String(input.providerOperationId),
      providerResultId: input.providerResultId == null ? null : String(input.providerResultId),
      providerReceipt: receipt,
      receiptRecordedAt: now,
      lastError: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(externalOperations.id, lease.operationId),
        eq(externalOperations.generation, lease.generation),
        eq(externalOperations.leaseToken, lease.leaseToken),
        inArray(externalOperations.state, ['in_flight', 'reconcile_required']),
      ),
    )
    .returning({ id: externalOperations.id });
  if (updated) return;

  const [current] = await dependencies.database
    .select()
    .from(externalOperations)
    .where(eq(externalOperations.id, lease.operationId))
    .limit(1);
  if (
    current &&
    current.generation === lease.generation &&
    ['receipt_recorded', 'consumed'].includes(current.state) &&
    stableJson(current.providerReceipt) === stableJson(receipt)
  ) {
    return;
  }
  throw new FulfillmentOperationFenceLostError(lease.operationId);
}

/**
 * A read-only provider poll may replace a previously recorded asynchronous
 * receipt (for example Shopify pending -> terminal). It cannot create a new
 * dispatch or move an unknown operation out of operator hold.
 */
export async function refreshFulfillmentOperationReceipt(
  operationId: number,
  input: {
    receipt: Record<string, unknown>;
    providerOperationId?: string | number | null;
    providerResultId?: string | number | null;
  },
  injected: FulfillmentOperationDependencies = {},
): Promise<void> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const now = dependencies.now();
  const [updated] = await dependencies.database
    .update(externalOperations)
    .set({
      providerOperationId: input.providerOperationId == null ? null : String(input.providerOperationId),
      providerResultId: input.providerResultId == null ? null : String(input.providerResultId),
      providerReceipt: safeJsonRecord(input.receipt),
      receiptRecordedAt: now,
      updatedAt: now,
    })
    .where(and(eq(externalOperations.id, operationId), eq(externalOperations.state, 'receipt_recorded')))
    .returning({ id: externalOperations.id });
  if (!updated) throw new Error('Only a receipt_recorded operation can refresh its provider receipt');
}

async function markFulfillmentOperationOutcome(
  lease: FulfillmentOperationLease,
  state: 'failed_pre_dispatch' | 'reconcile_required',
  error: unknown,
  injected: FulfillmentOperationDependencies,
): Promise<void> {
  const dependencies = dependenciesFor(injected);
  const now = dependencies.now();
  await dependencies.database
    .update(externalOperations)
    .set({
      state,
      lastError: safeError(error),
      leaseExpiresAt: state === 'failed_pre_dispatch' ? null : undefined,
      leaseToken: state === 'failed_pre_dispatch' ? null : undefined,
      updatedAt: now,
    })
    .where(
      and(
        eq(externalOperations.id, lease.operationId),
        eq(externalOperations.generation, lease.generation),
        eq(externalOperations.leaseToken, lease.leaseToken),
        eq(externalOperations.state, 'in_flight'),
      ),
    );
}

export async function dispatchFulfillmentOperation<T>(
  input: {
    lease: FulfillmentOperationLease;
    execute: (context: { signal: AbortSignal; idempotencyKey: string }) => Promise<T>;
    normalizeReceipt: (result: T) => {
      receipt: Record<string, unknown>;
      providerOperationId?: string | number | null;
      providerResultId?: string | number | null;
    };
    classifyError?: (error: unknown) => 'failed_pre_dispatch' | 'reconcile_required';
    timeoutMs?: number;
    heartbeatIntervalMs?: number;
    leaseMs?: number;
    label?: string;
  },
  injected: FulfillmentOperationDependencies = {},
): Promise<T> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const leaseMs = Math.max(30_000, input.leaseMs ?? DEFAULT_LEASE_MS);
  try {
    const attempt = await runDurableWorkerAttempt({
      label: input.label ?? input.lease.operationKey,
      timeoutMs: Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      heartbeatIntervalMs: Math.max(1, input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS),
      execute: async (signal) => {
        const result = await input.execute({ signal, idempotencyKey: input.lease.idempotencyKey });
        await recordFulfillmentOperationReceipt(input.lease, input.normalizeReceipt(result), injected);
        return result;
      },
      hooks: {
        heartbeat: () => heartbeatFulfillmentOperation(input.lease, leaseMs, injected),
        requestCancellation: () => markCancellation(input.lease, 'requested', injected),
        acknowledgeCancellation: () => markCancellation(input.lease, 'acknowledged', injected),
      },
    });
    return attempt.value;
  } catch (error) {
    const state = input.classifyError?.(error) ?? 'reconcile_required';
    await markFulfillmentOperationOutcome(input.lease, state, error, injected);
    throw error;
  }
}

export async function consumeFulfillmentOperation<T extends Record<string, unknown>>(
  operationId: number,
  apply: (tx: OperationTransaction, receipt: Record<string, unknown>) => Promise<T>,
  injected: FulfillmentOperationDependencies = {},
): Promise<{ kind: 'consumed' | 'already_consumed'; localResult: T | Record<string, unknown> | null }> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  return dependencies.database.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(externalOperations)
      .where(eq(externalOperations.id, operationId))
      .limit(1)
      .for('update');
    if (!current) throw new Error('Fulfillment operation not found');
    if (current.state === 'consumed') {
      return { kind: 'already_consumed', localResult: current.localResult };
    }
    if (current.state !== 'receipt_recorded' || !current.providerReceipt) {
      throw new FulfillmentOperationHeldError(current);
    }

    const localResult = safeJsonRecord(await apply(tx, current.providerReceipt));
    const now = dependencies.now();
    const [updated] = await tx
      .update(externalOperations)
      .set({
        state: 'consumed',
        localResult,
        consumedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(externalOperations.id, operationId), eq(externalOperations.state, 'receipt_recorded')))
      .returning({ id: externalOperations.id });
    if (!updated) throw new Error('Fulfillment operation receipt consumption raced with another worker');
    return { kind: 'consumed', localResult };
  });
}

type SqlExecutor = any;

/** Raw postgres.js transaction variant for legacy owners that already settle
 * their local projection through a tagged SQL executor (fulfillment outbox).
 */
export async function consumeFulfillmentOperationWithSql<T extends Record<string, unknown>>(
  operationId: number,
  apply: (tx: SqlExecutor, receipt: Record<string, unknown>) => Promise<T>,
  executor: SqlExecutor = pg,
): Promise<{ kind: 'consumed' | 'already_consumed'; localResult: T | Record<string, unknown> | null }> {
  if (executor !== pg && process.env.NODE_ENV !== 'test') {
    throw new Error('Fulfillment operation SQL executor may only be injected in tests');
  }
  await assertRuntimeSchemaReady();
  return executor.begin(async (tx: SqlExecutor) => {
    const [current] = await tx<Array<{
      state: string;
      provider_receipt: Record<string, unknown> | null;
      local_result: Record<string, unknown> | null;
    }>>`
      SELECT state, provider_receipt, local_result
      FROM external_operations
      WHERE id = ${operationId}
      FOR UPDATE
    `;
    if (!current) throw new Error('Fulfillment operation not found');
    if (current.state === 'consumed') {
      return { kind: 'already_consumed', localResult: current.local_result };
    }
    if (current.state !== 'receipt_recorded' || !current.provider_receipt) {
      const [operation] = await tx<Array<{ operationKey: string; state: string }>>`
        SELECT operation_key AS "operationKey", state
        FROM external_operations
        WHERE id = ${operationId}
      `;
      if (!operation) throw new Error('Fulfillment operation not found');
      throw new FulfillmentOperationHeldError(operation);
    }
    const localResult = safeJsonRecord(await apply(tx, current.provider_receipt));
    const [updated] = await tx<Array<{ id: number }>>`
      UPDATE external_operations
      SET state = 'consumed',
          local_result = ${tx.json(localResult as any)},
          consumed_at = NOW(),
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ${operationId} AND state = 'receipt_recorded'
      RETURNING id
    `;
    if (!updated) throw new Error('Fulfillment operation receipt consumption raced with another worker');
    return { kind: 'consumed', localResult };
  });
}

export async function listHeldFulfillmentOperations(
  input: { subjectType?: string; subjectId?: string | number; limit?: number } = {},
  injected: FulfillmentOperationDependencies = {},
): Promise<ExternalOperation[]> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const conditions = [eq(externalOperations.state, 'reconcile_required')];
  if (input.subjectType) conditions.push(eq(externalOperations.subjectType, input.subjectType));
  if (input.subjectId != null) conditions.push(eq(externalOperations.subjectId, String(input.subjectId)));
  return dependencies.database
    .select()
    .from(externalOperations)
    .where(and(...conditions))
    .orderBy(externalOperations.createdAt)
    .limit(Math.max(1, Math.min(200, input.limit ?? 100)));
}

/**
 * Explicit operator proof that the provider did not perform the mutation.
 * Incrementing generation fences the old attempt before a new claim is allowed.
 */
export async function resolveFulfillmentOperationNoEffect(
  operationId: number,
  input: { actor: string; note: string },
  injected: FulfillmentOperationDependencies = {},
): Promise<ExternalOperation> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const actor = nonEmpty(input.actor, 'actor');
  const note = nonEmpty(input.note, 'note');
  const now = dependencies.now();
  const [updated] = await dependencies.database
    .update(externalOperations)
    .set({
      state: 'failed_pre_dispatch',
      generation: sql`${externalOperations.generation} + 1`,
      leaseToken: null,
      leaseExpiresAt: null,
      resolutionNote: note,
      resolvedBy: actor,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(externalOperations.id, operationId), eq(externalOperations.state, 'reconcile_required')))
    .returning();
  if (!updated) throw new Error('Only a reconcile_required operation can be resolved as no-effect');
  return updated;
}

export async function recordFulfillmentOperationReceiptByOperator(
  operationId: number,
  input: {
    actor: string;
    note: string;
    receipt: Record<string, unknown>;
    providerOperationId?: string | number | null;
    providerResultId?: string | number | null;
  },
  injected: FulfillmentOperationDependencies = {},
): Promise<ExternalOperation> {
  const dependencies = dependenciesFor(injected);
  await dependencies.ensureSchema();
  const actor = nonEmpty(input.actor, 'actor');
  const note = nonEmpty(input.note, 'note');
  const receipt = safeJsonRecord(input.receipt);
  const now = dependencies.now();
  const [updated] = await dependencies.database
    .update(externalOperations)
    .set({
      state: 'receipt_recorded',
      generation: sql`${externalOperations.generation} + 1`,
      leaseToken: null,
      leaseExpiresAt: null,
      providerOperationId: input.providerOperationId == null ? null : String(input.providerOperationId),
      providerResultId: input.providerResultId == null ? null : String(input.providerResultId),
      providerReceipt: receipt,
      receiptRecordedAt: now,
      resolutionNote: note,
      resolvedBy: actor,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(externalOperations.id, operationId), eq(externalOperations.state, 'reconcile_required')))
    .returning();
  if (!updated) throw new Error('Only a reconcile_required operation can receive an operator receipt');
  return updated;
}
