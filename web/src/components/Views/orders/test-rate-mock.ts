// PS-166 (#685): the pure test-mock rate-builder cluster, moved VERBATIM out of
// OrdersView.tsx into the new orders/ package directory (DJ preference: new
// functions live in their own small file). These are PURE, deterministic mock
// generators for the local "PrepShip Test" carrier — output depends only on the
// arguments (plus the two template tables below). No React, no state, no fetch,
// no side effects.
//
// IMPORTANT (architecture): this fabricates a SYNTHETIC rate table for test
// orders only. It never reads or recomputes a real money/insurance verdict —
// the real best-rate truth is backend-owned and forwarded verbatim by the FE.
// The shared constants (TEST_CARRIER_CODE, TEST_RATE_BROWSER_ACCOUNTS) are
// re-exported so OrdersView keeps a single source of truth for its other uses.

export const TEST_CARRIER_CODE = 'prepship_test'

export const TEST_RATE_BROWSER_ACCOUNTS = [
  { shippingProviderId: 900001, carrierId: 'se-prepship-test-a', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Standard', accountNumber: 'MOCK-PT-A', name: 'PrepShip Test Standard', _label: 'PrepShip Test Standard' },
  { shippingProviderId: 900002, carrierId: 'se-prepship-test-b', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Saver', accountNumber: 'MOCK-PT-B', name: 'PrepShip Test Saver', _label: 'PrepShip Test Saver' },
  { shippingProviderId: 900003, carrierId: 'se-prepship-test-c', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Priority', accountNumber: 'MOCK-PT-C', name: 'PrepShip Test Priority', _label: 'PrepShip Test Priority' },
  { shippingProviderId: 900004, carrierId: 'se-prepship-test-d', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Express', accountNumber: 'MOCK-PT-D', name: 'PrepShip Test Express', _label: 'PrepShip Test Express' },
  { shippingProviderId: 900005, carrierId: 'se-prepship-test-e', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Local', accountNumber: 'MOCK-PT-E', name: 'PrepShip Test Local', _label: 'PrepShip Test Local' },
]

const TEST_RATE_SERVICE_TEMPLATES = [
  { code: 'prepship_test_economy', name: 'PrepShip Test Economy', base: 4.65, spread: 2.75, perLb: 0.72, days: '3-6 days' },
  { code: 'prepship_test_standard', name: 'PrepShip Test Standard', base: 7.25, spread: 3.8, perLb: 0.96, days: '2-4 days' },
  { code: 'prepship_test_priority', name: 'PrepShip Test Priority', base: 13.9, spread: 6.75, perLb: 1.28, days: '1-3 days' },
]

function seededTestUnit(seed: string) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

function roundTestMoney(value: number) {
  return Math.round(Math.max(0, value) * 100) / 100
}

export function buildTestRatesForShipment(orderId: number, dims: { length: number; width: number; height: number }, weightOz: number) {
  const weightLb = Math.max(0.25, weightOz / 16)
  const cubicInches = Math.max(0, dims.length * dims.width * dims.height)
  const dimFactor = Math.min(18, cubicInches / 1728) * 1.15
  const seedBase = `${orderId}:${weightOz}:${dims.length}x${dims.width}x${dims.height}`

  return TEST_RATE_BROWSER_ACCOUNTS.flatMap((account) => (
    TEST_RATE_SERVICE_TEMPLATES.map((template, templateIndex) => {
      const jitter = seededTestUnit(`${seedBase}:${account.shippingProviderId}:${template.code}`)
      const surchargeSeed = seededTestUnit(`${seedBase}:fuel:${account.shippingProviderId}:${templateIndex}`)
      const shipmentCost = roundTestMoney(template.base + template.spread * jitter + weightLb * template.perLb + dimFactor)
      const otherCost = roundTestMoney(surchargeSeed > 0.72 ? 0.55 + surchargeSeed * 1.45 : 0)
      return {
        carrierCode: TEST_CARRIER_CODE,
        serviceCode: template.code,
        serviceName: template.name,
        carrierNickname: account._label,
        shippingProviderId: account.shippingProviderId,
        amount: shipmentCost + otherCost,
        shipmentCost,
        otherCost,
        raw: {
          testRate: true,
          mocked: true,
          carrierCode: TEST_CARRIER_CODE,
          serviceCode: template.code,
          serviceName: template.name,
          carrierNickname: account._label,
          deliveryDays: template.days,
          delivery_days: Number.parseInt(template.days, 10) || null,
          rate_details: otherCost > 0
            ? [{ rate_detail_type: 'fuel_surcharge', carrier_description: 'Mock fuel surcharge', amount: { amount: otherCost } }]
            : [],
        },
      }
    })
  ))
}

export function buildBestTestRateForShipment(orderId: number, dims: { length: number; width: number; height: number }, weightOz: number) {
  return buildTestRatesForShipment(orderId, dims, weightOz)
    .sort((left, right) => (left.shipmentCost + left.otherCost) - (right.shipmentCost + right.otherCost))[0] ?? null
}

export function buildTestRateBrowserAccounts() {
  return TEST_RATE_BROWSER_ACCOUNTS
}
