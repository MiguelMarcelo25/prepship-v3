// PS-166 (Wave 1a): the persistent queue-job localStorage machinery, moved
// VERBATIM out of OrdersView.tsx (module-level pure helpers — no hooks, no
// JSX, no behavior change). This module is strict TypeScript; OrdersView's
// @ts-nocheck no longer covers this code.
//
// PS-176 part 2 (preserved contract): the persisted job carries IDENTIFIERS
// ONLY — never money payloads (rates/proof/label URLs). Resume re-reads
// everything fresh from the backend; localStorage holds no purchase
// authority. The ps-176 guard pins createQueueOrderSnapshot's
// identifiers-only shape HERE.
import type { OrderSummaryDto } from '../../types/api'

export type PersistentQueueJobKind = 'existing-labels' | 'batch-queue'

export interface PersistentQueueOrderRef {
  orderId: number
  orderNumber?: string | null
  clientId?: number | null
  orderStatus?: string | null
}

export interface PersistentQueueJob {
  id: string
  kind: PersistentQueueJobKind
  orders: PersistentQueueOrderRef[]
  completedOrderIds: number[]
  failedOrderIds: number[]
  total: number
  label: string
  batchTestMode?: boolean
  backendJobId?: string
  createdAt: number
  updatedAt: number
}

const QUEUE_ACTION_JOB_STORAGE_KEY = 'prepship.queueActionJob.v1'
const QUEUE_ACTION_JOB_MAX_AGE_MS = 30 * 60 * 1000
export const QUEUE_UI_YIELD_MS = 25
let persistentQueueJobCache: PersistentQueueJob | null | undefined

// PS-176 part 2: persist IDENTIFIERS ONLY. The old snapshot carried full money
// payloads (bestRate/selectedRate/label) into localStorage and the resume loop
// rebuilt label purchases from them — stale frontend money authority. Resume
// now re-reads everything fresh from the backend, so nothing here can buy.
export function createQueueOrderSnapshot(order: OrderSummaryDto): PersistentQueueOrderRef {
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber ?? null,
    clientId: order.clientId ?? null,
    orderStatus: order.orderStatus ?? null,
  }
}

export function readPersistentQueueJob(): PersistentQueueJob | null {
  if (persistentQueueJobCache !== undefined) return persistentQueueJobCache
  try {
    const raw = window.localStorage.getItem(QUEUE_ACTION_JOB_STORAGE_KEY)
    if (!raw) {
      persistentQueueJobCache = null
      return null
    }
    const job = JSON.parse(raw) as PersistentQueueJob
    if (!job?.id || !Array.isArray(job.orders)) {
      persistentQueueJobCache = null
      return null
    }
    if (Date.now() - (job.updatedAt || job.createdAt || 0) > QUEUE_ACTION_JOB_MAX_AGE_MS) {
      window.localStorage.removeItem(QUEUE_ACTION_JOB_STORAGE_KEY)
      persistentQueueJobCache = null
      return null
    }
    persistentQueueJobCache = {
      ...job,
      completedOrderIds: Array.isArray(job.completedOrderIds) ? job.completedOrderIds : [],
      failedOrderIds: Array.isArray(job.failedOrderIds) ? job.failedOrderIds : [],
      total: Math.max(job.total || job.orders.length, 1),
    }
    return persistentQueueJobCache
  } catch {
    persistentQueueJobCache = null
    return null
  }
}

export function writePersistentQueueJob(job: PersistentQueueJob) {
  persistentQueueJobCache = job
  try {
    window.localStorage.setItem(QUEUE_ACTION_JOB_STORAGE_KEY, JSON.stringify({ ...job, updatedAt: Date.now() }))
  } catch {
    // Progress persistence is best-effort; the queue action itself should continue.
  }
}

export function clearPersistentQueueJob(jobId?: string | null) {
  try {
    if (!jobId) {
      window.localStorage.removeItem(QUEUE_ACTION_JOB_STORAGE_KEY)
      persistentQueueJobCache = null
      return
    }
    const current = readPersistentQueueJob()
    if (!current || current.id === jobId) {
      window.localStorage.removeItem(QUEUE_ACTION_JOB_STORAGE_KEY)
      persistentQueueJobCache = null
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function createPersistentQueueJob(
  kind: PersistentQueueJobKind,
  orders: OrderSummaryDto[],
  options: { label?: string; batchTestMode?: boolean } = {},
): PersistentQueueJob {
  const now = Date.now()
  const job: PersistentQueueJob = {
    id: `${now}:${Math.random().toString(36).slice(2)}`,
    kind,
    orders: orders.map(createQueueOrderSnapshot),
    completedOrderIds: [],
    failedOrderIds: [],
    total: Math.max(orders.length, 1),
    label: options.label ?? 'Sending to queue',
    batchTestMode: options.batchTestMode,
    createdAt: now,
    updatedAt: now,
  }
  writePersistentQueueJob(job)
  return job
}

export function yieldToBrowser(delay = QUEUE_UI_YIELD_MS) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delay))
}

export function markPersistentQueueJobOrder(jobId: string | null | undefined, orderId: number, failed: boolean) {
  if (!jobId) return
  const job = readPersistentQueueJob()
  if (!job || job.id !== jobId) return

  const completed = new Set(job.completedOrderIds)
  const failedSet = new Set(job.failedOrderIds)
  completed.delete(orderId)
  failedSet.delete(orderId)
  if (failed) failedSet.add(orderId)
  else completed.add(orderId)

  writePersistentQueueJob({
    ...job,
    completedOrderIds: [...completed],
    failedOrderIds: [...failedSet],
  })
}

export function attachPersistentQueueBackendJob(jobId: string | null | undefined, backendJobId: string | null | undefined) {
  if (!jobId || !backendJobId) return
  const job = readPersistentQueueJob()
  if (!job || job.id !== jobId) return
  writePersistentQueueJob({
    ...job,
    backendJobId,
  })
}

export function getPersistentQueueJobProgress(job: PersistentQueueJob) {
  const completed = (job.completedOrderIds?.length ?? 0) + (job.failedOrderIds?.length ?? 0)
  return {
    label: job.label || 'Sending to queue',
    completed: Math.min(job.total, completed),
    failed: job.failedOrderIds?.length ?? 0,
    total: Math.max(job.total || job.orders.length, 1),
  }
}
