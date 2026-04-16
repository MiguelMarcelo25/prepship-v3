import { InMemoryShipFromState } from "../../modules/locations/application/ship-from-state.js";
import { PgAnalysisRepository } from "../../modules/analysis/data/pg-analysis-repository.js";
import { PgBillingRepository } from "../../modules/billing/data/pg-billing-repository.js";
import { PgClientRepository } from "../../modules/clients/data/pg-client-repository.js";
import { PgInitRepository } from "../../modules/init/data/pg-init-repository.js";
import { PgInventoryRepository } from "../../modules/inventory/data/pg-inventory-repository.js";
import { PgLabelRepository } from "../../modules/labels/data/pg-label-repository.js";
import { PgLocationRepository } from "../../modules/locations/data/pg-location-repository.js";
import { PgManifestRepository } from "../../modules/manifests/data/pg-manifest-repository.js";
import { PgOrderRepository } from "../../modules/orders/data/pg-order-repository.js";
import { PgPackageRepository } from "../../modules/packages/data/pg-package-repository.js";
import { PgProductRepository } from "../../modules/products/data/pg-product-repository.js";
import { PgRateRepository } from "../../modules/rates/data/pg-rate-repository.js";
import { PgSettingsRepository } from "../../modules/settings/data/pg-settings-repository.js";
import { PgShipmentRepository } from "../../modules/shipments/data/pg-shipment-repository.js";
import { PgQueueRepository } from "../../modules/queue/data/pg-queue-repository.js";
import { createPgClient } from "../../../../../packages/shared/src/postgres/database.js";
import type { ApiDataStore } from "../datastore.js";

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
