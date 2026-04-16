import type { TransitionalSecrets } from "../../../../../../../packages/shared/src/config/secrets-adapter.js";
import type { ExternalCarrierPackageRecord, PackageSyncGateway } from "../application/package-sync-gateway.js";
import { getShipStationClient } from "../../../common/shipstation/client.js";

export class ShipstationPackageSyncGateway implements PackageSyncGateway {
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(secrets: TransitionalSecrets) {
    const apiKey = secrets.shipstation?.api_key;
    const apiSecret = secrets.shipstation?.api_secret;
    if (!apiKey || !apiSecret) {
      throw new Error("Transitional ShipStation v1 credentials are required for package sync");
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async listCarrierPackages(carrierCode: string): Promise<ExternalCarrierPackageRecord[]> {
    const client = getShipStationClient();
    const payload = await client.v1<Array<Record<string, unknown>>>(
      { apiKey: this.apiKey, apiSecret: this.apiSecret },
      `/carriers/listpackages?carrierCode=${encodeURIComponent(carrierCode)}`,
    );
    if (!Array.isArray(payload)) return [];
    return payload.map((entry) => ({
      code: String(entry.code ?? ""),
      name: String(entry.name ?? ""),
      domestic: Boolean(entry.domestic),
      international: Boolean(entry.international),
    })).filter((entry) => entry.code && entry.name);
  }
}
