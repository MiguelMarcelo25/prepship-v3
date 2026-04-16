import { createApp } from "./create-app.js";
import { createAuthMiddleware } from "./auth-middleware.js";
import { loadAppConfig } from "../config/app-config.js";
import { CARRIER_ACCOUNTS_V2, EXCLUDED_STORE_IDS } from "../common/prepship-config.js";
import type { ApiDataStore } from "./datastore.js";
import { buildDataStore } from "./providers/build-datastore.js";
import { AnalysisHttpHandler } from "../modules/analysis/api/analysis-handler.js";
import { AnalysisServices } from "../modules/analysis/application/analysis-services.js";
import { BillingHttpHandler } from "../modules/billing/api/billing-handler.js";
import { RateShopperBillingReferenceRateFetcher } from "../modules/billing/data/rate-shopper-billing-reference-rate-fetcher.js";
import { BillingServices } from "../modules/billing/application/billing-services.js";
import { ClientsHttpHandler } from "../modules/clients/api/clients-handler.js";
import { ClientServices } from "../modules/clients/application/client-services.js";
import { InitHttpHandler } from "../modules/init/api/init-handler.js";
import type { InitMetadataProvider } from "../modules/init/application/init-metadata-provider.js";
import { InitServices } from "../modules/init/application/init-services.js";
import { ShipstationInitMetadataProvider } from "../modules/init/data/shipstation-init-metadata-provider.js";
import { InventoryHttpHandler } from "../modules/inventory/api/inventory-handler.js";
import { InventoryServices } from "../modules/inventory/application/inventory-services.js";
import { LabelsHttpHandler } from "../modules/labels/api/labels-handler.js";
import { LabelServices } from "../modules/labels/application/label-services.js";
import type { ShippingGateway } from "../modules/labels/application/shipping-gateway.js";
import { ShipstationShippingGateway } from "../modules/labels/data/shipstation-shipping-gateway.js";
import { LocationsHttpHandler } from "../modules/locations/api/locations-handler.js";
import { LocationServices } from "../modules/locations/application/location-services.js";
import { ManifestsHttpHandler } from "../modules/manifests/api/manifests-handler.js";
import { ManifestServices } from "../modules/manifests/application/manifest-services.js";
import { OrdersHttpHandler } from "../modules/orders/api/orders-handler.js";
import { PackagesHttpHandler } from "../modules/packages/api/packages-handler.js";
import type { PackageSyncGateway } from "../modules/packages/application/package-sync-gateway.js";
import { PackageServices } from "../modules/packages/application/package-services.js";
import { ShipstationPackageSyncGateway } from "../modules/packages/data/shipstation-package-sync-gateway.js";
import { ProductsHttpHandler } from "../modules/products/api/products-handler.js";
import { ProductServices } from "../modules/products/application/product-services.js";
import { RatesHttpHandler } from "../modules/rates/api/rates-handler.js";
import type { RateShopper } from "../modules/rates/application/rate-shopper.js";
import { RateServices } from "../modules/rates/application/rate-services.js";
import { ShipstationRateShopper } from "../modules/rates/data/shipstation-rate-shopper.js";
import { SettingsHttpHandler } from "../modules/settings/api/settings-handler.js";
import { SettingsServices } from "../modules/settings/application/settings-services.js";
import { ShipmentsHttpHandler } from "../modules/shipments/api/shipments-handler.js";
import { ShipmentServices } from "../modules/shipments/application/shipment-services.js";
import { ListOrdersService } from "../modules/orders/application/list-orders.js";
import { OrderDetailsService } from "../modules/orders/application/order-details.js";
import { OrderExportService } from "../modules/orders/application/order-export.js";
import { GetOrderIdsService } from "../modules/orders/application/get-order-ids.js";
import { OrderPicklistService } from "../modules/orders/application/order-picklist.js";
import { OrderFullService } from "../modules/orders/application/order-full.js";
import { OrderDailyStatsService } from "../modules/orders/application/order-daily-stats.js";
import { UpdateOrderOverridesService } from "../modules/orders/application/update-order-overrides.js";
import { ShipstationResidentialGateway } from "../modules/orders/data/shipstation-residential-gateway.js";
import { QueueHttpHandler } from "../modules/queue/api/queue-handler.js";
import { QueueServices } from "../modules/queue/application/queue-services.js";
import type { MemoryDataStoreSeed } from "./providers/memory-datastore.js";

