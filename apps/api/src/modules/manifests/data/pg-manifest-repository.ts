import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.js";
import type { GenerateManifestInput } from "../../../../../../../packages/contracts/src/manifests/contracts.js";
import type { ManifestRepository } from "../application/manifest-repository.js";
import type { ManifestShipmentRecord } from "../domain/manifest.js";

export class PgManifestRepository implements ManifestRepository {
  constructor(private readonly sql: PgClient) {}

  async listShipments(input: GenerateManifestInput): Promise<ManifestShipmentRecord[]> {
    // Build the query dynamically based on optional filters
    if (input.carrierId && input.clientId != null) {
      const rows = await this.sql`
        SELECT s."shipmentId", o."orderNumber", s."trackingNumber", s."carrierCode", s."serviceCode",
          s."shipmentCost", s."otherCost", s."shipDate",
          COALESCE(s.weight_oz, o."weightValue", 0) AS "weightOz",
          CASE WHEN s."shipmentId" IS NOT NULL THEN 'Shipped' ELSE 'Pending' END AS status
        FROM shipments s
        JOIN orders o ON o."orderId" = s."orderId"
        WHERE s."shipDate" >= ${input.startDate} AND s."shipDate" <= ${input.endDate}
          AND s.source = ${input.carrierId}
          AND s."clientId" = ${input.clientId}
        ORDER BY s."shipDate" DESC, s."shipmentId" DESC
      `;
      return rows as ManifestShipmentRecord[];
    }

    if (input.carrierId) {
      const rows = await this.sql`
        SELECT s."shipmentId", o."orderNumber", s."trackingNumber", s."carrierCode", s."serviceCode",
          s."shipmentCost", s."otherCost", s."shipDate",
          COALESCE(s.weight_oz, o."weightValue", 0) AS "weightOz",
          CASE WHEN s."shipmentId" IS NOT NULL THEN 'Shipped' ELSE 'Pending' END AS status
        FROM shipments s
        JOIN orders o ON o."orderId" = s."orderId"
        WHERE s."shipDate" >= ${input.startDate} AND s."shipDate" <= ${input.endDate}
          AND s.source = ${input.carrierId}
        ORDER BY s."shipDate" DESC, s."shipmentId" DESC
      `;
      return rows as ManifestShipmentRecord[];
    }

    if (input.clientId != null) {
      const rows = await this.sql`
        SELECT s."shipmentId", o."orderNumber", s."trackingNumber", s."carrierCode", s."serviceCode",
          s."shipmentCost", s."otherCost", s."shipDate",
          COALESCE(s.weight_oz, o."weightValue", 0) AS "weightOz",
          CASE WHEN s."shipmentId" IS NOT NULL THEN 'Shipped' ELSE 'Pending' END AS status
        FROM shipments s
        JOIN orders o ON o."orderId" = s."orderId"
        WHERE s."shipDate" >= ${input.startDate} AND s."shipDate" <= ${input.endDate}
          AND s."clientId" = ${input.clientId}
        ORDER BY s."shipDate" DESC, s."shipmentId" DESC
      `;
      return rows as ManifestShipmentRecord[];
    }

    const rows = await this.sql`
      SELECT s."shipmentId", o."orderNumber", s."trackingNumber", s."carrierCode", s."serviceCode",
        s."shipmentCost", s."otherCost", s."shipDate",
        COALESCE(s.weight_oz, o."weightValue", 0) AS "weightOz",
        CASE WHEN s."shipmentId" IS NOT NULL THEN 'Shipped' ELSE 'Pending' END AS status
      FROM shipments s
      JOIN orders o ON o."orderId" = s."orderId"
      WHERE s."shipDate" >= ${input.startDate} AND s."shipDate" <= ${input.endDate}
      ORDER BY s."shipDate" DESC, s."shipmentId" DESC
    `;
    return rows as ManifestShipmentRecord[];
  }
}
