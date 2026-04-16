import type { SaveProductDefaultsInput } from "../../../../../../packages/contracts/src/products/contracts.js";
import type { ProductServices } from "../application/product-services.js";

export class ProductsHttpHandler {
  private readonly services: ProductServices;

  constructor(services: ProductServices) {
    this.services = services;
  }

  async handleBulk(url: URL) {
    const skus = (url.searchParams.get("skus") ?? "")
      .split(",")
      .map((sku) => sku.trim())
      .filter(Boolean);
    return await this.services.getBulk(skus);
  }

  async handleBySku(sku: string) {
    return await this.services.getBySku(sku);
  }

  async handleSaveDefaults(body: SaveProductDefaultsInput) {
    return await this.services.saveDefaults(body);
  }

  async handleSaveSkuDefaults(sku: string, body: Record<string, unknown>) {
    return await this.services.saveDefaults({
      sku,
      weightOz: body.weight != null ? Number(body.weight) : body.weightOz != null ? Number(body.weightOz) : undefined,
      length: body.length != null ? Number(body.length) : undefined,
      width: body.width != null ? Number(body.width) : undefined,
      height: body.height != null ? Number(body.height) : undefined,
      packageId: body.packageId != null ? String(body.packageId) : null,
    });
  }
}
