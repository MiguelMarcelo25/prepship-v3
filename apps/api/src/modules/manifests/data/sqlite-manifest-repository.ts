import type { DatabaseSync } from "node:sqlite";
import type { GenerateManifestInput } from "../../../../../../../packages/contracts/src/manifests/contracts.js";
import type { ManifestRepository } from "../application/manifest-repository.js";
import type { ManifestShipmentRecord } from "../domain/manifest.js";

export class SqliteManifestRepository implements ManifestRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async listShipments(input: GenerateManifestInput): Promise<ManifestShipmentRecord[]> {
    const query = [
      "SELECT s.shipmentId, o.orderNumber, s.trackingNumber, s.carrierCode, s.serviceCode,",
      "s.shipmentCost, s.otherCost, s.shipDate,",
      "COALESCE(s.weight_oz, o.weightValue, 0) AS weightOz,",
      "CASE WHEN s.shipmentId IS NOT NULL THEN 'Shipped' ELSE 'Pending' END AS status",
      "FROM shipments s",
      "JOIN orders o ON o.orderId = s.orderId",
      "WHERE s.shipDate >= ? AND s.shipDate <= ?",
    ];
    const params: Array<string | number> = [input.startDate, input.endDate];

    if (input.carrierId) {
      query.push("AND s.source = ?");
      params.push(input.carrierId);
    }

    if (input.clientId != null) {
      query.push("AND s.clientId = ?");
      params.push(input.clientId);
    }

    query.push("ORDER BY s.shipDate DESC, s.shipmentId DESC");
    return this.db.prepare(query.join(" ")).all(...params) as ManifestShipmentRecord[];
  }
}
