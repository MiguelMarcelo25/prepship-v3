// PS-286 (slice): DIRECT-CARRIER proof parity for the Print-Queue <-> Awaiting
// rate-truth agreement.
//
// A direct-carrier saved best rate stores a SYNTHETIC provider id
// (DIRECT_CARRIER_PROVIDER_ID_OFFSET 10_000_000 + carrier_accounts.id) that the
// ShipStation account registry never carries. Before this slice, the Print-Queue
// preflight + the Awaiting "Best Rate" column already AGREED for ShipStation rows
// (both read classifyAwaitingBestRateDisplay), but nothing PROVED that a direct-
// carrier saved rate runs through the IDENTICAL backend source-of-truth verdict —
// so a future change could quietly let a direct row queue a confident-looking
// STALE / incomplete / expired / eligibility-mismatched rate the column refuses to
// show as a dollar figure.
//
// This PURE function closes that gap by CONSTRUCTION. It takes the backend SOT
// verdict inputs for ONE saved rate (the same fields the column feeds: isComplete /
// cacheExpiresAt / eligibilityVersion, surfaced via savedBestRateCanDisplayForCurrent
// Request) plus the rate's shippingProviderId, then runs the EXACT same chain the
// Awaiting column uses:
//
//   savedBestRateCanDisplayForCurrentRequest  (canonical FE display contract)
//     -> classifyAwaitingBestRateDisplay       (explicit column state)
//       -> classifyPrintQueuePreflightFromAwaitingState  (queueable-as-current verdict)
//
// The carrier family is read ONLY to set an isDirectCarrier diagnostic flag — it is
// NEVER consulted to change queueableAsCurrent / state / blockedReason. So a direct-
// carrier rate and a ShipStation rate with identical verdict inputs are blocked (or
// allowed) IDENTICALLY. This module recomputes no money / insurance / eligibility
// verdict; the backend owns those and the FE renders the result verbatim.

import { isDirectCarrierId } from '../../lib/direct-carrier-id'
import { savedBestRateCanDisplayForCurrentRequest } from './orders-parity'
import {
  classifyAwaitingBestRateDisplay,
  type AwaitingBestRateDisplayState,
} from './awaiting-best-rate-display-state'
import {
  classifyPrintQueuePreflightFromAwaitingState,
  type PrintQueuePreflightVerdict,
} from './print-queue-preflight-state'

export type PrintQueuePreflightForSavedRateInput = {
  // The saved rate's account id. A synthetic id >= 10M is a direct carrier; a
  // smaller id is a ShipStation provider account. Diagnostic only (see above).
  shippingProviderId: number | null
  // Whether the row carries ANY saved best-rate record with a positive base amount.
  hasSavedBestRate: boolean
  // Whether the row currently has complete dims + weight (so a rate is even possible).
  hasDimsAndWeight: boolean
  // ── backend SOT verdict inputs (forwarded verbatim to the canonical contract) ──
  clientRequestKey?: string | null
  requestKey: string
  hasBackendIssuedRateProof: boolean
  isComplete: boolean | null
  cacheExpiresAt: string | null
  eligibilityVersion: string | null
  requiredEligibilityVersion: string | null
  requireEligibilityVersion?: boolean
  matchType?: string | null
  baseAmount: number
  backendWorkflowCanUseSavedRate?: boolean | null
  backendSavedRateDisplay?: string | null
  nowMs?: number
}

export type PrintQueuePreflightForSavedRateVerdict = PrintQueuePreflightVerdict & {
  // True when the saved rate's provider id is a direct-carrier synthetic id. DIAGNOSTIC
  // ONLY — the (non-)queueable verdict above is identical regardless of this flag.
  isDirectCarrier: boolean
}

export function classifyPrintQueuePreflightForSavedRate(
  input: PrintQueuePreflightForSavedRateInput,
): PrintQueuePreflightForSavedRateVerdict {
  // The canonical FE display contract — the SAME gate the Awaiting column uses.
  const canDisplaySavedRate = savedBestRateCanDisplayForCurrentRequest({
    clientRequestKey: input.clientRequestKey,
    requestKey: input.requestKey,
    hasBackendIssuedRateProof: input.hasBackendIssuedRateProof,
    isComplete: input.isComplete === true,
    cacheExpiresAt: input.cacheExpiresAt,
    nowMs: input.nowMs,
    eligibilityVersion: input.eligibilityVersion,
    requiredEligibilityVersion: input.requiredEligibilityVersion,
    requireEligibilityVersion: input.requireEligibilityVersion,
    matchType: input.matchType,
    baseAmount: input.baseAmount,
    backendWorkflowCanUseSavedRate: input.backendWorkflowCanUseSavedRate ?? null,
    backendSavedRateDisplay: input.backendSavedRateDisplay,
  })

  const state: AwaitingBestRateDisplayState = classifyAwaitingBestRateDisplay({
    hasSavedBestRate: input.hasSavedBestRate,
    canDisplaySavedRate,
    isComplete: input.isComplete,
    cacheExpiresAt: input.cacheExpiresAt,
    eligibilityVersion: input.eligibilityVersion,
    requiredEligibilityVersion: input.requiredEligibilityVersion,
    hasDimsAndWeight: input.hasDimsAndWeight,
    nowMs: input.nowMs,
  })

  // The queueable verdict comes from the SAME mapping the ShipStation rows use —
  // carrier family is NOT consulted here.
  const verdict = classifyPrintQueuePreflightFromAwaitingState(state)

  return {
    ...verdict,
    isDirectCarrier: isDirectCarrierId(input.shippingProviderId),
  }
}
