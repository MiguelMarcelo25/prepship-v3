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

type OccRow = { id: number; order_id: number; occurrence_key: string; shipment_id: number | null; discriminator_kind: OccurrenceDiscriminator };

/**
 * Resolve the occurrence by BOTH identities and reject any contradiction. Every candidate row must belong
 * to this order (fail-closed on ANY cross-order row, not only the selected winner). If the DERIVED key and
 * the shipment identity resolve to DIFFERENT occurrences — e.g. shipment B (local key) is enriched with a
 * provider id whose provider key is already owned by a different occurrence A — the identities disagree and
 * we throw rather than silently prefer one (Release A blocker 3). Returns null when neither identity exists.
 */
async function resolveExistingOccurrence(
  sql: postgres.Sql,
  ctx: OccurrenceResolveContext,
  key: string,
  shipmentId: number | null,
): Promise<ResolvedOccurrence | null> {
  const rows = shipmentId != null
    ? await sql<OccRow[]>`
        select id, order_id, occurrence_key, shipment_id, discriminator_kind
        from public.fulfillment_occurrences
        where occurrence_key = ${key} or shipment_id = ${shipmentId}
      `
    : await sql<OccRow[]>`
        select id, order_id, occurrence_key, shipment_id, discriminator_kind
        from public.fulfillment_occurrences
        where occurrence_key = ${key}
      `;
  if (rows.length === 0) return null;

  // Validate order consistency on EVERY candidate — not only the winner.
  for (const r of rows) {
    if (Number(r.order_id) !== ctx.orderId) {
      throw new Error(`occurrence candidate ${r.id} belongs to order ${r.order_id}, not ${ctx.orderId} (key=${key}, shipment=${shipmentId})`);
    }
  }

  const byKey = rows.find((r) => r.occurrence_key === key) ?? null;
  const byShipment = shipmentId != null ? (rows.find((r) => r.shipment_id != null && Number(r.shipment_id) === shipmentId) ?? null) : null;

  // Contradiction: the derived key and the shipment identity resolve to two DIFFERENT occurrences.
  if (byKey && byShipment && Number(byKey.id) !== Number(byShipment.id)) {
    throw new Error(
      `occurrence identity conflict for order ${ctx.orderId}: derived key ${key} -> occurrence ${byKey.id}, ` +
        `but shipment ${shipmentId} -> occurrence ${byShipment.id} (key ${byShipment.occurrence_key})`,
    );
  }

  // Physical shipment identity is stable under provider enrichment; prefer it, else the key match.
  const winner = byShipment ?? byKey;
  if (!winner) return null;
  return { occurrenceId: Number(winner.id), occurrenceKey: winner.occurrence_key, discriminatorKind: winner.discriminator_kind, created: false };
}

/**
 * Resolve-or-create the occurrence. Key-stability hierarchy (Hermes §2): resolve by shipment_id AND the
 * derived key up front so a shipment later enriched with a provider id never spawns a second occurrence and
 * never silently masks a pre-existing provider-key occurrence; only when neither identity exists do we insert
 * with a TARGETLESS on-conflict (absorbs either the occurrence_key OR the shipment_id unique), then re-resolve
 * and re-check the contradiction on the race path.
 */
export async function resolveFulfillmentOccurrence(
  sql: postgres.Sql,
  ctx: OccurrenceResolveContext,
): Promise<ResolvedOccurrence> {
  const shipmentId = ctx.lockedShipment?.id ?? null;
  const { key, kind } = deriveOccurrenceKey(ctx);

  const pre = await resolveExistingOccurrence(sql, ctx, key, shipmentId);
  if (pre) return pre;

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

  // Lost the race: another writer inserted a conflicting identity. Re-resolve + re-check the contradiction.
  const post = await resolveExistingOccurrence(sql, ctx, key, shipmentId);
  if (!post) throw new Error(`occurrence resolve produced no winner for key=${key} (order ${ctx.orderId})`);
  return post;
}
