import type { OrderRepository } from "./order-repository.js";

export class OrderDailyStatsService {
  private readonly repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.repository = repository;
  }

  async execute() {
    return await this.repository.getDailyStats();
  }
}
