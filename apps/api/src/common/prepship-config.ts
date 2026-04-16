import type { CarrierAccountDto } from "../../../../../packages/contracts/src/init/contracts.js";
import type { RateDto } from "../../../../../packages/contracts/src/rates/contracts.js";

export const EXCLUDED_STORE_IDS = [376720, 272465, 309763, 376827];
export const BLOCKED_CARRIER_IDS = new Set([442017, 566344, 593739]);
export const SS_BASELINE_CARRIER_CODES = new Set(["stamps_com", "ups_walleted"]);
export const BLOCKED_SERVICE_CODES = new Set([
  "usps_media_mail",
  "usps_first_class_mail",
  "usps_library_mail",
  "usps_parcel_select",
  "usps_parcel_select_lightweight",
  "ups_surepost_1_lb_or_greater",
  "ups_surepost_less_than_1_lb",
]);
export const BLOCKED_PACKAGE_TYPES = new Set([
  "flat_rate_envelope",
  "flat_rate_legal_envelope",
  "flat_rate_padded_envelope",
  "small_flat_rate_box",
  "medium_flat_rate_box",
  "large_flat_rate_box",
  "regional_rate_box_a",
  "regional_rate_box_b",
]);
export const BLOCKED_NAME_RE = /flat[\s-]?rate|flat rate|\bbox\b/i;
export const MEDIA_MAIL_ALLOWED_STORES = new Set([376759]);

export const EXPEDITED_SERVICES = new Set([
  "ups_2nd_day_air", "ups_2nd_day_air_am",
  "ups_next_day_air", "ups_next_day_air_saver", "ups_next_day_air_early_am",
  "ups_3_day_select",
  "usps_priority_mail_express",
  "fedex_2day", "fedex_2day_am",
  "fedex_express_saver",
  "fedex_priority_overnight", "fedex_standard_overnight", "fedex_first_overnight",
]);

export const CARRIER_ACCOUNTS_V2: CarrierAccountDto[] = [
  { carrierId: "se-433542", carrierCode: "stamps_com", shippingProviderId: 433542, nickname: "USPS Chase x7439", clientId: null, code: "stamps_com", _label: "USPS Chase x7439", accountNumber: "djeon-952w77" },
  { carrierId: "se-433543", carrierCode: "ups_walleted", shippingProviderId: 433543, nickname: "UPS by SS - Chase x7439", clientId: null, code: "ups_walleted", _label: "UPS by SS - Chase x7439", accountNumber: "ups_433543" },
  { carrierId: "se-565326", carrierCode: "ups", shippingProviderId: 565326, nickname: "GG6381", clientId: null, code: "ups", _label: "GG6381", accountNumber: "GG6381" },
  { carrierId: "se-565377", carrierCode: "ups", shippingProviderId: 565377, nickname: "G19Y32", clientId: null, code: "ups", _label: "G19Y32", accountNumber: "G19Y32" },
  { carrierId: "se-596001", carrierCode: "ups", shippingProviderId: 596001, nickname: "ORION", clientId: null, code: "ups", _label: "ORION", accountNumber: "R05H19" },
  { carrierId: "se-604209", carrierCode: "ups", shippingProviderId: 604209, nickname: "ROCEL", clientId: null, code: "ups", _label: "ROCEL", accountNumber: null },
  { carrierId: "se-607855", carrierCode: "ups", shippingProviderId: 607855, nickname: "ROCEL C81F70", clientId: null, code: "ups", _label: "ROCEL C81F70", accountNumber: "C81F70" },
  { carrierId: "se-598840", carrierCode: "fedex", shippingProviderId: 598840, nickname: "FedEx", clientId: null, code: "fedex", _label: "FedEx", accountNumber: "208481048" },
  { carrierId: "se-585004", carrierCode: "fedex_walleted", shippingProviderId: 585004, nickname: "FedEx One Balance", clientId: null, code: "fedex_walleted", _label: "FedEx One Balance", accountNumber: null },
  { carrierId: "se-442006", carrierCode: "stamps_com", shippingProviderId: 442006, nickname: "GREG PAYABILITY 6/17", clientId: 10, code: "stamps_com", _label: "GREG PAYABILITY 6/17", accountNumber: null },
  { carrierId: "se-461890", carrierCode: "ups", shippingProviderId: 461890, nickname: "ROCEL C81F70", clientId: 10, code: "ups", _label: "ROCEL C81F70", accountNumber: "C81F70" },
  { carrierId: "se-565317", carrierCode: "ups", shippingProviderId: 565317, nickname: "GG6381", clientId: 10, code: "ups", _label: "GG6381", accountNumber: "GG6381" },
  { carrierId: "se-595995", carrierCode: "ups", shippingProviderId: 595995, nickname: "ORI Account", clientId: 10, code: "ups", _label: "ORI Account", accountNumber: "R05H19" },
  { carrierId: "se-442007", carrierCode: "ups", shippingProviderId: 442007, nickname: "GREG PAYABILITY 6/17", clientId: 10, code: "ups", _label: "GREG PAYABILITY 6/17", accountNumber: null },
  { carrierId: "se-442013", carrierCode: "fedex", shippingProviderId: 442013, nickname: "FedEx", clientId: 10, code: "fedex", _label: "FedEx", accountNumber: "208481048" },
  { carrierId: "se-585334", carrierCode: "fedex_walleted", shippingProviderId: 585334, nickname: "FedEx One Balance", clientId: 10, code: "fedex_walleted", _label: "FedEx One Balance", accountNumber: null },
  { carrierId: "se-442017", carrierCode: "amazon_buy_shipping", shippingProviderId: 442017, nickname: "Amazon Buy Shipping", clientId: 10, code: "amazon_buy_shipping", _label: "Amazon Buy Shipping", accountNumber: null },
  { carrierId: "se-566344", carrierCode: "sendle", shippingProviderId: 566344, nickname: "Sendle", clientId: 10, code: "sendle", _label: "Sendle", accountNumber: null },
  { carrierId: "se-593739", carrierCode: "amazon_shipping_us", shippingProviderId: 593739, nickname: "Amazon Shipping US", clientId: 10, code: "amazon_shipping_us", _label: "Amazon Shipping US", accountNumber: null },
];

export function isBlockedRate(rate: Pick<RateDto, "serviceCode" | "packageType" | "serviceName">, storeId: number | null = null): boolean {
  if (rate.serviceCode === "usps_media_mail" && storeId != null && MEDIA_MAIL_ALLOWED_STORES.has(storeId)) {
    return false;
  }

  return BLOCKED_SERVICE_CODES.has(rate.serviceCode) ||
    BLOCKED_PACKAGE_TYPES.has(rate.packageType ?? "") ||
    BLOCKED_NAME_RE.test(rate.serviceName ?? "");
}
