import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://ps423:ps423@localhost:5432/ps423';
process.env.SUPABASE_URL ||= 'https://ps423.invalid';
process.env.SUPABASE_ANON_KEY ||= 'ps423-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'ps423-service';
process.env.SUPABASE_JWT_SECRET ||= 'ps423-jwt';

const ledger = await import('../src/services/fulfillment-operation-ledger.js');

async function main(): Promise<void> {
  const client = new PGlite();
  await client.exec(readFileSync('drizzle/0072_external_operations.sql', 'utf8'));
  await client.exec(`
    CREATE TABLE ps423_local_results (
      operation_id integer PRIMARY KEY,
      result_key text NOT NULL
    );
  `);
  const database = drizzle(client, { schema, casing: 'snake_case' });
  let token = 0;
  const dependencies = {
    database: database as unknown as Parameters<typeof ledger.acquireFulfillmentOperation>[1] extends infer D
      ? D extends { database?: infer T } ? T : never
      : never,
    ensureSchema: async () => undefined,
    randomToken: () => `ps423-token-${++token}`,
  };

  const forwardInput = {
    kind: 'forward_label' as const,
    provider: 'shipstation',
    subjectType: 'order',
    subjectId: 423001,
    semanticGeneration: 1,
    request: { serviceCode: 'usps_ground_advantage', package: 'box' },
  };

  const [first, overlap] = await Promise.all([
    ledger.acquireFulfillmentOperation(forwardInput, dependencies),
    ledger.acquireFulfillmentOperation(forwardInput, dependencies),
  ]);
  const claimed = [first, overlap].find((result) => result.kind === 'dispatch');
  const blocked = [first, overlap].find((result) => result.kind === 'in_progress');
  assert.equal(claimed?.kind, 'dispatch', 'one concurrent caller owns provider dispatch');
  assert.equal(blocked?.kind, 'in_progress', 'overlapping caller observes the durable lease');
  if (claimed?.kind !== 'dispatch') throw new Error('forward operation was not claimed');

  let providerCalls = 0;
  await ledger.dispatchFulfillmentOperation(
    {
      lease: claimed.lease,
      execute: async ({ idempotencyKey, signal }) => {
        signal.throwIfAborted();
        providerCalls += 1;
        return {
          labelId: 'label-423001',
          shipmentId: 423001,
          trackingNumber: '9400000000000000042301',
          labelUrl: 'https://labels.invalid/423001.pdf',
          serviceCode: 'usps_ground_advantage',
          shipDate: '2026-07-21T00:00:00.000Z',
          voided: false,
          idempotencyKey,
          authorization: 'must-not-persist',
        };
      },
      normalizeReceipt: (result) => ({
        receipt: { created: result },
        providerOperationId: result.labelId,
        providerResultId: result.trackingNumber,
      }),
    },
    dependencies,
  );

  await assert.rejects(
    ledger.consumeFulfillmentOperation(
      claimed.lease.operationId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO ps423_local_results (operation_id, result_key)
          VALUES (${claimed.lease.operationId}, 'shipment-423001')
        `);
        throw new Error('fault after local insert');
      },
      dependencies,
    ),
    /fault after local insert/,
  );
  const localAfterRollback = await client.query(`SELECT * FROM ps423_local_results`);
  assert.equal(localAfterRollback.rows.length, 0, 'failed consumption rolls back the local result atomically');

  const recorded = await ledger.getLatestLabelOperationForOrder(423001, dependencies);
  assert.equal(recorded?.state, 'receipt_recorded', 'queue recovery can observe a durable receipt before local consumption');
  const resume = await ledger.acquireFulfillmentOperation(forwardInput, dependencies);
  assert.equal(resume.kind, 'resume_receipt', 'retry resumes the durable provider receipt');
  if (resume.kind !== 'resume_receipt') throw new Error('forward receipt was not resumable');
  assert.equal(
    (resume.receipt.created as Record<string, unknown>).authorization,
    '[redacted]',
    'receipt storage redacts credential-shaped fields',
  );
  await ledger.consumeFulfillmentOperation(
    resume.operation.id,
    async (tx, receipt) => {
      assert.equal((receipt.created as Record<string, unknown>).labelId, 'label-423001');
      await tx.execute(sql`
        INSERT INTO ps423_local_results (operation_id, result_key)
        VALUES (${resume.operation.id}, 'shipment-423001')
      `);
      return { shipmentId: 423001 };
    },
    dependencies,
  );
  const completed = await ledger.acquireFulfillmentOperation(forwardInput, dependencies);
  assert.equal(completed.kind, 'consumed');
  const latestCompleted = await ledger.getLatestLabelOperationForOrder(423001, dependencies);
  assert.equal(latestCompleted?.state, 'consumed', 'queue recovery reads canonical consumed local truth');
  const reconciler = await import('../src/services/print-queue/shipstation-operation-reconciler.js');
  assert.equal(
    latestCompleted && reconciler.consumedQueueLabelShipmentId(latestCompleted),
    423001,
    'consumed local_result identifies the exact canonical shipment without another provider call',
  );
  assert.equal(
    reconciler.isQueueLabelSafeNoEffect({
      state: 'failed_pre_dispatch',
    }),
    true,
    'a repeated recovery pass recognizes canonical failed-before-dispatch proof',
  );
  assert.equal(
    reconciler.isQueueLabelSafeNoEffect({
      state: 'reconcile_required',
    }),
    false,
    'an unknown provider outcome is never confused with safe no-effect proof',
  );
  assert.equal(
    reconciler.isHistoricalConsumedQueueLabelOperation({
      state: 'consumed',
      semanticGeneration: 1,
    }, 2, 'voided'),
    true,
    'a consumed operation behind the canonical next generation is historical after its label was voided',
  );
  assert.equal(
    reconciler.isHistoricalConsumedQueueLabelOperation({
      state: 'consumed',
      semanticGeneration: 2,
    }, 2, 'voided'),
    false,
    'same-generation consumed truth remains held when its exact shipment cannot be verified',
  );
  assert.equal(
    reconciler.isHistoricalConsumedQueueLabelOperation({
      state: 'consumed',
      semanticGeneration: 1,
    }, 2, 'active_unqueueable'),
    false,
    'an active shipment with an invalid queue artifact is never treated as historical',
  );
  assert.equal(
    reconciler.isHistoricalConsumedQueueLabelOperation({
      state: 'consumed',
      semanticGeneration: 1,
    }, 2, 'missing_or_inconsistent'),
    false,
    'a missing or inconsistent exact shipment remains held',
  );
  assert.equal(providerCalls, 1, 'provider success plus local fault causes exactly one provider invocation');
  assert.equal((await client.query(`SELECT * FROM ps423_local_results`)).rows.length, 1);

  const unknownInput = {
    kind: 'return_label' as const,
    provider: 'shipstation',
    subjectType: 'return',
    subjectId: 423002,
    request: { outboundShipmentId: 51002, reason: 'Customer Return' },
  };
  const unknownClaim = await ledger.acquireFulfillmentOperation(unknownInput, dependencies);
  assert.equal(unknownClaim.kind, 'dispatch');
  if (unknownClaim.kind !== 'dispatch') throw new Error('return operation was not claimed');
  let ambiguousCalls = 0;
  await assert.rejects(
    ledger.dispatchFulfillmentOperation(
      {
        lease: unknownClaim.lease,
        execute: async () => {
          ambiguousCalls += 1;
          throw new Error('timeout after request submission');
        },
        normalizeReceipt: () => ({ receipt: {} }),
      },
      dependencies,
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof ledger.FulfillmentOperationHeldError,
        'ambiguous post-dispatch failures must surface as a durable reconciliation hold',
      );
      assert.equal(error.operation.operationKey, unknownClaim.lease.operationKey);
      return true;
    },
  );
  const heldRetry = await ledger.acquireFulfillmentOperation(unknownInput, dependencies);
  assert.equal(heldRetry.kind, 'reconcile_required', 'ambiguous provider outcome is operator-held');
  assert.equal(ambiguousCalls, 1, 'operator-held unknown is never blindly dispatched again');

  const expiredInput = {
    kind: 'forward_label' as const,
    provider: 'shipstation',
    subjectType: 'order',
    subjectId: 423003,
    request: { serviceCode: 'ups_ground', package: 'box' },
  };
  const leaseStartedAt = new Date('2026-07-21T00:00:00.000Z');
  const expiredClaim = await ledger.acquireFulfillmentOperation(expiredInput, {
    ...dependencies,
    now: () => leaseStartedAt,
  });
  assert.equal(expiredClaim.kind, 'dispatch');
  if (expiredClaim.kind !== 'dispatch') throw new Error('expired-lease fixture was not claimed');
  await assert.rejects(
    ledger.holdExpiredFulfillmentOperationForReconciliation(
      expiredClaim.lease.operationId,
      { note: 'Provider GET verification is pending' },
      { ...dependencies, now: () => new Date('2026-07-21T00:00:10.000Z') },
    ),
    /lease is still active/,
    'an operator cannot hold a live provider lease',
  );
  const expiredHeld = await ledger.holdExpiredFulfillmentOperationForReconciliation(
    expiredClaim.lease.operationId,
    { note: 'Provider GET verified an existing label after the worker lease expired' },
    { ...dependencies, now: () => new Date('2026-07-21T00:04:00.000Z') },
  );
  assert.equal(expiredHeld.state, 'reconcile_required');
  const repeatedHold = await ledger.holdExpiredFulfillmentOperationForReconciliation(
    expiredClaim.lease.operationId,
    { note: 'Repeated operator hold remains idempotent' },
    { ...dependencies, now: () => new Date('2026-07-21T00:05:00.000Z') },
  );
  assert.equal(repeatedHold.state, 'reconcile_required');
  await ledger.recordFulfillmentOperationReceiptByOperator(
    expiredClaim.lease.operationId,
    {
      actor: 'ps423-fixture',
      note: 'Provider GET returned the exact external shipment id',
      receipt: { created: { labelId: 'label-423003' } },
      providerOperationId: 'label-423003',
    },
    dependencies,
  );
  await ledger.consumeFulfillmentOperation(
    expiredClaim.lease.operationId,
    async () => ({ shipmentId: 423003 }),
    dependencies,
  );

  await ledger.resolveFulfillmentOperationNoEffect(
    unknownClaim.lease.operationId,
    { actor: 'ps423-fixture', note: 'Provider lookup proved no return label exists' },
    dependencies,
  );
  await assert.rejects(
    ledger.recordFulfillmentOperationReceipt(
      unknownClaim.lease,
      { receipt: { labelId: 'late-stale-label' } },
      dependencies,
    ),
    ledger.FulfillmentOperationFenceLostError,
    'operator resolution fences the old generation before retry',
  );
  const retryAfterProof = await ledger.acquireFulfillmentOperation(unknownInput, dependencies);
  assert.equal(retryAfterProof.kind, 'dispatch');
  if (retryAfterProof.kind !== 'dispatch') throw new Error('proved no-effect operation was not retryable');
  assert.ok(retryAfterProof.lease.generation > unknownClaim.lease.generation);

  const operationKinds = [
    'shopify_label',
    'return_label',
    'void_label',
    'marketplace_confirmation',
  ] as const;
  for (const [index, kind] of operationKinds.entries()) {
    const operationInput = {
      kind,
      provider: kind === 'shopify_label' ? 'shopify' : 'fixture-provider',
      subjectType: kind === 'marketplace_confirmation' ? 'outbox' : kind === 'void_label' ? 'shipment' : 'return',
      subjectId: `fixture-${kind}-${index}`,
      request: { fixture: kind },
    };
    const action = await ledger.acquireFulfillmentOperation(operationInput, dependencies);
    assert.equal(action.kind, 'dispatch', `${kind} reaches the same dispatch owner`);
    if (action.kind !== 'dispatch') throw new Error(`${kind} was not claimable`);
    let calls = 0;
    await ledger.dispatchFulfillmentOperation(
      {
        lease: action.lease,
        execute: async ({ signal, idempotencyKey }) => {
          signal.throwIfAborted();
          calls += 1;
          return { providerResultId: `${kind}-result`, idempotencyKey };
        },
        normalizeReceipt: (result) => ({
          receipt: result,
          providerResultId: result.providerResultId,
        }),
      },
      dependencies,
    );
    await ledger.consumeFulfillmentOperation(
      action.lease.operationId,
      async () => ({ localResultId: `${kind}-local` }),
      dependencies,
    );
    const replay = await ledger.acquireFulfillmentOperation(operationInput, dependencies);
    assert.equal(replay.kind, 'consumed');
    assert.equal(calls, 1, `${kind} invokes its fake provider exactly once`);
  }

  const printQueueInput = {
    kind: 'forward_label' as const,
    provider: 'fixture-provider',
    subjectType: 'print_queue_order',
    subjectId: 'queue-order-423',
    request: { queueEntryId: 'queue-423' },
  };
  const queueAction = await ledger.acquireFulfillmentOperation(printQueueInput, dependencies);
  assert.equal(queueAction.kind, 'dispatch', 'Print Queue delegates its forward label to the same ledger');

  const rows = await database.select().from(schema.externalOperations);
  assert.ok(rows.every((row) => row.idempotencyKey.startsWith('psop_')));
  assert.ok(rows.every((row) => row.requestHash.length === 64));
  const held = await ledger.listHeldFulfillmentOperations({}, dependencies);
  assert.equal(held.length, 0, 'operator proof removed the only held fixture');

  const migration = readFileSync('drizzle/0072_external_operations.sql', 'utf8');
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+(?:public\.)?(?:orders|shipments)\b/i);
  assert.match(migration, /ALTER TABLE external_operations ENABLE ROW LEVEL SECURITY/i);

  const forwardRow = rows.find((row) => row.operationKey === claimed.lease.operationKey);
  assert.equal(forwardRow?.state, 'consumed');
  assert.equal(forwardRow?.attemptCount, 1);
  assert.equal(forwardRow?.localResult?.shipmentId, 423001);
  const persisted = await database
    .select()
    .from(schema.externalOperations)
    .where(eq(schema.externalOperations.id, claimed.lease.operationId));
  assert.equal(persisted.length, 1);

  await client.close();
  console.log('PASS PS-423 provider-operation ledger integration (fake providers only)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
