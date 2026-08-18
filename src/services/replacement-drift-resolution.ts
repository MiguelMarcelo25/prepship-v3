/**
 * PS-502 — re-resolve a replacement's frozen source lines against the order as it is NOW.
 *
 * READ ONLY. It reports the first item whose frozen coordinate no longer matches and never
 * writes, transitions or decides. Callers persist the review; this only answers the question.
 *
 * ONE OWNER. Both the shipment command and the lifecycle command must re-resolve before they
 * act, and the card requires re-resolution "before approval AND before label purchase". Two
 * copies of this comparison would eventually disagree about what counts as drift, and the
 * disagreement would surface as one boundary letting through what another blocks — which is
 * precisely the silent-retarget outcome section A exists to prevent.
 *
 * Effective target: the latest remap for an item when one exists, otherwise the originally
 * frozen coordinate. `replacement_items` is never rewritten, so a remapped item is compared
 * against what it was RESOLVED to while still preserving what was REQUESTED.
 */
import { desc, eq } from 'drizzle-orm';
import { orderItems } from '../db/schema/order-items';
import { replacementItemRemaps, replacementItems } from '../db/schema/replacements';
import { currentSourceLineFingerprint } from './replacement-source-line-fingerprint';
import { evaluateReplacementSourceLineDrift } from './replacement-state-machine';

export type DriftFinding = {
  replacementItemId: number;
  /** The coordinate actually in force — the latest remap's, or the frozen one. */
  effectiveOrderLineIndex: number;
  effectiveFingerprint: string;
  /** True when a remap moved this item, so review can say which target failed. */
  viaRemap: boolean;
};

type Tx = {
  select: (...args: never[]) => unknown;
};

/**
 * The first drifting item, or null when every item still resolves.
 *
 * Returns the FIRST rather than all of them deliberately: the caller's response is the same
 * either way — review the replacement and stop — and reporting one specific coordinate gives
 * an operator somewhere concrete to look. A full list is a read model's job, not a gate's.
 */
export async function findFrozenLineDrift(
  tx: any,
  replacement: { id: number; orderId: number },
): Promise<DriftFinding | null> {
  const frozenItems = await tx
    .select({
      id: replacementItems.id,
      orderLineIndex: replacementItems.orderLineIndex,
      sourceLineFingerprint: replacementItems.sourceLineFingerprint,
    })
    .from(replacementItems)
    .where(eq(replacementItems.replacementId, replacement.id));

  const currentLines = await tx
    .select({
      orderId: orderItems.orderId,
      lineIndex: orderItems.lineIndex,
      sku: orderItems.sku,
      name: orderItems.name,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, replacement.orderId));

  for (const item of frozenItems as Array<{
    id: number; orderLineIndex: number; sourceLineFingerprint: string;
  }>) {
    // A remap supersedes the frozen coordinate for COMPARISON only; the frozen row stays.
    const [latestRemap] = await tx
      .select({
        resolvedOrderLineIndex: replacementItemRemaps.resolvedOrderLineIndex,
        resolvedSourceLineFingerprint: replacementItemRemaps.resolvedSourceLineFingerprint,
      })
      .from(replacementItemRemaps)
      .where(eq(replacementItemRemaps.replacementItemId, item.id))
      .orderBy(desc(replacementItemRemaps.remapVersion))
      .limit(1);

    const effectiveIndex = latestRemap?.resolvedOrderLineIndex ?? item.orderLineIndex;
    const effectiveFingerprint =
      latestRemap?.resolvedSourceLineFingerprint ?? item.sourceLineFingerprint;

    const verdict = evaluateReplacementSourceLineDrift({
      frozenFingerprint: effectiveFingerprint,
      currentFingerprint: currentSourceLineFingerprint(currentLines as never[], {
        orderId: replacement.orderId,
        orderLineIndex: effectiveIndex,
      }),
    });
    if (verdict.matches) continue;

    return {
      replacementItemId: item.id,
      effectiveOrderLineIndex: effectiveIndex,
      effectiveFingerprint,
      viaRemap: latestRemap != null,
    };
  }

  return null;
}
