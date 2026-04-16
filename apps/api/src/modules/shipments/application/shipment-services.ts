import type { TransitionalSecrets } from "../../../../../../../packages/shared/src/config/secrets-adapter.ts";
import type {
  LegacySyncStatusDto,
  LegacySyncTriggerResponseDto,
  ShipmentSyncResponseDto,
  ShipmentSyncStatusDto,
} from "../../../../../../../packages/contracts/src/shipments/contracts.ts";
import type { ShipmentRepository } from "./shipment-repository.ts";
import type { ShipmentSyncAccountRecord } from "../domain/shipment.ts";
import type { ShipstationV1Credentials, ShippingGateway } from "../../labels/application/shipping-gateway.ts";

function credentialsOrThrow(apiKey: string | null | undefined, apiSecret: string | null | undefined, secrets: TransitionalSecrets): ShipstationV1Credentials {
  const key = apiKey ?? secrets.shipstation?.api_key;
  const secret = apiSecret ?? secrets.shipstation?.api_secret;
  if (!key || !secret) {
    throw new Error("No v1 ShipStation credentials configured");
  }
  return { apiKey: key, apiSecret: secret };
}

export class ShipmentServices {
  private readonly repository: ShipmentRepository;
  private readonly gateway: ShippingGateway;
  private readonly secrets: TransitionalSecrets;
  private running = false;
  private legacySyncStatus: LegacySyncStatusDto = {
    status: "idle",
    lastSync: null,
    count: 0,
    error: null,
    page: 0,
    mode: "idle",
    ratesCached: 0,
    ratePrefetchRunning: false,
  };

  constructor(repository: ShipmentRepository, gateway: ShippingGateway, secrets: TransitionalSecrets) {
    this.repository = repository;
    this.gateway = gateway;
    this.secrets = secrets;
  }

  triggerSync(): ShipmentSyncResponseDto {
    this.startSync("incremental");
    return { queued: true };
  }

  triggerLegacySync(full: boolean): LegacySyncTriggerResponseDto {
    this.startSync(full ? "full" : "incremental");
    return { queued: true, mode: full ? "full" : "incremental" };
  }

  async getLegacyStatus(): Promise<LegacySyncStatusDto> {
    return {
      ...this.legacySyncStatus,
      lastSync: await this.repository.getLastShipmentSync() ?? this.legacySyncStatus.lastSync,
    };
  }

  private startSync(mode: "incremental" | "full"): void {
    if (!this.running) {
      this.running = true;
      this.legacySyncStatus = {
        ...this.legacySyncStatus,
        status: "syncing",
        error: null,
        page: 0,
        mode,
      };
      void this.runSync(mode).finally(() => {
        this.running = false;
      });
    }
  }

  async getStatus(): Promise<ShipmentSyncStatusDto> {
    return {
      count: await this.repository.countActiveShipments(),
      lastSync: await this.repository.getLastShipmentSync(),
      running: this.running,
    };
  }

  async list(searchParams: URLSearchParams) {
    const credentials = credentialsOrThrow(null, null, this.secrets);
    const result = await this.gateway.listShipments(credentials, searchParams);
    return result.raw;
  }

  private async buildSyncAccounts(): Promise<ShipmentSyncAccountRecord[]> {
    const accounts: ShipmentSyncAccountRecord[] = [];
    const mainApiKey = this.secrets.shipstation?.api_key ?? null;
    const mainApiSecret = this.secrets.shipstation?.api_secret ?? null;

    // Legacy parity: shipment sync runs the global main account first, then
    // iterates client accounts separately. If clientId=1 also exists in
    // clients, the processed count can exceed the number of unique rows.
    if (mainApiKey && mainApiSecret) {
      accounts.push({
        clientId: 1,
        accountName: "main",
        v1ApiKey: mainApiKey,
        v1ApiSecret: mainApiSecret,
        v2ApiKey: this.secrets.shipstation?.api_key_v2 ?? null,
      });
    }

    return accounts.concat(
      (await this.repository
        .listSyncAccounts())
        .filter((account) => Boolean(account.v1ApiKey && account.v1ApiSecret)),
    );
  }

