import type { OrderExportQuery, OrderExportRow } from "../../../../../../packages/contracts/src/orders/contracts.js";
import type { OrderRepository } from "./order-repository.js";

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADERS = [
  "Order ID",
  "Order #",
  "Order Date",
  "Store ID",
  "Client ID",
  "Status",
  "Recipient",
  "Item Name",
  "SKU",
  "Qty",
  "Weight (oz)",
  "Ship To",
  "Carrier",
  "Shipping Account",
  "Service",
  "Tracking #",
  "Order Total",
  "Best Rate",
  "Label Cost",
  "Ship Margin",
  "Label Created",
  "Age (hrs)",
  "---",
  "V1_orderNumber",
  "V1_carrierCode",
  "V1_serviceCode",
  "V1_externallyFulfilled",
  "V1_shippingAmount",
  "V1_weight",
  "V1_dimensions",
  "V1_RAW_API (JSON)",
  "---",
  "V2_selected_rate (JSON)",
  "V2_shipment_record (JSON)",
  "---",
  "Best Rate JSON (order_local)",
  "External Shipped (Flag)",
];

export class OrderExportService {
  private readonly repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.repository = repository;
  }

  async execute(query: OrderExportQuery): Promise<{ filename: string; contentType: string; body: string }> {
    const rows = await this.repository.exportOrders(query);
    const lines: string[] = [CSV_HEADERS.map(escapeCsv).join(",")];

    for (const row of rows) {
      try {
        lines.push(this.buildCsvRow(row, query.orderStatus));
      } catch {
        // skip malformed rows silently
      }
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    return {
      filename: `orders-${query.orderStatus}-${timestamp}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: lines.join("\n"),
    };
  }

  private buildCsvRow(row: OrderExportRow, orderStatus: string): string {
    const rawOrder = JSON.parse(row.raw ?? "{}") as Record<string, unknown>;

    const orderId = row.orderId;
    const orderNumber = rawOrder.orderNumber ?? "";
    const orderDate = rawOrder.orderDate ?? "";
    const storeId = row.storeId ?? "";
    const clientId = row.clientId ?? "";
    const status = orderStatus;

    // Recipient / items
    const shipToObj = rawOrder.shipTo as Record<string, unknown> | undefined;
    const recipient = shipToObj?.name ?? "";
    const items = Array.isArray(rawOrder.items) ? (rawOrder.items as Array<Record<string, unknown>>) : [];
    const itemName = items[0]?.name ?? "";
    const sku = items[0]?.sku ?? "";
    const qty = items.reduce((sum: number, it: Record<string, unknown>) => sum + (Number(it.quantity) || 0), 0);
    const shipTo = `${shipToObj?.city ?? ""}, ${shipToObj?.state ?? ""}`;
    const orderTotal = rawOrder.orderTotal ?? "";

    // Weight from raw order
    const weightObj = rawOrder.weight as Record<string, unknown> | undefined;
    const weightOz = weightObj?.value ?? "";

    // Label info
    const carrierCode = row.label_carrier ?? "";
    const service = row.label_service ?? "";
    const tracking = row.label_tracking ?? "";
    const labelCost = row.label_cost != null ? row.label_cost : "";

    // Age in hours
    let ageHrs: string | number = "";
    if (orderDate) {
      const orderTime = new Date(String(orderDate)).getTime();
      if (!Number.isNaN(orderTime)) {
        ageHrs = Math.round((Date.now() - orderTime) / (1000 * 60 * 60));
      }
    }

    // Shipping account + best rate + margin
    let shippingAccount = "";
    let bestRate: string | number = "";
    let shipMargin = "";

    try {
      if (row.selected_rate_json) {
        const selectedRate = JSON.parse(row.selected_rate_json) as Record<string, unknown>;
        shippingAccount = String(selectedRate.providerAccountNickname ?? "");
        if (selectedRate.cost != null) bestRate = Number(selectedRate.cost);
      }
    } catch { /* ignore */ }

    try {
      if (row.best_rate_json) {
        const bestRateObj = JSON.parse(row.best_rate_json) as Record<string, unknown>;
        if (!bestRate && bestRateObj.cost != null) {
          bestRate = Number(bestRateObj.cost);
        }
        if (labelCost !== "" && bestRateObj.cost != null) {
          const margin = Number(labelCost) - Number(bestRateObj.cost);
          shipMargin = margin.toFixed(2);
        }
      }
    } catch { /* ignore */ }

    // V2 JSON blobs
    let selectedRateStr = "";
    try {
      if (row.selected_rate_json) {
        selectedRateStr = JSON.stringify(JSON.parse(row.selected_rate_json));
      }
    } catch { /* ignore */ }

    let v2ShipmentRecord = "";
    if (row.label_shipmentId != null) {
      v2ShipmentRecord = JSON.stringify({
        shipmentId: row.label_shipmentId,
        carrierCode: row.label_carrier,
        serviceCode: row.label_service,
        trackingNumber: row.label_tracking,
        shipDate: row.label_shipDate,
        labelCost: row.label_cost,
        labelRawCost: row.label_raw_cost,
        labelCreatedAt: row.label_created_at,
        selected_rate_json: row.selected_rate_json ? JSON.parse(row.selected_rate_json) : null,
      });
    }

    let bestRateStr = "";
    try {
      if (row.best_rate_json) {
        bestRateStr = JSON.stringify(JSON.parse(row.best_rate_json));
      }
    } catch { /* ignore */ }

    // V1 API columns
    const v1_orderNumber = rawOrder.orderNumber ?? "";
    const v1_carrierCode = rawOrder.carrierCode ?? "";
    const v1_serviceCode = rawOrder.serviceCode ?? "";
    const v1_externallyFulfilled = rawOrder.externallyFulfilled ? "yes" : "no";
    const v1_shippingAmount = rawOrder.shippingAmount ?? "";
    const v1_weight = rawOrder.weight ? JSON.stringify(rawOrder.weight) : "";
    const v1_dimensions = rawOrder.dimensions ? JSON.stringify(rawOrder.dimensions) : "";
    const v1_rawApi = JSON.stringify(rawOrder);

    const externalShipped = rawOrder.externallyFulfilled ? "yes" : "no";

    return [
      escapeCsv(orderId),
      escapeCsv(orderNumber),
      escapeCsv(orderDate),
      escapeCsv(storeId),
      escapeCsv(clientId),
      escapeCsv(status),
      escapeCsv(recipient),
      escapeCsv(itemName),
      escapeCsv(sku),
      escapeCsv(qty),
      escapeCsv(weightOz),
      escapeCsv(shipTo),
      escapeCsv(carrierCode),
      escapeCsv(shippingAccount),
      escapeCsv(service),
      escapeCsv(tracking),
      escapeCsv(orderTotal),
      escapeCsv(bestRate),
      escapeCsv(labelCost),
      escapeCsv(shipMargin),
      escapeCsv(row.label_created_at ?? ""),
      escapeCsv(ageHrs),
      escapeCsv("---"),
      escapeCsv(v1_orderNumber),
      escapeCsv(v1_carrierCode),
      escapeCsv(v1_serviceCode),
      escapeCsv(v1_externallyFulfilled),
      escapeCsv(v1_shippingAmount),
      escapeCsv(v1_weight),
      escapeCsv(v1_dimensions),
      escapeCsv(v1_rawApi),
      escapeCsv("---"),
      escapeCsv(selectedRateStr),
      escapeCsv(v2ShipmentRecord),
      escapeCsv("---"),
      escapeCsv(bestRateStr),
      escapeCsv(externalShipped),
    ].join(",");
  }
}
