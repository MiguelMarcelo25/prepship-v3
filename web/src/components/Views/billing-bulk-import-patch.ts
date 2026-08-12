/**
 * PS-499 — the ONE place a resolved paste row becomes a billing PATCH payload.
 *
 * The rule this file exists to enforce: an untouched field is ABSENT from the
 * payload, never resent at its current value. The route keys durable decisions
 * off field presence — a present `pickPack: 0` is the PS-389 prep-fee waiver, a
 * present `shipping` is a durable shipping override, a present `packageCost`
 * pins `billing_box_resolutions.override_price`. So resending an untouched field
 * converts a generated amount into an operator decision that survives
 * regeneration, which is how the July HUGRAB rows were underbilled.
 *
 * Consequently this mapper never reads the current detail row. It cannot: it is
 * not given one. Pick & Pack, Additional Units and Box Cost are owned by the
 * backend generator and `decidePackageCostLine`; a box import sends `packageId`
 * and lets the route resolve the configured price, so there is no second
 * billing calculator on this side of the wire.
 */
import type { BulkImportReadyRow } from './billing-bulk-import'
import type { BillingBulkImportPatch } from '../../lib/billing-detail-patch'

export type { BillingBulkImportPatch }

type BulkImportPatchCommon = {
  source: 'bulk_import'
  reason: string
  orderDescription?: string
}

export function toBillingBulkImportPatch(
  row: BulkImportReadyRow,
  reason: string,
): BillingBulkImportPatch {
  const common: BulkImportPatchCommon = {
    source: 'bulk_import',
    reason,
    // PS-498: the key is omitted, not blanked. Absence leaves any stored
    // description alone; an empty string is rejected by the route, not a clear.
    ...(row.description ? { orderDescription: row.description } : {}),
  }

  // `!== null`, never truthiness: a pasted `0` is an intentional override and
  // must survive to the wire, while a blank cell must not become one.
  const hasBox = row.packageId !== null
  const hasShipping = row.shipping !== null

  if (hasBox && hasShipping) {
    return { ...common, packageId: row.packageId as number, shipping: row.shipping as number }
  }
  if (hasBox) {
    return { ...common, packageId: row.packageId as number }
  }
  if (hasShipping) {
    return { ...common, shipping: row.shipping as number }
  }

  // `resolveBulkImportRows` already marks such a row `nothing_to_change`, so this
  // is unreachable via the UI. It throws rather than returning a metadata-only
  // patch because a PATCH carrying only a reason would be an audited no-op write.
  throw new Error('Bulk import row contains no patchable intent')
}