  private async runSync(mode: "incremental" | "full"): Promise<void> {
    const accounts = await this.buildSyncAccounts();
    const lastSync = await this.repository.getLastShipmentSync();
    const createdAtStart = lastSync ? new Date(lastSync - 60_000).toISOString() : undefined;
    const updatedAt = Date.now();
    let totalProcessed = 0;

    try {
      for (const account of accounts) {
        const credentials = {
          apiKey: account.v1ApiKey as string,
          apiSecret: account.v1ApiSecret as string,
        };
        const carrierLookup = new Map<string, number>();
        if (account.v2ApiKey) {
          let page = 1;
          while (true) {
            const rows = await this.gateway.listShipmentsV2(account.v2ApiKey, page, createdAtStart);
            if (rows.length === 0) break;
            for (const row of rows) {
              if (!row.orderNumber || !row.carrierId) continue;
              const numeric = Number.parseInt(row.carrierId.replace(/^se-/, ""), 10);
              if (Number.isFinite(numeric)) carrierLookup.set(row.orderNumber, numeric);
            }
            if (rows.length < 500) break;
            page += 1;
          }
        }

        let page = 1;
        while (true) {
          const params = new URLSearchParams({
            pageSize: "500",
            page: String(page),
            sortBy: "CreateDate",
            sortDir: "DESC",
          });
          if (createdAtStart) {
            params.set("modifyDateStart", createdAtStart.replace("T", " ").replace(/\.\d{3}Z$/, ""));
          }
          const result = await this.gateway.listShipments(credentials, params);
          if (result.shipments.length === 0) break;

          const normalized = [];
          for (const shipment of result.shipments) {
            let orderId = shipment.orderId;
            if (shipment.orderNumber) {
              const resolved = await this.repository.resolveOrderIdByOrderNumber(shipment.orderNumber);
              if (resolved) orderId = resolved;
            }
            if (!(await this.repository.orderExists(orderId))) continue;
            normalized.push({
              shipmentId: shipment.shipmentId,
              orderId,
              orderNumber: shipment.orderNumber,
              shipmentCost: shipment.shipmentCost,
              otherCost: shipment.otherCost,
              carrierCode: shipment.carrierCode,
              serviceCode: shipment.serviceCode,
              trackingNumber: shipment.trackingNumber,
              shipDate: shipment.shipDate,
              voided: shipment.voided,
              providerAccountId: shipment.orderNumber ? carrierLookup.get(shipment.orderNumber) ?? null : null,
              createDate: shipment.createDate,
              weightOz: shipment.weightOz,
              dimsLength: shipment.dimsLength,
              dimsWidth: shipment.dimsWidth,
              dimsHeight: shipment.dimsHeight,
              updatedAt,
              clientId: await this.repository.getOrderClientId(orderId) ?? account.clientId,
              source: "shipstation",
            });
          }

          if (normalized.length > 0) {
            await this.repository.upsertShipmentBatch(normalized);
            await this.repository.backfillOrderLocalFromShipments(normalized);
            totalProcessed += normalized.length;
            this.legacySyncStatus = {
              ...this.legacySyncStatus,
              status: "syncing",
              mode,
              page: totalProcessed,
            };
          }

          if (page >= result.pages) break;
          page += 1;
        }
      }

      const completedAt = Date.now();
      await this.repository.setLastShipmentSync(completedAt);
      this.legacySyncStatus = {
        ...this.legacySyncStatus,
        status: "done",
        lastSync: completedAt,
        count: totalProcessed,
        error: null,
        page: 0,
        mode,
      };
    } catch (error) {
      this.legacySyncStatus = {
        ...this.legacySyncStatus,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        page: 0,
        mode,
      };
      throw error;
    }
  }
}
