import { InMemoryShipFromState } from "../../modules/locations/application/ship-from-state.ts";
import { PgAnalysisRepository } from "../../modules/analysis/data/pg-analysis-repository.ts";
import { PgBillingRepository } from "../../modules/billing/data/pg-billing-repository.ts";
import { PgClientRepository } from "../../modules/clients/data/pg-client-repository.ts";
import { PgInitRepository } from "../../modules/init/data/pg-init-repository.ts";
import { PgInventoryRepository } from "../../modules/inventory/data/pg-inventory-repository.ts";
import { PgLabelRepository } from "../../modules/labels/data/pg-label-repository.ts";
import { PgLocationRepository } from "../../modules/locations/data/pg-location-repository.ts";
import { PgManifestRepository } from "../../modules/manifests/data/pg-manifest-repository.ts";
import { PgOrderRepository } from "../../modules/orders/data/pg-order-repository.ts";
import { PgPackageRepository } from "../../modules/packages/data/pg-package-repository.ts";
import { PgProductRepository } from "../../modules/products/data/pg-product-repository.ts";
import { PgRateRepository } from "../../modules/rates/data/pg-rate-repository.ts";
import { PgSettingsRepository } from "../../modules/settings/data/pg-settings-repository.ts";
import { PgShipmentRepository } from "../../modules/shipments/data/pg-shipment-repository.ts";
import { PgQueueRepository } from "../../modules/queue/data/pg-queue-repository.ts";
import { createPgClient } from "../../../../../packages/shared/src/postgres/database.ts";
import type { ApiDataStore } from "../datastore.ts";

export function createPgDataStore(databaseUrl: string, excludedStoreIds: number[], mainApiKeyV2: string | null): ApiDataStore {
  const sql = createPgClient(databaseUrl);

  return {
    queueRepository: new PgQueueRepository(sql),
    billingRepository: new PgBillingRepository(sql),
    analysisRepository: new PgAnalysisRepository(sql),
    clientRepository: new PgClientRepository(sql),
    initRepository: new PgInitRepository(sql, excludedStoreIds),
    inventoryRepository: new PgInventoryRepository(sql),
    labelRepository: new PgLabelRepository(sql, mainApiKeyV2),
    locationRepository: new PgLocationRepository(sql),
    manifestRepository: new PgManifestRepository(sql),
    orderRepository: new PgOrderRepository(sql, excludedStoreIds),
    packageRepository: new PgPackageRepository(sql),
    productRepository: new PgProductRepository(sql),
    rateRepository: new PgRateRepository(sql, mainApiKeyV2),
    settingsRepository: new PgSettingsRepository(sql),
    shipmentRepository: new PgShipmentRepository(sql),
    shipFromState: new InMemoryShipFromState(),
  };
}
