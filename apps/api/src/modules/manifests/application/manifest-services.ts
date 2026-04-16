import type { GenerateManifestInput } from "../../../../../../../packages/contracts/src/manifests/contracts.ts";
import type { ManifestRepository } from "./manifest-repository.ts";

function escapeCsv(value: unknown): string {
  const text = String(value ?? "");
  if (text.includes("\"") || text.includes(",") || text.includes("\n")) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export class ManifestServices {
  private readonly repository: ManifestRepository;

  constructor(repository: ManifestRepository) {
    this.repository = repository;
  }

  async generate(input: GenerateManifestInput) {
    if (!input.startDate || !input.endDate) {
      throw new Error("startDate and endDate required (YYYY-MM-DD format)");
    }

    const shipments = await this.repository.listShipments(input);
    if (shipments.length === 0) {
      return {
        filename: `manifest_${input.startDate}_${input.endDate}.csv`,
        contentType: "application/json",
        body: JSON.stringify({ success: true, rows: 0, message: "No shipments found for the date range" }),
      };
    }

    const lines = [
      ["Order#", "Tracking#", "Carrier", "Service", "Weight (oz)", "Shipping Cost", "Other Cost", "Total Cost", "Status", "Ship Date"].map(escapeCsv).join(","),
    ];

    for (const shipment of shipments) {
      const totalCost = Number(shipment.shipmentCost ?? 0) + Number(shipment.otherCost ?? 0);
      lines.push([
        shipment.orderNumber ?? "",
        shipment.trackingNumber ?? "",
        shipment.carrierCode ?? "—",
        shipment.serviceCode ?? "—",
        shipment.weightOz ?? 0,
        Number(shipment.shipmentCost ?? 0).toFixed(2),
        Number(shipment.otherCost ?? 0).toFixed(2),
        totalCost.toFixed(2),
        shipment.status,
        formatDate(shipment.shipDate),
      ].map(escapeCsv).join(","));
    }

    return {
      filename: `manifest_${input.startDate}_${input.endDate}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: lines.join("\n"),
    };
  }
}
