import type { AddToQueueInput, PrintQueueEntry } from "../domain/queue.ts";

export interface QueueRepository {
  add(input: AddToQueueInput): Promise<PrintQueueEntry>;
  getByClient(clientId: number, status?: 'queued' | 'printed'): Promise<PrintQueueEntry[]>;
  findById(id: string): Promise<PrintQueueEntry | null>;
  findByOrderId(orderId: string, clientId: number): Promise<PrintQueueEntry | null>;
  markPrinted(ids: string[], printedAt: number): Promise<void>;
  remove(id: string): Promise<void>;
  clearByClient(clientId: number): Promise<number>;
}
