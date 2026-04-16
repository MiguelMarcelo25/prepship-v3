import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.ts";
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

export class PgQueueRepository implements QueueRepository {
  constructor(private readonly sql: PgClient) {}

  async add(input: AddToQueueInput): Promise<PrintQueueEntry> {
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();

    await this.sql`
      INSERT INTO print_queue_orders (
        id, client_id, order_id, order_number, label_url,
        sku_group_id, primary_sku, item_description, order_qty,
        multi_sku_data, status, print_count, last_printed_at,
        queued_at, created_at
      ) VALUES (
        ${id}, ${input.clientId}, ${input.orderId}, ${input.orderNumber ?? null}, ${input.labelUrl},
        ${input.skuGroupId}, ${input.primarySku ?? null}, ${input.itemDescription ?? null}, ${input.orderQty ?? 1},
        ${input.multiSkuData ? JSON.stringify(input.multiSkuData) : null}, 'queued', 0, ${null},
        ${now}, ${now}
      )
      ON CONFLICT (order_id, client_id) DO UPDATE SET
        label_url = EXCLUDED.label_url,
        sku_group_id = EXCLUDED.sku_group_id,
        primary_sku = EXCLUDED.primary_sku,
        item_description = EXCLUDED.item_description,
        order_qty = EXCLUDED.order_qty,
        multi_sku_data = EXCLUDED.multi_sku_data,
        status = 'queued',
        queued_at = EXCLUDED.queued_at
    `;

    // Fetch the actual row (might have different id if conflict updated existing)
    const rows = await this.sql`
      SELECT * FROM print_queue_orders WHERE order_id = ${input.orderId} AND client_id = ${input.clientId} LIMIT 1
    `;
    return this.mapRow(rows[0] as PrintQueueRow);
  }

  async getByClient(clientId: number, status?: 'queued' | 'printed'): Promise<PrintQueueEntry[]> {
    const rows = status
      ? await this.sql`
          SELECT * FROM print_queue_orders WHERE client_id = ${clientId} AND status = ${status} ORDER BY queued_at ASC
        `
      : await this.sql`
          SELECT * FROM print_queue_orders WHERE client_id = ${clientId} ORDER BY queued_at ASC
        `;

    return (rows as PrintQueueRow[]).map(r => this.mapRow(r));
  }

  async findById(id: string): Promise<PrintQueueEntry | null> {
    const rows = await this.sql`
      SELECT * FROM print_queue_orders WHERE id = ${id} LIMIT 1
    `;
    const row = rows[0] as PrintQueueRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByOrderId(orderId: string, clientId: number): Promise<PrintQueueEntry | null> {
    const rows = await this.sql`
      SELECT * FROM print_queue_orders WHERE order_id = ${orderId} AND client_id = ${clientId} LIMIT 1
    `;
    const row = rows[0] as PrintQueueRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  async markPrinted(ids: string[], printedAt: number): Promise<void> {
    if (ids.length === 0) return;
    // Neon tagged templates don't support IN with arrays directly,
    // so we iterate for safety. For bulk, a single query with ANY() works:
    await this.sql`
      UPDATE print_queue_orders
      SET status = 'printed', print_count = print_count + 1, last_printed_at = ${printedAt}
      WHERE id = ANY(${ids})
    `;
  }

  async remove(id: string): Promise<void> {
    await this.sql`DELETE FROM print_queue_orders WHERE id = ${id}`;
  }

  async clearByClient(clientId: number): Promise<number> {
    const rows = await this.sql`
      DELETE FROM print_queue_orders WHERE client_id = ${clientId} AND status = 'queued'
      RETURNING id
    `;
    return rows.length;
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
