import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders, orderOverrides } from '../db/schema/orders';
import { settings } from '../db/schema/settings';
import { CACHE_TTL_MS, RATE_FETCH_CONCURRENCY, getDirectCarrierRatesForRateInput, getRates } from './rates';
import { combineCarrierUniverses } from './rates-combined';
import {
  buildResidentialEvidenceFromOrder,
  residentialEvidenceRateInput,
} from './shipping-workflow/residential-evidence';
// PS-276 (slice 2b-2b): the live address-classification resolver (cache-or-USPS), env-gated OFF.
import { resolveAddressClassification } from './shipping-workflow/resolve-address-classification';
import {
  BACKEND_RATE_PROOF_SOURCE,
  finalizeBestRateWithQuote,
  selectedRateOpaqueKey,
} from './shipping-workflow/rate-quote-snapshot-store';
import { isPersistedBestDowngrade } from './best-rate-ratchet-db';
import type { Rate } from '../lib/shipstation';
import { EXCLUDED_STORE_IDS } from '../config/prepship';
import {
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  describeShippingService,
  evaluateShippingServiceEligibility,
} from '../lib/shipping-service-eligibility';
import {
  clearOrderRateJob,
  computeOrderRateJobFingerprint,
  setOrderRatePending,
  setOrderRateRating,
  touchPendingOrderRateJobs,
} from './shipping-workflow/order-rate-job-status';
// #750 resilience: shared timeout + retry-on-timeout owner. The live Recalculate All re-rates every
// order with forceRefresh, so each fan-out queues behind the global rate limiter and the per-order
// timeout wrapped the QUEUE WAIT — under a 40+ order burst most orders timed out waiting for a permit.
import { runWithTimeoutAndRetry, withTimeout } from './with-timeout-retry';
// PS-293: the SHIPP house-tuple stamp owner shared with /rates/browse — the backfill previously
// persisted a tuple-LESS best rate for HUGRAB house orders, so which surface rated the row decided
// whether the House tuple appeared. Now both stamp it identically (default-OFF inert).
import { stampHouseTuple } from './shipping-workflow/house-tuple-stamp';
import {
  RATE_PREEXPIRY_REFRESH_LEAD_MS,
  classifyRatePreExpiryRefresh,
  shouldPreExpiryRefreshRate,
} from './rate-preexpiry-refresh-policy';
import {
  createPreExpiryRefreshProof,
  recordPreExpiryRefreshResult,
  recordPreExpirySelection,
  type PreExpiryRefreshProof,
} from './rate-preexpiry-refresh-proof';
import {
  backfillUsesLiveRateBudget,
  buildBackfillRateFetchDecision,
  toGetRatesOptions,
} from './rate-preexpiry-refresh-request';
import { env } from '../lib/env';
import {
  resolveRateBackfillConcurrency,
  resolveRateBackfillDbWriteConcurrency,
} from './rate-backfill-execution-policy';
import {
  createRateBackfillDiagnosticBuffers,
  normalizeRateBackfillDiagnosticSamples,
  recordRateBackfillDiagnostic,
} from './rate-backfill-diagnostics';
import {
  addRateOnIngestOrderIds,
  takeRateOnIngestBatch,
} from './rate-on-ingest-queue';

async function runBackfillDbWrites<T>(
  items: readonly T[],
  write: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const concurrency = resolveRateBackfillDbWriteConcurrency(env.DB_POOL_MAX);
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        if (item !== undefined) await write(item);
      }
    },
  );
  await Promise.all(workers);
}

function toPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getBackfillOrderDims(row: {
  rateDimsL: number | null;
  rateDimsW: number | null;
  rateDimsH: number | null;
  raw: Record<string, unknown> | null;
}): { length: number; width: number; height: number } | null {
  const raw = row.raw ?? {};
  const rawDims = raw.dimensions && typeof raw.dimensions === 'object'
    ? raw.dimensions as Record<string, unknown>
    : {};
  const length = toPositiveNumber(row.rateDimsL) ?? toPositiveNumber(rawDims.length);
  const width = toPositiveNumber(row.rateDimsW) ?? toPositiveNumber(rawDims.width);
  const height = toPositiveNumber(row.rateDimsH) ?? toPositiveNumber(rawDims.height);
  if (length == null || width == null || height == null) return null;
  return { length, width, height };
}

function getBackfillOrderWeightOz(row: {
  rateWeightOz?: number | null;
  weightOz: number | null;
}): number | null {
  return toPositiveNumber(row.rateWeightOz) ?? toPositiveNumber(row.weightOz);
}

function savedBestRateNeedsEligibilityRefresh(row: {
  clientId: number | null;
  storeId: number | null;
  bestRateJson: unknown;
}): boolean {
  if (!row.bestRateJson) return false;
  return !evaluateShippingServiceEligibility(
    { clientId: row.clientId, storeId: row.storeId },
    describeShippingService(row.bestRateJson),
  ).allowed;
}

export type BackfillJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  mode: BackfillJobMode;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  error: string | null;
  skipSamples: string[];
  failureSamples: string[];
  preExpiryRefresh: PreExpiryRefreshProof | null;
  startedAt: number;
  finishedAt: number | null;
};

export type BackfillJobMode = 'manual_force_live' | 'cache_friendly';

type BackfillOptions = {
  mode?: 'cache_first' | 'full_live_audit' | 'preexpiry_refresh';
  clientId?: number;
  limit?: number;
  maxAgeHours?: number;
  // PS-121: targeted recalc — restrict the backfill to exactly these awaiting order ids
  // (e.g. the SKU+qty-combo siblings whose dims/weight just changed via an explicit default
  // save). The awaiting_shipment lockdown filter is ALWAYS kept, so shipped/cancelled ids
  // passed here are silently dropped — never re-rated.
  orderIds?: number[];
};

