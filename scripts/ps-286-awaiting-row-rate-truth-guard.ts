/**
 * PS-286 guard — the Awaiting Best Rate column is a THIN CONSUMER of the backend
 * rate source-of-truth.
 *
 * Read-only: pure DTO / UI-reader contract checks. No DB, no carrier APIs, no
 * labels, no shipped/cancelled mutation. Awaiting-only.
 *
 * Pins two behaviors:
 *
 *  (1) Precedence flip in getV2CarrierAccountForOrder (orders-row-display.tsx).
 *      For an awaiting_shipment row the CURRENT order.bestRate carrier/account
 *      must win over a STALE order.selectedRate / order.label provider id
 *      (required-behavior #2). The shipped/cancelled path keeps the old
 *      selected-first precedence (proves no shipped path was touched).
 *
 *  (2) The explicit-state classifier (awaiting-best-rate-display-state.ts) turns
 *      the backend SOT verdict (isComplete / cacheExpiresAt / eligibilityVersion,
 *      surfaced via savedBestRateCanDisplayForCurrentRequest) into an explicit
 *      Best-Rate-column state — so a stale / incomplete / expired / eligibility-
 *      mismatched saved rate renders an actionable label, not a dollar figure.
 */
import {
  getV2CarrierAccountForOrder,
  V2_CARRIER_ACCOUNT_REFS,
} from '../web/src/components/Views/orders-row-display'
import { savedBestRateCanDisplayForCurrentRequest } from '../web/src/components/Views/orders-parity'
import {
  classifyAwaitingBestRateDisplay,
  type AwaitingBestRateDisplayState,
} from '../web/src/components/Views/awaiting-best-rate-display-state'
import type { OrderSummaryDto } from '../web/src/types/api'

let failures = 0

function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

// Two REAL registry accounts so resolveV2CarrierAccount returns a concrete nickname.
const STALE_SELECTED = V2_CARRIER_ACCOUNT_REFS.find((r) => r.shippingProviderId === 565326)! // GG6381 (ups)
const FRESH_BESTRATE = V2_CARRIER_ACCOUNT_REFS.find((r) => r.shippingProviderId === 433542)! // USPS Chase x7439 (stamps_com)

if (!STALE_SELECTED || !FRESH_BESTRATE) {
  console.error('FAIL fixture: expected registry provider ids 565326 and 433542 to exist')
  process.exit(1)
}

// ── (1) precedence flip — awaiting bestRate wins over stale selected/label ──────

const awaitingStaleSelected = {
  orderId: 'o-286-1',
  orderStatus: 'awaiting_shipment',
  // STALE selected rate + label still point at the old GG6381 account…
  selectedRate: { shippingProviderId: STALE_SELECTED.shippingProviderId, carrierCode: 'ups' },
  label: { shippingProviderId: STALE_SELECTED.shippingProviderId },
  // …but the CURRENT best rate is on USPS Chase x7439.
  bestRate: { shippingProviderId: FRESH_BESTRATE.shippingProviderId, carrierCode: 'stamps_com' },
} as unknown as OrderSummaryDto

check(
  'awaiting: current bestRate account wins over stale selectedRate/label',
  getV2CarrierAccountForOrder(awaitingStaleSelected)?.shippingProviderId,
  FRESH_BESTRATE.shippingProviderId,
)
check(
  'awaiting: resolved nickname is the bestRate account, not the stale one',
  getV2CarrierAccountForOrder(awaitingStaleSelected)?.nickname,
  FRESH_BESTRATE.nickname,
)

// A shipped row with the SAME shape must keep the OLD selected-first precedence —
// proves this slice did not touch the shipped/cancelled display path.
const shippedSameShape = {
  ...awaitingStaleSelected,
  orderId: 'o-286-1s',
  orderStatus: 'shipped',
} as unknown as OrderSummaryDto

check(
  'shipped: selectedRate/label account still wins (shipped path unchanged)',
  getV2CarrierAccountForOrder(shippedSameShape)?.shippingProviderId,
  STALE_SELECTED.shippingProviderId,
)

