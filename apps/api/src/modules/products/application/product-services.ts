import type {
  SaveProductDefaultsInput,
} from "../../../../../../packages/contracts/src/products/contracts.js";
import type { ProductRepository } from "./product-repository.js";

export class ProductServices {
  private readonly repository: ProductRepository;

  constructor(repository: ProductRepository) {
    this.repository = repository;
  }

  async getBulk(skus: string[]) {
    return await this.repository.getBulk(skus);
  }

  async getBySku(sku: string) {
    return await this.repository.getBySku(sku);
  }

  async saveDefaults(input: SaveProductDefaultsInput) {
    if (!input.productId && !input.sku) {
      throw new Error("productId or sku required");
    }
    return await this.repository.saveDefaults(input);
  }
}
