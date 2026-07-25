import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  orderHazmatDeclarations,
  orderHazmatMaterials,
  shipmentHazmatSnapshots,
} from '../db/schema/hazmat.js';
import { orderOverrides, orders } from '../db/schema/orders.js';
import { shipments } from '../db/schema/shipments.js';
import { acquireLabelPurchaseLock } from '../lib/label-purchase-lock.js';
import type { ClientStoreScope } from '../lib/client-store-scope.js';
import { orderScopePredicate } from '../lib/order-scope.js';
import {
  recordRequiredAuditEventInTransaction,
  type AuditActor,
} from './audit-log.js';
import { resolveOrderLifecycleStatus } from './order-lifecycle-status.js';
import { assertRuntimeSchemaReady } from './runtime-schema-readiness.js';
import { getLatestLabelOperationForOrder } from './fulfillment-operation-ledger.js';
import {
  currentHazmatFeatureFlags,
  resolveHazmatCapabilities,
  type HazmatCapabilities,
} from './shipping-workflow/hazmat-capability.js';
import {
  hazmatSemanticHash,
  normalizeAndValidateHazmatDeclaration,
  normalizeHazmatDeclaration,
  sealHazmatDeclaration,
  summarizeHazmatDeclaration,
  validateHazmatDeclaration,
  type CanonicalHazmatPurchaseFacts,
  type HazmatDeclarationInput,
  type HazmatProfile,
  type HazmatValidationResult,
  type NormalizedHazmatDeclaration,
  type NormalizedHazmatMaterial,
} from './shipping-workflow/hazmat-declaration.js';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type HazmatOrderRow = {
  id: number;
  clientId: number | null;
  storeId: number | null;
  orderStatus: string;
  canonicalStatus: string | null;
  externallyShipped: boolean;
  bestRateJson: unknown;
};

export type OrderHazmatState = {
  orderId: number;
  clientId: number | null;
  storeId: number | null;
  declaration: NormalizedHazmatDeclaration | null;
  revision: number;
  semanticHash: string | null;
  decisionSource: 'manual' | 'automation' | null;
  capabilities: HazmatCapabilities;
  validation: HazmatValidationResult;
  requiresRerate: boolean;
  frozenPurchaseFacts: CanonicalHazmatPurchaseFacts | null;
};

export type SaveOrderHazmatResult = OrderHazmatState & {
  changed: boolean;
  invalidatedRate: boolean;
};

export class OrderHazmatError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 422 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderHazmatError';
  }
}