export interface BootstrapApiOverrides {
  initMetadataProvider?: InitMetadataProvider;
  dataStore?: ApiDataStore;
  memorySeed?: MemoryDataStoreSeed;
  rateShopper?: RateShopper;
  shippingGateway?: ShippingGateway;
  packageSyncGateway?: PackageSyncGateway;
}

export async function bootstrapApi(env = process.env, overrides: BootstrapApiOverrides = {}) {
  const config = loadAppConfig(env);
  const dataStore = overrides.dataStore ?? await buildDataStore(config, overrides.memorySeed);
  const rateShopper = overrides.rateShopper ?? new ShipstationRateShopper();
  const billingServices = new BillingServices(
    dataStore.billingRepository,
    new RateShopperBillingReferenceRateFetcher(dataStore.rateRepository, rateShopper),
  );
  const billingHandler = new BillingHttpHandler(billingServices);
  const analysisServices = new AnalysisServices(dataStore.analysisRepository);
  const analysisHandler = new AnalysisHttpHandler(analysisServices);
  const initMetadataProvider = overrides.initMetadataProvider ?? new ShipstationInitMetadataProvider(config.secrets, CARRIER_ACCOUNTS_V2);
  const clientServices = new ClientServices(dataStore.clientRepository, initMetadataProvider);
  const initServices = new InitServices(dataStore.initRepository, initMetadataProvider, clientServices, EXCLUDED_STORE_IDS);
  const initHandler = new InitHttpHandler(initServices);
  const clientsHandler = new ClientsHttpHandler(clientServices);
  const inventoryServices = new InventoryServices(dataStore.inventoryRepository);
  const inventoryHandler = new InventoryHttpHandler(inventoryServices);
  const shippingGateway = overrides.shippingGateway ?? new ShipstationShippingGateway(config.secrets);
  const labelServices = new LabelServices(dataStore.labelRepository, shippingGateway, config.secrets);
  const labelsHandler = new LabelsHttpHandler(labelServices);
  const locationServices = new LocationServices(dataStore.locationRepository, dataStore.shipFromState);
  const locationsHandler = new LocationsHttpHandler(locationServices);
  const manifestServices = new ManifestServices(dataStore.manifestRepository);
  const manifestsHandler = new ManifestsHttpHandler(manifestServices);
  const packageServices = new PackageServices(dataStore.packageRepository, overrides.packageSyncGateway ?? new ShipstationPackageSyncGateway(config.secrets));
  const packagesHandler = new PackagesHttpHandler(packageServices);
  const productServices = new ProductServices(dataStore.productRepository);
  const productsHandler = new ProductsHttpHandler(productServices);
  const rateServices = new RateServices(dataStore.rateRepository, rateShopper);
  const ratesHandler = new RatesHttpHandler(rateServices);
  const settingsServices = new SettingsServices(dataStore.settingsRepository);
  const settingsHandler = new SettingsHttpHandler(settingsServices, rateServices);
  const shipmentServices = new ShipmentServices(dataStore.shipmentRepository, shippingGateway, config.secrets);
  const shipmentsHandler = new ShipmentsHttpHandler(shipmentServices);
  const residentialGateway = new ShipstationResidentialGateway(config.secrets);
  const listOrdersService = new ListOrdersService(dataStore.orderRepository, rateServices, residentialGateway);
  const orderDetailsService = new OrderDetailsService(dataStore.orderRepository, rateServices);
  const getOrderIdsService = new GetOrderIdsService(dataStore.orderRepository);
  const orderPicklistService = new OrderPicklistService(dataStore.orderRepository);
  const orderFullService = new OrderFullService(dataStore.orderRepository);
  const updateOrderOverridesService = new UpdateOrderOverridesService(dataStore.orderRepository);
  const orderDailyStatsService = new OrderDailyStatsService(dataStore.orderRepository);
  const orderExportService = new OrderExportService(dataStore.orderRepository);
  const queueServices = new QueueServices(dataStore.queueRepository);
  const queueHandler = new QueueHttpHandler(queueServices);

  const ordersHandler = new OrdersHttpHandler(
    listOrdersService,
    orderDetailsService,
    getOrderIdsService,
    orderPicklistService,
    orderFullService,
    updateOrderOverridesService,
    orderDailyStatsService,
    orderExportService,
  );

  const rawApp = createApp({ analysisHandler, billingHandler, ordersHandler, clientsHandler, initHandler, inventoryHandler, labelsHandler, locationsHandler, manifestsHandler, packagesHandler, productsHandler, ratesHandler, settingsHandler, shipmentsHandler, queueHandler });

  return {
    config,
    app: createAuthMiddleware(rawApp, config.sessionToken),
  };
}
