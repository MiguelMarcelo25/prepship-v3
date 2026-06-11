/**
 * PS-189 — canonical account→service catalog.
 *
 * Single source of truth for which label services each carrier account family
 * offers in the side-panel service picker. The FE's OrdersView used to keep its
 * own CARRIER_SERVICES copy of this table AND auto-defaulted the FIRST entry on
 * account switch — for stamps_com that silently stamped usps_media_mail (a
 * legally restricted, books-only service) into the purchase payload with no
 * backend re-check. The FE now reads this catalog via GET /carriers/service-
 * catalog and NEVER auto-picks a service the operator didn't choose.
 *
 * Service ELIGIBILITY (who may buy what, e.g. HUGRAB Ground Saver blocks) stays
 * with src/lib/shipping-service-eligibility — this catalog only answers "what
 * services exist on this account family", availability not permission.
 */

export type CarrierServiceOption = { code: string; label: string };

const CARRIER_SERVICE_CATALOG: Record<string, CarrierServiceOption[]> = {
  stamps_com: [
    // NOTE: media mail is listed (it exists on the account) but is NEVER
    // auto-defaulted — USPS restricts it to qualifying media; the operator
    // must explicitly choose it.
    { code: 'usps_media_mail', label: 'USPS Media Mail' },
    { code: 'usps_first_class_mail', label: 'USPS First Class Mail' },
    { code: 'usps_ground_advantage', label: 'USPS Ground Advantage' },
    { code: 'usps_priority_mail', label: 'USPS Priority Mail' },
    { code: 'usps_priority_mail_express', label: 'USPS Priority Express' },
    { code: 'usps_parcel_select', label: 'USPS Parcel Select' },
  ],
  ups: [
    { code: 'ups_ground', label: 'UPS Ground' },
    { code: 'ups_ground_saver', label: 'UPS Ground Saver' },
    { code: 'ups_surepost_less_than_1_lb', label: 'UPS Ground Saver (<1 lb)' },
    { code: 'ups_surepost_1_lb_or_greater', label: 'UPS Ground Saver (1 lb+)' },
    { code: 'ups_3_day_select', label: 'UPS 3 Day Select' },
    { code: 'ups_2nd_day_air', label: 'UPS 2nd Day Air' },
    { code: 'ups_2nd_day_air_am', label: 'UPS 2nd Day Air AM' },
    { code: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver' },
    { code: 'ups_next_day_air', label: 'UPS Next Day Air' },
  ],
  ups_walleted: [
    { code: 'ups_ground', label: 'UPS Ground' },
    { code: 'ups_ground_saver', label: 'UPS Ground Saver' },
    { code: 'ups_surepost_less_than_1_lb', label: 'UPS Ground Saver (<1 lb)' },
    { code: 'ups_surepost_1_lb_or_greater', label: 'UPS Ground Saver (1 lb+)' },
    { code: 'ups_3_day_select', label: 'UPS 3 Day Select' },
    { code: 'ups_2nd_day_air', label: 'UPS 2nd Day Air' },
    { code: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver' },
    { code: 'ups_next_day_air', label: 'UPS Next Day Air' },
  ],
  fedex: [
    { code: 'fedex_ground', label: 'FedEx Ground' },
    { code: 'fedex_home_delivery', label: 'FedEx Home Delivery' },
    { code: 'fedex_2day', label: 'FedEx 2Day' },
    { code: 'fedex_express_saver', label: 'FedEx Express Saver' },
    { code: 'fedex_priority_overnight', label: 'FedEx Priority Overnight' },
    { code: 'fedex_standard_overnight', label: 'FedEx Standard Overnight' },
  ],
  fedex_walleted: [
    { code: 'fedex_ground', label: 'FedEx Ground' },
    { code: 'fedex_home_delivery', label: 'FedEx Home Delivery' },
    { code: 'fedex_2day', label: 'FedEx 2Day' },
    { code: 'fedex_express_saver', label: 'FedEx Express Saver' },
    { code: 'fedex_priority_overnight', label: 'FedEx Priority Overnight' },
    { code: 'fedex_standard_overnight', label: 'FedEx Standard Overnight' },
  ],
};

export function servicesForCarrierCode(carrierCode: string | null | undefined): CarrierServiceOption[] {
  if (!carrierCode) return [];
  return CARRIER_SERVICE_CATALOG[carrierCode] ?? [];
}

export function fullServiceCatalog(): Record<string, CarrierServiceOption[]> {
  return CARRIER_SERVICE_CATALOG;
}