type QueuedBackfillRequest = {
  jobId: string;
  opts: BackfillOptions;
  mode: BackfillJobMode;
};

export const RATE_BACKFILL_STATUS_KEY = 'rate_backfill_best_rates.last_run';
export const RATE_BACKFILL_JOB_STATUS_KEY_PREFIX = 'rate_backfill_best_rates.job.';

export type BackfillJobSnapshot = {
  version: 1;
  durableKey: typeof RATE_BACKFILL_STATUS_KEY;
  jobId: string;
  status: BackfillJob['status'];
  mode: BackfillJobMode;
  active: boolean;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  error: string | null;
  skipSamples: string[];
  failureSamples: string[];
  preExpiryRefresh: PreExpiryRefreshProof | null;
  options: BackfillOptions;
  startedAt: string;
  finishedAt: string | null;
  persistedAt: string;
};

const PER_ORDER_TIMEOUT_MS = 30_000;
// #750 resilience (live Recalculate All): the live path re-rates EVERY awaiting order with forceRefresh
// (no cache), so each order's carrier fan-out queues behind the global rate limiter
// (RATE_FETCH_CONCURRENCY). The 30s per-order cap wrapped that queue wait, so a 40+ order burst timed
// out 37/43 orders waiting for a permit (single Browse Rate works fine). Give the live path a larger
// budget + ONE retry (the burst drains by the retry) and a smaller burst so orders stop starving each
// other. Passive/nightly sweeps (cache-allowed, fast) keep the 30s cap + no retry.
const LIVE_PER_ORDER_TIMEOUT_MS = 90_000;
const LIVE_MAX_RETRIES = 1;
const LIVE_BACKFILL_CONCURRENCY = 2;
// RC4: refresh queued 'pending' stamps this often so a large burst's waiting tail never ages past the
// /orders reader's stale-display window (RATE_JOB_STALE_MS = 6min) and flips to "Rate unavailable".
const PENDING_STAMP_HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes (< 6min reader window)

const jobs = new Map<string, BackfillJob>();
const backfillExecutionPromises = new Map<string, Promise<void>>();
let activeJobId: string | null = null;
let latestJobId: string | null = null;
const queuedBackfillRequests: QueuedBackfillRequest[] = [];
const queuedRateOnIngestOrderIds = new Set<number>();

export function enqueueBackfillBestRatesForOrderIds(orderIds: readonly number[]): number {
  const added = addRateOnIngestOrderIds(queuedRateOnIngestOrderIds, orderIds);
  if (added > 0) startQueuedBackfillIfIdle();
  return added;
}

export function backfillJobModeForOptions(opts: BackfillOptions): BackfillJobMode {
  if (opts.mode === 'full_live_audit') return 'manual_force_live';
  if (opts.mode === 'cache_first') return 'cache_friendly';
  if (opts.mode === 'preexpiry_refresh') return 'cache_friendly';
  return opts.maxAgeHours === 0 ? 'manual_force_live' : 'cache_friendly';
}

export function getBackfillJob(jobId: string): BackfillJob | null {
  return jobs.get(jobId) ?? null;
}

export function getActiveBackfillJob(): BackfillJob | null {
  return activeJobId ? (jobs.get(activeJobId) ?? null) : null;
}

export function getLatestBackfillJob(): BackfillJob | null {
  return latestJobId ? (jobs.get(latestJobId) ?? null) : null;
}

function toBackfillSnapshot(
  job: BackfillJob,
  opts: BackfillOptions,
): BackfillJobSnapshot {
  return {
    version: 1,
    durableKey: RATE_BACKFILL_STATUS_KEY,
    jobId: job.jobId,
    status: job.status,
    mode: job.mode,
    active: activeJobId === job.jobId && job.status === 'running',
    total: job.total,
    processed: job.processed,
    updated: job.updated,
    skipped: job.skipped,
    failed: job.failed,
    message: job.message,
    error: job.error,
    skipSamples: [...job.skipSamples],
    failureSamples: [...job.failureSamples],
    preExpiryRefresh: job.preExpiryRefresh
      ? {
          ...job.preExpiryRefresh,
          reasons: { ...job.preExpiryRefresh.reasons },
        }
      : null,
    options: {
      clientId: opts.clientId,
      limit: opts.limit,
      maxAgeHours: opts.maxAgeHours,
      mode: opts.mode,
    },
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    persistedAt: new Date().toISOString(),
  };
}

function backfillJobStatusKey(jobId: string): string {
  return `${RATE_BACKFILL_JOB_STATUS_KEY_PREFIX}${jobId}`;
}

async function persistBackfillSnapshotAtKey(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({
      key,
      value,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value,
      },
    });
}

async function persistBackfillJobSnapshot(
  job: BackfillJob,
  opts: BackfillOptions,
): Promise<void> {
  try {
    const value = JSON.stringify(toBackfillSnapshot(job, opts));
    await Promise.all([
      persistBackfillSnapshotAtKey(RATE_BACKFILL_STATUS_KEY, value),
      persistBackfillSnapshotAtKey(backfillJobStatusKey(job.jobId), value),
    ]);
  } catch (err) {
    console.warn(
      '[rates-backfill] failed to persist durable status:',
      err instanceof Error ? err.message : err,
    );
  }
}

function parseBackfillJobSnapshot(value: string): BackfillJobSnapshot | null {
  const parsed = JSON.parse(value) as BackfillJobSnapshot & {
    mode?: BackfillJobMode;
    skipSamples?: unknown;
    failureSamples?: unknown;
  };
  return {
    ...parsed,
    ...normalizeRateBackfillDiagnosticSamples(parsed),
    mode: parsed.mode === 'manual_force_live' ? 'manual_force_live' : 'cache_friendly',
  };
}

