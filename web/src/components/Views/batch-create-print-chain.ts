// Batch-print pipeline (docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md):
// pure orchestration for the flag-ON "Create + Print Label" chain. No React, no api client,
// no window — every effect is injected, so scripts/batch-print-via-queue-guard.ts can
// exercise the sequencing with fakes.
//
// Chain: proof pre-pass (strict re-rate the orders whose saved rate cannot serve as current
// proof) → backend queue-send job (buys under createLabelV2's full gate ladder) → fade the
// bought rows → print the job's queued entries as ONE merged PDF. The FE buys nothing here;
// it sequences the two existing backend jobs.

export type ChainOrder = { orderId: number; orderNumber?: string | null }

export type ProofPassDeps<TOrder> = {
  needsOverride: (order: TOrder) => boolean
  recalculate: (order: TOrder) => Promise<{ ok: true; rate: unknown } | { ok: false; message: string }>
  buildOverride: (order: TOrder, freshRate: unknown) => Record<string, unknown> | null
  runPool: (orders: TOrder[], worker: (order: TOrder) => Promise<void>) => Promise<void>
}

export type ProofPassResult = {
  overrides: Map<number, Record<string, unknown>>
  failures: Array<{ orderId: number; message: string }>
}

export async function collectBatchPrintProofOverrides<TOrder extends { orderId: number }>(
  orders: TOrder[],
  deps: ProofPassDeps<TOrder>,
): Promise<ProofPassResult> {
  const overrides = new Map<number, Record<string, unknown>>()
  const failures: Array<{ orderId: number; message: string }> = []
  const pending = orders.filter((order) => deps.needsOverride(order))
  await deps.runPool(pending, async (order) => {
    try {
      const result = await deps.recalculate(order)
      if (!result.ok) {
        failures.push({ orderId: order.orderId, message: result.message })
        return
      }
      const payload = deps.buildOverride(order, result.rate)
      if (!payload) {
        failures.push({
          orderId: order.orderId,
          message: 'Current best rate could not be proven before label purchase',
        })
        return
      }
      overrides.set(order.orderId, payload)
    } catch (err) {
      failures.push({
        orderId: order.orderId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return { overrides, failures }
}

export type QueueSendOutcome = {
  queued: number
  failed: number
  queuedEntryIds: string[]
  successOrderIds: Set<number>
  skippedErrors: string[]
}

export type CreatePrintChainDeps<TOrder extends ChainOrder> = ProofPassDeps<TOrder> & {
  sendToQueue: (orders: TOrder[], overrides: Map<number, Record<string, unknown>>) => Promise<QueueSendOutcome>
  printEntries: (entryIds: string[]) => Promise<boolean>
  markShipped: (orderId: number) => void
}

export type CreatePrintChainOutcome = {
  queued: number
  failed: number
  printed: boolean
  printAttempted: boolean
  errors: string[]
}

export async function runCreatePrintChain<TOrder extends ChainOrder>(
  orders: TOrder[],
  deps: CreatePrintChainDeps<TOrder>,
): Promise<CreatePrintChainOutcome> {
  const proofPass = await collectBatchPrintProofOverrides(orders, deps)
  const proofFailedIds = new Set(proofPass.failures.map((failure) => failure.orderId))
  const sendable = orders.filter((order) => !proofFailedIds.has(order.orderId))
  const outcome: QueueSendOutcome = sendable.length > 0
    ? await deps.sendToQueue(sendable, proofPass.overrides)
    : { queued: 0, failed: 0, queuedEntryIds: [], successOrderIds: new Set<number>(), skippedErrors: [] }
  for (const orderId of outcome.successOrderIds) deps.markShipped(orderId)
  let printed = false
  const printAttempted = outcome.queuedEntryIds.length > 0
  if (printAttempted) printed = await deps.printEntries(outcome.queuedEntryIds)
  const byId = new Map(orders.map((order) => [order.orderId, order]))
  const errors = [
    ...proofPass.failures.map((failure) => {
      const order = byId.get(failure.orderId)
      return `${order?.orderNumber ?? failure.orderId}: ${failure.message}`
    }),
    ...outcome.skippedErrors,
  ]
  return {
    queued: outcome.queued,
    failed: outcome.failed + proofPass.failures.length,
    printed,
    printAttempted,
    errors,
  }
}
