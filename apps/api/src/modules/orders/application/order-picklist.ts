import type {
  GetOrderPicklistQuery,
  GetOrderPicklistResponse,
} from "../../../../../../packages/contracts/src/orders/contracts.js";
import type { OrderRepository } from "./order-repository.js";

export class OrderPicklistService {
  private readonly repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.repository = repository;
  }

  async execute(query: GetOrderPicklistQuery): Promise<GetOrderPicklistResponse> {
    return {
      skus: await this.repository.getPicklist(query),
      orderStatus: query.orderStatus,
    };
  }
}

