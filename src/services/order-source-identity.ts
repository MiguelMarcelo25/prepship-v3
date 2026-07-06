import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { orders } from '../db/schema/orders';

export type OrderSourceIdentity = {
  sourceProvider: string;
  sourceAccountId: string;
  sourceOrderId: string;
};

function textPart(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

function providerPart(value: unknown): string | null {
  return textPart(value)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;
}

export function buildOrderSourceIdentity(input: {
  sourceProvider?: unknown;
  sourceAccountId?: unknown;
  sourceOrderId?: unknown;
}): OrderSourceIdentity | null {
  const sourceProvider = providerPart(input.sourceProvider);
  const sourceAccountId = textPart(input.sourceAccountId);
  const sourceOrderId = textPart(input.sourceOrderId);
  if (!sourceProvider || !sourceAccountId || !sourceOrderId) return null;
  return { sourceProvider, sourceAccountId, sourceOrderId };
}

export function orderSourceIdentityKey(identity: OrderSourceIdentity): string {
  return `${identity.sourceProvider}\u001f${identity.sourceAccountId}\u001f${identity.sourceOrderId}`;
}

export function dedupeOrderSourceIdentities(identities: Array<OrderSourceIdentity | null | undefined>): OrderSourceIdentity[] {
  const byKey = new Map<string, OrderSourceIdentity>();
  for (const identity of identities) {
    if (!identity) continue;
    byKey.set(orderSourceIdentityKey(identity), identity);
  }
  return [...byKey.values()];
}

export function legacyExternalOrderIdForSource(identity: OrderSourceIdentity): string {
  if (identity.sourceProvider === 'shipstation') return identity.sourceOrderId;
  return `${identity.sourceProvider}-${identity.sourceOrderId}`;
}

export function orderSourceIdentityPredicate(identity: OrderSourceIdentity): SQL {
  return and(
    eq(orders.sourceProvider, identity.sourceProvider),
    eq(orders.sourceAccountId, identity.sourceAccountId),
    eq(orders.sourceOrderId, identity.sourceOrderId),
  )!;
}

export function orderSourceIdentitiesPredicate(identities: Array<OrderSourceIdentity | null | undefined>): SQL | undefined {
  const unique = dedupeOrderSourceIdentities(identities);
  if (!unique.length) return undefined;
  return or(...unique.map(orderSourceIdentityPredicate));
}

export function legacyOrderSourceCompatibilityPredicate(
  externalOrderIds: Array<string | null | undefined>,
  options: { includeUnqualifiedShipStation?: boolean } = {},
): SQL | undefined {
  const ids = [...new Set(externalOrderIds.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))];
  if (!ids.length) return undefined;

  const missingComposite = or(
    isNull(orders.sourceProvider),
    isNull(orders.sourceAccountId),
    isNull(orders.sourceOrderId),
  )!;
  const unqualifiedShipStation = options.includeUnqualifiedShipStation === true
    ? and(eq(orders.sourceProvider, 'shipstation'), eq(orders.sourceAccountId, 'shipstation-default'))
    : undefined;

  return and(
    inArray(orders.externalOrderId, ids),
    unqualifiedShipStation ? or(missingComposite, unqualifiedShipStation)! : missingComposite,
  );
}

export function orderSourceIdentityOrLegacyPredicate(input: {
  identities: Array<OrderSourceIdentity | null | undefined>;
  legacyExternalOrderIds?: Array<string | null | undefined>;
  includeUnqualifiedShipStationLegacy?: boolean;
}): SQL | undefined {
  const sourcePredicate = orderSourceIdentitiesPredicate(input.identities);
  const legacyPredicate = legacyOrderSourceCompatibilityPredicate(input.legacyExternalOrderIds ?? [], {
    includeUnqualifiedShipStation: input.includeUnqualifiedShipStationLegacy,
  });
  if (sourcePredicate && legacyPredicate) return or(sourcePredicate, legacyPredicate);
  return sourcePredicate ?? legacyPredicate;
}
