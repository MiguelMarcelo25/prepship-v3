import type { OrderSummaryDto } from "../../../../../../packages/contracts/src/orders/contracts.js";
import type { OrderRepository } from "./order-repository.js";
import type { RateServices } from "../../rates/application/rate-services.js";
import {
  normalizeOrderBestRateDto,
  normalizeOrderSelectedRateDto,
  parseOrderRateJson,
} from "./order-rate-dto.js";
import { resolveCarrierNickname } from "./carrier-resolver.js";

export class OrderDetailsService {
  private readonly repository: OrderRepository;
  private readonly rateServices: RateServices | null;

  constructor(repository: OrderRepository, rateServices?: RateServices) {
    this.repository = repository;
    this.rateServices = rateServices ?? null;
  }

  async getRecord(orderId: number) {
    return await this.repository.getById(orderId);
  }

  async execute(orderId: number): Promise<OrderSummaryDto | null> {
    const record = await this.repository.getById(orderId);

    if (!record) {
      return null;
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

    // Look up sku_qty_dims for this order's primary SKU+QTY combo
    // This is the user-saved dimension record for this exact packing scenario.
    // We intentionally do NOT fall back to order_local.rate_dims_* because:
    //   - Different QTY = different packing = should show blank, not previous dims
    //   - order_local.rate_dims_* is auto-populated by rate shopper (not user intent)
    let rateDims: { length: number; width: number; height: number } | null = null;
    let parsedItems: Array<{ sku?: string; quantity?: number; adjustment?: boolean }> = [];
    try {
      parsedItems = Array.isArray(items) ? items as typeof parsedItems : JSON.parse(record.items) as typeof parsedItems;
    } catch { /* ignore */ }
    const activeItems = parsedItems.filter((i) => !i.adjustment && i.sku);
    const uniqueSkus = [...new Set(activeItems.map((i) => i.sku).filter(Boolean))];
    if (uniqueSkus.length === 1) {
      const sku = uniqueSkus[0] as string;
      const qty = activeItems.filter((i) => i.sku === sku).reduce((s, i) => s + (i.quantity ?? 1), 0);
      const dims = await this.repository.getSkuQtyDims(sku, qty);
      if (dims) {
        // Validate saved dimensions against order weight.
        // A heavy order (>= 16 oz) packed into a tiny box (< 1000 cubic inches)
        // is almost certainly stale single-unit packing data — discard it so the
        // UI prompts the user to enter correct dimensions instead of silently
        // using wrong data for rate calculations.
        const orderWeightOz = record.weightValue ?? 0;
        const cubicInches = dims.length * dims.width * dims.height;
        const isHeavy = orderWeightOz >= 16;
        const isTinyBox = cubicInches < 1000;
        if (isHeavy && isTinyBox) {
          // Dimensions are implausible for this weight — treat as missing
          rateDims = null;
        } else {
          rateDims = dims;
        }
      }
    }

    let rawData: any = null;
    try {
      rawData = record.raw ? JSON.parse(record.raw) as any : null;
    } catch {
      rawData = null;
    }
    
    // Enrich raw data with database-level externallyFulfilled flag
    // This ensures the frontend can check isExternallyFulfilledOrder(order)
    if (record.externallyFulfilledVerified) {
      if (!rawData) {
        // Create minimal raw object if it doesn't exist
        rawData = {};
      }
      rawData.externallyFulfilled = true;
    }

    // bestRate is ONLY for awaiting_shipment — never expose on shipped/cancelled orders
    let bestRate = null;
    if (record.orderStatus === "awaiting_shipment") {
      bestRate = rateDims 
        ? normalizeOrderBestRateDto(parseOrderRateJson(record.bestRateJson, `order ${record.orderId} bestRateJson`))
        : null;
      if (!bestRate && this.rateServices && weight && record.shipToPostalCode && rateDims) {
        const cached = await this.rateServices.getCached({
          wt: weight.value,
          zip: record.shipToPostalCode,
          dims: rateDims,
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
        if (parsed != null) {
          const rate = normalizeOrderSelectedRateDto(parsed, fallback, `order ${record.orderId} selectedRate`);
          if (rate) {
            rate.providerAccountNickname = record.labelProviderNickname
              ?? rate.providerAccountNickname
              ?? resolveCarrierNickname(rate.providerAccountId ?? record.labelProvider, rate.carrierCode ?? record.labelCarrier, record.labelTracking, record.clientId);
          }
          return rate;
        }
        if (record.orderStatus === "shipped" && (record.labelCarrier || record.labelService || record.labelProvider)) {
          const nickname = record.labelProviderNickname
            ?? resolveCarrierNickname(record.labelProvider, record.labelCarrier, record.labelTracking, record.clientId);
          return normalizeOrderSelectedRateDto(
            { providerAccountId: record.labelProvider, providerAccountNickname: nickname, carrierCode: record.labelCarrier, serviceCode: record.labelService, shipmentCost: record.labelRawCost, otherCost: 0 },
            fallback, `order ${record.orderId} selectedRate`,
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
      rateDims,
    };
  }
}
