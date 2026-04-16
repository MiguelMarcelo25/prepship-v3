import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.js";
import type {
  OrderBestRateDto,
  OrderSelectedRateDto,
} from "../../../../../../packages/contracts/src/orders/contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function readNullableString(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string or null`);
  }
  return value;
}

function readNullableStringLike(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${path} must be a string, number, or null`);
  }
  return String(value);
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function readNullableNumber(value: unknown, path: string): number | null {
  if (value == null) return null;
  return readNumber(value, path);
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function hasAnyMeaningfulRateField(rate: OrderBestRateDto): boolean {
  return (
    rate.serviceCode != null ||
    rate.serviceName != null ||
    rate.carrierCode != null ||
    rate.shippingProviderId != null ||
    rate.shipmentCost > 0 ||
    rate.otherCost > 0
  );
}

function hasAnyMeaningfulSelectedRateField(rate: OrderSelectedRateDto): boolean {
  return (
    rate.providerAccountId != null ||
    rate.providerAccountNickname != null ||
    rate.shippingProviderId != null ||
    rate.carrierCode != null ||
    rate.serviceCode != null ||
    rate.serviceName != null ||
    rate.cost != null ||
    rate.shipmentCost != null ||
    rate.otherCost != null
  );
}

export function parseOrderRateJson(value: string | null, path: string): unknown | null {
  if (value == null) return null;

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${path} contains invalid JSON`);
  }
}

export function normalizeOrderBestRateDto(value: unknown, path = "bestRate"): OrderBestRateDto | null {
  if (value == null) return null;

  const record = expectRecord(value, path);
  const rate: OrderBestRateDto = {
    serviceCode: readNullableString(record.serviceCode ?? null, `${path}.serviceCode`),
    serviceName: readNullableString(record.serviceName ?? record.serviceCode ?? null, `${path}.serviceName`),
    packageType: readNullableString(record.packageType ?? null, `${path}.packageType`),
    shipmentCost: readNumber(record.shipmentCost ?? record.cost ?? 0, `${path}.shipmentCost`),
    otherCost: readNumber(record.otherCost ?? 0, `${path}.otherCost`),
    rateDetails: readArray(record.rateDetails ?? [], `${path}.rateDetails`),
    carrierCode: readNullableString(record.carrierCode ?? record.carrier ?? null, `${path}.carrierCode`),
    shippingProviderId: readNullableNumber(record.shippingProviderId ?? record.providerAccountId ?? null, `${path}.shippingProviderId`),
    carrierNickname: readNullableString(record.carrierNickname ?? record._carrierName ?? null, `${path}.carrierNickname`),
    guaranteed: readBoolean(record.guaranteed ?? false, `${path}.guaranteed`),
    zone: readNullableStringLike(record.zone ?? null, `${path}.zone`),
    sourceClientId: readNullableNumber(record.sourceClientId ?? record.clientId ?? null, `${path}.sourceClientId`),
    deliveryDays: readNullableNumber(record.deliveryDays ?? null, `${path}.deliveryDays`),
    estimatedDelivery: readNullableString(record.estimatedDelivery ?? null, `${path}.estimatedDelivery`),
  };

  return hasAnyMeaningfulRateField(rate) ? rate : null;
}

export function assertPersistedOrderBestRateDto(value: unknown, path = "bestRate"): OrderBestRateDto {
  const rate = normalizeOrderBestRateDto(value, path);
  if (!rate) {
    throw new InputValidationError(`${path} must include a carrier/service or cost payload`);
  }
  if (!rate.serviceCode) {
    throw new InputValidationError(`${path}.serviceCode is required`);
  }
  if (!rate.carrierCode) {
    throw new InputValidationError(`${path}.carrierCode is required`);
  }
  return rate;
}

export function normalizeOrderSelectedRateDto(
  value: unknown,
  fallback?: {
    providerAccountId?: number | null;
    carrierCode?: string | null;
    serviceCode?: string | null;
    shipmentCost?: number | null;
    otherCost?: number | null;
  },
  path = "selectedRate",
): OrderSelectedRateDto | null {
  if (value == null) return null;

  const record = expectRecord(value, path);
  const providerAccountId = readNullableNumber(
    record.providerAccountId ?? record.shippingProviderId ?? fallback?.providerAccountId ?? null,
    `${path}.providerAccountId`,
  );
  const shipmentCost = readNullableNumber(
    record.shipmentCost ?? record.cost ?? fallback?.shipmentCost ?? null,
    `${path}.shipmentCost`,
  );
  const fallbackOtherCost = shipmentCost != null || fallback?.otherCost != null
    ? (fallback?.otherCost ?? 0)
    : null;
  const otherCost = readNullableNumber(record.otherCost ?? fallbackOtherCost, `${path}.otherCost`);
  const rate: OrderSelectedRateDto = {
    providerAccountId,
    providerAccountNickname: readNullableString(
      record.providerAccountNickname ?? null,
      `${path}.providerAccountNickname`,
    ),
    shippingProviderId: readNullableNumber(
      record.shippingProviderId ?? providerAccountId ?? fallback?.providerAccountId ?? null,
      `${path}.shippingProviderId`,
    ),
    carrierCode: readNullableString(record.carrierCode ?? fallback?.carrierCode ?? null, `${path}.carrierCode`),
    serviceCode: readNullableString(record.serviceCode ?? fallback?.serviceCode ?? null, `${path}.serviceCode`),
    serviceName: readNullableString(record.serviceName ?? record.serviceCode ?? fallback?.serviceCode ?? null, `${path}.serviceName`),
    cost: readNullableNumber(record.cost ?? shipmentCost ?? null, `${path}.cost`),
    shipmentCost,
    otherCost,
  };

  return hasAnyMeaningfulSelectedRateField(rate) ? rate : null;
}