async function readBackfillJobSnapshot(key: string): Promise<BackfillJobSnapshot | null> {
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    if (!row?.value) return null;
    return parseBackfillJobSnapshot(row.value);
  } catch (err) {
    console.warn(
      '[rates-backfill] failed to read durable status:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function getLatestBackfillJobSnapshot(): Promise<BackfillJobSnapshot | null> {
  return readBackfillJobSnapshot(RATE_BACKFILL_STATUS_KEY);
}

export async function getBackfillJobSnapshot(jobId: string): Promise<BackfillJobSnapshot | null> {
  const trimmed = String(jobId ?? '').trim();
  if (!trimmed) return null;
  return readBackfillJobSnapshot(backfillJobStatusKey(trimmed));
}

function createBackfillJob(opts: BackfillOptions, mode: BackfillJobMode, message = 'Starting…'): BackfillJob {
  const jobId = randomUUID();
  const job: BackfillJob = {
    jobId,
    status: 'pending',
    mode,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    message,
    error: null,
    ...createRateBackfillDiagnosticBuffers(),
    preExpiryRefresh: opts.mode === 'preexpiry_refresh' ? createPreExpiryRefreshProof() : null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(jobId, job);
  latestJobId = jobId;
  return job;
}

function isActiveJob(job: BackfillJob | null | undefined): job is BackfillJob {
  return !!job && (job.status === 'pending' || job.status === 'running');
}

function findQueuedManualForceLiveJob(): BackfillJob | null {
  const queued = queuedBackfillRequests.find((request) => request.mode === 'manual_force_live');
  return queued ? (jobs.get(queued.jobId) ?? null) : null;
}

function launchBackfillExecution(jobId: string, opts: BackfillOptions): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: expose the actual
  // backend rate execution lifetime so the durable worker lane cannot finish
  // while its database/provider work is still running in the background.
  let execution: Promise<void>;
  execution = runBackfill(jobId, opts).finally(() => {
    if (backfillExecutionPromises.get(jobId) === execution) {
      backfillExecutionPromises.delete(jobId);
    }
  });
  backfillExecutionPromises.set(jobId, execution);
  return execution;
}

export async function waitForBackfillJob(jobId: string): Promise<BackfillJob | null> {
  let executionJobId = jobId;
  const awaited = new Set<string>();
  while (!awaited.has(executionJobId)) {
    awaited.add(executionJobId);
    const execution = backfillExecutionPromises.get(executionJobId);
    if (execution) await execution;

    // runBackfill may start a queued force-live or rate-on-ingest request in its
    // finally block. Keep the durable lane until that chained execution settles.
    const active = activeJobId ? jobs.get(activeJobId) : null;
    if (!isActiveJob(active) || awaited.has(active.jobId)) break;
    executionJobId = active.jobId;
  }
  return jobs.get(jobId) ?? null;
}

function startQueuedBackfillIfIdle(): void {
  const active = activeJobId ? jobs.get(activeJobId) : null;
  if (isActiveJob(active)) return;

  const next = queuedBackfillRequests.shift();
  if (next) {
    const job = jobs.get(next.jobId);
    if (!job) {
      startQueuedBackfillIfIdle();
      return;
    }

    activeJobId = job.jobId;
    job.message = 'Starting queued force-live backfill…';
    void persistBackfillJobSnapshot(job, next.opts);
    void launchBackfillExecution(job.jobId, next.opts);
    return;
  }

  const ingestOrderIds = takeRateOnIngestBatch(queuedRateOnIngestOrderIds);
  if (!ingestOrderIds.length) return;

  const opts: BackfillOptions = {
    mode: 'cache_first',
    orderIds: ingestOrderIds,
    limit: ingestOrderIds.length,
  };
  const job = createBackfillJob(
    opts,
    backfillJobModeForOptions(opts),
    'Starting rate-on-ingest backfill…',
  );
  activeJobId = job.jobId;
  void persistBackfillJobSnapshot(job, opts);
  void launchBackfillExecution(job.jobId, opts);
}

export function startBackfillBestRates(opts: BackfillOptions): BackfillJob {
  const requestedMode = backfillJobModeForOptions(opts);
  const active = activeJobId ? jobs.get(activeJobId) : null;
  if (isActiveJob(active)) {
    const activeMode = active.mode;
    if (requestedMode === 'manual_force_live' && activeMode === 'cache_friendly') {
      const existingQueued = findQueuedManualForceLiveJob();
      if (existingQueued) return existingQueued;

      const queuedJob = createBackfillJob(
        opts,
        requestedMode,
        'Manual force-live Recalculate All queued behind active cache-friendly backfill',
      );
      queuedBackfillRequests.push({ jobId: queuedJob.jobId, opts, mode: requestedMode });
      void persistBackfillJobSnapshot(queuedJob, opts);
      return queuedJob;
    }

    return active;
  }

  const job = createBackfillJob(opts, requestedMode);
  activeJobId = job.jobId;
  void persistBackfillJobSnapshot(job, opts);
  void launchBackfillExecution(job.jobId, opts);
  return job;
}

/**
 * PS-121 — targeted best-rate recalc for an explicit set of awaiting order ids (e.g. the
 * SKU+qty-combo siblings whose dims/weight just changed via an explicit "Save defaults").
 * Reuses the exact runBackfill engine — canonical getRates, the PS-120 pending/rating
 * producer, and the selected-rate proof/fingerprint write — only swapping the order
 * selection to `inArray(orders.id, …)`. The awaiting_shipment lockdown filter is retained,
 * so any shipped/cancelled/labelled ids are silently excluded (never re-rated).
 */
export function startBackfillBestRatesForOrderIds(
  orderIds: number[],
  opts?: { maxAgeHours?: number },
): BackfillJob | null {
  const ids = Array.from(new Set((orderIds ?? []).filter((n) => Number.isFinite(n) && n > 0)));
  if (!ids.length) return null;
  return startBackfillBestRates({ orderIds: ids, limit: ids.length, maxAgeHours: opts?.maxAgeHours });
}

async function runBackfill(
  jobId: string,
  opts: BackfillOptions
) {
  const job = jobs.get(jobId)!;
  job.status = 'running';
  job.message = 'Querying orders...';
  await persistBackfillJobSnapshot(job, opts);

  // PS-120 finalize: every selected row is stamped 'pending' up front, but processOne only clears the
  // rows the workers actually REACH. Rows past the cursor when the job stops/breaks/errors would stay
  // 'rating'/'pending' forever (the awaiting "infinite spinner"). Track the stamped set + the rows
  // processOne finalized, then clear the leftovers in the finally below.
  const finalizedIds = new Set<number>();
  let stampedIds: number[] = [];
  // RC4: keeps the queued 'pending' tail's updated_at fresh while the workers drain a large burst.
  let pendingHeartbeat: ReturnType<typeof setInterval> | null = null;

  try {
    const effectiveMaxAgeHours = opts.maxAgeHours ?? CACHE_TTL_MS / (60 * 60 * 1000);
    const staleCutoff = new Date(Date.now() - effectiveMaxAgeHours * 60 * 60 * 1000);
    // Recalculate All (maxAgeHours: 0) is an OPERATOR demand for current prices:
    // bypass the rate cache and live-fan-out every carrier, exactly like manual
    // Browse Rates with forceLive. Without this the job re-served cached rate
    // sets — a set cached while one carrier errored would "recalculate" to a
    // worse winner than a manual browse (the $13.00-vs-$11.66 class). Nightly /
    // passive sweeps (maxAgeHours unset or > 0) keep cache-allowed behavior so
    // they never hammer the carrier APIs.
    // PS-347: normal operator Recalculate All is cache-first. It reuses exact
    // current tuples and live-rates only misses/stale rows. Full Live Recalculate
    // audit is the explicit slow full-live path that bypasses cache.
    const liveRecalculate = opts.mode === 'full_live_audit' || opts.maxAgeHours === 0;
    // PS-121: when targeting a specific id set, bound the limit to that set.
    const targetedIds = opts.orderIds?.length ? opts.orderIds : null;
    const hardLimit = targetedIds
      ? Math.max(1, Math.min(targetedIds.length, 10000))
      : Math.max(1, Math.min(opts.limit ?? 5000, 10000));
    const preExpiryCutoffIso = new Date(Date.now() + RATE_PREEXPIRY_REFRESH_LEAD_MS).toISOString();
    const preExpiryRefreshPredicate = sql`(
      ${orderOverrides.bestRateJson} is not null
      and (
        case
          when nullif(${orderOverrides.bestRateJson}->>'cacheExpiresAt', '') is null then true
          when nullif(${orderOverrides.bestRateJson}->>'cacheExpiresAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
            then (nullif(${orderOverrides.bestRateJson}->>'cacheExpiresAt', ''))::timestamptz <= ${preExpiryCutoffIso}::timestamptz
          else true
        end
        or coalesce(${orderOverrides.bestRateJson}->>'isComplete', 'false') <> 'true'
        or nullif(${orderOverrides.bestRateJson}->>'proofSource', '') is distinct from 'backend_rate_response'
        or nullif(${orderOverrides.bestRateJson}->>'requestFingerprint', '') is null
        or nullif(${orderOverrides.bestRateJson}->>'cacheKey', '') is null
        or nullif(${orderOverrides.bestRateJson}->>'rateQuoteId', '') is null
        or nullif(${orderOverrides.bestRateJson}->>'selectedRateKey', '') is null
        or nullif(${orderOverrides.bestRateJson}->>'cShippingRateAmount', '') is null
        or nullif(${orderOverrides.bestRateJson}->>'selectedRateCost', '') is null
      )
    )`;
    const needsRatePredicate = staleCutoff
      ? or(isNull(orderOverrides.bestRateAt), lt(orderOverrides.bestRateAt, staleCutoff))
      : isNull(orderOverrides.bestRateAt);
    const ineligibleSavedRatePredicate = and(
      or(eq(orders.clientId, 4), eq(orders.storeId, 378060)),
      sql`${orderOverrides.bestRateJson} is not null`,
      sql`(
        ${orderOverrides.bestRateJson}::text ilike '%surepost%'
        or ${orderOverrides.bestRateJson}::text ilike '%ground saver%'
        or ${orderOverrides.bestRateJson}::text ilike '%ground_saver%'
      )`,
    );

    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        clientId: orders.clientId,
        storeId: orders.storeId,
        weightOz: orders.weightOz,
        rateWeightOz: orderOverrides.rateWeightOz,
        shipToPostalCode: orders.shipToPostalCode,
        shipToState: orders.shipToState,
        shipToCity: orders.shipToCity,
        serviceCode: orders.serviceCode,
        raw: orders.raw,
        shipToName: orders.shipToName,
        // PS-276: the operator's manual residential/commercial override — backfill must feed
        // this to the classifier the SAME way /rates/browse does (it previously did not, so a
        // manual commercial override was dropped: the #1585 $13.00-vs-$10.79 asymmetry).
        residentialOverride: orderOverrides.residential,
        bestRateJson: orderOverrides.bestRateJson,
        rateDimsL: orderOverrides.rateDimsL,
        rateDimsW: orderOverrides.rateDimsW,
        rateDimsH: orderOverrides.rateDimsH,
        overridesBestRateAt: orderOverrides.bestRateAt,
      })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .where(
        and(
          eq(orders.orderStatus, 'awaiting_shipment'),
          // PS-121: targeted recalc — never widens past awaiting_shipment (lockdown safe).
          targetedIds ? inArray(orders.id, targetedIds) : undefined,
          opts.clientId !== undefined
            ? eq(orders.clientId, opts.clientId)
            : undefined,
          notInArray(orders.storeId, [...EXCLUDED_STORE_IDS]),
          sql`coalesce(${orderOverrides.rateWeightOz}, ${orders.weightOz}) is not null and coalesce(${orderOverrides.rateWeightOz}, ${orders.weightOz}) > 0`,
          sql`${orders.shipToPostalCode} is not null and ${orders.shipToPostalCode} <> ''`,
          // A TARGETED re-rate (selected-package-id / save-dims / SKU defaults) explicitly demands
          // "re-rate these orders now": a dims/package change leaves a RECENT bestRateAt, so the
          // staleness predicate would wrongly skip it and the FE sits on a mismatched_request spinner
          // forever. Bypass staleness for targeted ids; the bulk/passive sweep (targetedIds null) keeps
          // it. The awaiting_shipment + inArray(orders.id, targetedIds) filters above are unchanged.
          targetedIds ? undefined : or(needsRatePredicate, preExpiryRefreshPredicate, ineligibleSavedRatePredicate),
          // Skip test-client orders — no real ShipStation rate calls for sandbox data.
          sql`not exists (select 1 from clients c where c.id = ${orders.clientId} and c.is_test = true)`
        )
      )
      .orderBy(desc(orders.orderDate))
      .limit(hardLimit);

    job.total = rows.length;
    job.message = `Found ${rows.length} orders; fetching rates…`;
    await persistBackfillJobSnapshot(job, opts);

    // PS-120 (producer): these orders are now ENQUEUED for backend rating. Stamp a per-order
    // `pending` state keyed by the shared job fingerprint so the Orders table can show "queued
    // for backend rating" instead of a generic spinner / a premature `missing`. Best-effort:
    // a status write must never break the actual rating, so failures are swallowed. The fields
    // come from the SAME columns the /orders reader has, so the fingerprints match.
    const fingerprintForRow = (row: (typeof rows)[number]): string =>
      computeOrderRateJobFingerprint({
        orderId: row.id,
        weightOz: getBackfillOrderWeightOz(row),
        shipToPostalCode: row.shipToPostalCode,
        shipToState: row.shipToState,
        shipToCity: row.shipToCity,
        rateDimsL: row.rateDimsL,
        rateDimsW: row.rateDimsW,
        rateDimsH: row.rateDimsH,
        raw: row.raw,
      });
    // Per user override unlock shipped data on 2026-07-14: do not enqueue
    // thousands of settings/status writes into postgres.js at once. Supabase's
    // transaction pooler wedges that client-side burst before the provider walk.
    await runBackfillDbWrites(
      rows,
      async (row) => {
        try {
          await setOrderRatePending(row.id, fingerprintForRow(row));
        } catch (err) {
          console.warn(
            '[rates-backfill] failed to set pending rate-job status:',
            err instanceof Error ? err.message : err,
          );
        }
      },
    );
    stampedIds = rows.map((row) => row.id);

    // RC4: while the workers drain the burst, keep the still-QUEUED 'pending' rows' updated_at fresh so a
    // large Recalculate All can't age its own waiting tail past the reader's 6-min window and flip those
    // rows to "Rate unavailable" before a worker reaches them. Only 'pending' rows are touched (never a
    // 'rating'/cleared row), and it's cleared in the finally. Harmless for small jobs (they finish first).
    pendingHeartbeat = setInterval(() => {
      void touchPendingOrderRateJobs(stampedIds).catch((err) =>
        console.warn('[rates-backfill] pending heartbeat failed:', err instanceof Error ? err.message : err),
      );
    }, PENDING_STAMP_HEARTBEAT_MS);

    const liveRateBudget = backfillUsesLiveRateBudget({ liveRecalculate, mode: opts.mode });
    // #750/PS-348: throttle live bursts so force-refresh orders do not starve each other for the global
    // rate-limiter's permits. PS-348 pre-expiry runs force live only for policy-selected non-fresh rows,
    // but the job still uses the live budget because those rows must push cacheExpiresAt forward.
    // Per user override unlock shipped data on 2026-07-14: production can run with
    // DB_POOL_MAX=1. Do not pipeline multiple background rate workflows through that
    // single application connection; a stalled rate read otherwise starves shipment
    // sync, fulfillment outbox, and worker-status persistence behind it.
    const configuredRateFetchConcurrency = liveRateBudget
      ? LIVE_BACKFILL_CONCURRENCY
      : RATE_FETCH_CONCURRENCY;
    const CONCURRENCY = resolveRateBackfillConcurrency({
      liveRateBudget,
      rateFetchConcurrency: configuredRateFetchConcurrency,
      dbPoolMax: env.DB_POOL_MAX,
    });
    // #750/PS-348: live paths need a larger per-order budget because this wraps the limiter queue wait.
    const perOrderTimeoutMs = liveRateBudget ? LIVE_PER_ORDER_TIMEOUT_MS : PER_ORDER_TIMEOUT_MS;
    const processOne = async (row: (typeof rows)[number]) => {
      if (jobs.get(jobId)?.status !== 'running') return;
      const preExpiryRefreshReason = shouldPreExpiryRefreshRate(row.bestRateJson, {
        refreshLeadMs: RATE_PREEXPIRY_REFRESH_LEAD_MS,
      })
        ? classifyRatePreExpiryRefresh(row.bestRateJson, { refreshLeadMs: RATE_PREEXPIRY_REFRESH_LEAD_MS })
        : 'fresh';
      const effectiveWeightOz = getBackfillOrderWeightOz(row);
      const weightLabel = effectiveWeightOz ?? row.weightOz;
      const recordPreExpiryOutcome = (
        after: unknown,
        updated: boolean,
        evidence?: { forceRefresh?: boolean; cached?: boolean },
      ) => {
        if (opts.mode !== 'preexpiry_refresh' || !job.preExpiryRefresh) return;
        recordPreExpiryRefreshResult(job.preExpiryRefresh, {
          before: row.bestRateJson,
          after,
          updated,
          forceRefresh: evidence?.forceRefresh,
          cached: evidence?.cached,
        });
      };
      if (opts.mode === 'preexpiry_refresh' && job.preExpiryRefresh) {
        recordPreExpirySelection(job.preExpiryRefresh, preExpiryRefreshReason);
      }

      // PS-120 (producer): the job has PICKED this order up to rate it -> mark `rating`. The
      // FE classifier shows "actively rating" (calculating) for this row, bounded by the
      // bestRateStateAgeMs watchdog. Best-effort; never let a status write break rating.
      const jobFingerprint = computeOrderRateJobFingerprint({
        orderId: row.id,
        weightOz: effectiveWeightOz,
        shipToPostalCode: row.shipToPostalCode,
        shipToState: row.shipToState,
        shipToCity: row.shipToCity,
        rateDimsL: row.rateDimsL,
        rateDimsW: row.rateDimsW,
        rateDimsH: row.rateDimsH,
        raw: row.raw,
      });
      try {
        await setOrderRateRating(row.id, jobFingerprint);
      } catch (err) {
        console.warn(
          '[rates-backfill] failed to set rating rate-job status:',
          err instanceof Error ? err.message : err,
        );
      }
      // PS-120: clear the in-progress row once this order's rate RESOLVES (saved, empty,
      // skipped, or errored) so a resolved order never lingers as pending/rating.
      const resolveRateJob = async () => {
        finalizedIds.add(row.id);
        try {
          await clearOrderRateJob(row.id);
        } catch (err) {
          console.warn(
            '[rates-backfill] failed to clear rate-job status:',
            err instanceof Error ? err.message : err,
          );
        }
      };

      const raw = (row.raw ?? {}) as Record<string, unknown> & {
        shipTo?: { country?: string; residential?: boolean };
        dimensions?: { length?: number; width?: number; height?: number; units?: string };
      };
      const toCountry = raw.shipTo?.country ?? 'US';
      const dims = getBackfillOrderDims(row);
      const eligibilityRefresh = savedBestRateNeedsEligibilityRefresh(row);
      if (!dims) {
        await resolveRateJob();
        job.skipped++;
        recordPreExpiryOutcome(null, false);
        recordRateBackfillDiagnostic(
          job,
          'skip',
          `order ${row.id} (${row.orderNumber}, w=${weightLabel}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): missing real dimensions${eligibilityRefresh ? ' for PS-057 saved-rate refresh' : ''}`
            + (preExpiryRefreshReason !== 'fresh' ? `; PS-348 refresh reason=${preExpiryRefreshReason}` : ''),
        );
        job.processed++;
        if (job.processed % 10 === 0 || job.processed === job.total) {
          job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed`;
        }
        if (job.processed % 50 === 0 || job.processed === job.total) {
          void persistBackfillJobSnapshot(job, opts);
        }
        return;
      }
      const dimsLabel = `${dims.length}x${dims.width}x${dims.height}`;
      try {
        // PS-276: build residential evidence through the SAME shared owner /rates/browse uses,
        // so the persisted BEST RATE column honors the manual override + source flag identically
        // to the live Rate Browser (residential: undefined lets the classifier's tiers attribute).
        // PS-276 (slice 2b-2b): resolve the address-validation evidence (cache-or-USPS), env-gated
        // ADDRESS_RESOLVER (OFF -> {} -> unchanged). SAME resolver /rates/browse uses, so the persisted
        // best rate and the live browse fingerprint stay identical on residential by construction.
        const backfillRawShipTo = (raw.shipTo ?? {}) as Record<string, unknown>;
        const backfillResolved = await resolveAddressClassification({
          street1: typeof backfillRawShipTo.street1 === 'string' ? backfillRawShipTo.street1 : null,
          city: row.shipToCity ?? null,
          state: row.shipToState ?? null,
          postalCode: row.shipToPostalCode ?? null,
          country: toCountry,
        });
        const residentialEvidence = buildResidentialEvidenceFromOrder({
          rawShipTo: raw.shipTo,
          manualOverrideResidential: row.residentialOverride,
          shipToName: row.shipToName,
          resolved: backfillResolved,
        });
        const rateInput = {
          weightOz: Number(effectiveWeightOz),
          toZip: row.shipToPostalCode!,
          toState: row.shipToState ?? undefined,
          toCity: row.shipToCity ?? undefined,
          toCountry,
          ...residentialEvidenceRateInput(residentialEvidence),
          dimsL: dims.length,
          dimsW: dims.width,
          dimsH: dims.height,
          storeId: row.storeId,
          clientId: row.clientId,
        };
        const rateFetchDecision = buildBackfillRateFetchDecision({
          liveRecalculate,
          mode: opts.mode,
          preExpiryRefreshReason,
        });
        // #750: retry a TIMED-OUT live fetch once — by the retry the initial burst has drained, so the
        // order that was stuck waiting for a limiter permit now gets its rate. Non-timeout errors throw
        // immediately (a real rate error is recorded honestly). Passive sweeps get no retry.
        const result = await runWithTimeoutAndRetry(
          // PS-350: this background backfill is lower-priority bulk work; manual Rate Browser
          // and Print Queue preflight attach to the backend job owner ahead of this lane.
          // PS-perf: the best-rate backfill is bulk BACKGROUND work — it yields ShipStation
          // budget + fan-out permits to interactive Browse Rates clicks (the limiter priority lane).
          () => getRates(rateInput, toGetRatesOptions(rateFetchDecision)),
          {
            timeoutMs: perOrderTimeoutMs,
            maxRetries: rateFetchDecision.forceRefresh ? LIVE_MAX_RETRIES : 0,
            label: `getRates(order=${row.id})`,
          },
        );
        // PS-203 (stage 4): the persisted best rate is the COMBINED winner —
        // visible direct carriers (Shipp / Walmart Shipping / direct UPS) join
        // the comparison through the same canonical owner /browse delegates to.
        // A wholesale direct-fetch failure marks the universe incomplete (a
        // synthetic failed diagnostic) instead of self-certifying SS-only.
        const directResult = await withTimeout(
          getDirectCarrierRatesForRateInput({
            ...rateInput,
            includeVisibleDirectCarriers: true,
            orderId: row.id,
            orderNumber: row.orderNumber ?? undefined,
          }, { priority: 'background' }),
          perOrderTimeoutMs,
          `getDirectCarrierRates(order=${row.id})`
        ).catch((err) => ({
          rates: [],
          errors: [],
          metas: [],
          diagnostics: [{
            carrierId: 'se-direct-fetch',
            carrierCode: 'direct',
            nickname: 'direct carriers',
            status: 'failed' as const,
            rateCount: 0,
            error: err instanceof Error ? err.message.slice(0, 200) : 'direct rate fetch failed',
          }],
        }));
        const combined = combineCarrierUniverses({
          ssRates: result.rates as unknown as Array<Record<string, unknown>>,
          ssCacheKey: result.cacheKey,
          ssCached: result.cached,
          ssDiagnostics: result.carrierDiagnostics ?? [],
          directRates: directResult.rates as unknown as Array<Record<string, unknown>>,
          directDiagnostics: directResult.diagnostics,
          requestedCarrierIds: null,
          accountNamesByCarrierId: new Map(),
          accountCarrierIds: (result.carrierDiagnostics ?? []).map((diagnostic) => diagnostic.carrierId),
          isCachedOnlyLookup: false,
        });
        const best = combined.cheapest;
        const secondBest = combined.secondCheapest;

        if (!best) {
          job.skipped++;
          recordPreExpiryOutcome(null, false, {
            forceRefresh: rateFetchDecision.forceRefresh,
            cached: result.cached,
          });
          recordRateBackfillDiagnostic(
            job,
            'skip',
            `order ${row.id} (${row.orderNumber}, w=${weightLabel}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): no rates returned`,
          );
        } else {
          const now = new Date();
          const rawAmountSecondBest: Record<string, unknown> | null = secondBest
            ? {
                ...secondBest,
                ...(secondBest.original_amount ? { shipping_amount: secondBest.original_amount } : {}),
              }
            : null;
          if (rawAmountSecondBest) {
            delete rawAmountSecondBest.original_amount;
            delete rawAmountSecondBest.markup;
          }
          // PS-174 (Phase 2): stamp the backend quote snapshot ref + proof marker —
          // the SAME finalization /rates/browse performs — so the persisted best
          // rate is snapshot-purchasable on reload without a re-browse. Best-effort
          // (a snapshot failure persists the rate without the ref; the purchase
          // boundary then requires a re-rate exactly as before PS-174).
          // PS-244: the finalizer now returns { bestRate, rates, rateQuoteId } (single owner shared
          // with /rates/browse); the backfill persists only the best rate.
          //
          // Audit R-1 (2026-07-13): finalize from the MARKED best — exactly like
          // /rates/browse — never from the raw-restored copy. The snapshot store
          // mints selectedRateKey from the object it is handed, while purchase
          // resolution recomputes keys from the snapshot's own (marked) rates:
          // minting from the raw-restored object meant the persisted best's key
          // resolved in NOBODY's snapshot for any marked-up carrier, so every
          // purchase of a backfill-persisted best failed
          // selected_rate_not_in_snapshot -> spurious "Rate changed or expired.
          // Re-rate this order". The PS-203 raw-amount rule still holds — the
          // raw restore is applied to the PERSISTED COPY below, after the key
          // was minted from the marked object.
          const { bestRate: finalizedBest } = await finalizeBestRateWithQuote({
            bestRate: best as unknown as Record<string, unknown>,
            rates: combined.combinedRates as Array<Record<string, unknown>>,
            cacheKey: combined.combinedRequestKey,
            bestRateComplete: combined.bestRateComplete,
            fetchedAt: result.fetchedAt,
          });
          // PS-203 (stage 4): persist the RAW carrier amount, never the marked-up
          // charge. The display markup is applied at read time by the PS-177 row
          // money tuple — persisting marked amounts double-marked the display.
          // (Raw restore AFTER finalization: proof stamps survive the spread.)
          const persistedFinalizedBest: Record<string, unknown> = {
            ...finalizedBest,
            ...((finalizedBest as Record<string, unknown>).original_amount
              ? { shipping_amount: (finalizedBest as Record<string, unknown>).original_amount }
              : {}),
          };
          delete persistedFinalizedBest.original_amount;
          delete persistedFinalizedBest.markup;
          const secondBestRate =
            rawAmountSecondBest && combined.bestRateComplete
              ? {
                  ...rawAmountSecondBest,
                  selectedRateKey: selectedRateOpaqueKey(secondBest),
                  ...(finalizedBest.rateQuoteId ? { rateQuoteId: finalizedBest.rateQuoteId } : {}),
                  proofSource: BACKEND_RATE_PROOF_SOURCE,
                  requestFingerprint: combined.combinedRequestKey,
                  cacheKey: combined.combinedRequestKey,
                  cacheCreatedAt: result.fetchedAt,
                  cacheExpiresAt: new Date(new Date(result.fetchedAt).getTime() + CACHE_TTL_MS).toISOString(),
                  eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
                  isComplete: combined.bestRateComplete,
                  rateCount: combined.combinedRates.length,
                  matchType: result.cached ? 'exact' : 'live',
                }
              : null;
          const bestWithMetadata = {
            ...persistedFinalizedBest,
            secondBestRate,
            requestFingerprint: combined.combinedRequestKey,
            cacheKey: combined.combinedRequestKey,
            cacheCreatedAt: result.fetchedAt,
            cacheExpiresAt: new Date(new Date(result.fetchedAt).getTime() + CACHE_TTL_MS).toISOString(),
            eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
            // PS-111/PS-203: completeness over the COMBINED universe.
            isComplete: combined.bestRateComplete,
            rateCount: combined.combinedRates.length,
            matchType: result.cached ? 'exact' : 'live',
          };
          // PS-293: stamp the SHIPP house tuple via the SAME owner /rates/browse uses, so a HUGRAB
          // house order rated by the backfill carries nextBestNonHouseRate/houseMargin identically to
          // the live Rate Browser (default-OFF inert: non-SHIPP winner / non-opted-in client => the
          // best rate is returned unchanged). The added fields don't affect the no-downgrade total.
          const stampedBest = await stampHouseTuple(bestWithMetadata as Record<string, unknown>, {
            cheapest: best,
            combinedRates: combined.combinedRates,
            clientId: row.clientId,
            storeId: row.storeId,
            insuranceProvider: (result as { effectiveInsuranceProvider?: string | null }).effectiveInsuranceProvider ?? null,
            insuredValue: (result as { effectiveInsuredValue?: number | null }).effectiveInsuredValue ?? null,
          });
          // PS-271: no-downgrade ratchet (automated persist site). Keep a CHEAPER fresh best for the
          // SAME shipment inputs (same requestFingerprint) instead of overwriting it with a thin Shipp
          // re-quote that dropped UPS/USPS; a different fingerprint (inputs changed) or a cheaper-or-
          // equal incoming always overwrites. The operator's deliberate FE save is a separate path.
          if (await isPersistedBestDowngrade(row.id, stampedBest)) {
            job.skipped++;
            recordPreExpiryOutcome(stampedBest, false, {
              forceRefresh: rateFetchDecision.forceRefresh,
              cached: result.cached,
            });
            recordRateBackfillDiagnostic(
              job,
              'skip',
              `order ${row.id} (${row.orderNumber}): kept cheaper fresh best (PS-271 no-downgrade) — re-quote was more expensive for the same inputs`,
            );
          } else {
            await db
              .insert(orderOverrides)
              .values({
                orderId: row.id,
                bestRateJson: stampedBest as unknown,
                bestRateDims: dimsLabel,
                bestRateAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: orderOverrides.orderId,
                set: {
                  bestRateJson: stampedBest as unknown,
                  bestRateDims: dimsLabel,
                  bestRateAt: now,
                  updatedAt: now,
                },
              });
            job.updated++;
            recordPreExpiryOutcome(stampedBest, true, {
              forceRefresh: rateFetchDecision.forceRefresh,
              cached: result.cached,
            });
          }
        }
      } catch (err) {
        job.failed++;
        recordPreExpiryOutcome(null, false);
        const msg = (err as Error).message ?? 'unknown';
        recordRateBackfillDiagnostic(
          job,
          'failure',
          `order ${row.id} (w=${weightLabel}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): ${msg.slice(0, 1500)}`,
        );
      } finally {
        // PS-120: the rate attempt RESOLVED (saved, empty/no-rate, or errored) — clear the
        // in-progress row so the order shows its terminal state (fresh/missing/blocked) and
        // never lingers as pending/rating. On error the FE watchdog (bestRateStateAgeMs) is
        // the backstop, but clearing here is the deterministic path.
        await resolveRateJob();
      }

      job.processed++;
      if (job.processed % 10 === 0 || job.processed === job.total) {
        job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed`;
      }
      if (job.processed % 50 === 0 || job.processed === job.total) {
        void persistBackfillJobSnapshot(job, opts);
      }
    };

    let idx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (idx < rows.length) {
        const i = idx++;
        if (jobs.get(jobId)?.status !== 'running') break;
        await processOne(rows[i]!);
      }
    });
    await Promise.all(workers);

    job.status = 'done';
    job.finishedAt = Date.now();
    job.message = `Done — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed (of ${job.total})`;
    await persistBackfillJobSnapshot(job, opts);
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
    job.message = `Error: ${job.error}`;
    job.finishedAt = Date.now();
    await persistBackfillJobSnapshot(job, opts);
  } finally {
    if (pendingHeartbeat) {
      clearInterval(pendingHeartbeat);
      pendingHeartbeat = null;
    }
    if (activeJobId === jobId) activeJobId = null;
    // PS-120 finalize: clear every stamped row the workers didn't reach (timeout / error / early-stop)
    // so no order is left 'rating'/'pending' forever after the job ends. Best-effort + idempotent
    // (clearOrderRateJob is DELETE WHERE order_id); never throw out of runBackfill.
    try {
      const leftover = stampedIds.filter((id) => !finalizedIds.has(id));
      if (leftover.length) {
        await runBackfillDbWrites(leftover, async (id) => {
          try {
            await clearOrderRateJob(id);
          } catch {
            // Best-effort cleanup; the age-based reaper remains the backstop.
          }
        });
      }
    } catch (err) {
      console.warn('[rates-backfill] finalize sweep failed:', err instanceof Error ? err.message : err);
    }
    startQueuedBackfillIfIdle();
  }
}
