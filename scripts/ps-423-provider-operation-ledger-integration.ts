import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import {
  buildShipStationForwardLabelOperationRequest,
  buildShipStationForwardLabelReceipt,
  canAutomaticallyConsumeShipStationForwardLabelReceipt,
  readShipStationForwardLabelPersistenceFacts,
  SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR,
} from '../src/services/shipstation-forward-label-operation.js';
import { shippingQuoteCredentialFingerprint } from '../src/services/shipping-workflow/shipping-quote-authorization.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://ps423:ps423@localhost:5432/ps423';
process.env.SUPABASE_URL ||= 'https://ps423.invalid';
process.env.SUPABASE_ANON_KEY ||= 'ps423-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'ps423-service';
process.env.SUPABASE_JWT_SECRET ||= 'ps423-jwt';

const ledger = await import('../src/services/fulfillment-operation-ledger.js');
const exactReconciliation = await import(
  '../src/services/shipstation-forward-label-reconciliation.js'
);

async function main(): Promise<void> {
  const client = new PGlite();
  await client.exec(readFileSync('drizzle/0072_external_operations.sql', 'utf8'));
  await client.exec(`
    CREATE TABLE ps423_local_results (
      operation_id integer PRIMARY KEY,
      result_key text NOT NULL
    );
    CREATE TABLE ps423_recovery_shipments (
      order_id integer PRIMARY KEY,
      tracking_number text NOT NULL
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

  const canonicalForwardRequest = buildShipStationForwardLabelOperationRequest({
    shippingProviderId: 423,
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    packageCode: 'package',
    weightOz: 20,
    dimensions: { length: 12, width: 8, height: 4 },
    packageId: 42,
    shippingOptions: {
      confirmation: 'none',
      insuranceProvider: 'parcelguard',
      insuredValue: 100,
    },
    shipTo: {
      name: 'PS-423 Recipient', company: '', street1: '1 Test Way', street2: '',
      city: 'Testville', state: 'CA', postalCode: '90001', country: 'US', phone: '5550000001',
      residential: true,
    },
    shipFrom: {
      name: 'PS-423 Warehouse', company: '', street1: '2 Test Way', street2: '',
      city: 'Testville', state: 'CA', postalCode: '90002', country: 'US', phone: '5550000002',
    },
    orderNumber: 'PS-423-001',
  });
  const forwardInput = {
    kind: 'forward_label' as const,
    provider: 'shipstation',
    subjectType: 'order',
    subjectId: 423001,
    semanticGeneration: 1,
    request: canonicalForwardRequest,
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
          labelFormat: 'pdf',
          cost: 8.42,
          insuranceCost: 1.25,
          serviceCode: 'usps_ground_advantage',
          carrierCode: 'stamps_com',
          shipDate: '2026-07-21T00:00:00.000Z',
          voided: false,
          providerAccountId: 423,
          idempotencyKey,
          authorization: 'must-not-persist',
        };
      },
      normalizeReceipt: (result) => ({
        receipt: buildShipStationForwardLabelReceipt(result, {
          orderId: 423001,
          clientId: 42,
          effectiveWeightOz: 20,
          dimensions: { length: 12, width: 8, height: 4 },
          selectedPackageId: 42,
          insuranceProvider: 'parcelguard',
          insuredValue: 100,
        }),
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
  const persistenceFacts = readShipStationForwardLabelPersistenceFacts(
    resume.receipt,
    { orderId: 423001, clientId: 42 },
  );
  assert.deepEqual(
    persistenceFacts,
    {
      version: 1,
      authority: 'canonical_shipping_quote',
      provider: 'shipstation',
      source: 'prepship_v2',
      orderId: 423001,
      clientId: 42,
      effectiveWeightOz: 20,
      dimensions: { length: 12, width: 8, height: 4 },
      selectedPackageId: 42,
      insuranceProvider: 'parcelguard',
      insuredValue: 100,
    },
    'receipt recovery reads the canonical post-authorization facts, not a mutable queue payload',
  );
  assert.equal(
    canAutomaticallyConsumeShipStationForwardLabelReceipt({
      providerReceipt: resume.receipt,
      resolvedBy: null,
    }),
    true,
    'the canonical provider-ACK receipt can automatically resume local persistence',
  );
  assert.equal(
    canAutomaticallyConsumeShipStationForwardLabelReceipt({
      providerReceipt: resume.receipt,
      resolvedBy: SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR,
    }),
    true,
    'the fixed exact-ID system reconciler may seal a resumable receipt',
  );
  assert.equal(
    canAutomaticallyConsumeShipStationForwardLabelReceipt({
      providerReceipt: resume.receipt,
      resolvedBy: 'operator@example.test',
    }),
    false,
    'generic operator receipt JSON cannot authorize automatic shipped persistence',
  );
  assert.throws(
    () => readShipStationForwardLabelPersistenceFacts(
      { created: resume.receipt.created },
      { orderId: 423001, clientId: 42 },
    ),
    /missing canonical persistence facts/,
    'legacy receipts without sealed facts remain held',
  );
  assert.throws(
    () => readShipStationForwardLabelPersistenceFacts(
      {
        ...resume.receipt,
        persistenceFacts: { ...persistenceFacts, effectiveWeightOz: -1 },
      },
      { orderId: 423001, clientId: 42 },
    ),
    /invalid effectiveWeightOz/,
    'malformed receipt facts fail closed',
  );
  assert.throws(
    () => readShipStationForwardLabelPersistenceFacts(
      resume.receipt,
      { orderId: 423099, clientId: 42 },
    ),
    /scope does not match/,
    'cross-order receipt facts fail closed',
  );
  assert.equal(
    ledger.hashFulfillmentOperationRequest(canonicalForwardRequest),
    claimed.operation.requestHash,
    'the system reconciler can prove the exact canonical request before sealing facts',
  );
  const tamperedWeightRequest = structuredClone(canonicalForwardRequest);
  const tamperedWeightShipment = (
    tamperedWeightRequest.providerRequest as Record<string, unknown>
  ).shipment as Record<string, unknown>;
  const tamperedWeightPackage = (tamperedWeightShipment.packages as Array<Record<string, unknown>>)[0]!;
  (tamperedWeightPackage.weight as Record<string, unknown>).value = 10;
  assert.notEqual(
    ledger.hashFulfillmentOperationRequest(tamperedWeightRequest),
    claimed.operation.requestHash,
    'a tampered queue weight cannot match the immutable operation request',
  );
  const tamperedResidentialRequest = structuredClone(canonicalForwardRequest);
  const tamperedResidentialShipment = (
    tamperedResidentialRequest.providerRequest as Record<string, unknown>
  ).shipment as Record<string, unknown>;
  (tamperedResidentialShipment.ship_to as Record<string, unknown>)
    .address_residential_indicator = 'no';
  assert.notEqual(
    ledger.hashFulfillmentOperationRequest(tamperedResidentialRequest),
    claimed.operation.requestHash,
    'the immutable operation request binds the residential bit sent to ShipStation',
  );
  let localApplyCalls = 0;
  const consumeReceipt = () => ledger.consumeFulfillmentOperation(
    resume.operation.id,
    async (tx, receipt) => {
      localApplyCalls += 1;
      assert.equal((receipt.created as Record<string, unknown>).labelId, 'label-423001');
      await tx.execute(sql`
        INSERT INTO ps423_local_results (operation_id, result_key)
        VALUES (${resume.operation.id}, 'shipment-423001')
      `);
      return { shipmentId: 423001 };
    },
    dependencies,
  );
  const concurrentConsumption = await Promise.all([consumeReceipt(), consumeReceipt()]);
  assert.deepEqual(
    concurrentConsumption.map((result) => result.kind).sort(),
    ['already_consumed', 'consumed'],
    'two concurrent recovery workers produce one canonical local consumption',
  );
  assert.equal(localApplyCalls, 1, 'the exact durable receipt is applied once');
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
  // Per user override unlock shipped data on 2026-07-22: all reconciliation
  // fixtures below use fake GET/receipt/persistence dependencies and PGlite;
  // no provider POST, postage, or production mutation is reachable.
  const reconciliationOrder = {
    orderId: 423007,
    clientId: 42,
    orderNumber: 'PS-423-001',
    skuGroupId: 'ps423',
    label: {
      selectionRef: `sqa_${'a'.repeat(32)}.${'b'.repeat(24)}`,
      shippingProviderId: 423,
      serviceCode: 'usps_ground_advantage',
      customPackageId: 42,
      weightOz: 20,
      length: 12,
      width: 8,
      height: 4,
      confirmation: 'none',
      insuranceProvider: 'parcelguard',
      insuredValue: 100,
    },
  };
  const reconciliationSelection = {
    authorizationContext: {
      version: 1 as const,
      order: {
        orderId: 423007, clientId: 42, storeId: null,
        sourceProvider: null, sourceAccountId: null, sourceOrderId: null,
      },
      shipment: {
        shipFromLocationId: null,
        shipFrom: {
          name: 'PS-423 Warehouse', company: '', street1: '2 Test Way', street2: '',
          city: 'Testville', state: 'CA', postalCode: '90002', country: 'US', phone: '5550000002',
        },
        shipTo: {
          name: 'PS-423 Recipient', company: '', street1: '1 Test Way', street2: '',
          city: 'Testville', state: 'CA', postalCode: '90001', country: 'US', phone: '5550000001',
        },
        package: { id: 42, type: 'package', code: 'package' },
        weightOz: 20,
        dimensions: { length: 12, width: 8, height: 4 },
        residential: true,
        confirmation: 'none',
        insuranceProvider: 'parcelguard',
        insuredValue: 100,
      },
    },
    accountAuthorization: {
      providerFamily: 'shipstation' as const,
      provider: 'shipstation',
      shippingProviderId: 423,
      sourceTable: 'shipstation' as const,
      sourceAccountId: 423,
      ownerClientId: 42,
      ownerStoreAccountId: null,
      credentialSource: 'client' as const,
      credentialFingerprint: shippingQuoteCredentialFingerprint('ps423-key'),
      environment: 'test',
    },
    selectedRate: {
      serviceCode: 'usps_ground_advantage',
      serviceName: 'USPS Ground Advantage',
      carrierCode: 'stamps_com',
      packageCode: 'package',
    },
  };
  const reconciliationOperation = {
    ...latestCompleted!,
    id: 423007,
    state: 'reconcile_required',
    kind: 'forward_label',
    provider: 'shipstation',
    subjectType: 'order',
    subjectId: '423007',
    requestHash: ledger.hashFulfillmentOperationRequest(canonicalForwardRequest),
    idempotencyKey: `psop_${'7'.repeat(45)}`,
    providerReceipt: null,
    localResult: null,
    resolvedBy: null,
  };
  let exactLookupCalls = 0;
  let exactReceiptWrites = 0;
  let exactResumeCalls = 0;
  const reconciliationDependencies: Parameters<
    typeof reconciler.reconcileQueueShipStationOperation
  >[2] = {
    getLatestOperation: async () => reconciliationOperation as never,
    selectRate: async () => reconciliationSelection as never,
    loadCredentials: async () => ({
      apiKeyV2: 'ps423-key',
      apiKeyV1: null,
      apiSecretV1: null,
      sourceClientId: 42,
    }),
    lookupByExternalShipmentId: async () => {
      exactLookupCalls += 1;
      return {
        status: 'completed',
        label: {
          labelId: 'label-423007', shipmentId: 423007,
          trackingNumber: 'tracking-423007',
          labelUrl: 'https://labels.invalid/423007.pdf', labelFormat: 'pdf',
          cost: 8.42, insuranceCost: 1.25, voided: false,
          carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage',
          shipDate: '2026-07-21T00:00:00.000Z', providerAccountId: 423,
        },
      };
    },
    recordExactReceipt: async () => { exactReceiptWrites += 1; },
    resumeReceipt: async () => {
      exactResumeCalls += 1;
      return {
        shipmentId: 423007, trackingNumber: 'tracking-423007',
        labelUrl: 'https://labels.invalid/423007.pdf', cost: 8.42,
        voided: false, orderStatus: 'shipped', apiVersion: 'v2',
      };
    },
  };
  const exactReconciled = await reconciler.reconcileQueueShipStationOperation(
    reconciliationOrder, {}, reconciliationDependencies,
  );
  assert.equal(exactReconciled.status, 'recovered');
  assert.equal(exactLookupCalls, 1, 'the exact request hash admits one provider GET');
  assert.equal(exactReceiptWrites, 1, 'the exact GET result reaches the dedicated receipt writer');
  assert.equal(exactResumeCalls, 1, 'the exact GET result resumes local persistence once');
  const hashHeld = await reconciler.reconcileQueueShipStationOperation(
    reconciliationOrder,
    {},
    {
      ...reconciliationDependencies,
      getLatestOperation: async () => ({
        ...reconciliationOperation,
        requestHash: '0'.repeat(64),
      }) as never,
    },
  );
  assert.equal(hashHeld.status, 'held');
  assert.equal(exactLookupCalls, 1,
    'a mismatched immutable request hash is held before any provider GET');
  assert.equal(providerCalls, 1, 'provider success plus local fault causes exactly one provider invocation');
  assert.equal((await client.query(`SELECT * FROM ps423_local_results`)).rows.length, 1);

  // Per user override unlock shipped data on 2026-07-22: execute the real
  // recovery orchestrator with only injected PGlite/fake local boundaries.
  const recoveryService = await import('../src/services/verified-forward-label-recovery.js');
  let recoveryProviderCalls = 0;
  const seedRecoveryReceipt = async (orderId: number): Promise<number> => {
    const action = await ledger.acquireFulfillmentOperation({
      ...forwardInput,
      subjectId: orderId,
    }, dependencies);
    assert.equal(action.kind, 'dispatch');
    if (action.kind !== 'dispatch') throw new Error('recovery receipt fixture was not claimable');
    await ledger.dispatchFulfillmentOperation({
      lease: action.lease,
      execute: async () => {
        recoveryProviderCalls += 1;
        return {
          labelId: `label-${orderId}`,
          shipmentId: orderId,
          trackingNumber: `tracking-${orderId}`,
          labelUrl: `https://labels.invalid/${orderId}.pdf`,
          labelFormat: 'pdf',
          cost: 8.42,
          insuranceCost: 0,
          serviceCode: 'usps_ground_advantage',
          carrierCode: 'stamps_com',
          shipDate: '2026-07-21T00:00:00.000Z',
          voided: false,
          providerAccountId: 423,
        };
      },
      normalizeReceipt: (created) => ({
        receipt: buildShipStationForwardLabelReceipt(created, {
          orderId,
          clientId: 42,
          effectiveWeightOz: 20,
          dimensions: { length: 12, width: 8, height: 4 },
          selectedPackageId: 42,
          insuranceProvider: 'none',
          insuredValue: null,
        }),
      }),
    }, dependencies);
    return action.operation.id;
  };
  let recoveryPersistCalls = 0;
  let recoveryLifecycleCalls = 0;
  let recoveryConfirmationCalls = 0;
  const recoveryDependencies: Parameters<
    typeof recoveryService.resumeVerifiedShipStationForwardLabel
  >[2] = {
    database: database as never,
    ensureFulfillment: async () => undefined,
    ensurePackageConsumption: async () => undefined,
    ensureShipmentRateCost: async () => undefined,
    loadOrder: async (orderId) => ({
      id: orderId,
      orderNumber: `PS-423-${orderId}`,
      clientId: null,
      storeId: 420,
      externalOrderId: null,
      sourceProvider: null,
    }) as never,
    resolveClientId: async () => 42,
    consumeOperation: (operationId, apply) =>
      ledger.consumeFulfillmentOperation(operationId, apply as never, dependencies),
    persistLabel: async (input) => {
      recoveryPersistCalls += 1;
      await input.tx.execute(sql`
        INSERT INTO ps423_recovery_shipments (order_id, tracking_number)
        VALUES (${input.orderId}, ${input.created.trackingNumber})
      `);
      return input.orderId;
    },
    applyLifecycle: async (_tx, input) => {
      recoveryLifecycleCalls += 1;
      assert.equal(input.requireAwaitingOrderStatus, true);
      assert.equal(input.requireNoActiveOutboundShipment, true);
      return {
        lifecycleEventId: input.orderId,
        alreadyApplied: false,
        statusChanged: true,
        claimCount: 1,
      };
    },
    enqueueConfirmation: async (input) => {
      recoveryConfirmationCalls += 1;
      assert.equal(input.order.clientId, 42,
        'legacy store-only recovery passes the resolved client to confirmation');
      return undefined;
    },
  };
  const recoveryOperationId = await seedRecoveryReceipt(423005);
  const recoveryInput = { operationId: recoveryOperationId, orderId: 423005 };
  const [firstRecovery, racedRecovery] = await Promise.all([
    recoveryService.resumeVerifiedShipStationForwardLabel(
      recoveryInput, { clientIds: [42], storeIds: [], isGlobal: false, isRestricted: true },
      recoveryDependencies,
    ),
    recoveryService.resumeVerifiedShipStationForwardLabel(
      recoveryInput, { clientIds: [42], storeIds: [], isGlobal: false, isRestricted: true },
      recoveryDependencies,
    ),
  ]);
  assert.equal(firstRecovery.shipmentId, 423005);
  assert.equal(racedRecovery.shipmentId, 423005,
    'a worker that observes the already-consumed receipt returns the committed result');
  assert.equal(recoveryPersistCalls, 1, 'two recovery workers persist one local shipment');
  assert.equal(recoveryLifecycleCalls, 1, 'two recovery workers apply one terminal transition');
  assert.equal(recoveryConfirmationCalls, 2,
    'confirmation enqueue remains idempotently requested after either recovery result');

  const rollbackOperationId = await seedRecoveryReceipt(423006);
  await assert.rejects(
    recoveryService.resumeVerifiedShipStationForwardLabel(
      { operationId: rollbackOperationId, orderId: 423006 },
      { clientIds: [42], storeIds: [], isGlobal: false, isRestricted: true },
      {
        ...recoveryDependencies,
        applyLifecycle: async () => {
          throw new Error('PS-423 recovery lifecycle rejection');
        },
      },
    ),
    /PS-423 recovery lifecycle rejection/,
  );
  assert.equal(
    (await client.query(`SELECT * FROM ps423_recovery_shipments WHERE order_id = 423006`)).rows.length,
    0,
    'a lifecycle rejection rolls the recovery shipment back',
  );
  const [rolledBackOperation] = await database.select().from(schema.externalOperations)
    .where(eq(schema.externalOperations.id, rollbackOperationId));
  assert.equal(rolledBackOperation?.state, 'receipt_recorded',
    'a lifecycle rejection leaves the durable receipt unconsumed for review/retry');
  assert.equal(recoveryProviderCalls, 2,
    'only fixture receipt seeding called a fake provider; recovery never dispatched');

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
  await assert.rejects(
    ledger.recordFulfillmentOperationReceiptByOperator(
      expiredClaim.lease.operationId,
      {
        actor: SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR,
        note: 'A generic caller must not mint trusted system provenance',
        receipt: { created: { labelId: 'forged-label' } },
      },
      dependencies,
    ),
    /Reserved system receipt provenance/,
    'generic operator JSON cannot forge exact-reconciler provenance',
  );
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

  const trustedReconcileInput = {
    kind: 'forward_label' as const,
    provider: 'shipstation',
    subjectType: 'order',
    subjectId: 423004,
    request: canonicalForwardRequest,
  };
  const trustedClaim = await ledger.acquireFulfillmentOperation(trustedReconcileInput, {
    ...dependencies,
    now: () => leaseStartedAt,
  });
  assert.equal(trustedClaim.kind, 'dispatch');
  if (trustedClaim.kind !== 'dispatch') throw new Error('trusted reconciliation fixture was not claimed');
  await ledger.holdExpiredFulfillmentOperationForReconciliation(
    trustedClaim.lease.operationId,
    { note: 'Exact provider GET is ready' },
    { ...dependencies, now: () => new Date('2026-07-21T00:04:00.000Z') },
  );
  await exactReconciliation.recordExactShipStationForwardLabelReceipt(
    trustedClaim.lease.operationId,
    {
      labelId: 'label-423004', shipmentId: 423004,
      trackingNumber: '9400000000000000042304',
      labelUrl: 'https://labels.invalid/423004.pdf', labelFormat: 'pdf',
      cost: 9.42, insuranceCost: 0, voided: false,
      carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage',
      shipDate: '2026-07-21T00:00:00.000Z', providerAccountId: 423,
    },
    {
      orderId: 423004, clientId: 42, effectiveWeightOz: 20,
      dimensions: { length: 12, width: 8, height: 4 },
      selectedPackageId: 42, insuranceProvider: 'none', insuredValue: null,
    },
    dependencies,
  );
  const trustedRecorded = await database.select().from(schema.externalOperations)
    .where(eq(schema.externalOperations.id, trustedClaim.lease.operationId));
  assert.equal(trustedRecorded[0]?.resolvedBy, SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR,
    'only the dedicated exact-GET writer stamps trusted provenance');

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
