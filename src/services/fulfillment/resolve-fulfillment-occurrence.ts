// PS-497 Slice 2 (S2.1) — the canonical occurrence resolver. PURE key derivation + a resolve-or-create
// against the transaction. Release A shipped this UNWIRED; Release B (S2.4) wires it INSIDE
// applyOrderLifecycleCommandInTransaction (and the reverse writer) AFTER the orders/shipment FOR UPDATE.
//
// Per user override unlock shipped data on 2026-08-25: PS-497 Release B converts this resolver from the
// Release A postgres-js signature to the DRIZZLE transaction the sole owner actually runs on (the owner uses
// db.transaction, not a raw postgres-js Sql). The logic is unchanged — shipment-first lookup, 3-class key,
// TARGETLESS onConflictDoNothing single-winner, contradiction rejection, provider id read ONLY from the
// locked canonical shipment. No shipped/cancelled data is written by this file.
import { eq, or } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { fulfillmentOccurrences } from '../../db/schema/fulfillment-occurrences.js';

/** A drizzle transaction (or the base db) — whatever the owner is currently inside. */
export type OccurrenceResolverExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OccurrenceDiscriminator = 'provider_shipment' | 'local_shipment' | 'whole_order';

/** The canonical shipment facts, read under FOR UPDATE by the owner. null for shipment-less transitions. */
export interface LockedShipment {
  id: number;
  labelShipmentId: number | null;
  source: string | null;
}

export interface OccurrenceResolveContext {
  orderId: number;
  transition: 'shipped' | 'external_shipped';
  source: string;
  effectiveAt: Date | string;
  lockedShipment: LockedShipment | null;
  /** true for a genuinely-external whole-order fulfillment (external_shipped / webhook). */
  external: boolean;
}

export interface ResolvedOccurrence {
  occurrenceId: number;
  occurrenceKey: string;
  discriminatorKind: OccurrenceDiscriminator;
  created: boolean;
}

/** provider = normalized shipments.source (fallback 'provider'); safe for use inside the key. */
export function normalizeProvider(source: string | null): string {
  const s = (source ?? '').trim().toLowerCase();
  const cleaned = s.replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length ? cleaned : 'provider';
}

/**
 * Deterministic occurrence key + discriminator from LOCKED canonical facts:
 *   shipment-backed, provider id present → ord:{orderId}|pship:{provider}:{labelShipmentId} (provider_shipment)
 *   shipment-backed, no provider id      → ord:{orderId}|ship:{localShipmentId}             (local_shipment)
 *   shipment-less external               → ord:{orderId}|ext                                (whole_order)
 *   shipment-less status projection      → ord:{orderId}|whole                              (whole_order)
 */
export function deriveOccurrenceKey(
  ctx: OccurrenceResolveContext,
): { key: string; kind: OccurrenceDiscriminator } {
  const s = ctx.lockedShipment;
  if (s) {
    if (s.labelShipmentId != null) {
      return { key: `ord:${ctx.orderId}|pship:${normalizeProvider(s.source)}:${s.labelShipmentId}`, kind: 'provider_shipment' };
    }
    return { key: `ord:${ctx.orderId}|ship:${s.id}`, kind: 'local_shipment' };
  }
  return ctx.external
    ? { key: `ord:${ctx.orderId}|ext`, kind: 'whole_order' }
    : { key: `ord:${ctx.orderId}|whole`, kind: 'whole_order' };
}

const occurrenceColumns = {
  id: fulfillmentOccurrences.id,
  orderId: fulfillmentOccurrences.orderId,
  occurrenceKey: fulfillmentOccurrences.occurrenceKey,
  shipmentId: fulfillmentOccurrences.shipmentId,
  discriminatorKind: fulfillmentOccurrences.discriminatorKind,
} as const;

/**
 * Resolve the occurrence by BOTH identities and reject any contradiction. Every candidate row must belong to
 * this order (fail-closed on ANY cross-order row, not only the winner). If the derived key and the shipment
 * identity resolve to DIFFERENT occurrences, throw. Returns null when neither identity exists.
 */
async function resolveExistingOccurrence(
  tx: OccurrenceResolverExecutor,
  ctx: OccurrenceResolveContext,
  key: string,
  shipmentId: number | null,
): Promise<ResolvedOccurrence | null> {
  const rows = await tx
    .select(occurrenceColumns)
    .from(fulfillmentOccurrences)
    .where(
      shipmentId != null
        ? or(eq(fulfillmentOccurrences.occurrenceKey, key), eq(fulfillmentOccurrences.shipmentId, shipmentId))
        : eq(fulfillmentOccurrences.occurrenceKey, key),
    );
  if (rows.length === 0) return null;

  for (const r of rows) {
    if (Number(r.orderId) !== ctx.orderId) {
      throw new Error(`occurrence candidate ${r.id} belongs to order ${r.orderId}, not ${ctx.orderId} (key=${key}, shipment=${shipmentId})`);
    }
  }

  const byKey = rows.find((r) => r.occurrenceKey === key) ?? null;
  const byShipment = shipmentId != null ? (rows.find((r) => r.shipmentId != null && Number(r.shipmentId) === shipmentId) ?? null) : null;

  if (byKey && byShipment && Number(byKey.id) !== Number(byShipment.id)) {
    throw new Error(
      `occurrence identity conflict for order ${ctx.orderId}: derived key ${key} -> occurrence ${byKey.id}, ` +
        `but shipment ${shipmentId} -> occurrence ${byShipment.id} (key ${byShipment.occurrenceKey})`,
    );
  }

  const winner = byShipment ?? byKey;
  if (!winner) return null;
  return { occurrenceId: Number(winner.id), occurrenceKey: winner.occurrenceKey, discriminatorKind: winner.discriminatorKind as OccurrenceDiscriminator, created: false };
}

/**
 * Resolve-or-create the occurrence. Key-stability hierarchy: resolve by shipment_id AND the derived key up
 * front so a shipment later enriched with a provider id never spawns a second occurrence and never silently
 * masks a pre-existing provider-key occurrence; only when neither identity exists do we insert with a
 * TARGETLESS on-conflict, then re-resolve and re-check the contradiction on the race path.
 */
export async function resolveFulfillmentOccurrence(
  tx: OccurrenceResolverExecutor,
  ctx: OccurrenceResolveContext,
): Promise<ResolvedOccurrence> {
  const shipmentId = ctx.lockedShipment?.id ?? null;
  const { key, kind } = deriveOccurrenceKey(ctx);

  const pre = await resolveExistingOccurrence(tx, ctx, key, shipmentId);
  if (pre) return pre;

  const inserted = await tx
    .insert(fulfillmentOccurrences)
    .values({
      orderId: ctx.orderId,
      shipmentId,
      occurrenceKey: key,
      discriminatorKind: kind,
      firstSeenSource: ctx.source,
      effectiveAt: typeof ctx.effectiveAt === 'string' ? new Date(ctx.effectiveAt) : ctx.effectiveAt,
    })
    .onConflictDoNothing()
    .returning({ id: fulfillmentOccurrences.id });
  const insertedId = inserted[0]?.id;
  if (insertedId != null) {
    return { occurrenceId: Number(insertedId), occurrenceKey: key, discriminatorKind: kind, created: true };
  }

  // Lost the race: another writer inserted a conflicting identity. Re-resolve + re-check the contradiction.
  const post = await resolveExistingOccurrence(tx, ctx, key, shipmentId);
  if (!post) throw new Error(`occurrence resolve produced no winner for key=${key} (order ${ctx.orderId})`);
  return post;
}
