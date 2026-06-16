// PS-280 / PS-278 — the canonical FRONTEND residential/commercial FORWARD rule.
//
// The BACKEND (PS-276 resolver) OWNS the residential/commercial verdict and publishes the
// money-safe value on every order DTO (residentialClassification, also under
// canonicalOrder.recipient). The frontend's ONLY job is to FORWARD that verdict into the rate
// request (the `residential` bit / cache key). It must NEVER re-classify by ZIP, company name,
// raw shipTo, or the legacy boolean fields.
//
// Missing/unknown verdict -> residential-safe `true`, so the residential surcharge is never
// under-quoted (a commercial-by-mistake quote would under-charge and lose money on the real label).
//
// Shared by OrdersView (Best Rate / Recalculate) AND RateBrowserModal so both rate surfaces forward
// the IDENTICAL verdict — one FE rule, not two copies that can drift (the drift that let the Rate
// Browser keep showing "Residential (always)" after PS-276 shipped).
export type ResidentialForRateOrder =
  | {
      residentialClassification?: 'residential' | 'commercial' | null
      canonicalOrder?: {
        recipient?: { residentialClassification?: 'residential' | 'commercial' | null } | null
      } | null
    }
  | null
  | undefined

export function residentialForRate(order: ResidentialForRateOrder): boolean {
  const backendClass =
    order?.residentialClassification ?? order?.canonicalOrder?.recipient?.residentialClassification
  if (backendClass === 'residential') return true
  if (backendClass === 'commercial') return false
  // missing / unknown -> residential-safe (never under-quote the residential surcharge)
  return true
}
