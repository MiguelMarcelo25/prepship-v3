import { jsonResponse } from "../common/http/json.js";
import { InputValidationError } from "../../../../packages/contracts/src/common/input-validation.js";
import { createRouteDispatcher, route } from "./router.js";
import type { AnalysisHttpHandler } from "../modules/analysis/api/analysis-handler.js";
import type { BillingHttpHandler } from "../modules/billing/api/billing-handler.js";
import type { ClientsHttpHandler } from "../modules/clients/api/clients-handler.js";
import { createAnalysisRoutes } from "../modules/analysis/api/analysis-routes.js";
import { createBillingRoutes } from "../modules/billing/api/billing-routes.js";
import { createClientRoutes } from "../modules/clients/api/client-routes.js";
import { createInventoryRoutes } from "../modules/inventory/api/inventory-routes.js";
import { createOrderRoutes } from "../modules/orders/api/order-routes.js";
import { createPackageRoutes } from "../modules/packages/api/package-routes.js";
import type { InitHttpHandler } from "../modules/init/api/init-handler.js";
import { createInitRoutes } from "../modules/init/api/init-routes.js";
import type { InventoryHttpHandler } from "../modules/inventory/api/inventory-handler.js";
import type { LabelsHttpHandler } from "../modules/labels/api/labels-handler.js";
import { createLabelRoutes } from "../modules/labels/api/label-routes.js";
import type { LocationsHttpHandler } from "../modules/locations/api/locations-handler.js";
import { createLocationRoutes } from "../modules/locations/api/location-routes.js";
import type { ManifestsHttpHandler } from "../modules/manifests/api/manifests-handler.js";
import { createManifestRoutes } from "../modules/manifests/api/manifests-routes.js";
import type { OrdersHttpHandler } from "../modules/orders/api/orders-handler.js";
import type { PackagesHttpHandler } from "../modules/packages/api/packages-handler.js";
import type { ProductsHttpHandler } from "../modules/products/api/products-handler.js";
import { createProductRoutes } from "../modules/products/api/product-routes.js";
import type { RatesHttpHandler } from "../modules/rates/api/rates-handler.js";
import { createRateRoutes } from "../modules/rates/api/rates-routes.js";
import type { SettingsHttpHandler } from "../modules/settings/api/settings-handler.js";
import { createSettingsRoutes } from "../modules/settings/api/settings-routes.js";
import type { ShipmentsHttpHandler } from "../modules/shipments/api/shipments-handler.js";
import { createShipmentRoutes } from "../modules/shipments/api/shipment-routes.js";
import type { QueueHttpHandler } from "../modules/queue/api/queue-handler.js";
import { createQueueRoutes } from "../modules/queue/api/queue-routes.js";

export interface AppDependencies {
  queueHandler: QueueHttpHandler;
  analysisHandler: AnalysisHttpHandler;
  billingHandler: BillingHttpHandler;
  ordersHandler: OrdersHttpHandler;
  clientsHandler: ClientsHttpHandler;
  initHandler: InitHttpHandler;
  inventoryHandler: InventoryHttpHandler;
  labelsHandler: LabelsHttpHandler;
  locationsHandler: LocationsHttpHandler;
  manifestsHandler: ManifestsHttpHandler;
  packagesHandler: PackagesHttpHandler;
  productsHandler: ProductsHttpHandler;
  ratesHandler: RatesHttpHandler;
  settingsHandler: SettingsHttpHandler;
  shipmentsHandler: ShipmentsHttpHandler;
}

export function createApp(dependencies: AppDependencies) {
  const dispatchRoute = createRouteDispatcher([
    route("GET", "/health", () => jsonResponse(200, { ok: true })),
    ...createAnalysisRoutes(dependencies.analysisHandler),
    ...createBillingRoutes(dependencies.billingHandler),
    ...createClientRoutes(dependencies.clientsHandler),
    ...createInitRoutes(dependencies.initHandler),
    ...createInventoryRoutes(dependencies.inventoryHandler),
    ...createLabelRoutes(dependencies.labelsHandler),
    ...createLocationRoutes(dependencies.locationsHandler),
    ...createManifestRoutes(dependencies.manifestsHandler),
    ...createOrderRoutes(dependencies.ordersHandler),
    ...createPackageRoutes(dependencies.packagesHandler),
    ...createProductRoutes(dependencies.productsHandler),
    ...createQueueRoutes(dependencies.queueHandler),
    ...createRateRoutes(dependencies.ratesHandler),
    ...createSettingsRoutes(dependencies.settingsHandler),
    ...createShipmentRoutes(dependencies.shipmentsHandler),
  ]);

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url, "http://localhost");
    const readJson = async (): Promise<Record<string, unknown>> => {
      const text = await request.text();
      if (!text) return {};
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new InputValidationError("Malformed JSON body");
      }
    };

    const routed = await dispatchRoute({ request, url, readJson });
    if (routed) {
      return routed;
    }

    return jsonResponse(404, { error: "Not found" });
  };
}
