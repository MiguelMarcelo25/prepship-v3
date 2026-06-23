import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

async function read(relPath) {
  return readFile(path.join(root, relPath), 'utf8')
}

function assert(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`)
  if (!condition) process.exitCode = 1
}

const [
  shippingOptions,
  ratesService,
  ratesCombined,
  labelsService,
  shipstationLabels,
  rateFingerprint,
  ordersView,
  rateBrowser,
  apiClient,
  connectorTypes,
  directRates,
  directLabels,
  optionSupport,
  upsConnector,
  easyPostConnector,
  shipEngineConnector,
  walmartConnector,
  shippConnector,
  fedexConnector,
  uspsConnector,
  amazonConnector,
  ebayConnector,
  packageJson,
] = await Promise.all([
  read('src/lib/shipping-options.ts').catch(() => ''),
  read('src/services/rates.ts'),
  read('src/services/rates-combined.ts'),
  read('src/services/labels.ts'),
  read('src/lib/shipstation/labels.ts'),
  read('src/services/shipping-workflow/rate-fingerprint.ts'),
  read('web/src/components/Views/OrdersView.tsx'),
  read('web/src/components/RateBrowserModal.tsx'),
  read('web/src/lib/v2-apiClient.ts'),
  read('src/connectors/types.ts'),
  read('api/carriers/rates.ts'),
  read('api/carriers/labels.ts'),
  read('src/connectors/carrier/shipping-option-support.ts'),
  read('src/connectors/carrier/ups.ts'),
  read('src/connectors/carrier/easypost.ts'),
  read('src/connectors/carrier/shipengine.ts'),
  read('src/connectors/carrier/walmart-shipping.ts'),
  read('src/connectors/carrier/shipp.ts'),
  read('src/connectors/carrier/fedex.ts'),
  read('src/connectors/carrier/usps.ts'),
  read('src/connectors/carrier/amazon-shipping.ts'),
  read('src/connectors/carrier/ebay-shipping.ts'),
  read('package.json'),
])

assert(
  shippingOptions.includes('NormalizedShippingOptions') &&
    shippingOptions.includes('normalizeShippingOptions') &&
    shippingOptions.includes('normalizeConfirmation') &&
    shippingOptions.includes('normalizeInsurance'),
  'shared normalized confirmation/insurance option model exists',
)

assert(
    ratesService.includes('normalizeShippingOptions') &&
    ratesService.includes('insuranceProvider') &&
    ratesService.includes('insuredValue') &&
    rateFingerprint.includes('ip=') &&
    rateFingerprint.includes('iv=') &&
    ratesService.includes('body.insurance_provider') &&
    ratesService.includes('body.insured_value') &&
    // PS-307 (0cf5bbd4) extracted the insurance-in-total math into the canonical shared helper
    // rates-combined.ts (rateTotal/rateCostTotal); rates.ts now delegates via combinedRateTotal.
    // Assert the literal at its new authoritative owner. (QA root-cause 2026-06-23.)
    ratesCombined.includes('Number(rate.insurance_amount?.amount ?? 0)'),
  'ShipStation rates include normalized insurance in request body, totals, and cache fingerprint',
)

assert(
  labelsService.includes('insuranceProvider?:') &&
    labelsService.includes('insuredValue?:') &&
    labelsService.includes('normalizeShippingOptions') &&
    labelsService.includes('insuranceProvider: options.insuranceProvider') &&
    labelsService.includes('insuredValue: options.insuredValue'),
  'backend label DTO and ShipStation label call pass normalized insurance options',
)

assert(
  shipstationLabels.includes('insuranceProvider?:') &&
    shipstationLabels.includes('insuredValue?:') &&
    shipstationLabels.includes('insurance_provider') &&
    shipstationLabels.includes('insured_value'),
  'ShipStation label payload includes normalized insurance fields',
)

assert(
    ordersView.includes('buildPanelShippingOptionsPayload') &&
    ordersView.includes('insuranceProvider') &&
    ordersView.includes('insuredValue') &&
    ordersView.includes('refreshPanelBestRate({') &&
    !ordersView.includes("confirmation: 'delivery',\n          testLabel"),
  'Orders side panel, queue, and batch flows use selected confirmation/insurance instead of hardcoded delivery',
)

assert(
  rateBrowser.includes('insuranceProvider') &&
    rateBrowser.includes('insuredValue') &&
    rateBrowser.includes('initialInsurance') &&
    rateBrowser.includes('initialInsuranceValue'),
  'Rate Browser receives and sends the same insurance options as the order panel',
)

assert(
  // PS-209: api/carriers/labels.ts is a retired 410 stub. The v4 label owner
  // (src/services/labels.ts createLabelV2) now passes normalized shipping
  // options to the direct-carrier connector path.
  apiClient.includes('insuranceProvider') &&
    apiClient.includes('insuredValue') &&
    directRates.includes('shippingOptions') &&
    labelsService.includes('shippingOptions') &&
    connectorTypes.includes('shippingOptions?: NormalizedShippingOptions'),
  'direct carrier rate/label endpoints and connector inputs receive normalized shipping options',
)

assert(
  optionSupport.includes('assertUnsupportedShippingOptions') &&
    upsConnector.includes('PackageServiceOptions') &&
    upsConnector.includes('DeclaredValue') &&
    easyPostConnector.includes('delivery_confirmation') &&
    easyPostConnector.includes('insurance') &&
    shipEngineConnector.includes('insured_value') &&
    shipEngineConnector.includes('confirmation') &&
    walmartConnector.includes("assertUnsupportedShippingOptions('Walmart Shipping'") &&
    shippConnector.includes("assertUnsupportedShippingOptions('Shipp'") &&
    fedexConnector.includes("assertUnsupportedShippingOptions('FedEx'") &&
    uspsConnector.includes("assertUnsupportedShippingOptions('USPS'") &&
    amazonConnector.includes("assertUnsupportedShippingOptions('Amazon Shipping'") &&
    ebayConnector.includes("assertUnsupportedShippingOptions('eBay Shipping'"),
  'carrier support matrix maps supported options and explicitly rejects unsupported confirmation/insurance options',
)

assert(
  // PS-209: the direct-label purchase path is now the v4 createLabelV2 owner.
  // It enqueues the marketplace confirmation (enqueueShipmentConfirmation) with
  // the store-connector confirmation payload (confirmationProvider + rawOrder)
  // while the carrier connector receives the normalized shippingOptions.
  labelsService.includes('enqueueShipmentConfirmation(') &&
    labelsService.includes('payload: confirmationPayload') &&
    labelsService.includes('rawOrder') &&
    labelsService.includes('confirmationProvider') &&
    labelsService.includes('shippingOptions'),
  'direct label purchase keeps store connector confirmation context while carrier connector receives shipping options',
)

assert(
  packageJson.includes('"test:ps-051-shipping-options"'),
  'package script exposes PS-051 shipping options guard',
)

if (process.exitCode) {
  console.error('\nPS-051 shipping options guard failed.')
  process.exit(process.exitCode)
}
