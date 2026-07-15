// Per user override unlock shipped data on 2026-07-14: order override and Best Rate
// commands moved here unchanged; routes/orders.ts still owns auth, scope, and lockdown guards.
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { orderOverrides, orders } from '../db/schema/orders';
import { packages } from '../db/schema/packages';
import { boxDimsKey } from './billing-box-policy';
import { clientHouseAccountEnabled } from './house-account-opt-in';
import {
  assertPersistedOrderBestRateDto,
  InputValidationError,
} from './order-rate-dto';
import { ensureOrderRecipientOverrideSchema } from './order-recipient-override';
import {
  orderShippingEligibilityContext,
  shippingRateEligibilityReason,
} from './orders-read-model';
import {
  applyRateQuoteRef,
  buildApplyBestRatePatch,
  finalizeAppliedBestRateFromSnapshot,
  validateBestRateDimsForPersistedRate,
} from './shipping-workflow/apply-best-rate';
import {
  HOUSE_TUPLE_REQUIRED_MESSAGE,
  houseTupleStatus,
  shouldRejectHalfHouseSave,
} from './shipping-workflow/house-tuple-save-policy';
import { stampHouseTuple } from './shipping-workflow/house-tuple-stamp';
import { loadRateQuoteSnapshot } from './shipping-workflow/rate-quote-snapshot-store';
import {
  withOrderEditableWrite,
  type OrderEditWriteAuthorization,
  type OrderEditWriteFailure,
  type OrderEditWriteResult,
  type OrderEditWriteTransaction,
} from './order-editable-write';

type OrderCommandFailure = {
  ok: false;
  status: 400 | 403 | 404;
  error: string;
  code?: string;
};

type OrderCommandSuccess = {
  ok: true;
  row: typeof orderOverrides.$inferSelect;
};

export type OrderCommandResult = OrderCommandSuccess | OrderCommandFailure;

export type ApplyBestRateCommandInput = {
  bestRateJson: unknown;
  bestRateDims?: string | null;
  selectedPid?: number | null;
  weightOz?: number | null;
  currentRequestFingerprint?: string | null;
};

export type SaveBestRateCommandInput = {
  bestRateJson: unknown | null;
  bestRateDims?: string | null;
};

type OrderOverridesPatch = Partial<typeof orderOverrides.$inferInsert>;
type OrderOverridesWriteResult = OrderEditWriteResult<typeof orderOverrides.$inferSelect>;

function commandFailureFromWrite(failure: OrderEditWriteFailure): OrderCommandFailure {
  if (failure.reason === 'not_found') {
    return { ok: false, status: 404, error: 'Order not found' };
  }
  return {
    ok: false,
    status: 403,
    error: `Cannot modify a ${failure.lifecycle.orderLifecycleStatus} order — historical records are locked.`,
    code: 'ORDER_LOCKED',
  };
}