// Awaiting with NO bestRate provider id falls back to selected/label as before.
const awaitingNoBestRateId = {
  orderId: 'o-286-2',
  orderStatus: 'awaiting_shipment',
  selectedRate: { shippingProviderId: STALE_SELECTED.shippingProviderId, carrierCode: 'ups' },
  bestRate: { carrierCode: 'ups' },
} as unknown as OrderSummaryDto

check(
  'awaiting: falls back to selected provider id when bestRate carries none',
  getV2CarrierAccountForOrder(awaitingNoBestRateId)?.shippingProviderId,
  STALE_SELECTED.shippingProviderId,
)

// ── (2) explicit-state classifier off the SOT verdict ──────────────────────────

const REQUIRED_ELIG = 'ground-saver-v2'
const FUTURE = '2026-06-30T00:00:00.000Z'
const PAST = '2026-06-01T00:00:00.000Z'
const NOW = Date.parse('2026-06-18T00:00:00.000Z')

function state(partial: {
  isComplete: boolean | null
  cacheExpiresAt: string | null
  eligibilityVersion: string | null
  hasBackendIssuedRateProof?: boolean
  backendWorkflowCanUseSavedRate?: boolean | null
}): AwaitingBestRateDisplayState {
  const canDisplaySavedRate = savedBestRateCanDisplayForCurrentRequest({
    clientRequestKey: 'order|current',
    requestKey: 'order|current',
    hasBackendIssuedRateProof: partial.hasBackendIssuedRateProof ?? true,
    isComplete: partial.isComplete === true,
    cacheExpiresAt: partial.cacheExpiresAt,
    nowMs: NOW,
    eligibilityVersion: partial.eligibilityVersion,
    requiredEligibilityVersion: REQUIRED_ELIG,
    matchType: 'live',
    baseAmount: 7.78,
    backendWorkflowCanUseSavedRate: partial.backendWorkflowCanUseSavedRate ?? null,
  })
  return classifyAwaitingBestRateDisplay({
    hasSavedBestRate: true,
    canDisplaySavedRate,
    isComplete: partial.isComplete,
    cacheExpiresAt: partial.cacheExpiresAt,
    eligibilityVersion: partial.eligibilityVersion,
    requiredEligibilityVersion: REQUIRED_ELIG,
    hasDimsAndWeight: true,
    nowMs: NOW,
  })
}

check(
  'fresh complete in-window matching-eligibility rate => show_amount',
  state({ isComplete: true, cacheExpiresAt: FUTURE, eligibilityVersion: REQUIRED_ELIG }),
  'show_amount',
)
check(
  'eligibility mismatch => eligibility_mismatch (not a $ figure)',
  state({ isComplete: true, cacheExpiresAt: FUTURE, eligibilityVersion: 'old-v1' }),
  'eligibility_mismatch',
)
check(
  'backend marked incomplete => coverage_incomplete',
  state({ isComplete: false, cacheExpiresAt: FUTURE, eligibilityVersion: REQUIRED_ELIG }),
  'coverage_incomplete',
)
check(
  'cache window elapsed => expired',
  state({ isComplete: true, cacheExpiresAt: PAST, eligibilityVersion: REQUIRED_ELIG }),
  'expired',
)

// No saved rate + missing dims => add_dims; no saved rate + dims present => no_rate.
check(
  'no saved rate, missing dims => add_dims',
  classifyAwaitingBestRateDisplay({
    hasSavedBestRate: false,
    canDisplaySavedRate: false,
    isComplete: null,
    cacheExpiresAt: null,
    eligibilityVersion: null,
    requiredEligibilityVersion: REQUIRED_ELIG,
    hasDimsAndWeight: false,
    nowMs: NOW,
  }),
  'add_dims',
)

if (failures > 0) {
  console.error(`\nFAIL ps-286 awaiting row rate-truth guard (${failures} failing)`)
  process.exit(1)
}

console.log('\nPASS ps-286 awaiting row rate-truth guard')
