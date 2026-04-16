import type { DatabaseSync } from "node:sqlite";
import type { QueueRepository } from "../application/queue-repository.ts";
import type { AddToQueueInput, MultiSkuItem, PrintQueueEntry } from "../domain/queue.ts";
import { randomUUID } from "node:crypto";

interface PrintQueueRow {
  id: string;
  client_id: number;
  order_id: string;
  order_number: string | null;
  label_url: string;
  sku_group_id: string;
  primary_sku: string | null;
  item_description: string | null;
  order_qty: number;
  multi_sku_data: string | null;
  status: string;
  print_count: number;
  last_printed_at: number | null;
  queued_at: number;
  created_at: number;
}

export class SqliteQueueRepository implements QueueRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async add(input: AddToQueueInput): Promise<PrintQueueEntry> {
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO print_queue_orders (
        id, client_id, order_id, order_number, label_url,
        sku_group_id, primary_sku, item_description, order_qty,
        multi_sku_data, status, print_count, last_printed_at,
        queued_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)
      ON CONFLICT(order_id, client_id) DO UPDATE SET
        label_url = excluded.label_url,
        sku_group_id = excluded.sku_group_id,
        primary_sku = excluded.primary_sku,
        item_description = excluded.item_description,
        order_qty = excluded.order_qty,
        multi_sku_data = excluded.multi_sku_data,
        status = 'queued',
        queued_at = excluded.queued_at
    `).run(
      id,
      input.clientId,
      input.orderId,
      input.orderNumber ?? null,
      input.labelUrl,
      input.skuGroupId,
      input.primarySku ?? null,
      input.itemDescription ?? null,
      input.orderQty ?? 1,
      input.multiSkuData ? JSON.stringify(input.multiSkuData) : null,
      now,
      now,
    );

    // Fetch the actual row (might have different id if conflict updated existing)
    const row = this.db.prepare(
      `SELECT * FROM print_queue_orders WHERE order_id = ? AND client_id = ? LIMIT 1`
    ).get(input.orderId, input.clientId) as PrintQueueRow;

    return this.mapRow(row);
  }

  async getByClient(clientId: number, status?: 'queued' | 'printed'): Promise<PrintQueueEntry[]> {
    const rows = status
      ? this.db.prepare(
          `SELECT * FROM print_queue_orders WHERE client_id = ? AND status = ? ORDER BY queued_at ASC`
        ).all(clientId, status) as PrintQueueRow[]
      : this.db.prepare(
          `SELECT * FROM print_queue_orders WHERE client_id = ? ORDER BY queued_at ASC`
        ).all(clientId) as PrintQueueRow[];

    return rows.map(r => this.mapRow(r));
  }

  async findById(id: string): Promise<PrintQueueEntry | null> {
    const row = this.db.prepare(
      `SELECT * FROM print_queue_orders WHERE id = ? LIMIT 1`
    ).get(id) as PrintQueueRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByOrderId(orderId: string, clientId: number): Promise<PrintQueueEntry | null> {
    const row = this.db.prepare(
      `SELECT * FROM print_queue_orders WHERE order_id = ? AND client_id = ? LIMIT 1`
    ).get(orderId, clientId) as PrintQueueRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async markPrinted(ids: string[], printedAt: number): Promise<void> {
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE print_queue_orders
       SET status = 'printed', print_count = print_count + 1, last_printed_at = ?
       WHERE id IN (${placeholders})`
    ).run(printedAt, ...ids);
  }

  async remove(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM print_queue_orders WHERE id = ?`).run(id);
  }

  async clearByClient(clientId: number): Promise<number> {
    const result = this.db.prepare(
      `DELETE FROM print_queue_orders WHERE client_id = ? AND status = 'queued'`
    ).run(clientId);
    return (result as { changes: number }).changes;
  }

  private mapRow(row: PrintQueueRow): PrintQueueEntry {
    return {
      id: row.id,
      clientId: row.client_id,
      orderId: row.order_id,
      orderNumber: row.order_number,
      labelUrl: row.label_url,
      skuGroupId: row.sku_group_id,
      primarySku: row.primary_sku,
      itemDescription: row.item_description,
      orderQty: row.order_qty,
      multiSkuData: row.multi_sku_data ? JSON.parse(row.multi_sku_data) as MultiSkuItem[] : null,
      status: row.status as 'queued' | 'printed',
      printCount: row.print_count,
      lastPrintedAt: row.last_printed_at,
      queuedAt: row.queued_at,
      createdAt: row.created_at,
    };
  }
}
