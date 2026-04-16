import type { OrderOverrideInput } from "../../../../../../packages/contracts/src/orders/contracts.js";
import type { OrderRepository } from "./order-repository.js";

export class UpdateOrderOverridesService {
  readonly repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.repository = repository;
  }

  async setExternalShipped(orderId: number, externalShipped: boolean, source: string | null = null) {
    // NOTE: This flag marks an order as fulfilled externally (Amazon, eBay, Shopify, etc.)
    // It is a LOCAL-ONLY flag in PrepShip's database.
    // NO notification is sent to the customer or original marketplace.
    // This is for internal tracking only when orders are manually fulfilled outside PrepShip.
    await this.repository.updateExternalShipped(orderId, externalShipped, source);
    return { ok: true, orderId, orderStatus: externalShipped ? 'shipped' : 'awaiting_shipment', external_shipped: externalShipped ? 1 : 0, source };
  }

  async setResidential(orderId: number, residential: boolean | null) {
    await this.repository.updateResidential(orderId, residential);
    return { ok: true, orderId, residential: residential == null ? null : residential ? 1 : 0 };
  }

  async setSelectedPid(orderId: number, selectedPid: number | null) {
    await this.repository.updateSelectedPid(orderId, selectedPid);
    return { ok: true, orderId, selectedPid };
  }

  async setBestRate(input: OrderOverrideInput) {
    if (input.bestRate == null) {
      throw new Error("best + orderId required");
    }
    await this.repository.updateBestRate(input.orderId, input.bestRate, input.bestRateDims ?? null);
    return { ok: true };
  }

  async saveDims(orderId: number, sku: string | null, qty: number | null, length: number, width: number, height: number) {
    if (length <= 0 || width <= 0 || height <= 0) {
      throw new Error("length, width, height must all be > 0");
    }
    // Always save to per-order dims
    await this.repository.updateOrderRateDims(orderId, length, width, height);
    // Save to sku_qty_dims if SKU and qty provided (single-SKU orders)
    if (sku && qty != null && qty > 0) {
      await this.repository.saveSkuQtyDims(sku, qty, length, width, height);
    }
    return { ok: true, orderId, sku, qty, length, width, height };
  }
}