async function persistOrderOverridesPatch(
  tx: OrderEditWriteTransaction,
  id: number,
  patch: OrderOverridesPatch,
): Promise<typeof orderOverrides.$inferSelect> {
  const bestRateAt = patch.bestRateJson === undefined
    ? undefined
    : patch.bestRateJson === null
      ? null
      : new Date();
  const [row] = await tx
    .insert(orderOverrides)
    .values({ orderId: id, ...patch, bestRateAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orderOverrides.orderId,
      set: { ...patch, bestRateAt, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error(`Order override write returned no row for order ${id}`);
  return row;
}

// PS-207 (B): package selection and dimensions are one override command concern.
export async function applyBoxDimsCoherence(
  patch: Partial<typeof orderOverrides.$inferInsert>,
): Promise<
  | { ok: true; patch: Partial<typeof orderOverrides.$inferInsert> }
  | { ok: false; error: string }
> {
  const rawPkg =
    patch.selectedPackageId !== undefined && patch.selectedPackageId !== null
      ? String(patch.selectedPackageId).trim()
      : null;
  const l = patch.rateDimsL;
  const w = patch.rateDimsW;
  const h = patch.rateDimsH;
  const dimsKey = boxDimsKey(
    typeof l === 'number' ? l : null,
    typeof w === 'number' ? w : null,
    typeof h === 'number' ? h : null,
  );
  if (!rawPkg && !dimsKey) return { ok: true, patch };

  const pkgRows = await db
    .select({
      id: packages.id,
      name: packages.name,
      packageCode: packages.packageCode,
      length: packages.length,
      width: packages.width,
      height: packages.height,
    })
    .from(packages);
  const byId = new Map(pkgRows.map((pkg) => [pkg.id, pkg]));
  const byCode = new Map(
    pkgRows.filter((pkg) => pkg.packageCode).map((pkg) => [pkg.packageCode!, pkg]),
  );
  const byDims = new Map(
    pkgRows
      .map((pkg) => [boxDimsKey(pkg.length, pkg.width, pkg.height), pkg] as const)
      .filter((entry): entry is [string, (typeof pkgRows)[number]] => entry[0] !== null),
  );

  let explicitPkg: (typeof pkgRows)[number] | null = null;
  if (rawPkg) {
    const asInt = Number.parseInt(rawPkg, 10);
    if (Number.isFinite(asInt) && String(asInt) === rawPkg) {
      explicitPkg = byId.get(asInt) ?? null;
    }
    if (!explicitPkg) explicitPkg = byCode.get(rawPkg) ?? null;
    if (!explicitPkg) return { ok: true, patch };
  }

  if (explicitPkg && dimsKey) {
    const pkgKey = boxDimsKey(explicitPkg.length, explicitPkg.width, explicitPkg.height);
    if (pkgKey && pkgKey !== dimsKey) {
      return {
        ok: false,
        error: `Selected box (${explicitPkg.name ?? pkgKey} ${pkgKey}) disagrees with the entered dims (${dimsKey}) — pick the matching box or fix the dims`,
      };
    }
    return { ok: true, patch };
  }

  if (explicitPkg) {
    const pkgKey = boxDimsKey(explicitPkg.length, explicitPkg.width, explicitPkg.height);
    if (!pkgKey) return { ok: true, patch };
    return {
      ok: true,
      patch: {
        ...patch,
        rateDimsL: explicitPkg.length,
        rateDimsW: explicitPkg.width,
        rateDimsH: explicitPkg.height,
      },
    };
  }

  const match = byDims.get(dimsKey!);
  if (match && patch.selectedPackageId === undefined) {
    return { ok: true, patch: { ...patch, selectedPackageId: String(match.id) } };
  }
  return { ok: true, patch };
}

export async function applyOrderOverridesPatch(
  id: number,
  patch: OrderOverridesPatch,
  authorization: OrderEditWriteAuthorization,
): Promise<OrderOverridesWriteResult> {
  await ensureOrderRecipientOverrideSchema();
  return withOrderEditableWrite(id, authorization, (tx) =>
    persistOrderOverridesPatch(tx, id, patch));
}

export async function applyEditableOrderPatch(
  id: number,
  input: {
    externallyShipped?: boolean;
    overridesPatch: OrderOverridesPatch;
  },
  authorization: OrderEditWriteAuthorization,
): Promise<OrderOverridesWriteResult> {
  await ensureOrderRecipientOverrideSchema();
  return withOrderEditableWrite(id, authorization, async (tx) => {
    if (input.externallyShipped !== undefined) {
      await tx
        .update(orders)
        .set({ externallyShipped: input.externallyShipped, updatedAt: new Date() })
        .where(eq(orders.id, id));
    }
    return persistOrderOverridesPatch(tx, id, input.overridesPatch);
  });
}

export async function applyBestRateForOrder(
  id: number,
  body: ApplyBestRateCommandInput,
  authorization: OrderEditWriteAuthorization,
): Promise<OrderCommandResult> {
  // Per user override unlock shipped data on 2026-07-15: read destination
  // evidence so the canonical eligibility owner can reject PO Box carrier mismatches.
  const [existing] = await db
    .select({
      id: orders.id,
      clientId: orders.clientId,
      storeId: orders.storeId,
      raw: orders.raw,
      recipientOverride: orderOverrides.recipientOverride,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(eq(orders.id, id))
    .limit(1);
  if (!existing) return { ok: false, status: 404, error: 'Order not found' };

  const quoteRef = applyRateQuoteRef(body.bestRateJson);
  const quoteSnapshot = quoteRef.rateQuoteId && quoteRef.selectedRateKey
    ? await loadRateQuoteSnapshot(quoteRef.rateQuoteId)
    : null;
  const finalized = finalizeAppliedBestRateFromSnapshot({
    rateQuoteId: quoteRef.rateQuoteId,
    selectedRateKey: quoteRef.selectedRateKey,
    snapshot: quoteSnapshot,
  });
  if (!finalized.ok) {
    return { ok: false, status: 400, error: finalized.error, code: finalized.code };
  }

  let bestRateJsonForApply = finalized.bestRateJson;
  if (
    finalized.source === 'snapshot' &&
    quoteSnapshot?.bestRateKey &&
    quoteRef.selectedRateKey === quoteSnapshot.bestRateKey
  ) {
    bestRateJsonForApply = await stampHouseTuple(bestRateJsonForApply, {
      cheapest: bestRateJsonForApply as never,
      combinedRates: quoteSnapshot.rates as never,
      clientId: existing.clientId,
      storeId: existing.storeId,
    });
  }

  const built = buildApplyBestRatePatch({
    bestRateJson: bestRateJsonForApply,
    dimsLabel: body.bestRateDims ?? null,
    selectedPid: body.selectedPid ?? null,
    weightOz: body.weightOz ?? null,
    currentRequestFingerprint: body.currentRequestFingerprint ?? null,
  });
  if (!built.ok) {
    return { ok: false, status: 400, error: built.error, code: built.code };
  }

  let normalizedBestRate: unknown;
  try {
    normalizedBestRate = assertPersistedOrderBestRateDto(built.patch.bestRateJson, 'bestRateJson');
  } catch (err) {
    return { ok: false, status: 400, error: (err as Error).message };
  }
  const eligibilityReason = shippingRateEligibilityReason(
    orderShippingEligibilityContext(existing),
    normalizedBestRate,
  );
  if (eligibilityReason) {
    return { ok: false, status: 400, error: eligibilityReason, code: 'RATE_NOT_ELIGIBLE' };
  }

  const canonicalBestRate = normalizedBestRate as {
    nextBestNonHouseRate?: unknown;
    houseMargin?: number | null;
    houseTupleStatus?: unknown;
  };
  const rawBody = built.patch.bestRateJson as Record<string, unknown> | null;
  const rawHouseProvider =
    (rawBody?.provider ?? (rawBody?.raw as Record<string, unknown> | undefined)?.provider) ?? null;
  const hStatus = houseTupleStatus({
    rawProvider: rawHouseProvider,
    nextBestNonHouseRate: canonicalBestRate.nextBestNonHouseRate,
    houseMargin: canonicalBestRate.houseMargin,
    optedIn: await clientHouseAccountEnabled(existing.clientId ?? null),
  });
  if (shouldRejectHalfHouseSave(hStatus) && process.env.HOUSE_TUPLE_SAVE_GUARD === 'on') {
    return {
      ok: false,
      status: 400,
      error: HOUSE_TUPLE_REQUIRED_MESSAGE,
      code: 'HOUSE_TUPLE_REQUIRED',
    };
  }
  canonicalBestRate.houseTupleStatus = hStatus;

  const row = await applyOrderOverridesPatch(id, {
    ...built.patch,
    bestRateJson: canonicalBestRate,
  }, authorization);
  return row.ok ? { ok: true, row: row.value } : commandFailureFromWrite(row);
}

export async function saveBestRateForOrder(
  id: number,
  body: SaveBestRateCommandInput,
  authorization: OrderEditWriteAuthorization,
): Promise<OrderCommandResult> {
  if (body.bestRateJson === null) {
    const row = await applyOrderOverridesPatch(id, {
      bestRateJson: null,
      bestRateDims: null,
    }, authorization);
    return row.ok ? { ok: true, row: row.value } : commandFailureFromWrite(row);
  }

  const validatedDims = validateBestRateDimsForPersistedRate(
    body.bestRateJson,
    body.bestRateDims,
  );
  if (!validatedDims) {
    return {
      ok: false,
      status: 400,
      error: 'Complete dimensions are required before saving a best rate',
    };
  }

  let canonical;
  try {
    canonical = assertPersistedOrderBestRateDto(body.bestRateJson, 'bestRateJson');
  } catch (err) {
    const error = err instanceof InputValidationError ? err.message : (err as Error).message;
    return { ok: false, status: 400, error };
  }

  // Per user override unlock shipped data on 2026-07-15: this is read-only
  // destination evidence for the same pre-persist PO Box eligibility check.
  const [existing] = await db
    .select({
      id: orders.id,
      clientId: orders.clientId,
      storeId: orders.storeId,
      raw: orders.raw,
      recipientOverride: orderOverrides.recipientOverride,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(eq(orders.id, id))
    .limit(1);
  if (!existing) return { ok: false, status: 404, error: 'Order not found' };
  const eligibilityReason = shippingRateEligibilityReason(
    orderShippingEligibilityContext(existing),
    canonical,
  );
  if (eligibilityReason) {
    return {
      ok: false,
      status: 400,
      error: eligibilityReason,
      code: 'SHIPPING_SERVICE_NOT_ELIGIBLE',
    };
  }

  const rawBody = body.bestRateJson as Record<string, unknown> | null;
  const rawHouseProvider =
    (rawBody?.provider ?? (rawBody?.raw as Record<string, unknown> | undefined)?.provider) ?? null;
  const hStatus = houseTupleStatus({
    rawProvider: rawHouseProvider,
    nextBestNonHouseRate: canonical.nextBestNonHouseRate,
    houseMargin: canonical.houseMargin,
    optedIn: await clientHouseAccountEnabled(existing.clientId ?? null),
  });
  if (shouldRejectHalfHouseSave(hStatus) && process.env.HOUSE_TUPLE_SAVE_GUARD === 'on') {
    return {
      ok: false,
      status: 400,
      error: HOUSE_TUPLE_REQUIRED_MESSAGE,
      code: 'HOUSE_TUPLE_REQUIRED',
    };
  }
  canonical.houseTupleStatus = hStatus;

  const row = await applyOrderOverridesPatch(id, {
    bestRateJson: canonical,
    bestRateDims: validatedDims,
  }, authorization);
  return row.ok ? { ok: true, row: row.value } : commandFailureFromWrite(row);
}
