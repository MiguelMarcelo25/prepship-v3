import type { BillingRepository } from "../modules/billing/application/billing-repository.js";
import type { AnalysisRepository } from "../modules/analysis/application/analysis-repository.js";
import type { ClientRepository } from "../modules/clients/application/client-repository.js";
import type { InitRepository } from "../modules/init/application/init-repository.js";
import type { InventoryRepository } from "../modules/inventory/application/inventory-repository.js";
import type { LabelRepository } from "../modules/labels/application/label-repository.js";
import type { LocationRepository } from "../modules/locations/application/location-repository.js";
import type { ShipFromState } from "../modules/locations/application/ship-from-state.js";
import type { ManifestRepository } from "../modules/manifests/application/manifest-repository.js";
import type { OrderRepository } from "../modules/orders/application/order-repository.js";
import type { PackageRepository } from "../modules/packages/application/package-repository.js";
import type { ProductRepository } from "../modules/products/application/product-repository.js";
import type { RateRepository } from "../modules/rates/application/rate-repository.js";
import type { SettingsRepository } from "../modules/settings/application/settings-repository.js";
import type { ShipmentRepository } from "../modules/shipments/application/shipment-repository.js";
import type { QueueRepository } from "../modules/queue/application/queue-repository.js";

export interface ApiDataStore {
  queueRepository: QueueRepository;
  billingRepository: BillingRepository;
  analysisRepository: AnalysisRepository;
  clientRepository: ClientRepository;
  initRepository: InitRepository;
  inventoryRepository: InventoryRepository;
  labelRepository: LabelRepository;
  locationRepository: LocationRepository;
  manifestRepository: ManifestRepository;
  orderRepository: OrderRepository;
  packageRepository: PackageRepository;
  productRepository: ProductRepository;
  rateRepository: RateRepository;
  settingsRepository: SettingsRepository;
  shipmentRepository: ShipmentRepository;
  shipFromState: ShipFromState;
}
