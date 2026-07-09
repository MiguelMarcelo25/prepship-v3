import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { withAdvisorySessionLock } from '../lib/advisory-session-lock';
import { orderOverrides, orders } from '../db/schema/orders';
import { orderItems } from '../db/schema/order-items';
import {
  clientComboPackageDefaults,
  type ClientComboPackageDefault,
} from '../db/schema/client-combo-package-defaults';
import { computeComboKey, isMultiSkuCombo, normalizeComboItems, type ComboItemInput } from '../lib/package-combo';
import {
  computeOrderRateJobFingerprint,
  setOrderRatePending,
} from './shipping-workflow/order-rate-job-status';
import {
  resolvePackageFactsFromInputs,
  rungHasFacts,
  type EffectivePackageFacts,
  type PackageFactsRung,
} from './package-facts-policy';
import { getOrderDimsDefaultsForOrder } from './order-dims-defaults';
import { orderLifecycleEffectiveStatusSql } from './order-lifecycle-status';

// PS-037 — Service for per-client SKU+qty-combination package defaults.
//
// SOURCE OF TRUTH: the combo key is always derived here from real order data
// (canonical order_items, falling back to orders.items jsonb) — never trusted
// from the client. Scope is enforced by clientId; uniqueness on
// (clientId, comboKey) makes save an idempotent upsert and prevents any
// cross-client leakage.

export interface OrderComboContext {
  clientId: number | null;
  comboKey: string;
  multiSku: boolean;
}

