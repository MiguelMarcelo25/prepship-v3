import type {
  GetOrderIdsQuery,
  GetOrderIdsResponse,
} from "../../../../../../packages/contracts/src/orders/contracts.ts";
import type { OrderRepository } from "./order-repository.ts";

export class GetOrderIdsService {
  private readonly repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.repository = repository;
  }

  async execute(query: GetOrderIdsQuery): Promise<GetOrderIdsResponse> {
    return {
      ids: await this.repository.findIdsBySku(query),
    };
  }
}