function orderWhere(orderId: number, scope: ClientStoreScope) {
  const scopePredicate = orderScopePredicate(scope);
  return scopePredicate
    ? and(eq(orders.id, orderId), scopePredicate)!
    : eq(orders.id, orderId);
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function materialFromRow(row: typeof orderHazmatMaterials.$inferSelect): NormalizedHazmatMaterial {
  return {
    sequence: row.sequence,
    unNaNumber: row.unNaNumber,
    properShippingName: row.properShippingName,
    technicalName: row.technicalName,
    hazardClass: row.hazardClass,
    subsidiaryHazardClass: row.subsidiaryHazardClass,
    packingGroup: row.packingGroup,
    amount: numberOrNull(row.amount),
    amountUnit: row.amountUnit,
    quantity: row.quantity,
    packagingInstruction: row.packagingInstruction,
    packagingInstructionSection: row.packagingInstructionSection,
    packagingType: row.packagingType,
    transportMean: row.transportMean,
    transportCategory: row.transportCategory,
    regulationAuthority: row.regulationAuthority,
    regulationLevel: row.regulationLevel,
    radioactive: row.radioactive === true,
    reportableQuantity: row.reportableQuantity === true,
    additionalDescription: row.additionalDescription,
  };
}

async function loadDeclaration(
  conn: Pick<typeof db, 'select'>,
  orderId: number,
): Promise<{
  declaration: NormalizedHazmatDeclaration | null;
  revision: number;
  semanticHash: string | null;
  decisionSource: 'manual' | 'automation' | null;
}> {
  const [header] = await conn
    .select()
    .from(orderHazmatDeclarations)
    .where(eq(orderHazmatDeclarations.orderId, orderId))
    .limit(1);
  if (!header) {
    return { declaration: null, revision: 0, semanticHash: null, decisionSource: null };
  }
  const materials = await conn
    .select()
    .from(orderHazmatMaterials)
    .where(eq(orderHazmatMaterials.orderId, orderId))
    .orderBy(orderHazmatMaterials.sequence);
  const declaration: NormalizedHazmatDeclaration = {
    schemaVersion: 1,
    status: header.status,
    limitedQuantity: header.limitedQuantity === true,
    containsBattery: header.containsBattery === true,
    dryIce: header.dryIce === true,
    dryIceWeightValue: numberOrNull(header.dryIceWeightValue),
    dryIceWeightUnit: header.dryIceWeightUnit,
    emergencyContactName: header.emergencyContactName,
    emergencyContactPhone: header.emergencyContactPhone,
    uspsCategory: header.uspsCategory,
    uspsPackageLevel: header.uspsPackageLevel,
    regulatedContentType: header.regulatedContentType,
    materials: materials.map(materialFromRow),
  };
  return {
    declaration,
    revision: header.revision,
    semanticHash: header.semanticHash,
    decisionSource: header.decisionSource,
  };
}

async function loadFrozenPurchaseFacts(orderId: number): Promise<CanonicalHazmatPurchaseFacts | null> {
  // Per user override unlock shipped data on 2026-07-25: read only the additive,
  // immutable PS-465 snapshot sidecar; shipment history is never rewritten.
  const [row] = await db
    .select({
      snapshotJson: shipmentHazmatSnapshots.snapshotJson,
      snapshotHash: shipmentHazmatSnapshots.snapshotHash,
      revision: shipmentHazmatSnapshots.orderDeclarationRevision,
      profile: shipmentHazmatSnapshots.summaryProfile,
      isHazmat: shipmentHazmatSnapshots.summaryIsHazmat,
    })
    .from(shipmentHazmatSnapshots)
    .innerJoin(shipments, eq(shipments.id, shipmentHazmatSnapshots.shipmentId))
    .where(eq(shipments.orderId, orderId))
    .orderBy(desc(shipments.id))
    .limit(1);
  if (!row) return null;
  const profileValues: HazmatProfile[] = [
    'shipstation_usps',
    'shipstation_ups_dry_ice',
    'shipstation_ups_dangerous_goods',
    'ups_direct',
    'walmart',
  ];
  const candidate = row.snapshotJson as Partial<CanonicalHazmatPurchaseFacts> | null;
  if (
    row.isHazmat !== true
    || !candidate?.declaration
    || !profileValues.includes(row.profile as HazmatProfile)
  ) {
    throw new OrderHazmatError(
      'The immutable hazmat snapshot is invalid.',
      'HAZMAT_SNAPSHOT_INVALID',
      409,
    );
  }
  try {
    const sealed = sealHazmatDeclaration({
      declaration: candidate.declaration,
      revision: row.revision,
      profile: row.profile as HazmatProfile,
    });
    if (
      candidate.revision !== row.revision
      || candidate.profile !== row.profile
      || candidate.declarationHash !== hazmatSemanticHash(candidate.declaration)
      || candidate.snapshotHash !== row.snapshotHash
      || sealed.snapshotHash !== row.snapshotHash
    ) {
      throw new Error('snapshot seal mismatch');
    }
    return sealed;
  } catch {
    throw new OrderHazmatError(
      'The immutable hazmat snapshot failed integrity verification.',
      'HAZMAT_SNAPSHOT_INVALID',
      409,
    );
  }
}

async function loadOrderRow(
  orderId: number,
  scope: ClientStoreScope,
  options: { forUpdate?: boolean; tx?: DbTransaction } = {},
): Promise<HazmatOrderRow> {
  const conn = options.tx ?? db;
  let query = conn
    .select({
      id: orders.id,
      clientId: orders.clientId,
      storeId: orders.storeId,
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      externallyShipped: orders.externallyShipped,
      bestRateJson: orderOverrides.bestRateJson,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(orderWhere(orderId, scope))
    .limit(1);
  const rows = options.forUpdate ? await query.for('update') : await query;
  const row = rows[0];
  if (!row) throw new OrderHazmatError('Order not found', 'ORDER_NOT_FOUND', 404);
  return row;
}

function publicState(input: {
  order: HazmatOrderRow;
  declaration: NormalizedHazmatDeclaration | null;
  revision: number;
  semanticHash: string | null;
  decisionSource: 'manual' | 'automation' | null;
  frozenPurchaseFacts?: CanonicalHazmatPurchaseFacts | null;
}): OrderHazmatState {
  const capabilities = resolveHazmatCapabilities({ clientId: input.order.clientId });
  const declaration = capabilities.featureEnabled ? input.declaration : null;
  const validation = declaration
    ? validateHazmatDeclaration(declaration)
    : { valid: true, issues: [] };
  return {
    orderId: input.order.id,
    clientId: input.order.clientId,
    storeId: input.order.storeId,
    declaration,
    revision: capabilities.featureEnabled ? input.revision : 0,
    semanticHash: capabilities.featureEnabled ? input.semanticHash : null,
    decisionSource: capabilities.featureEnabled ? input.decisionSource : null,
    capabilities,
    validation,
    requiresRerate: declaration?.status === 'active' && input.order.bestRateJson == null,
    frozenPurchaseFacts: capabilities.featureEnabled ? input.frozenPurchaseFacts ?? null : null,
  };
}

export async function getOrderHazmat(
  orderId: number,
  scope: ClientStoreScope,
): Promise<OrderHazmatState> {
  await assertRuntimeSchemaReady();
  const order = await loadOrderRow(orderId, scope);
  if (!resolveHazmatCapabilities({ clientId: order.clientId }).featureEnabled) {
    return publicState({
      order,
      declaration: null,
      revision: 0,
      semanticHash: null,
      decisionSource: null,
      frozenPurchaseFacts: null,
    });
  }
  const current = await loadDeclaration(db, orderId);
  return publicState({
    order,
    ...current,
    frozenPurchaseFacts: await loadFrozenPurchaseFacts(orderId),
  });
}

export async function getOrderHazmatForShipping(orderId: number): Promise<{
  declaration: NormalizedHazmatDeclaration | null;
  revision: number;
  semanticHash: string | null;
  decisionSource: 'manual' | 'automation' | null;
  validation: HazmatValidationResult;
  capabilities: HazmatCapabilities;
  clientId: number | null;
}> {
  await assertRuntimeSchemaReady();
  const [order] = await db
    .select({ id: orders.id, clientId: orders.clientId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw new OrderHazmatError('Order not found', 'ORDER_NOT_FOUND', 404);
  const current = await loadDeclaration(db, orderId);
  const capabilities = resolveHazmatCapabilities({ clientId: order.clientId });
  return {
    // Internal shipping reads deliberately retain a persisted declaration when
    // rollout flags are disabled. The policy layer must see it and fail closed;
    // hiding it here could purchase an undeclared legacy label after a kill switch.
    declaration: current.declaration,
    revision: current.revision,
    semanticHash: current.semanticHash,
    decisionSource: current.decisionSource,
    clientId: order.clientId,
    validation: current.declaration
      ? validateHazmatDeclaration(current.declaration)
      : { valid: true, issues: [] },
    capabilities,
  };
}

export async function validateOrderHazmatDraft(input: {
  orderId: number;
  expectedRevision: number;
  declaration: HazmatDeclarationInput;
  scope: ClientStoreScope;
}): Promise<{
  declaration: NormalizedHazmatDeclaration;
  validation: HazmatValidationResult;
  semanticHash: string;
  revision: number;
  capabilities: HazmatCapabilities;
}> {
  await assertRuntimeSchemaReady();
  const order = await loadOrderRow(input.orderId, input.scope);
  const current = await loadDeclaration(db, input.orderId);
  if (input.expectedRevision !== current.revision) {
    throw new OrderHazmatError(
      'Hazmat declaration changed. Reload before validating.',
      'HAZMAT_REVISION_CONFLICT',
      409,
      { expectedRevision: input.expectedRevision, currentRevision: current.revision },
    );
  }
  const result = normalizeAndValidateHazmatDeclaration(input.declaration);
  const capabilities = resolveHazmatCapabilities({ clientId: order.clientId });
  if (!capabilities.writeEnabled) {
    throw new OrderHazmatError('Hazmat declaration writes are disabled.', 'HAZMAT_WRITE_DISABLED', 403);
  }
  return {
    ...result,
    semanticHash: hazmatSemanticHash(result.declaration),
    revision: current.revision,
    capabilities,
  };
}

function assertEditable(order: HazmatOrderRow): void {
  const lifecycle = resolveOrderLifecycleStatus(order);
  if (lifecycle.isTerminal) {
    throw new OrderHazmatError(
      `Hazmat declaration is immutable for ${lifecycle.orderLifecycleLabel.toLowerCase()} orders.`,
      'HAZMAT_ORDER_TERMINAL',
      409,
      { lifecycle: lifecycle.orderLifecycleStatus },
    );
  }
}

function materialInsertValues(orderId: number, material: NormalizedHazmatMaterial) {
  return {
    orderId,
    sequence: material.sequence,
    unNaNumber: material.unNaNumber,
    properShippingName: material.properShippingName,
    technicalName: material.technicalName,
    hazardClass: material.hazardClass,
    subsidiaryHazardClass: material.subsidiaryHazardClass,
    packingGroup: material.packingGroup,
    amount: material.amount == null ? null : String(material.amount),
    amountUnit: material.amountUnit,
    quantity: material.quantity,
    packagingInstruction: material.packagingInstruction,
    packagingInstructionSection: material.packagingInstructionSection,
    packagingType: material.packagingType,
    transportMean: material.transportMean,
    transportCategory: material.transportCategory,
    regulationAuthority: material.regulationAuthority,
    regulationLevel: material.regulationLevel,
    radioactive: material.radioactive,
    reportableQuantity: material.reportableQuantity,
    additionalDescription: material.additionalDescription,
  };
}

async function saveInTransaction(
  tx: DbTransaction,
  input: {
    orderId: number;
    expectedRevision: number;
    declaration: HazmatDeclarationInput;
    scope: ClientStoreScope;
    actor: AuditActor;
    decisionSource?: 'manual' | 'automation';
  },
): Promise<SaveOrderHazmatResult> {
  const order = await loadOrderRow(input.orderId, input.scope, { forUpdate: true, tx });
  assertEditable(order);
  const flags = currentHazmatFeatureFlags();
  const capabilities = resolveHazmatCapabilities({ clientId: order.clientId, flags });
  if (!capabilities.writeEnabled) {
    throw new OrderHazmatError('Hazmat declaration writes are disabled.', 'HAZMAT_WRITE_DISABLED', 403);
  }
  const current = await loadDeclaration(tx, input.orderId);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new OrderHazmatError('expectedRevision must be a non-negative integer.', 'HAZMAT_REVISION_INVALID');
  }
  if (input.expectedRevision !== current.revision) {
    throw new OrderHazmatError(
      'Hazmat declaration changed. Reload before saving.',
      'HAZMAT_REVISION_CONFLICT',
      409,
      { expectedRevision: input.expectedRevision, currentRevision: current.revision },
    );
  }

  const { declaration, validation } = normalizeAndValidateHazmatDeclaration(input.declaration);
  if (!validation.valid) {
    throw new OrderHazmatError(
      'Hazmat declaration is invalid.',
      'HAZMAT_DECLARATION_INVALID',
      422,
      { issues: validation.issues },
    );
  }
  const semanticHash = hazmatSemanticHash(declaration);
  if (current.semanticHash === semanticHash && current.declaration) {
    return {
      ...publicState({ order, ...current }),
      capabilities,
      changed: false,
      invalidatedRate: false,
    };
  }

  const now = new Date();
  const revision = current.revision + 1;
  const decisionSource = input.decisionSource ?? 'manual';
  await tx
    .insert(orderHazmatDeclarations)
    .values({
      orderId: input.orderId,
      schemaVersion: declaration.schemaVersion,
      revision,
      status: declaration.status,
      decisionSource,
      limitedQuantity: declaration.limitedQuantity,
      containsBattery: declaration.containsBattery,
      dryIce: declaration.dryIce,
      dryIceWeightValue: declaration.dryIceWeightValue == null ? null : String(declaration.dryIceWeightValue),
      dryIceWeightUnit: declaration.dryIceWeightUnit,
      emergencyContactName: declaration.emergencyContactName,
      emergencyContactPhone: declaration.emergencyContactPhone,
      uspsCategory: declaration.uspsCategory,
      uspsPackageLevel: declaration.uspsPackageLevel,
      regulatedContentType: declaration.regulatedContentType,
      semanticHash,
      createdByUserId: input.actor.actorId ?? null,
      createdByEmail: input.actor.actorEmail ?? null,
      updatedByUserId: input.actor.actorId ?? null,
      updatedByEmail: input.actor.actorEmail ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orderHazmatDeclarations.orderId,
      set: {
        schemaVersion: declaration.schemaVersion,
        revision,
        status: declaration.status,
        decisionSource,
        limitedQuantity: declaration.limitedQuantity,
        containsBattery: declaration.containsBattery,
        dryIce: declaration.dryIce,
        dryIceWeightValue: declaration.dryIceWeightValue == null ? null : String(declaration.dryIceWeightValue),
        dryIceWeightUnit: declaration.dryIceWeightUnit,
        emergencyContactName: declaration.emergencyContactName,
        emergencyContactPhone: declaration.emergencyContactPhone,
        uspsCategory: declaration.uspsCategory,
        uspsPackageLevel: declaration.uspsPackageLevel,
        regulatedContentType: declaration.regulatedContentType,
        semanticHash,
        updatedByUserId: input.actor.actorId ?? null,
        updatedByEmail: input.actor.actorEmail ?? null,
        updatedAt: now,
      },
    });
  await tx.delete(orderHazmatMaterials).where(eq(orderHazmatMaterials.orderId, input.orderId));
  if (declaration.materials.length > 0) {
    await tx.insert(orderHazmatMaterials).values(
      declaration.materials.map((material) => materialInsertValues(input.orderId, material)),
    );
  }

  const invalidatedRate = order.bestRateJson != null;
  if (invalidatedRate) {
    await tx
      .update(orderOverrides)
      .set({ bestRateJson: null, bestRateAt: null, bestRateDims: null, updatedAt: now })
      .where(eq(orderOverrides.orderId, input.orderId));
  }
  await recordRequiredAuditEventInTransaction(tx, {
    ...input.actor,
    eventType: 'order.hazmat.updated',
    resourceType: 'order',
    resourceId: input.orderId,
    action: 'hazmat_declaration_saved',
    details: {
      previousRevision: current.revision,
      revision,
      previousSemanticHash: current.semanticHash,
      semanticHash,
      previousDecisionSource: current.decisionSource,
      decisionSource,
      summary: summarizeHazmatDeclaration(declaration),
      invalidatedRate,
    },
  });

  return {
    ...publicState({
      order: { ...order, bestRateJson: invalidatedRate ? null : order.bestRateJson },
      declaration,
      revision,
      semanticHash,
      decisionSource,
    }),
    capabilities,
    changed: true,
    invalidatedRate,
  };
}

export async function saveOrderHazmatDeclaration(input: {
  orderId: number;
  expectedRevision: number;
  declaration: HazmatDeclarationInput;
  scope: ClientStoreScope;
  actor: AuditActor;
  decisionSource?: 'manual' | 'automation';
}): Promise<SaveOrderHazmatResult> {
  await assertRuntimeSchemaReady();
  await loadOrderRow(input.orderId, input.scope);
  const purchaseLock = await acquireLabelPurchaseLock(input.orderId);
  try {
    const operation = await getLatestLabelOperationForOrder(input.orderId);
    if (operation && operation.state !== 'consumed') {
      throw new OrderHazmatError(
        'Hazmat cannot change while a label operation is unresolved.',
        'HAZMAT_LABEL_OPERATION_UNRESOLVED',
        409,
        { operationState: operation.state },
      );
    }
    return await db.transaction((tx) => saveInTransaction(tx, input));
  } finally {
    await purchaseLock.release();
  }
}

export function legacyUnsetHazmatDeclaration(): NormalizedHazmatDeclaration {
  return normalizeHazmatDeclaration({ status: 'clear' });
}
