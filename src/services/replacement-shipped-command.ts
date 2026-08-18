/**
 * PS-502 — the ONE function that writes replacement status `shipped`.
 *
 * REQUIRES `unlock shipped data`. This is the transition that consumes stock and commits
 * money, and it is the only place in the codebase permitted to write that status. A guard
 * fails if any route or second service does.
 *
 * ATOMIC OR NOTHING
 *
 * Drift re-check, inventory deduction, package consumption, billing (or authoritative proof
 * that none is owed), `shipped_at`, the state version and the activity event all commit in
 * ONE transaction. Any failure rolls back everything.
 *
 * Splitting them is how stock leaves the warehouse with no billing row behind it — the exact
 * shape of the PS-497/PS-505 inventory leak, where a partial success looked like a success.
 *
 * INVENTORY IDENTITY IS REPLACEMENT-SCOPED
 *
 * `replacement:<id>:shipment:<id>:item:<itemId>:inventory:<invId>:ship`, keyed to the
 * replacement ITEM rather than the SKU. Reusing the ordinary
 * `inventory:ship:order:<orderId>:inventory:<invId>` key makes the ledger treat the deduction
 * as already applied — the original order already shipped under it — so stock silently
 * inflates while every row looks correct.
 *
 * Keying on the item rather than the SKU is what keeps duplicate-SKU replacement lines
 * independently attributable: two lines of the same product must deduct twice, and a
 * SKU-keyed identity would collapse them into one.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../lib/env.js';
import {
  replacementActivityEvents,
  replacementItems,
  replacementLabelPurchaseIntents,
  replacements,
  type ReplacementRow,
} from '../db/schema/replacements';
import { applyInventoryMovementInTransaction } from './inventory-movement';
import { findFrozenLineDrift } from './replacement-drift-resolution';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

export type ReplacementShippedErrorCode =
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_NOT_SHIPPABLE'
  | 'REPLACEMENT_STATE_CONFLICT'
  | 'REPLACEMENT_SOURCE_LINE_CHANGED'
  | 'REPLACEMENT_INVENTORY_DISABLED'
  | 'REPLACEMENT_LABEL_NOT_ACTIVE'
  | 'REPLACEMENT_PACKAGE_UNRESOLVED'
  | 'REPLACEMENT_BILLING_UNRESOLVED'
  | 'REPLACEMENT_INVENTORY_UNRESOLVED';

export class ReplacementShippedError extends Error {
  constructor(
    readonly code: ReplacementShippedErrorCode,
    message: string,
    readonly httpStatus: 400 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementShippedError';
  }
}

/**
 * How a replacement item maps onto stock.
 *
 * Supplied by the caller rather than resolved here: SKU-to-inventory resolution is an existing
 * owner's job, and this command must not become a second one. A line with no mapping FAILS
 * rather than shipping silently unaccounted.
 */
export type ReplacementInventoryLine = {
  replacementItemId: number;
  inventoryId: number;
  qty: number;
  name?: string | null;
};

/**
 * Package consumption, injected.
 *
 * DJ decision 3 (package authority) is not frozen, so this command must not choose. It calls
 * what it is given and fails closed when given nothing — an unresolved package blocks
 * shipping rather than being silently skipped.
 */
export type ReplacementPackageConsumer = (tx: unknown, input: {
  replacementId: number;
  shipmentId: number;
}) => Promise<{ consumed: boolean; reason?: string }>;

/**
 * Billing, injected — item 8 owns the planner.
 *
 * A BILLABLE replacement with no planner FAILS. "Billing lines, or authoritative proof that
 * none is owed, established before the state transition" is not satisfied by shipping first
 * and billing later: the goods are gone and the only record of what was owed left with them.
 */
export type ReplacementBillingWriter = (tx: unknown, input: {
  replacement: ReplacementRow;
  shipmentId: number;
}) => Promise<{ linesWritten: number }>;

