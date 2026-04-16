import type {
  ListOrdersQuery,
  ListOrdersResponse,
  OrderSummaryDto,
} from "../../../../../../packages/contracts/src/orders/contracts.js";
import type { OrderRepository } from "./order-repository.js";
import type { RateServices } from "../../rates/application/rate-services.js";
import type { ShipstationResidentialGateway } from "../data/shipstation-residential-gateway.js";
import {
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
  parseOrderRateJson,
} from "./order-rate-dto.js";
import { resolveCarrierNickname } from "./carrier-resolver.js";

function parseRawJson(value: string | null): unknown | null {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function toOrderDto(
  record: ReturnType<OrderRepository["list"]>["orders"][number],
  rateServices: RateServices | null,
): Promise<OrderSummaryDto> {
  let rawData = parseRawJson(record.raw) as any;
  
  // Enrich raw data with database-level externallyFulfilled flag
  // This ensures the frontend can check isExternallyFulfilledOrder(order)
  if (record.externallyFulfilledVerified) {
    if (!rawData) {
      // Create minimal raw object if it doesn't exist
      rawData = {};
    }
    rawData.externallyFulfilled = true;
  }
  
  const itemsStr = record.items || "[]";
  let items = [];
  try {
    items = Array.isArray(itemsStr) ? itemsStr : JSON.parse(itemsStr);
  } catch {
    items = [];
  }
  
  const shipTo = (record.shipToName || record.shipToCity || record.shipToState || record.shipToPostalCode)
    ? {
        name: record.shipToName || null,
        city: record.shipToCity || null,
        state: record.shipToState || null,
        postalCode: record.shipToPostalCode || null,
      }
    : null;

  const weight = record.weightValue != null && record.weightValue > 0
    ? { value: record.weightValue, units: "ounces" }
    : null;
  
  // bestRate is ONLY for awaiting_shipment orders (used for rate shopping UI).
  // Shipped/cancelled orders must never expose bestRate — it is stale and misleading.
  // selectedRate (from shipments table) is the source of truth for shipped orders.
  let bestRate = null;
  if (record.orderStatus === "awaiting_shipment") {
    bestRate = normalizeOrderBestRateDto(parseOrderRateJson(record.bestRateJson, `order ${record.orderId} bestRateJson`));
    if (!bestRate && rateServices && weight && record.shipToPostalCode) {
      const cached = await rateServices.getCached({
        wt: weight.value,
        zip: record.shipToPostalCode,
        dims: null,
        storeId: record.storeId,
        residential: record.residential ?? false,
      });
      if (cached.cached && cached.best) {
        bestRate = normalizeOrderBestRateDto(cached.best, `order ${record.orderId} cachedBestRate`);
      }
    }
  }
  
  return {
    orderId: record.orderId,
    clientId: record.clientId,
    clientName: record.clientName,
    orderNumber: record.orderNumber,
    orderStatus: record.orderStatus,
    orderDate: record.orderDate,
    storeId: record.storeId,
    customerEmail: record.customerEmail,
    shipTo,
    carrierCode: record.carrierCode,
    serviceCode: record.serviceCode,
    weight,
    orderTotal: record.orderTotal,
    shippingAmount: record.shippingAmount,
    residential: record.residential,
    sourceResidential: record.sourceResidential,
    externalShipped: record.externalShipped,
    bestRate,
    selectedRate: (() => {
      // For shipped orders: selectedRate comes ONLY from shipments table data.
      // Never fall back to bestRate or best_rate_json for shipped orders.
      const parsed = parseOrderRateJson(record.selectedRateJson, `order ${record.orderId} selectedRateJson`);
      const fallback = {
        providerAccountId: record.labelProvider,
        carrierCode: record.labelCarrier,
        serviceCode: record.labelService,
        shipmentCost: record.labelRawCost,
        otherCost: record.labelCost != null && record.labelRawCost != null
          ? record.labelCost - record.labelRawCost
          : null,
      };

      // If we have parsed selectedRate json, use it with shipment fallback.
      // Nickname comes from shipments.provider_account_nickname (stored at write time, immutable).
      // Only fall back to resolver if DB value is missing (old records pre-migration).
      if (parsed != null) {
        const rate = normalizeOrderSelectedRateDto(parsed, fallback, `order ${record.orderId} selectedRate`);
        if (rate) {
          rate.providerAccountNickname = record.labelProviderNickname
            ?? rate.providerAccountNickname
            ?? resolveCarrierNickname(rate.providerAccountId ?? record.labelProvider, rate.carrierCode ?? record.labelCarrier, record.labelTracking, record.clientId);
        }
        return rate;
      }

      // No stored selectedRate json — for shipped orders, build from shipment record data
      if (record.orderStatus === "shipped" && (record.labelCarrier || record.labelService || record.labelProvider)) {
        const nickname = record.labelProviderNickname
          ?? resolveCarrierNickname(record.labelProvider, record.labelCarrier, record.labelTracking, record.clientId);
        return normalizeOrderSelectedRateDto(
          {
            providerAccountId: record.labelProvider,
            providerAccountNickname: nickname,
            carrierCode: record.labelCarrier,
            serviceCode: record.labelService,
            shipmentCost: record.labelRawCost,
            otherCost: 0,
          },
          fallback,
          `order ${record.orderId} selectedRate`,
        );
      }

      return null;
    })(),
    label: {
      shipmentId: record.labelShipmentId,
      trackingNumber: record.labelTracking,
      carrierCode: record.labelCarrier,
      serviceCode: record.labelService,
      shippingProviderId: record.labelProvider,
      cost: record.labelCost,
      rawCost: record.labelRawCost,
      shipDate: record.labelShipDate,
      createdAt: record.labelCreatedAt,
      labelUrl: record.labelUrl,
    },
    items,
    raw: rawData,
  };
}

export class ListOrdersService {
  private readonly repository: OrderRepository;
  private readonly rateServices: RateServices | null;
  private readonly residentialGateway: ShipstationResidentialGateway | null;

  constructor(
    repository: OrderRepository,
    rateServices?: RateServices,
    residentialGateway?: ShipstationResidentialGateway,
  ) {
    this.repository = repository;
    this.rateServices = rateServices ?? null;
    this.residentialGateway = residentialGateway ?? null;
  }

  async execute(query: ListOrdersQuery): Promise<ListOrdersResponse> {
    const result = await this.repository.list(query);

    // Enrich orders with ShipStation residential status BEFORE mapping to DTO
    // This ensures rates are fetched with the correct residential flag
    if (this.residentialGateway && result.orders.length > 0) {
      const residentialResults = await this.residentialGateway.lookupResidential(
        result.orders.map((record) => ({
          orderId: record.orderId,
          shipStationOrderNumber: record.orderNumber,
        })),
      );

      // Merge ShipStation residential status into records
      const residentialMap = new Map(
        residentialResults
          .filter((r) => r.residential !== null)
          .map((r) => [r.orderId, r.residential]),
      );

      for (const record of result.orders) {
        const ssResidential = residentialMap.get(record.orderId);
        if (ssResidential !== undefined) {
          // Update sourceResidential if ShipStation provided a value
          record.sourceResidential = ssResidential;
        }
      }
    }

    const pages = Math.max(1, Math.ceil(result.total / query.pageSize));

    return {
      orders: await Promise.all(result.orders.map((record) => toOrderDto(record, this.rateServices))),
      page: query.page,
      pages,
      total: result.total,
    };
  }
}
