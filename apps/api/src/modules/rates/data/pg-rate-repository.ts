import { createHash } from "node:crypto";
import type { PgClient } from "../../../../../../../packages/shared/src/postgres/database.js";
import type { CarrierAccountDto } from "../../../../../../../packages/contracts/src/init/contracts.js";
import type { RateDimsDto, RateDto } from "../../../../../../../packages/contracts/src/rates/contracts.js";
import { BLOCKED_CARRIER_IDS, CARRIER_ACCOUNTS_V2 } from "../../../common/prepship-config.js";
import type { CachedRateRecord, RateRepository, RateSourceConfig, RefetchRateOrderRecord } from "../application/rate-repository.js";

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

export class PgRateRepository implements RateRepository {
  private readonly sql: PgClient;
  private readonly mainApiKeyV2: string | null;

  constructor(sql: PgClient, mainApiKeyV2: string | null) {
    this.sql = sql;
    this.mainApiKeyV2 = mainApiKeyV2;
  }

  async getClientIdForStoreId(storeId: number): Promise<number | null> {
    const rows = await this.sql`
      SELECT "clientId"
      FROM clients
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements("storeIds"::jsonb) AS elem
        WHERE CAST(elem::text AS INTEGER) = ${storeId}
      )
      LIMIT 1
    `;

    const row = rows[0] as StoreClientRow | undefined;
    return row?.clientId ?? null;
  }

  async getCurrentWeightVersion(): Promise<number> {
    const rows = await this.sql`
      SELECT value
      FROM sync_meta
      WHERE key = 'weight_version'
    `;

    const row = rows[0] as SyncMetaRow | undefined;
    return Number.parseInt(row?.value ?? "0", 10) || 0;
  }

  async getCachedRate(cacheKey: string): Promise<CachedRateRecord | null> {
    const rows = await this.sql`
      SELECT rates, best_rate, weight_version
      FROM rate_cache
      WHERE cache_key = ${cacheKey}
    `;

    const row = rows[0] as CachedRateRow | undefined;
    if (!row) return null;

    return {
      ratesJson: row.rates,
      bestRateJson: row.best_rate,
      weightVersion: row.weight_version,
    };
  }

  async listCarriersForClient(clientId: number | null): Promise<CarrierAccountDto[]> {
    const rateSourceConfig = await this.getRateSourceConfig(clientId);
    const sourceClientId = rateSourceConfig.sourceClientId;
    const carrierGroupClientId = sourceClientId != null &&
      CARRIER_ACCOUNTS_V2.some((carrier) => carrier.clientId === sourceClientId)
      ? sourceClientId
      : null;
    const discoveredCarriers = await this.listDiscoveredCarriersForApiKey(
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

    const rows = await this.sql`
      SELECT "clientId", rate_source_client_id, ss_api_key_v2
      FROM clients
      WHERE "clientId" = ${clientId}
      LIMIT 1
    `;

    const client = rows[0] as ClientRateSourceRow | undefined;
    if (!client) {
      return {
        apiKeyV2: this.mainApiKeyV2,
        sourceClientId: null,
      };
    }

    if (client.rate_source_client_id != null) {
      const sourceRows = await this.sql`
        SELECT "clientId", rate_source_client_id, ss_api_key_v2
        FROM clients
        WHERE "clientId" = ${client.rate_source_client_id}
        LIMIT 1
      `;
      const source = sourceRows[0] as ClientRateSourceRow | undefined;
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
    await this.sql`DELETE FROM rate_cache`;
    try {
      await this.sql`DELETE FROM carrier_cache`;
    } catch {
      // Some test fixtures do not include carrier_cache.
    }
  }

  async listOrdersForRateRefetch(limit: number): Promise<RefetchRateOrderRecord[]> {
    const rows = await this.sql`
      SELECT o."orderId", o."storeId", o."shipToPostalCode", o."weightValue",
             ol.residential, ol.rate_dims_l, ol.rate_dims_w, ol.rate_dims_h
      FROM orders o
      LEFT JOIN order_local ol ON ol."orderId" = o."orderId"
      WHERE o."orderStatus" = 'awaiting_shipment'
        AND o."shipToPostalCode" IS NOT NULL
        AND o."weightValue" > 0
      ORDER BY o."orderId"
      LIMIT ${limit}
    ` as RefetchOrderRow[];

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
    const ratesJson = JSON.stringify(rates);
    const bestRateJson = bestRate ? JSON.stringify(bestRate) : null;
    const fetchedAt = Date.now();

    await this.sql`
      INSERT INTO rate_cache (cache_key, weight_oz, to_zip, rates, best_rate, fetched_at, weight_version)
      VALUES (${cacheKey}, ${weightOz}, ${toZip}, ${ratesJson}, ${bestRateJson}, ${fetchedAt}, ${weightVersion})
      ON CONFLICT (cache_key) DO UPDATE SET
        weight_oz = EXCLUDED.weight_oz,
        to_zip = EXCLUDED.to_zip,
        rates = EXCLUDED.rates,
        best_rate = EXCLUDED.best_rate,
        fetched_at = EXCLUDED.fetched_at,
        weight_version = EXCLUDED.weight_version
    `;
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
    const dimsL = dims?.length ?? null;
    const dimsW = dims?.width ?? null;
    const dimsH = dims?.height ?? null;

    void storeId;
    for (const orderId of orderIds) {
      await this.sql`
        INSERT INTO order_local ("orderId", ref_usps_rate, ref_ups_rate, rate_weight_oz, rate_dims_l, rate_dims_w, rate_dims_h, "updatedAt")
        VALUES (${orderId}, ${refUsps}, ${refUps}, ${weightOz}, ${dimsL}, ${dimsW}, ${dimsH}, ${now})
        ON CONFLICT ("orderId") DO UPDATE SET
          ref_usps_rate = CASE WHEN EXCLUDED.ref_usps_rate IS NOT NULL THEN EXCLUDED.ref_usps_rate ELSE order_local.ref_usps_rate END,
          ref_ups_rate = CASE WHEN EXCLUDED.ref_ups_rate IS NOT NULL THEN EXCLUDED.ref_ups_rate ELSE order_local.ref_ups_rate END,
          rate_weight_oz = EXCLUDED.rate_weight_oz,
          rate_dims_l = EXCLUDED.rate_dims_l,
          rate_dims_w = EXCLUDED.rate_dims_w,
          rate_dims_h = EXCLUDED.rate_dims_h,
          "updatedAt" = EXCLUDED."updatedAt"
      `;
    }
  }

  private async listDiscoveredCarriersForApiKey(apiKeyV2: string | null, carrierGroupClientId: number | null): Promise<CarrierAccountDto[]> {
    if (!apiKeyV2) {
      return [];
    }

    const discoveredProviderIds = await this.readDiscoveredProviderIds(apiKeyV2);
    if (discoveredProviderIds.size === 0) {
      return [];
    }

    return CARRIER_ACCOUNTS_V2.filter((carrier) =>
      carrier.clientId === carrierGroupClientId &&
      !BLOCKED_CARRIER_IDS.has(carrier.shippingProviderId) &&
      discoveredProviderIds.has(carrier.shippingProviderId),
    );
  }

  private async readDiscoveredProviderIds(apiKeyV2: string): Promise<Set<number>> {
    try {
      const apiKeyHash = createHash("sha256").update(apiKeyV2).digest("hex");
      const rows = await this.sql`
        SELECT carriers
        FROM carrier_cache
        WHERE "apiKeyHash" = ${apiKeyHash}
        LIMIT 1
      `;

      const row = rows[0] as CarrierCacheRow | undefined;
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
