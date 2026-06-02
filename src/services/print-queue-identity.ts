/**
 * PS-070 — safe Print Queue item identity.
 *
 * Pure, NO database / IO. Resolves a stable, human-pickable identity for a
 * Print Queue / batch-header line even when an eBay (or other) order line has
 * NO SKU. The old code did `if (!sku) continue` and then fell back to the
 * literal string "UNKNOWN SKU", which (a) dropped no-SKU lines out of multi-SKU
 * combos and (b) printed an unsafe pickable-looking SKU on the warehouse batch
 * header. This module replaces that with a fallback HIERARCHY:
 *
 *   1. canonical SKU                              -> group token  SKU:<sku>
 *   2. (opportunistic) eBay item/variation/line id + title
 *                                                 -> EBAY_ID:<id>|TITLE:<title>
 *   3. product title only                         -> NOSKU:<title>
 *   4. eBay item id only                          -> EBAY_ID:<id>
 *   5. nothing usable                             -> UNRESOLVED (flagged unsafe)
 *
 * Different blank-SKU titles never collapse together (each gets its own
 * NOSKU:<title> token); identical titles + qty DO group so they batch. A
 * truly-empty line is bucketed under one clearly-labeled UNRESOLVED group that
 * the operator must review — never shown as a normal pickable SKU.
 *
 * IMPORTANT: this file is mirrored, function-for-function, in
 * web/src/components/Views/orders-parity.ts (the frontend grouping path). Keep
 * the two in sync — scripts/ps-070-ebay-nosku-identity-guard.ts imports BOTH
 * and asserts they produce identical group tokens and display text.
 */

export const UNRESOLVED_QUEUE_ITEM_LABEL = 'UNRESOLVED EBAY ITEM';
export const UNRESOLVED_QUEUE_ITEM_PICK_NOTE = 'UNRESOLVED EBAY ITEM — review order details';
export const NO_SKU_PICK_NOTE = 'no SKU — eBay item';

export function normalizeQueueSkuKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeQueueTitleKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function queueLineQty(value: unknown): number {
  const qty = Number(value ?? 1);
  return Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 1;
}

export type QueueLineKind = 'sku' | 'title' | 'unresolved';

export interface QueueLineIdentity {
  /** Real SKU, or '' when the source line has none. */
  sku: string;
  /** Product title / item name, or '' when absent. */
  title: string;
  kind: QueueLineKind;
  /** Stable grouping token — identical tokens batch together. */
  groupToken: string;
  /** Prominent card/combo label (title preferred; never "UNKNOWN SKU"). */
  cardTitle: string;
  /** Second-row text under the card title (a real "sku: X", or a no-SKU note). */
  skuLineText: string;
}

function firstStableId(line: Record<string, unknown>): string {
  for (const key of ['itemId', 'variationId', 'lineItemId', 'legacyItemId', 'productId']) {
    const raw = line[key];
    const s = raw == null ? '' : String(raw).trim();
    if (s) return `${key}:${s}`;
  }
  return '';
}

/**
 * Resolve one queue/order line into a safe pick identity. Accepts either an
 * order_items / order.items raw object ({ sku, name, quantity, ... }) or a
 * multi_sku_data line ({ sku, description, qty }).
 */
export function resolveQueueLineIdentity(line: unknown): QueueLineIdentity {
  const obj = line && typeof line === 'object' ? (line as Record<string, unknown>) : {};
  const sku = String(obj.sku ?? '').trim();
  const title = String(obj.description ?? obj.name ?? obj.title ?? '').trim();

  if (sku) {
    return {
      sku,
      title,
      kind: 'sku',
      groupToken: `SKU:${normalizeQueueSkuKey(sku)}`,
      cardTitle: title || sku,
      skuLineText: `sku: ${sku}`,
    };
  }

  const id = firstStableId(obj);

  if (title) {
    const token = id
      ? `EBAY_ID:${id}|TITLE:${normalizeQueueTitleKey(title)}`
      : `NOSKU:${normalizeQueueTitleKey(title)}`;
    return { sku: '', title, kind: 'title', groupToken: token, cardTitle: title, skuLineText: NO_SKU_PICK_NOTE };
  }

  if (id) {
    return {
      sku: '',
      title: '',
      kind: 'title',
      groupToken: `EBAY_ID:${id}`,
      cardTitle: `eBay item (${id})`,
      skuLineText: NO_SKU_PICK_NOTE,
    };
  }

  return {
    sku: '',
    title: '',
    kind: 'unresolved',
    groupToken: 'UNRESOLVED',
    cardTitle: UNRESOLVED_QUEUE_ITEM_LABEL,
    skuLineText: UNRESOLVED_QUEUE_ITEM_PICK_NOTE,
  };
}

export interface CollapsedQueueLine {
  sku: string;
  description: string;
  qty: number;
  groupToken: string;
  kind: QueueLineKind;
  cardTitle: string;
  skuLineText: string;
}

/**
 * Collapse raw lines into deterministic, qty-merged identity lines. Blank-SKU
 * lines are KEPT (keyed by title/id), never dropped. Sorted by group token so
 * identical combos in any input order produce identical output.
 */
export function collapseIdentityLines(lines: unknown): CollapsedQueueLine[] {
  const rawLines = Array.isArray(lines) ? lines : [];
  const collapsed = new Map<string, CollapsedQueueLine>();
  for (const raw of rawLines) {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const identity = resolveQueueLineIdentity(obj);
    const qty = queueLineQty(obj.qty ?? obj.quantity);
    const existing = collapsed.get(identity.groupToken);
    if (existing) {
      existing.qty += qty;
      if (!existing.description && identity.title) existing.description = identity.title;
    } else {
      collapsed.set(identity.groupToken, {
        sku: identity.sku,
        description: identity.title,
        qty,
        groupToken: identity.groupToken,
        kind: identity.kind,
        cardTitle: identity.cardTitle,
        skuLineText: identity.skuLineText,
      });
    }
  }
  return [...collapsed.values()].sort((a, b) => a.groupToken.localeCompare(b.groupToken));
}

/** Deterministic combo key for grouping a set of collapsed lines. */
export function buildQueueComboKey(lines: Array<{ groupToken: string; qty: number }>): string {
  return lines
    .map((line) => `${line.groupToken}:${queueLineQty(line.qty)}`)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

/** Short, safe combo summary, e.g. "Booster Gel x1 + Samyang Variety Pack x2". */
export function buildQueueComboSummary(lines: CollapsedQueueLine[]): string {
  return lines.map((line) => `${line.cardTitle} x${line.qty}`).join(' + ');
}
