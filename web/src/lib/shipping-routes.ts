// PS-279 (slice 1): the Send-to-Queue routing decision (direct carriers vs ShipStation) moved here,
// out of web/src/components/Views/orders-parity.ts. It is a MONEY-PATH decision (it picks buy-then-queue
// vs a backend create/recover job), so its home belongs at a shareable web/src/lib boundary, not inside
// a component module. The logic is unchanged from its prior location.
//
// PS-204 note: since PS-202, createLabelV2 owns BOTH families server-side (synthetic direct ids route to
// the direct connector branch), so this routing decides which CLIENT flow runs (buy-then-queue vs backend
// create/recover job) — it no longer protects ShipStation from synthetic ids; the backend proof/account
// binding and the se- emission assert own that. This is the pure decision the queue action consumes so it
// can be unit-tested without buying real postage.
// PS-178 final part: planStrictBestRateRecalculate (the FE copy of the strict recalc decision) DELETED —
// the decision is backend-owned (src/services/rates-recalculate.ts → response.strictRecalculation) and a
// response without the verdict is treated as blocked, never FE-decided.

export type QueueOrderRoute = 'direct-create' | 'backend'

export function classifyQueueOrderRoute(
  input: {
    /** The order already has a queueable (non-[object Object]) label URL. */
    hasQueueableLabel: boolean
    /** Test-client order — must never buy real postage; backend forces a mock. */
    isTest: boolean
    /** Selected/best rate resolves to a direct carrier_accounts synthetic id. */
    isDirectCarrier: boolean
    /**
     * PS-176: the BACKEND's routing policy (bestRateWorkflow.queueRoute). It is
     * consulted ONLY after the live never-buy ladder below, so a stale
     * list-time value can never cause a re-buy — it only decides the residual
     * direct-vs-backend question for orders that genuinely need a label.
     */
    backendQueueRoute?: string | null
    /**
     * PS-204: the LIVE single-order panel payload's shippingProviderId, passed
     * only when the caller carries an explicit labelPayloadOverrides entry for
     * this order. When present it — not the stale saved DTO — decides the
     * residual direct-vs-backend question: the operator's current selection is
     * the purchase account, and the backend proof/account binding blocks the
     * purchase before postage if that selection is incoherent with the proof.
     * Batch/list flows don't pass it and keep PS-176 backend-policy routing.
     */
    explicitPayloadProviderId?: number | null
  },
  options: { existingLabelOnly?: boolean; batchTestMode?: boolean } = {},
): QueueOrderRoute {
  // Never create a label in these cases — defer to the backend job:
  if (options.existingLabelOnly) return 'backend' // caller only wants existing labels queued
  if (options.batchTestMode) return 'backend' // test run → backend mock, no real postage
  if (input.isTest) return 'backend' // test-client order → backend mock
  if (input.hasQueueableLabel) return 'backend' // already bought → backend queues it as-is
  // PS-204: an explicit live panel payload outranks the saved DTO policy for
  // the residual routing question (never the never-buy rungs above).
  if (input.explicitPayloadProviderId != null) {
    return input.explicitPayloadProviderId >= 10_000_000 ? 'direct-create' : 'backend'
  }
  // PS-176: the backend owns the residual routing policy when it spoke.
  if (input.backendQueueRoute === 'backend' || input.backendQueueRoute === 'direct-create') {
    return input.backendQueueRoute
  }
  // A direct-carrier order that still needs a label: buy via the direct client
  // flow (apiClient.createLabel → v4 /labels), then queue.
  if (input.isDirectCarrier) return 'direct-create'
  return 'backend' // ShipStation provider → backend createLabelV2
}
