import type { MarkupRule } from './rate-money';

/**
 * #798 fix — resolve a shipment's per-ACCOUNT markup rule from the settings markup.<account> map, keyed
 * on the SAME namespace the rate DISPLAY uses, so quote == invoice.
 *
 * The display path (rates.ts applyMarkups) looks a rate's markup up by:
 *     markups.get(String(carrier_id))  ??  markups.get(bare digits of /^se-(\d+)$/)
 * i.e. a settings key of either `markup.se-595995` OR `markup.595995` matches a rate on account 595995.
 *
 * Billing must key on the SAME identifier. The shipment column to use is `providerAccountId` (integer) —
 * it is reliably written by BOTH the sync path (shipment-sync) AND the label path (labels.ts via
 * carrierIdToProviderAccountId, which strips the `se-` prefix → the bare numeric). The earlier slice
 * keyed on `shipments.carrierAccountId`, which is NULL on synced rows and a different namespace → the
 * per-account markup never billed. providerAccountId == applyMarkups' bare fallback key; `se-<id>` ==
 * its carrier_id key. We try BOTH forms so billing matches whichever form the operator configured.
 */
export function resolvePerAccountMarkupRule(
  markups: Map<string, MarkupRule> | null | undefined,
  providerAccountId: number | null | undefined,
): MarkupRule | null {
  if (!markups || providerAccountId == null || !Number.isFinite(providerAccountId)) return null;
  return markups.get(`se-${providerAccountId}`) ?? markups.get(String(providerAccountId)) ?? null;
}
