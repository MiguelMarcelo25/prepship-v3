import type {
  ProductBulkItemDto,
  SaveProductDefaultsInput,
} from "../../../../../../packages/contracts/src/products/contracts.js";
import type { ProductDefaultsRecord, SaveProductDefaultsRecordResult } from "../domain/product.js";

export interface ProductRepository {
  getBulk(skus: string[]): Promise<Record<string, ProductBulkItemDto>>;
  getBySku(sku: string): Promise<ProductDefaultsRecord | null>;
  saveDefaults(input: SaveProductDefaultsInput): Promise<SaveProductDefaultsRecordResult>;
}
