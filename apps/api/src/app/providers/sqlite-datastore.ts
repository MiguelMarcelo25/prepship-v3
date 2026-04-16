import { InMemoryShipFromState } from "../../modules/locations/application/ship-from-state.js";
import { SqliteAnalysisRepository } from "../../modules/analysis/data/sqlite-analysis-repository.js";
import { SqliteBillingRepository } from "../../modules/billing/data/sqlite-billing-repository.js";
import { SqliteClientRepository } from "../../modules/clients/data/sqlite-client-repository.js";
import { SqliteInitRepository } from "../../modules/init/data/sqlite-init-repository.js";
import { SqliteInventoryRepository } from "../../modules/inventory/data/sqlite-inventory-repository.js";
import { SqliteLabelRepository } from "../../modules/labels/data/sqlite-label-repository.js";
import { SqliteLocationRepository } from "../../modules/locations/data/sqlite-location-repository.js";
import { SqliteManifestRepository } from "../../modules/manifests/data/sqlite-manifest-repository.js";
import { SqliteOrderRepository } from "../../modules/orders/data/sqlite-order-repository.js";
import { SqlitePackageRepository } from "../../modules/packages/data/sqlite-package-repository.js";
import { SqliteProductRepository } from "../../modules/products/data/sqlite-product-repository.js";
import { SqliteRateRepository } from "../../modules/rates/data/sqlite-rate-repository.js";
import { SqliteSettingsRepository } from "../../modules/settings/data/sqlite-settings-repository.js";
import { SqliteShipmentRepository } from "../../modules/shipments/data/sqlite-shipment-repository.js";
import { SqliteQueueRepository } from "../../modules/queue/data/sqlite-queue-repository.js";
import { openSqliteDatabase } from "../../../../../packages/shared/src/sqlite/database.js";
import type { ApiDataStore } from "../datastore.js";

export function createSqliteDataStore(sqliteDbPath: string, excludedStoreIds: number[], mainApiKeyV2: string | null): ApiDataStore {
  const db = openSqliteDatabase(sqliteDbPath);

  return {
    queueRepository: new SqliteQueueRepository(db),
    billingRepository: new SqliteBillingRepository(db),
    analysisRepository: new SqliteAnalysisRepository(db),
    clientRepository: new SqliteClientRepository(db),
    initRepository: new SqliteInitRepository(db, excludedStoreIds),
    inventoryRepository: new SqliteInventoryRepository(db),
    labelRepository: new SqliteLabelRepository(db, mainApiKeyV2),
    locationRepository: new SqliteLocationRepository(db),
    manifestRepository: new SqliteManifestRepository(db),
    orderRepository: new SqliteOrderRepository(db, excludedStoreIds),
    packageRepository: new SqlitePackageRepository(db),
    productRepository: new SqliteProductRepository(db),
    rateRepository: new SqliteRateRepository(db, mainApiKeyV2),
    settingsRepository: new SqliteSettingsRepository(db),
    shipmentRepository: new SqliteShipmentRepository(db),
    shipFromState: new InMemoryShipFromState(),
  };
}