async function loadComboItems(orderId: number, fallbackItems: unknown): Promise<ComboItemInput[]> {
  // Canonical per-line table first.
  const rows = await db
    .select({ sku: orderItems.sku, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (rows.length) {
    return rows.map((r) => ({ sku: r.sku, quantity: r.quantity }));
  }
  // Fallback: raw orders.items jsonb (always present on import).
  return Array.isArray(fallbackItems) ? (fallbackItems as ComboItemInput[]) : [];
}

/** Derive {clientId, comboKey, multiSku} for an order, server-side. */
export async function deriveOrderComboContext(orderId: number): Promise<OrderComboContext> {
  const [ord] = await db
    .select({ clientId: orders.clientId, items: orders.items })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!ord) return { clientId: null, comboKey: '', multiSku: false };
  const items = await loadComboItems(orderId, ord.items);
  return {
    clientId: ord.clientId ?? null,
    comboKey: computeComboKey(items),
    multiSku: isMultiSkuCombo(items),
  };
}

export interface SaveComboDefaultInput {
  packageId?: number | null;
  packageCode?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  weightOz?: number | null;
}

export interface SaveComboDefaultResult {
  saved: boolean;
  reason?: string;
  clientId?: number;
  comboKey?: string;
  appliedMutableOrderCount?: number;
  // PS-121: ids of the sibling awaiting orders whose dims/weight/package changed AND that had a
  // saved best rate — i.e. the ones invalidated + queued for a targeted recalc. Empty unless the
  // caller passed { recalcGroup: true } (the explicit "Save weights & dims as SKU defaults").
  affectedOrderIds?: number[];
}

function selectedPackageIdFromComboInput(input: SaveComboDefaultInput): string | null {
  if (input.packageId != null && Number.isFinite(Number(input.packageId))) {
    return String(Math.trunc(Number(input.packageId)));
  }
  const packageCode = typeof input.packageCode === 'string' ? input.packageCode.trim() : '';
  return packageCode || null;
}

function mutableAwaitingOrderLifecyclePredicate(): SQL {
  return sql`${orderLifecycleEffectiveStatusSql()} = 'awaiting_shipment'`;
}

// PS-121 — numeric equality tolerant of null + real-column string/number drift.
function numEq(a: unknown, b: unknown): boolean {
  const na = a == null ? null : Number(a);
  const nb = b == null ? null : Number(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) < 1e-9;
}

async function applyComboPackageDefaultToMatchingMutableOrders(
  clientId: number,
  comboKey: string,
  input: SaveComboDefaultInput,
  opts: { recalcGroup: boolean; sourceOrderId: number },
): Promise<{ appliedMutableOrderCount: number; affectedOrderIds: number[] }> {
  // Pull each candidate's ship-to + base weight + raw (for the PS-120 rate-job fingerprint) and
  // its CURRENT override dims/weight/package + whether it has a saved best rate (to detect change).
  // Per user override unlock shipped data on 2026-07-09: PS-411 gates these writes
  // by effective lifecycle awaiting state, so upstream-cancelled/external-shipped rows stay locked.
  const candidates = await db
    .select({
      id: orders.id,
      items: orders.items,
      weightOz: orders.weightOz,
      shipToPostalCode: orders.shipToPostalCode,
      shipToState: orders.shipToState,
      shipToCity: orders.shipToCity,
      raw: orders.raw,
      curDimsL: orderOverrides.rateDimsL,
      curDimsW: orderOverrides.rateDimsW,
      curDimsH: orderOverrides.rateDimsH,
      curWeightOz: orderOverrides.rateWeightOz,
      curPackageId: orderOverrides.selectedPackageId,
      curBestRateAt: orderOverrides.bestRateAt,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(
      and(
        eq(orders.clientId, clientId),
        mutableAwaitingOrderLifecyclePredicate(),
      ),
    );

  let appliedMutableOrderCount = 0;
  const affectedOrderIds: number[] = [];
  const selectedPackageId = selectedPackageIdFromComboInput(input);
  const rateWeightOz =
    typeof input.weightOz === 'number' && Number.isFinite(input.weightOz) && input.weightOz > 0
      ? input.weightOz
      : null;

  for (const candidate of candidates) {
    const items = await loadComboItems(candidate.id, candidate.items);
    if (computeComboKey(items) !== comboKey) continue;

    // PS-121: a sibling's saved best rate is stale ONLY when the explicit default save actually
    // CHANGED its dims/weight/package AND it currently HAS a saved rate. The source (panel) order
    // is never invalidated here — it already refreshed its own rate. Silent/normal saves
    // (recalcGroup=false) propagate dims exactly as before and never touch saved rates.
    const dimsOrPackageChanged =
      !numEq(candidate.curDimsL, input.length ?? null) ||
      !numEq(candidate.curDimsW, input.width ?? null) ||
      !numEq(candidate.curDimsH, input.height ?? null) ||
      !numEq(candidate.curWeightOz, rateWeightOz) ||
      (candidate.curPackageId ?? null) !== selectedPackageId;
    const invalidate =
      opts.recalcGroup &&
      candidate.id !== opts.sourceOrderId &&
      candidate.curBestRateAt != null &&
      dimsOrPackageChanged;

    const set = {
      selectedPackageId,
      rateDimsL: input.length ?? null,
      rateDimsW: input.width ?? null,
      rateDimsH: input.height ?? null,
      rateWeightOz,
      updatedAt: new Date(),
      // Invalidate the stale saved rate (bestRateAt=null makes the order recalc-eligible).
      ...(invalidate ? { bestRateJson: null, bestRateAt: null, bestRateDims: null } : {}),
    };

    await db
      .insert(orderOverrides)
      .values({ orderId: candidate.id, ...set })
      .onConflictDoUpdate({ target: orderOverrides.orderId, set });
    appliedMutableOrderCount += 1;

    if (invalidate) {
      affectedOrderIds.push(candidate.id);
      // Stamp `pending` immediately with the same current package facts rates-backfill will use
      // (override weight/dims before imported facts), so the Orders table shows "refreshing".
      try {
        await setOrderRatePending(
          candidate.id,
          computeOrderRateJobFingerprint({
            orderId: candidate.id,
            weightOz: rateWeightOz ?? candidate.weightOz,
            shipToPostalCode: candidate.shipToPostalCode,
            shipToState: candidate.shipToState,
            shipToCity: candidate.shipToCity,
            rateDimsL: input.length ?? null,
            rateDimsW: input.width ?? null,
            rateDimsH: input.height ?? null,
            raw: candidate.raw,
          }),
        );
      } catch (err) {
        console.warn(
          '[combo-package-defaults] failed to stamp pending rate-job:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { appliedMutableOrderCount, affectedOrderIds };
}

/**
 * Upsert the package default for an order's exact (client, SKU+qty combo).
 * No-ops (saved:false) when the order has no client or no resolvable combo
 * (e.g. empty/adjustment-only items) so we never write a meaningless key.
 */
export async function saveComboPackageDefault(
  orderId: number,
  input: SaveComboDefaultInput,
  opts?: { recalcGroup?: boolean },
): Promise<SaveComboDefaultResult> {
  const { clientId, comboKey } = await deriveOrderComboContext(orderId);
  if (clientId == null) return { saved: false, reason: 'order has no client scope' };
  if (!comboKey) return { saved: false, reason: 'order has no resolvable SKU+qty combination' };

  // PS-253 (Card 8): serialize concurrent saves for the SAME (client, combo). The upsert is atomic on
  // its own, but the sibling-order apply below is a read-modify-write — two concurrent saves (multi-
  // process worker + API) could interleave the apply and lose updates. A per-(client,combo) session
  // advisory lock makes the upsert + apply one serialized unit; different combos never contend.
  return withAdvisorySessionLock(`combo_default:${clientId}:${comboKey}`, async () => {
    const now = new Date();
    await db
      .insert(clientComboPackageDefaults)
      .values({
        clientId,
        comboKey,
        packageId: input.packageId ?? null,
        packageCode: input.packageCode ?? null,
        length: input.length ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        weightOz: input.weightOz ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [clientComboPackageDefaults.clientId, clientComboPackageDefaults.comboKey],
        set: {
          packageId: input.packageId ?? null,
          packageCode: input.packageCode ?? null,
          length: input.length ?? null,
          width: input.width ?? null,
          height: input.height ?? null,
          weightOz: input.weightOz ?? null,
          updatedAt: now,
        },
      });

    const { appliedMutableOrderCount, affectedOrderIds } =
      await applyComboPackageDefaultToMatchingMutableOrders(clientId, comboKey, input, {
        recalcGroup: opts?.recalcGroup === true,
        sourceOrderId: orderId,
      });

    return { saved: true, clientId, comboKey, appliedMutableOrderCount, affectedOrderIds };
  });
}

export interface ComboPackageDefaultDto {
  packageId: number | null;
  packageCode: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weightOz: number | null;
  comboKey: string;
}

/** Resolve the saved combo default for an order (null when none / not applicable). */
export async function getComboPackageDefaultForOrder(
  orderId: number,
): Promise<ComboPackageDefaultDto | null> {
  const { clientId, comboKey } = await deriveOrderComboContext(orderId);
  if (clientId == null || !comboKey) return null;
  const [row] = await db
    .select()
    .from(clientComboPackageDefaults)
    .where(
      and(
        eq(clientComboPackageDefaults.clientId, clientId),
        eq(clientComboPackageDefaults.comboKey, comboKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  const r = row as ClientComboPackageDefault;
  return {
    packageId: r.packageId ?? null,
    packageCode: r.packageCode ?? null,
    length: r.length ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    weightOz: r.weightOz ?? null,
    comboKey: r.comboKey,
  };
}

// ─── PS-205: import-time materialization + the effective-facts resolver ──────
//
// ShipStation re-imports stale weights/dims on every sync (the upsert
// overwrites orders.weight_oz unconditionally), and every rating/label/list
// reader resolves `order_overrides.rate_* ?? orders.*`. So the ONE write that
// protects every downstream path is: when an imported MUTABLE awaiting order
// matches a saved client combo default and carries NO package-fact overrides
// yet, materialize the default into order_overrides — imported data then loses
// at every existing read site without touching any reader.

const PACKAGE_FACTS_MATERIALIZE_SOURCE = 'combo_default' as const;

function comboDefaultRung(row: Pick<ClientComboPackageDefault, 'packageId' | 'packageCode' | 'length' | 'width' | 'height' | 'weightOz'>): PackageFactsRung {
  return {
    weightOz: row.weightOz ?? null,
    length: row.length ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    selectedPackageId: selectedPackageIdFromComboInput({
      packageId: row.packageId ?? null,
      packageCode: row.packageCode ?? null,
    }),
  };
}

export type MaterializePackageFactsResult = {
  examined: number;
  materialized: number;
  invalidatedOrderIds: number[];
};

/**
 * PS-205 — apply saved combo defaults to freshly-imported orders.
 *
 * Strictly scoped writes:
 *   • orderStatus = 'awaiting_shipment' ONLY (shipped/cancelled never touched —
 *     the lockdown stays intact; this filter is the gate).
 *   • Orders with ANY existing package-fact override (operator edit OR a prior
 *     materialization) are SKIPPED — sync can never overwrite a human.
 *   • Orders with a live (non-voided) shipment label are SKIPPED (read-only
 *     EXISTS probe against shipments — labelled rows keep their facts).
 *   • Only the package-fact override columns are written; every other override
 *     field (selected_pid, residential, …) is preserved.
 *   • If a skipped-rate row ALREADY had a saved best rate (rated between
 *     import and materialization), the stale rate is invalidated exactly like
 *     the explicit save-defaults flow (bestRateAt=null + pending stamp).
 */
export async function materializePackageFactsForImportedOrders(
  externalOrderIds: string[],
): Promise<MaterializePackageFactsResult> {
  const ids = [...new Set(externalOrderIds.filter((id) => typeof id === 'string' && id.trim()))];
  if (!ids.length) return { examined: 0, materialized: 0, invalidatedOrderIds: [] };
  return materializePackageFactsForImportedOrdersWhere(inArray(orders.externalOrderId, ids));
}

export async function materializePackageFactsForImportedOrderIds(
  orderIds: number[],
): Promise<MaterializePackageFactsResult> {
  const ids = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { examined: 0, materialized: 0, invalidatedOrderIds: [] };
  return materializePackageFactsForImportedOrdersWhere(inArray(orders.id, ids));
}

async function materializePackageFactsForImportedOrdersWhere(
  importedOrdersPredicate: SQL,
): Promise<MaterializePackageFactsResult> {
  const candidates = await db
    .select({
      id: orders.id,
      clientId: orders.clientId,
      items: orders.items,
      weightOz: orders.weightOz,
      shipToPostalCode: orders.shipToPostalCode,
      shipToState: orders.shipToState,
      shipToCity: orders.shipToCity,
      raw: orders.raw,
      curDimsL: orderOverrides.rateDimsL,
      curDimsW: orderOverrides.rateDimsW,
      curDimsH: orderOverrides.rateDimsH,
      curWeightOz: orderOverrides.rateWeightOz,
      curPackageId: orderOverrides.selectedPackageId,
      curBestRateAt: orderOverrides.bestRateAt,
      // Read-only label probe (shipments reads are allowed; never written here).
      hasActiveLabel: sql<boolean>`exists (
        select 1 from shipments s
        where s.order_id = ${orders.id} and coalesce(s.voided, false) = false
      )`,
    })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(
      and(
        importedOrdersPredicate,
        // Lockdown gate: mutable effective-awaiting rows only.
        mutableAwaitingOrderLifecyclePredicate(),
      ),
    );

  let materialized = 0;
  const invalidatedOrderIds: number[] = [];
  const defaultsCache = new Map<string, ClientComboPackageDefault | null>();

  for (const candidate of candidates) {
    if (candidate.clientId == null) continue;
    if (candidate.hasActiveLabel) continue;
    // An operator edit OR a prior materialization already owns the facts.
    const hasExistingFacts = rungHasFacts({
      weightOz: candidate.curWeightOz,
      length: candidate.curDimsL,
      width: candidate.curDimsW,
      height: candidate.curDimsH,
      selectedPackageId: candidate.curPackageId ?? null,
    });
    if (hasExistingFacts) continue;

    const items = await loadComboItems(candidate.id, candidate.items);
    const comboKey = computeComboKey(items);
    if (!comboKey) continue;

    const cacheKey = `${candidate.clientId}:${comboKey}`;
    let def = defaultsCache.get(cacheKey);
    if (def === undefined) {
      const [row] = await db
        .select()
        .from(clientComboPackageDefaults)
        .where(
          and(
            eq(clientComboPackageDefaults.clientId, candidate.clientId),
            eq(clientComboPackageDefaults.comboKey, comboKey),
          ),
        )
        .limit(1);
      def = (row as ClientComboPackageDefault | undefined) ?? null;
      defaultsCache.set(cacheKey, def);
    }
    if (!def) continue;
    const rung = comboDefaultRung(def);
    if (!rungHasFacts(rung)) continue;

    const set = {
      selectedPackageId: rung.selectedPackageId ?? null,
      rateDimsL: def.length ?? null,
      rateDimsW: def.width ?? null,
      rateDimsH: def.height ?? null,
      rateWeightOz:
        typeof def.weightOz === 'number' && Number.isFinite(def.weightOz) && def.weightOz > 0
          ? def.weightOz
          : null,
      updatedAt: new Date(),
      // A rate saved off the imported facts (between import and this pass) is
      // stale for the materialized facts — same invalidation the explicit
      // save-defaults flow performs.
      ...(candidate.curBestRateAt != null ? { bestRateJson: null, bestRateAt: null, bestRateDims: null } : {}),
    };
    await db
      .insert(orderOverrides)
      .values({ orderId: candidate.id, ...set })
      .onConflictDoUpdate({ target: orderOverrides.orderId, set });
    materialized += 1;

    if (candidate.curBestRateAt != null) {
      invalidatedOrderIds.push(candidate.id);
      try {
        await setOrderRatePending(
          candidate.id,
          computeOrderRateJobFingerprint({
            orderId: candidate.id,
            weightOz:
              typeof def.weightOz === 'number' && Number.isFinite(def.weightOz) && def.weightOz > 0
                ? def.weightOz
                : candidate.weightOz,
            shipToPostalCode: candidate.shipToPostalCode,
            shipToState: candidate.shipToState,
            shipToCity: candidate.shipToCity,
            rateDimsL: def.length ?? null,
            rateDimsW: def.width ?? null,
            rateDimsH: def.height ?? null,
            raw: candidate.raw,
          }),
        );
      } catch (err) {
        console.warn(
          '[package-facts] failed to stamp pending rate-job after materialization:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  if (materialized > 0) {
    console.log(
      `[package-facts] materialized ${PACKAGE_FACTS_MATERIALIZE_SOURCE} onto ${materialized}/${candidates.length} imported awaiting orders` +
      (invalidatedOrderIds.length ? ` (invalidated stale rates: ${invalidatedOrderIds.join(', ')})` : ''),
    );
  }
  return { examined: candidates.length, materialized, invalidatedOrderIds };
}

/**
 * PS-205 — the canonical effective package facts for an order, with the
 * precedence decided by the PURE policy (package-facts-policy.ts). Read-only;
 * attached to the order detail payload as `packageFacts` so the panel / UI can
 * tell the operator WHERE the weight/dims came from instead of mixing sources.
 */
export async function resolveOrderPackageFacts(orderId: number): Promise<EffectivePackageFacts | null> {
  try {
    const [row] = await db
      .select({
        id: orders.id,
        clientId: orders.clientId,
        items: orders.items,
        weightOz: orders.weightOz,
        raw: orders.raw,
        curDimsL: orderOverrides.rateDimsL,
        curDimsW: orderOverrides.rateDimsW,
        curDimsH: orderOverrides.rateDimsH,
        curWeightOz: orderOverrides.rateWeightOz,
        curPackageId: orderOverrides.selectedPackageId,
      })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row) return null;

    const items = await loadComboItems(orderId, row.items);
    const comboKey = computeComboKey(items);
    const normalized = normalizeComboItems(items);

    let comboDefault: PackageFactsRung | null = null;
    if (row.clientId != null && comboKey) {
      const [def] = await db
        .select()
        .from(clientComboPackageDefaults)
        .where(
          and(
            eq(clientComboPackageDefaults.clientId, row.clientId),
            eq(clientComboPackageDefaults.comboKey, comboKey),
          ),
        )
        .limit(1);
      if (def) comboDefault = comboDefaultRung(def as ClientComboPackageDefault);
    }

    // Rung 3 — TRUE single-SKU orders only (the dims-defaults owner already
    // enforces the qty-scope rules); product-derived multi-SKU stacking stays
    // a display/seed fallback BELOW any explicit combo default by position.
    let singleSkuDefault: PackageFactsRung | null = null;
    if (normalized.length === 1) {
      const dd = await getOrderDimsDefaultsForOrder(orderId);
      if (dd) {
        singleSkuDefault = {
          weightOz: dd.weightOz,
          length: dd.dims?.length ?? null,
          width: dd.dims?.width ?? null,
          height: dd.dims?.height ?? null,
          selectedPackageId: dd.packageId != null ? String(dd.packageId) : dd.defaultPackageCode,
        };
      }
    }

    // Imported dims live on the raw ShipStation payload (orders.raw.dimensions).
    const rawRecord = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)
      ? (row.raw as Record<string, unknown>)
      : null;
    const importedDims = rawRecord?.dimensions && typeof rawRecord.dimensions === 'object' && !Array.isArray(rawRecord.dimensions)
      ? (rawRecord.dimensions as { length?: unknown; width?: unknown; height?: unknown })
      : null;
    return resolvePackageFactsFromInputs({
      override: {
        weightOz: row.curWeightOz,
        length: row.curDimsL,
        width: row.curDimsW,
        height: row.curDimsH,
        selectedPackageId: row.curPackageId ?? null,
      },
      comboDefault,
      singleSkuDefault,
      imported: {
        weightOz: row.weightOz,
        length: importedDims?.length as number | null | undefined ?? null,
        width: importedDims?.width as number | null | undefined ?? null,
        height: importedDims?.height as number | null | undefined ?? null,
        selectedPackageId: null,
      },
      comboKey,
    });
  } catch (err) {
    console.warn('[package-facts] resolve skipped:', err instanceof Error ? err.message : err);
    return null;
  }
}