export type ShipReplacementInput = {
  replacementId: number;
  actor: { email: string | null; type: string };
  /** One entry per replacement item. Every item must be represented. */
  inventoryLines: readonly ReplacementInventoryLine[];
  consumePackage?: ReplacementPackageConsumer;
  writeBilling?: ReplacementBillingWriter;
};

export type ShipReplacementResult = {
  replacement: ReplacementRow;
  inventoryApplied: number;
  inventoryAlreadyApplied: number;
  billingLinesWritten: number;
  /** False when the replacement was already shipped and nothing was re-applied. */
  shipped: boolean;
};

type Conn = Pick<typeof db, 'transaction'>;

/** The replacement-scoped ledger identity. Never the ordinary order key. */
export function replacementInventoryIdempotencyKey(input: {
  replacementId: number;
  shipmentId: number;
  replacementItemId: number;
  inventoryId: number;
}): string {
  return `replacement:${input.replacementId}:shipment:${input.shipmentId}` +
    `:item:${input.replacementItemId}:inventory:${input.inventoryId}:ship`;
}

export async function shipReplacement(
  input: ShipReplacementInput,
  conn: Conn = db,
): Promise<ShipReplacementResult> {
  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);

    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);
    if (!replacement) {
      throw new ReplacementShippedError(
        'REPLACEMENT_NOT_FOUND', `replacement ${input.replacementId} does not exist`,
      );
    }

    // Retry is a no-op. Reaching the deduction again would double-deduct even with a keyed
    // ledger, because the package and billing writers are not all idempotent.
    if (replacement.status === 'shipped' || replacement.status === 'completed') {
      return {
        replacement: replacement as ReplacementRow,
        inventoryApplied: 0, inventoryAlreadyApplied: 0, billingLinesWritten: 0, shipped: false,
      };
    }

    if (replacement.status !== 'label_created') {
      throw new ReplacementShippedError(
        'REPLACEMENT_NOT_SHIPPABLE',
        `a replacement ships from label_created; ${replacement.reference} is ${replacement.status}`,
        409, { status: replacement.status },
      );
    }
    if (replacement.replacementShipmentId == null) {
      throw new ReplacementShippedError(
        'REPLACEMENT_NOT_SHIPPABLE', `${replacement.reference} has no shipment`,
      );
    }

    // The kill switch, BEFORE any write. Shipping while auto-deduct is off would move goods
    // with no ledger entry, which is precisely the drift PS-497 spent months reconciling.
    if (env.INVENTORY_AUTO_DEDUCT !== true) {
      throw new ReplacementShippedError(
        'REPLACEMENT_INVENTORY_DISABLED',
        'INVENTORY_AUTO_DEDUCT is off, so this replacement cannot deduct stock and must not ' +
          'ship. It stays at label_created with no inventory, package or billing row.',
        409,
      );
    }

    // An active, non-voided receipt. A voided label is not a shipment.
    const [intent] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1);
    if (!intent || intent.voidState === 'voided') {
      throw new ReplacementShippedError(
        'REPLACEMENT_LABEL_NOT_ACTIVE',
        `${replacement.reference} has no active purchased label` +
          (intent?.voidState === 'voided' ? ' — its label was voided' : ''),
      );
    }

    const drift = await findFrozenLineDrift(tx, replacement);
    if (drift) {
      throw new ReplacementShippedError(
        'REPLACEMENT_SOURCE_LINE_CHANGED',
        `the source line at index ${drift.effectiveOrderLineIndex} moved. Nothing was deducted.`,
        409, { replacementItemId: drift.replacementItemId },
      );
    }

    // Every item must be accounted for. A missing mapping would ship goods with no ledger row
    // and nothing would say so.
    const items = await tx.select().from(replacementItems)
      .where(eq(replacementItems.replacementId, replacement.id));
    const mapped = new Set(input.inventoryLines.map((line) => line.replacementItemId));
    const unmapped = (items as Array<{ id: number }>).filter((item) => !mapped.has(item.id));
    if (unmapped.length > 0) {
      throw new ReplacementShippedError(
        'REPLACEMENT_INVENTORY_UNRESOLVED',
        `${unmapped.length} replacement item(s) have no inventory mapping. Shipping would move ` +
          'goods with no ledger entry.',
        400, { replacementItemIds: unmapped.map((i) => i.id) },
      );
    }

    let applied = 0;
    let alreadyApplied = 0;
    for (const line of input.inventoryLines) {
      const movement = await applyInventoryMovementInTransaction(tx as never, {
        inventoryId: line.inventoryId,
        type: 'ship',
        qty: -Math.abs(Math.trunc(line.qty)),
        note: `Replacement ${replacement.reference} / shipment ${replacement.replacementShipmentId}`,
        createdBy: input.actor.email ?? 'replacement',
        effectiveAt: new Date(),
        idempotencyKey: replacementInventoryIdempotencyKey({
          replacementId: replacement.id,
          shipmentId: replacement.replacementShipmentId,
          replacementItemId: line.replacementItemId,
          inventoryId: line.inventoryId,
        }),
        sourceEntity: 'shipment',
        sourceId: String(replacement.replacementShipmentId),
        nameIfMissing: line.name ?? undefined,
      } as never);
      if ((movement as { status?: string })?.status === 'already_applied') alreadyApplied += 1;
      else applied += 1;
    }

    // Package authority is DJ decision 3. Absent a consumer this fails closed rather than
    // shipping without accounting for the box.
    if (!input.consumePackage) {
      throw new ReplacementShippedError(
        'REPLACEMENT_PACKAGE_UNRESOLVED',
        'no package consumer was supplied. DJ decision 3 (package authority) is unfrozen, and ' +
          'silently skipping consumption would ship a box nothing accounted for.',
        400,
      );
    }
    const pkg = await input.consumePackage(tx, {
      replacementId: replacement.id,
      shipmentId: replacement.replacementShipmentId,
    });
    if (!pkg.consumed) {
      throw new ReplacementShippedError(
        'REPLACEMENT_PACKAGE_UNRESOLVED',
        `package consumption did not complete${pkg.reason ? `: ${pkg.reason}` : ''}. ` +
          'Shipping is blocked rather than silently skipping it.',
      );
    }

    // Billing BEFORE the transition. A billable replacement with no writer fails: shipping
    // first and billing later means the goods are gone and the record of what was owed left
    // with them.
    let billingLinesWritten = 0;
    if (replacement.billable) {
      if (!input.writeBilling) {
        throw new ReplacementShippedError(
          'REPLACEMENT_BILLING_UNRESOLVED',
          `${replacement.reference} is billable but no billing writer was supplied. Billing ` +
            'lines must exist before the state transition, not after it.',
          400,
        );
      }
      const billing = await input.writeBilling(tx, {
        replacement: replacement as ReplacementRow,
        shipmentId: replacement.replacementShipmentId,
      });
      billingLinesWritten = billing.linesWritten;
      if (billingLinesWritten <= 0) {
        throw new ReplacementShippedError(
          'REPLACEMENT_BILLING_UNRESOLVED',
          `${replacement.reference} is billable but the writer produced no lines`,
        );
      }
    }

    const moved = await tx.update(replacements)
      .set({
        status: 'shipped',
        shippedAt: new Date(),
        stateVersion: replacement.stateVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacements.id, replacement.id),
        eq(replacements.status, replacement.status),
        eq(replacements.stateVersion, replacement.stateVersion),
      ))
      .returning();
    if (moved.length === 0) {
      throw new ReplacementShippedError(
        'REPLACEMENT_STATE_CONFLICT',
        `${replacement.reference} moved under this request; nothing was committed`,
      );
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: replacement.id,
      shipmentId: replacement.replacementShipmentId,
      eventType: 'replacement_shipped',
      fromStatus: replacement.status,
      toStatus: 'shipped',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      idempotencyKey: `replacement:${replacement.id}:shipped:v${replacement.stateVersion}`,
    });

    return {
      replacement: moved[0] as ReplacementRow,
      inventoryApplied: applied,
      inventoryAlreadyApplied: alreadyApplied,
      billingLinesWritten,
      shipped: true,
    };
  });
}
