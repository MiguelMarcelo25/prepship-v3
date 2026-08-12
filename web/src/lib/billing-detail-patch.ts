/**
 * PS-499 — the wire contract for PATCH /billing/details/:orderId.
 *
 * Two callers, two fundamentally different intents, so two contracts:
 *
 * - The Edit Billing modal is a DELIBERATE full edit. The operator saw every
 *   money field and chose each value, so sending all of them is honest.
 * - The pasted Box Size / Shipping import is SPARSE. The operator supplied a box
 *   and/or a shipping amount and said nothing about prep fees, so the payload
 *   must say nothing about them either.
 *
 * The route keys durable decisions off field PRESENCE (a present `pickPack: 0`
 * is the PS-389 prep-fee waiver; a present `packageCost` pins
 * `billing_box_resolutions.override_price`). PS-499's July underbilling was a
 * sparse intent sent in a full-edit shape. `?: never` on the bulk variants is
 * what makes that shape fail to compile rather than fail in production.
 *
 * Lives in lib/ rather than beside the mapper so the transport layer does not
 * have to import from components/ to know its own contract.
 */

/** The Edit Billing modal: every money field explicitly chosen by the operator. */
export type BillingManualEditPatch = {
  source?: 'manual_edit'
  pickPack: number
  additional: number
  packageCost: number
  shipping: number
  /** billing-line-only box override; null clears it and keeps the shipment box. */
  packageId: number | null
  reason: string
  note?: string
  orderDescription?: string
}

type BulkImportCommon = {
  source: 'bulk_import'
  reason: string
  orderDescription?: string
}

/**
 * The three legal bulk-import intents. Every variant forbids the generated-money
 * fields outright: Pick & Pack and Additional Units are owned by the billing
 * generator, and package cost is owned by `decidePackageCostLine` on the server,
 * which is why a box import sends `packageId` and never a price.
 */
export type BillingBulkImportPatch =
  | (BulkImportCommon & {
      shipping: number
      packageId?: never
      packageCost?: never
      pickPack?: never
      additional?: never
    })
  | (BulkImportCommon & {
      packageId: number
      shipping?: never
      packageCost?: never
      pickPack?: never
      additional?: never
    })
  | (BulkImportCommon & {
      packageId: number
      shipping: number
      packageCost?: never
      pickPack?: never
      additional?: never
    })

export type BillingDetailPatch = BillingManualEditPatch | BillingBulkImportPatch
