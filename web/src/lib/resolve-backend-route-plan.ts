// PS-279: FE buy-path delegation to the backend queue-route orchestrator.
//
// SAFE-BY-DEFAULT: the caller invokes this ONLY when the backend-provided
// printQueueBackendOrchestration flag is ON (default OFF). When OFF this never
// runs and the FE keeps using its local classifyQueueOrderRoute — byte-identical
// to today's buy path. On ANY failure (the endpoint 503s when disabled, network
// error, or a malformed body) this returns null so the caller falls back to the
// local classifier PER ORDER. The backend plan is an override, never a hard
// dependency — the label-purchase route decision stays owned by the backend
// (src/services/print-queue/queue-route-orchestrator.ts); this only threads the
// already-computed answer to the FE.
import type { QueueOrderRoute } from './shipping-routes'

export type RoutePlanOrderInput = {
  order_id: number
  has_queueable_label: boolean
  is_test: boolean
  is_direct_carrier: boolean
  backend_queue_route: string | null
  explicit_payload_provider_id: number | null
}

export type RoutePlanRequestBody = {
  existingLabelOnly?: boolean
  batchTestMode?: boolean
  orders: RoutePlanOrderInput[]
}

/**
 * POST the route-plan request via `post` and reduce it to an orderId -> route map.
 * Returns null on empty input or ANY failure so the caller stays on the local
 * classifier. Never throws.
 */
export async function resolveBackendRoutePlan(
  post: (body: RoutePlanRequestBody) => Promise<unknown>,
  body: RoutePlanRequestBody,
): Promise<Map<number, QueueOrderRoute> | null> {
  if (body.orders.length === 0) return null
  try {
    const res = (await post(body)) as { plans?: Array<{ order_id?: unknown; route?: unknown }> } | null
    const plans = Array.isArray(res?.plans) ? res.plans : null
    if (!plans) return null
    const map = new Map<number, QueueOrderRoute>()
    for (const plan of plans) {
      const id = Number(plan?.order_id)
      const route = plan?.route
      if (Number.isFinite(id) && (route === 'direct-create' || route === 'backend')) {
        map.set(id, route)
      }
    }
    return map.size > 0 ? map : null
  } catch {
    // Flag off (503) / network / parse error -> caller uses the local classifier.
    return null
  }
}
