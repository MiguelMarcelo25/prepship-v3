// PS-497 Slice 2 (S2.1) — the canonical occurrence resolver. PURE key derivation + a resolve-or-create
// against the transaction. UNWIRED in Release A: the only caller is its PG17 guard; the Release-B owner
// cutover (S2.4) calls it inside applyOrderLifecycleCommandInTransaction AFTER the orders/shipment
// FOR UPDATE. It NEVER uses the lifecycle-event id as physical identity, and reads the provider id ONLY
// from the locked canonical shipment row (never from caller provenance).
import type postgres from 'postgres';

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

type OccRow = { id: number; order_id: number; occurrence_key: string; discriminator_kind: OccurrenceDiscriminator };

/**
 * Resolve-or-create the occurrence. Key-stability hierarchy (Hermes §2): look up by shipment_id FIRST so a
 * shipment later enriched with a provider id never spawns a second occurrence; only when none exists derive
 * the key and insert with a TARGETLESS on-conflict (absorbs either the occurrence_key OR the shipment_id
 * unique), then read back by BOTH identities and reject cross-order winners.
 */
export async function resolveFulfillmentOccurrence(
  sql: postgres.Sql,
  ctx: OccurrenceResolveContext,
): Promise<ResolvedOccurrence> {
  const shipmentId = ctx.lockedShipment?.id ?? null;

  if (shipmentId != null) {
    const existing = await sql<OccRow[]>`
      select id, order_id, occurrence_key, discriminator_kind
      from public.fulfillment_occurrences
      where shipment_id = ${shipmentId}
    `;
    const found = existing[0];
    if (found) {
      if (Number(found.order_id) !== ctx.orderId) {
        throw new Error(`occurrence ${found.id} on shipment ${shipmentId} belongs to order ${found.order_id}, not ${ctx.orderId}`);
      }
      return { occurrenceId: Number(found.id), occurrenceKey: found.occurrence_key, discriminatorKind: found.discriminator_kind, created: false };
    }
  }

  const { key, kind } = deriveOccurrenceKey(ctx);
  const inserted = await sql<{ id: number }[]>`
    insert into public.fulfillment_occurrences
      (order_id, shipment_id, occurrence_key, discriminator_kind, first_seen_source, effective_at)
    values (${ctx.orderId}, ${shipmentId}, ${key}, ${kind}, ${ctx.source}, ${ctx.effectiveAt})
    on conflict do nothing
    returning id
  `;
  if (inserted[0]) {
    return { occurrenceId: Number(inserted[0].id), occurrenceKey: key, discriminatorKind: kind, created: true };
  }

  // Lost the race / already present. Read back by BOTH identities; prefer the physical shipment row.
  const rows = shipmentId != null
    ? await sql<OccRow[]>`
        select id, order_id, occurrence_key, discriminator_kind
        from public.fulfillment_occurrences
        where occurrence_key = ${key} or shipment_id = ${shipmentId}
      `
    : await sql<OccRow[]>`
        select id, order_id, occurrence_key, discriminator_kind
        from public.fulfillment_occurrences
        where occurrence_key = ${key}
      `;
  const winner =
    (shipmentId != null ? rows.find((r) => r.occurrence_key !== key) : undefined) ??
    rows.find((r) => r.occurrence_key === key) ??
    rows[0];
  if (!winner) throw new Error(`occurrence resolve produced no winner for key=${key}`);
  if (Number(winner.order_id) !== ctx.orderId) {
    throw new Error(`occurrence winner ${winner.id} belongs to order ${winner.order_id}, not ${ctx.orderId}`);
  }
  return { occurrenceId: Number(winner.id), occurrenceKey: winner.occurrence_key, discriminatorKind: winner.discriminator_kind, created: false };
}
