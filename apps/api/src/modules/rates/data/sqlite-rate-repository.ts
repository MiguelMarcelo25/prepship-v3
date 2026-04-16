import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CarrierAccountDto } from "../../../../../../../packages/contracts/src/init/contracts.ts";
import type { RateDimsDto, RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.ts";
import { BLOCKED_CARRIER_IDS, CARRIER_ACCOUNTS_V2 } from "../../../common/prepship-config.ts";
import type { CachedRateRecord, RateRepository, RateSourceConfig, RefetchRateOrderRecord } from "../application/rate-repository.ts";

interface StoreClientRow {
  clientId: number;
}

interface CachedRateRow {
  rates: string;
  best_rate: string | null;
  weight_version: number | null;
}

interface CarrierCacheRow {
  carriers: string;
}

interface SyncMetaRow {
  value: string | null;
}

interface ClientRateSourceRow {
  clientId: number;
  rate_source_client_id: number | null;
  ss_api_key_v2: string | null;
}

interface RefetchOrderRow {
  orderId: number;
  storeId: number | null;
  shipToPostalCode: string | null;
  weightValue: number | null;
  residential: number | null;
  rate_dims_l: number | null;
  rate_dims_w: number | null;
  rate_dims_h: number | null;
}

export class SqliteRateRepository implements RateRepository {
  private readonly db: DatabaseSync;
  private readonly mainApiKeyV2: string | null;

  constructor(db: DatabaseSync, mainApiKeyV2: string | null) {
    this.db = db;
    this.mainApiKeyV2 = mainApiKeyV2;
  }

  async getClientIdForStoreId(storeId: number): Promise<number | null> {
    const row = this.db.prepare(`
      SELECT clientId
      FROM clients
      WHERE EXISTS (
        SELECT 1
        FROM json_each(clients.storeIds)
        WHERE CAST(json_each.value AS INTEGER) = ?
      )
      LIMIT 1
    `).get(storeId) as StoreClientRow | undefined;

    return row?.clientId ?? null;
  }

  async getCurrentWeightVersion(): Promise<number> {
    const row = this.db.prepare(`
      SELECT value
      FROM sync_meta
      WHERE key = 'weight_version'
    `).get() as SyncMetaRow | undefined;

    return Number.parseInt(row?.value ?? "0", 10) || 0;
  }

  async getCachedRate(cacheKey: string): Promise<CachedRateRecord | null> {
    const row = this.db.prepare(`
      SELECT rates, best_rate, weight_version
      FROM rate_cache
      WHERE cache_key = ?
    `).get(cacheKey) as CachedRateRow | undefined;

    if (!row) return null;

    return {
      ratesJson: row.rates,
      bestRateJson: row.best_rate,
      weightVersion: row.weight_version,
    };
  }

  async listCarriersForClient(clientId: number | null): Promise<CarrierAccountDto[]> {
    const rateSourceConfig = this.getRateSourceConfig(clientId);
    const sourceClientId = rateSourceConfig.sourceClientId;
    const carrierGroupClientId = sourceClientId != null &&
      CARRIER_ACCOUNTS_V2.some((carrier) => carrier.clientId === sourceClientId)
      ? sourceClientId
      : null;
    const discoveredCarriers = this.listDiscoveredCarriersForApiKey(
      rateSourceConfig.apiKeyV2,
      carrierGroupClientId,
    );

    if (discoveredCarriers.length > 0) {
      return discoveredCarriers;
    }

    return CARRIER_ACCOUNTS_V2.filter((carrier) =>
      !BLOCKED_CARRIER_IDS.has(carrier.shippingProviderId) &&
      carrier.clientId === carrierGroupClientId,
    );
  }

  async getRateSourceConfig(clientId: number | null): Promise<RateSourceConfig> {
    if (clientId == null) {
      return {
        apiKeyV2: this.mainApiKeyV2,
        sourceClientId: null,
      };
    }

    const client = this.db.prepare(`
      SELECT clientId, rate_source_client_id, ss_api_key_v2
      FROM clients
      WHERE clientId = ?
      LIMIT 1
    `).get(clientId) as ClientRateSourceRow | undefined;

    if (!client) {
      return {
        apiKeyV2: this.mainApiKeyV2,
        sourceClientId: null,
      };
    }

    if (client.rate_source_client_id != null) {
      const source = this.db.prepare(`
        SELECT clientId, rate_source_client_id, ss_api_key_v2
        FROM clients
        WHERE clientId = ?
        LIMIT 1
      `).get(client.rate_source_client_id) as ClientRateSourceRow | undefined;
      if (source?.ss_api_key_v2) {
        return {
          apiKeyV2: source.ss_api_key_v2,
          sourceClientId: source.clientId,
        };
      }
    }

    return {
      apiKeyV2: client.ss_api_key_v2 ?? this.mainApiKeyV2,
      sourceClientId: client.ss_api_key_v2 ? client.clientId : null,
    };
  }

  async clearCaches(): Promise<void> {
    this.db.prepare(`DELETE FROM rate_cache`).run();
    try {
      this.db.prepare(`DELETE FROM carrier_cache`).run();
    } catch {
      // Some test fixtures do not include carrier_cache.
    }
  }

  async listOrdersForRateRefetch(limit: number): Promise<RefetchRateOrderRecord[]> {
    const rows = this.db.prepare(`
      SELECT o.orderId, o.storeId, o.shipToPostalCode, o.weightValue,
             ol.residential, ol.rate_dims_l, ol.rate_dims_w, ol.rate_dims_h
      FROM orders o
      LEFT JOIN order_local ol ON ol.orderId = o.orderId
      WHERE o.orderStatus = 'awaiting_shipment'
        AND o.shipToPostalCode IS NOT NULL
        AND o.weightValue > 0
      ORDER BY o.orderId
      LIMIT ?
    `).all(limit) as RefetchOrderRow[];

    return rows.map((row) => ({
      orderId: row.orderId,
      storeId: row.storeId,
      shipToPostalCode: row.shipToPostalCode,
      weightOz: row.weightValue,
      residential: row.residential !== 0,
      dims: row.rate_dims_l && row.rate_dims_w && row.rate_dims_h
        ? {
            length: Number(row.rate_dims_l),
            width: Number(row.rate_dims_w),
            height: Number(row.rate_dims_h),
          }
        : null,
    }));
  }

  async saveCachedRate(
    cacheKey: string,
    weightOz: number,
    toZip: string,
    rates: RateDto[],
    bestRate: RateDto | null,
    weightVersion: number,
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO rate_cache (cache_key, weight_oz, to_zip, rates, best_rate, fetched_at, weight_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        weight_oz = excluded.weight_oz,
        to_zip = excluded.to_zip,
        rates = excluded.rates,
        best_rate = excluded.best_rate,
        fetched_at = excluded.fetched_at,
        weight_version = excluded.weight_version
    `).run(
      cacheKey,
      weightOz,
      toZip,
      JSON.stringify(rates),
      bestRate ? JSON.stringify(bestRate) : null,
      Date.now(),
      weightVersion,
    );
  }

  async saveReferenceRates(orderIds: number[], rates: RateDto[], weightOz: number, dims: RateDimsDto | null, storeId: number | null): Promise<void> {
    if (orderIds.length === 0 || rates.length === 0) {
      return;
    }

    const usps = rates
      .filter((rate) => rate.shippingProviderId === 433542)
      .map((rate) => Number(rate.shipmentCost ?? 0) + Number(rate.otherCost ?? 0));
    const ups = rates
      .filter((rate) => rate.shippingProviderId === 433543)
      .map((rate) => Number(rate.shipmentCost ?? 0) + Number(rate.otherCost ?? 0));
    const refUsps = usps.length > 0 ? Math.min(...usps) : null;
    const refUps = ups.length > 0 ? Math.min(...ups) : null;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO order_local (orderId, ref_usps_rate, ref_ups_rate, rate_weight_oz, rate_dims_l, rate_dims_w, rate_dims_h, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(orderId) DO UPDATE SET
        ref_usps_rate = CASE WHEN excluded.ref_usps_rate IS NOT NULL THEN excluded.ref_usps_rate ELSE ref_usps_rate END,
        ref_ups_rate = CASE WHEN excluded.ref_ups_rate IS NOT NULL THEN excluded.ref_ups_rate ELSE ref_ups_rate END,
        rate_weight_oz = excluded.rate_weight_oz,
        rate_dims_l = excluded.rate_dims_l,
        rate_dims_w = excluded.rate_dims_w,
        rate_dims_h = excluded.rate_dims_h,
        updatedAt = excluded.updatedAt
    `);

    void storeId;
    for (const orderId of orderIds) {
      stmt.run(orderId, refUsps, refUps, weightOz, dims?.length ?? null, dims?.width ?? null, dims?.height ?? null, now);
    }
  }

  private listDiscoveredCarriersForApiKey(apiKeyV2: string | null, carrierGroupClientId: number | null): CarrierAccountDto[] {
    if (!apiKeyV2) {
      return [];
    }

    const discoveredProviderIds = this.readDiscoveredProviderIds(apiKeyV2);
    if (discoveredProviderIds.size === 0) {
      return [];
    }

    return CARRIER_ACCOUNTS_V2.filter((carrier) =>
      carrier.clientId === carrierGroupClientId &&
      !BLOCKED_CARRIER_IDS.has(carrier.shippingProviderId) &&
      discoveredProviderIds.has(carrier.shippingProviderId),
    );
  }

  private readDiscoveredProviderIds(apiKeyV2: string): Set<number> {
    try {
      const apiKeyHash = createHash("sha256").update(apiKeyV2).digest("hex");
      const row = this.db.prepare(`
        SELECT carriers
        FROM carrier_cache
        WHERE apiKeyHash = ?
        LIMIT 1
      `).get(apiKeyHash) as CarrierCacheRow | undefined;

      if (!row?.carriers) {
        return new Set();
      }

      const carriers = JSON.parse(row.carriers) as Array<Record<string, unknown>>;
      return new Set(
        carriers
          .filter((carrier) => String(carrier.carrierCode ?? carrier.code ?? "") !== "unknown")
          .map((carrier) => Number(
            carrier.shippingProviderId ??
            String(carrier.carrierId ?? carrier.carrier_id ?? "").replace(/^se-/, "")
          ))
          .filter(Number.isFinite),
      );
    } catch {
      return new Set();
    }
  }
}
