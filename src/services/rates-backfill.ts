import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders, orderOverrides } from '../db/schema/orders';
import { packages } from '../db/schema/packages';
import { settings } from '../db/schema/settings';
import {
  CACHE_TTL_MS,
  RATE_FETCH_CONCURRENCY,
  getDirectCarrierRatesForRateInput,
  getRates,
  resolveRateInput,
} from './rates';
import { combineCarrierUniverses } from './rates-combined';
import {
  buildResidentialEvidenceFromOrder,
  residentialEvidenceRateInput,
} from './shipping-workflow/residential-evidence';
// PS-276 (slice 2b-2b): the live address-classification resolver (cache-or-USPS), env-gated OFF.
import { resolveAddressClassification } from './shipping-workflow/resolve-address-classification';
import { isPoBoxAddress } from './shipping-workflow/address-classification';
import {
  BACKEND_RATE_PROOF_SOURCE,
  finalizeBestRateWithQuote,
  selectedRateOpaqueKey,
} from './shipping-workflow/rate-quote-snapshot-store';
import { persistBestRateWithRatchet } from './best-rate-ratchet-db';
import type { Rate } from '../lib/shipstation';
import {
  createRateSignatureCacheMetrics,
  rateSourcesArePurchaseProofEligible,
  recordRateSignatureCacheLookup,
  type RateSignatureCacheMetrics,
} from './shipping-workflow/rate-signature-cache-policy';
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
import { getDefaultShipFrom } from '../lib/ship-from';
import { normalizeShippingOptions } from '../lib/shipping-options';
import { resolveOutboundPackageSelection } from './package-consumption';
import { resolveCarrierRecipientName } from './carrier-recipient-name';
import { getDefaultLocation } from './locations';
import {
  normalizeShippingQuoteAddress,
  shippingProviderIdFromAuthorizedRate,
  type ShippingQuoteAuthorizationContext,
} from './shipping-workflow/shipping-quote-authorization';
import { shipStationQuoteAccountAuthorizations } from './shipping-workflow/quote-account-authorization';
import {
  resolveRateBackfillConcurrency,
  resolveRateBackfillDbWriteConcurrency,
} from './rate-backfill-execution-policy';
import { awaitSettledWork } from '../lib/sync-job-cancellation';
import { stampRateSourceDisplay } from './rate-source-display';
import {
  createRateBackfillDiagnosticBuffers,
  normalizeRateBackfillDiagnosticSamples,
  recordRateBackfillDiagnostic,
} from './rate-backfill-diagnostics';
import { enqueueDurableRateBackfillJob } from './rate-backfill-job-producer';
import type {
  DurableRateBackfillJobPayload,
  RateBackfillCursor,
  RateBackfillOptions,
  RateBackfillRequestSource,
} from './rate-backfill-job-types';

export const RATE_BACKFILL_DURABLE_CHUNK_SIZE = 2;
export const RATE_BACKFILL_GENERATION_STATUS_KEY_PREFIX = 'rate_backfill_best_rates.generation.';
export const RATE_BACKFILL_CADENCE_GENERATION_STATUS_KEY =
  'rate_backfill_best_rates.cadence_generation';

type BackfillExecutionContext = {
  signal?: AbortSignal;
  cursor?: RateBackfillCursor | null;
  selectionLimit?: number;
  targetOffset?: number;
  durableChunk?: boolean;
};

export type BackfillChunkOutcome = {
  hasMore: boolean;
  nextCursor: RateBackfillCursor | null;
  advanced: number;
};

export type DurableRateBackfillGenerationState = {
  version: 1;
  generationId: string;
  requestedBy: RateBackfillRequestSource;
  status: 'active' | 'complete';
  currentChunkIndex: number;
  currentJobId: string;
  nextPayload: DurableRateBackfillJobPayload | null;
  lastError: string | null;
  updatedAt: string;
};

function assertBackfillCanContinue(
  jobId: string,
  signal: AbortSignal | undefined,
  label: string,
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`${label} aborted`);
  }
  const job = jobs.get(jobId);
  if (!job || activeJobId !== jobId || job.status !== 'running') {
    throw new Error(`rate backfill generation ${jobId} is no longer current before ${label}`);
  }
}

async function runBackfillDbWrites<T>(
  items: readonly T[],
  write: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let index = 0;
  const concurrency = resolveRateBackfillDbWriteConcurrency(env.DB_POOL_MAX);
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        signal?.throwIfAborted();
        const item = items[index++];
        if (item !== undefined) await write(item);
        signal?.throwIfAborted();
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
  raw: unknown;
}): boolean {
  if (!row.bestRateJson) return false;
  const rawShipTo = ((row.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
  return !evaluateShippingServiceEligibility(
    {
      clientId: row.clientId,
      storeId: row.storeId,
      destinationPoBox: isPoBoxAddress({
        street1: typeof rawShipTo.street1 === 'string' ? rawShipTo.street1 : null,
        street2: typeof rawShipTo.street2 === 'string' ? rawShipTo.street2 : null,
        country: typeof rawShipTo.country === 'string' ? rawShipTo.country : null,
      }),
    },
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
  signatureCache: RateSignatureCacheMetrics;
  startedAt: number;
  finishedAt: number | null;
};

export type BackfillJobMode = 'manual_force_live' | 'cache_friendly';

function signatureCacheSummary(metrics: RateSignatureCacheMetrics): string {
  return `signature cache ${metrics.fullHits}/${metrics.lookups} full hits (${metrics.hitRatePct}%), ${metrics.providerFetches} provider fetches`;
}

export type BackfillOptions = RateBackfillOptions & {
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
  signatureCache: RateSignatureCacheMetrics;
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
const backfillExecutionPromises = new Map<string, Promise<BackfillChunkOutcome>>();
const backfillChunkOutcomes = new Map<string, BackfillChunkOutcome>();
let activeJobId: string | null = null;
let latestJobId: string | null = null;
const MAX_COMPLETED_JOBS_IN_MEMORY = 25;

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
    active: job.status === 'pending' || job.status === 'running',
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
    signatureCache: { ...job.signatureCache },
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

function backfillGenerationStatusKey(generationId: string): string {
  return `${RATE_BACKFILL_GENERATION_STATUS_KEY_PREFIX}${generationId}`;
}

export function deterministicRateBackfillChunkJobId(
  generationId: string,
  chunkIndex: number,
): string {
  const hex = createHash('sha256')
    .update(`${generationId}:chunk:${chunkIndex}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function shouldCoalesceCadenceGeneration(
  state: DurableRateBackfillGenerationState | null,
  payload: DurableRateBackfillJobPayload,
): boolean {
  if (payload.requestedBy !== 'cadence' || (payload.chunkIndex ?? 0) !== 0) return false;
  const generationId = payload.generationId ?? payload.jobId;
  if (state?.status !== 'active') return false;
  if (state.generationId !== generationId) return true;
  // The exact persisted current chunk is a crash/retry resume, not a duplicate.
  // Only a stale first-chunk wake that the generation already advanced past
  // should join/re-admit the newer persisted continuation.
  return state.nextPayload !== null
    && state.nextPayload.jobId !== payload.jobId;
}

export function buildRateBackfillContinuation(
  payload: DurableRateBackfillJobPayload,
  outcome: BackfillChunkOutcome,
): DurableRateBackfillJobPayload | null {
  const generationId = payload.generationId ?? payload.jobId;
  const chunkIndex = Math.max(0, Math.trunc(payload.chunkIndex ?? 0));
  const totalLimit = Math.max(1, Math.min(payload.options.limit ?? 5_000, 10_000));
  const remainingLimit = Math.max(0, Math.min(payload.remainingLimit ?? totalLimit, totalLimit));
  const nextRemaining = Math.max(0, remainingLimit - outcome.advanced);
  if (!outcome.hasMore || nextRemaining <= 0) return null;
  return {
    ...payload,
    jobId: deterministicRateBackfillChunkJobId(generationId, chunkIndex + 1),
    generationId,
    chunkIndex: chunkIndex + 1,
    cursor: outcome.nextCursor,
    remainingLimit: nextRemaining,
    targetOffset: Math.max(0, Math.trunc(payload.targetOffset ?? 0)) + outcome.advanced,
  };
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

async function persistRateBackfillGenerationState(
  state: DurableRateBackfillGenerationState,
): Promise<void> {
  const value = JSON.stringify(state);
  const values = [
    {
      key: backfillGenerationStatusKey(state.generationId),
      value,
    },
    ...(state.requestedBy === 'cadence'
      ? [{
          key: RATE_BACKFILL_CADENCE_GENERATION_STATUS_KEY,
          value,
        }]
      : []),
  ];
  // The per-generation record and cadence pointer are one durable truth. A
  // single upsert prevents a crash between two writes from resuming an older
  // chunk after the generation already advanced.
  await db
    .insert(settings)
    .values(values)
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`excluded.value`,
      },
    });
}

async function readRateBackfillGenerationState(
  key: string,
): Promise<DurableRateBackfillGenerationState | null> {
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    if (!row?.value) return null;
    const state = JSON.parse(row.value) as Partial<DurableRateBackfillGenerationState>;
    if (
      state.version !== 1
      || typeof state.generationId !== 'string'
      || (state.status !== 'active' && state.status !== 'complete')
    ) {
      return null;
    }
    return state as DurableRateBackfillGenerationState;
  } catch (error) {
    console.warn(
      '[rates-backfill] failed to read durable generation state:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function getCadenceRateBackfillGenerationState(): Promise<DurableRateBackfillGenerationState | null> {
  return readRateBackfillGenerationState(RATE_BACKFILL_CADENCE_GENERATION_STATUS_KEY);
}

export async function getRateBackfillGenerationState(
  generationId: string,
): Promise<DurableRateBackfillGenerationState | null> {
  const trimmed = String(generationId ?? '').trim();
  if (!trimmed) return null;
  return readRateBackfillGenerationState(backfillGenerationStatusKey(trimmed));
}

export function backfillGenerationIsActive(
  jobId: string,
  generation: DurableRateBackfillGenerationState | null,
): boolean {
  return generation?.generationId === jobId && generation.status === 'active';
}

export function reconcileBackfillJobWithGeneration(
  job: BackfillJob,
  generation: DurableRateBackfillGenerationState | null,
): BackfillJob {
  if (!generation || !backfillGenerationIsActive(job.jobId, generation)) return job;
  return {
    ...job,
    status: 'running',
    message: `Durable rate generation continuing at chunk ${generation.currentChunkIndex + 1}`,
    error: null,
    finishedAt: null,
  };
}

export function reconcileBackfillSnapshotWithGeneration(
  snapshot: BackfillJobSnapshot,
  generation: DurableRateBackfillGenerationState | null,
): BackfillJobSnapshot {
  if (!generation || !backfillGenerationIsActive(snapshot.jobId, generation)) return snapshot;
  return {
    ...snapshot,
    status: 'running',
    active: true,
    message: `Durable rate generation continuing at chunk ${generation.currentChunkIndex + 1}`,
    error: null,
    finishedAt: null,
  };
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
    signatureCache?: RateSignatureCacheMetrics;
  };
  return {
    ...parsed,
    ...normalizeRateBackfillDiagnosticSamples(parsed),
    mode: parsed.mode === 'manual_force_live' ? 'manual_force_live' : 'cache_friendly',
    signatureCache: parsed.signatureCache ?? createRateSignatureCacheMetrics(),
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
  const snapshot = await readBackfillJobSnapshot(RATE_BACKFILL_STATUS_KEY);
  if (!snapshot) return null;
  const generation = await getRateBackfillGenerationState(snapshot.jobId);
  return reconcileBackfillSnapshotWithGeneration(snapshot, generation);
}

export async function getBackfillJobSnapshot(jobId: string): Promise<BackfillJobSnapshot | null> {
  const trimmed = String(jobId ?? '').trim();
  if (!trimmed) return null;
  const [snapshot, generation] = await Promise.all([
    readBackfillJobSnapshot(backfillJobStatusKey(trimmed)),
    getRateBackfillGenerationState(trimmed),
  ]);
  return snapshot
    ? reconcileBackfillSnapshotWithGeneration(snapshot, generation)
    : null;
}

function createBackfillJob(
  opts: BackfillOptions,
  mode: BackfillJobMode,
  message = 'Starting…',
  jobId: string = randomUUID(),
  registerInProcess = true,
): BackfillJob {
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
    signatureCache: createRateSignatureCacheMetrics(),
    startedAt: Date.now(),
    finishedAt: null,
  };
  if (registerInProcess) {
    jobs.set(jobId, job);
    latestJobId = jobId;
  }
  return job;
}

function pruneCompletedBackfillJobs(): void {
  const completed = [...jobs.values()]
    .filter((job) => job.status === 'done' || job.status === 'error')
    .sort((left, right) => right.startedAt - left.startedAt);
  for (const job of completed.slice(MAX_COMPLETED_JOBS_IN_MEMORY)) {
    if (job.jobId !== latestJobId) {
      jobs.delete(job.jobId);
      backfillChunkOutcomes.delete(job.jobId);
    }
  }
}

function isActiveJob(job: BackfillJob | null | undefined): job is BackfillJob {
  return !!job && (job.status === 'pending' || job.status === 'running');
}

function launchBackfillExecution(
  jobId: string,
  opts: BackfillOptions,
  context: BackfillExecutionContext = {},
): Promise<BackfillChunkOutcome> {
  // Per user override unlock shipped data on 2026-07-14: expose the actual
  // backend rate execution lifetime so the durable worker lane cannot finish
  // while its database/provider work is still running in the background.
  let execution: Promise<BackfillChunkOutcome>;
  execution = runBackfill(jobId, opts, context)
    .then((outcome) => {
      backfillChunkOutcomes.set(jobId, outcome);
      return outcome;
    })
    .finally(() => {
      if (backfillExecutionPromises.get(jobId) === execution) {
        backfillExecutionPromises.delete(jobId);
      }
    });
  backfillExecutionPromises.set(jobId, execution);
  return execution;
}

export async function waitForBackfillJob(jobId: string): Promise<BackfillJob | null> {
  const execution = backfillExecutionPromises.get(jobId);
  if (execution) await execution;
  return jobs.get(jobId) ?? null;
}

/** Worker-only execution entrypoint. External callers must use durable admission below. */
export function startBackfillBestRates(
  opts: BackfillOptions,
  jobId: string = randomUUID(),
  context: BackfillExecutionContext = {},
): BackfillJob {
  const requestedMode = backfillJobModeForOptions(opts);
  const active = activeJobId ? jobs.get(activeJobId) : null;
  if (isActiveJob(active)) return active;

  const job = createBackfillJob(opts, requestedMode, 'Starting…', jobId);
  activeJobId = job.jobId;
  void persistBackfillJobSnapshot(job, opts);
  void launchBackfillExecution(job.jobId, opts, context);
  return job;
}

export async function enqueueBackfillBestRates(
  opts: BackfillOptions,
  requestedBy: RateBackfillRequestSource = 'manual',
): Promise<BackfillJob> {
  const job = createBackfillJob(
    opts,
    backfillJobModeForOptions(opts),
    'Queued in durable rate-backfill lane',
    randomUUID(),
    false,
  );
  await persistBackfillJobSnapshot(job, opts);
  const payload: DurableRateBackfillJobPayload = {
    version: 1,
    jobId: job.jobId,
    generationId: job.jobId,
    chunkIndex: 0,
    cursor: null,
    remainingLimit: Math.max(1, Math.min(opts.limit ?? 5_000, 10_000)),
    targetOffset: 0,
    requestedAt: new Date().toISOString(),
    requestedBy,
    options: opts,
  };
  const admission = await enqueueDurableRateBackfillJob(payload);
  if (!admission.queued && !admission.deduplicated) {
    job.status = 'error';
    job.error = admission.error ?? 'durable rate-backfill admission failed';
    job.message = `Queue error: ${job.error}`;
    job.finishedAt = Date.now();
    await persistBackfillJobSnapshot(job, opts);
  }
  return job;
}

export async function runDurableRateBackfillJob(
  payload: DurableRateBackfillJobPayload,
  signal?: AbortSignal,
): Promise<BackfillJob | null> {
  signal?.throwIfAborted();
  const generationId = payload.generationId ?? payload.jobId;
  const chunkIndex = Math.max(0, Math.trunc(payload.chunkIndex ?? 0));

  // PS-436 cadence coalescing: a new cron/defer wake-up joins the one durable
  // active generation and re-admits its persisted next chunk instead of
  // starting another broad scan.
  if (payload.requestedBy === 'cadence' && chunkIndex === 0) {
    const cadence = await awaitSettledWork(
      readRateBackfillGenerationState(RATE_BACKFILL_CADENCE_GENERATION_STATUS_KEY),
      signal,
      'read cadence generation',
    );
    if (shouldCoalesceCadenceGeneration(cadence, payload)) {
      const nextPayload = cadence?.nextPayload ?? null;
      if (nextPayload) {
        const admission = await enqueueDurableRateBackfillJob(nextPayload);
        if (!admission.queued && !admission.deduplicated) {
          throw new Error(admission.error ?? 'failed to resume durable cadence generation');
        }
      }
      return null;
    }
  }

  const active = getActiveBackfillJob();
  if (active) {
    await awaitSettledWork(
      waitForBackfillJob(active.jobId),
      signal,
      `wait for active rate generation ${active.jobId}`,
    );
  }

  const totalLimit = Math.max(1, Math.min(payload.options.limit ?? 5_000, 10_000));
  const remainingLimit = Math.max(
    0,
    Math.min(payload.remainingLimit ?? totalLimit, totalLimit),
  );
  const targetOffset = Math.max(0, Math.trunc(payload.targetOffset ?? 0));
  const targetRemaining = payload.options.orderIds?.length
    ? Math.max(0, payload.options.orderIds.length - targetOffset)
    : remainingLimit;
  const selectionLimit = Math.min(
    RATE_BACKFILL_DURABLE_CHUNK_SIZE,
    remainingLimit,
    targetRemaining,
  );
  if (selectionLimit <= 0) return null;

  const runningState: DurableRateBackfillGenerationState = {
    version: 1,
    generationId,
    requestedBy: payload.requestedBy,
    status: 'active',
    currentChunkIndex: chunkIndex,
    currentJobId: payload.jobId,
    // Keep the current chunk resumable until its successor is durably written.
    // A worker crash between this write and completion can therefore re-admit
    // the same deterministic job instead of stranding an active generation.
    nextPayload: payload,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
  await persistRateBackfillGenerationState(runningState);
  signal?.throwIfAborted();

  const job = startBackfillBestRates(payload.options, generationId, {
    signal,
    cursor: payload.cursor ?? null,
    selectionLimit,
    targetOffset,
    durableChunk: true,
  });
  await waitForBackfillJob(job.jobId);
  const completed = getBackfillJob(job.jobId);
  if (!completed || completed.status === 'error') {
    await persistRateBackfillGenerationState({
      ...runningState,
      nextPayload: payload,
      lastError: completed?.error ?? 'rate backfill chunk did not complete',
      updatedAt: new Date().toISOString(),
    });
    throw new Error(completed?.error ?? 'rate backfill chunk did not complete');
  }

  const outcome = backfillChunkOutcomes.get(generationId) ?? {
    hasMore: false,
    nextCursor: null,
    advanced: completed.processed,
  };
  const nextPayload = buildRateBackfillContinuation(payload, outcome);

  await persistRateBackfillGenerationState({
    ...runningState,
    status: nextPayload ? 'active' : 'complete',
    nextPayload,
    lastError: null,
    updatedAt: new Date().toISOString(),
  });
  signal?.throwIfAborted();
  if (nextPayload) {
    const admission = await enqueueDurableRateBackfillJob(nextPayload);
    if (!admission.queued && !admission.deduplicated) {
      throw new Error(admission.error ?? 'failed to enqueue next durable rate chunk');
    }
  }
  return completed;
}

/**
 * PS-121 — targeted best-rate recalc for an explicit set of awaiting order ids (e.g. the
 * SKU+qty-combo siblings whose dims/weight just changed via an explicit "Save defaults").
 * Reuses the exact runBackfill engine — canonical getRates, the PS-120 pending/rating
 * producer, and the selected-rate proof/fingerprint write — only swapping the order
 * selection to `inArray(orders.id, …)`. The awaiting_shipment lockdown filter is retained,
 * so any shipped/cancelled/labelled ids are silently excluded (never re-rated).
 */
export async function enqueueBackfillBestRatesForOrderIds(
  orderIds: readonly number[],
  opts?: { maxAgeHours?: number },
  requestedBy: Exclude<RateBackfillRequestSource, 'manual' | 'cadence'> = 'targeted-order-change',
): Promise<BackfillJob | null> {
  const ids = Array.from(new Set((orderIds ?? []).filter((n) => Number.isFinite(n) && n > 0)));
  if (!ids.length) return null;
  return enqueueBackfillBestRates(
    { mode: 'cache_first', orderIds: ids, limit: ids.length, maxAgeHours: opts?.maxAgeHours },
    requestedBy,
  );
}

async function runBackfill(
  jobId: string,
  opts: BackfillOptions,
  context: BackfillExecutionContext = {},
): Promise<BackfillChunkOutcome> {
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
  let chunkOutcome: BackfillChunkOutcome = {
    hasMore: false,
    nextCursor: null,
    advanced: 0,
  };

  try {
    assertBackfillCanContinue(jobId, context.signal, 'order selection');
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
    const allTargetedIds = opts.orderIds?.length ? opts.orderIds : null;
    const targetOffset = Math.max(0, Math.trunc(context.targetOffset ?? 0));
    const targetedIds = allTargetedIds
      ? allTargetedIds.slice(
          targetOffset,
          targetOffset + Math.max(1, context.selectionLimit ?? allTargetedIds.length),
        )
      : null;
    const hardLimit = targetedIds
      ? Math.max(1, Math.min(context.selectionLimit ?? targetedIds.length, 10_000))
      : Math.max(1, Math.min(context.selectionLimit ?? opts.limit ?? 5_000, 10_000));
    const queryLimit = context.durableChunk && !targetedIds ? hardLimit + 1 : hardLimit;
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
        or nullif(${orderOverrides.bestRateJson}->>'selectionRef', '') is null
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

    // Per user override unlock shipped data on 2026-07-17 (PS-436): selection
    // remains awaiting-only. Await the actual DB promise so cancellation cannot
    // release the shared lane while a detached query still owns a pool socket.
    const selectedRows = await awaitSettledWork(db
      .select({
        id: orders.id,
        orderDate: orders.orderDate,
        orderNumber: orders.orderNumber,
        clientId: orders.clientId,
        storeId: orders.storeId,
        sourceProvider: orders.sourceProvider,
        sourceAccountId: orders.sourceAccountId,
        sourceOrderId: orders.sourceOrderId,
        customerEmail: orders.customerEmail,
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
          !targetedIds && context.cursor
            ? sql`(
                coalesce(${orders.orderDate}, 'epoch'::timestamptz),
                ${orders.id}
              ) < (
                ${context.cursor.beforeOrderDate}::timestamptz,
                ${context.cursor.beforeOrderId}
              )`
            : undefined,
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
      .orderBy(desc(sql`coalesce(${orders.orderDate}, 'epoch'::timestamptz)`), desc(orders.id))
      .limit(queryLimit), context.signal, 'rate backfill order query');

    assertBackfillCanContinue(jobId, context.signal, 'post-selection');
    const rows = context.durableChunk ? selectedRows.slice(0, hardLimit) : selectedRows;
    const lastRow = rows.at(-1);
    const lastOrderDate = lastRow?.orderDate instanceof Date
      ? lastRow.orderDate.toISOString()
      : lastRow?.orderDate
        ? new Date(lastRow.orderDate).toISOString()
        : new Date(0).toISOString();
    chunkOutcome = {
      hasMore: allTargetedIds
        ? targetOffset + hardLimit < allTargetedIds.length
        : Boolean(context.durableChunk && selectedRows.length > hardLimit),
      nextCursor: !allTargetedIds && lastRow
        ? { beforeOrderDate: lastOrderDate, beforeOrderId: lastRow.id }
        : null,
      advanced: allTargetedIds
        ? Math.min(hardLimit, Math.max(0, allTargetedIds.length - targetOffset))
        : rows.length,
    };

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
      context.signal,
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
      assertBackfillCanContinue(jobId, context.signal, `rate order ${row.id}`);
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
        shipTo?: { country?: string; residential?: boolean; street1?: string; street2?: string };
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
          job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed; ${signatureCacheSummary(job.signatureCache)}`;
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
        const backfillResolved = await awaitSettledWork(resolveAddressClassification({
          street1: typeof backfillRawShipTo.street1 === 'string' ? backfillRawShipTo.street1 : null,
          city: row.shipToCity ?? null,
          state: row.shipToState ?? null,
          postalCode: row.shipToPostalCode ?? null,
          country: toCountry,
        }), context.signal, `address classification for order ${row.id}`);
        assertBackfillCanContinue(jobId, context.signal, `post-address order ${row.id}`);
        const residentialEvidence = buildResidentialEvidenceFromOrder({
          rawShipTo: raw.shipTo,
          manualOverrideResidential: row.residentialOverride,
          shipToName: row.shipToName,
          resolved: backfillResolved,
        });
        const rateInput = {
          signal: context.signal,
          weightOz: Number(effectiveWeightOz),
          toZip: row.shipToPostalCode!,
          toState: row.shipToState ?? undefined,
          toCity: row.shipToCity ?? undefined,
          toCountry,
          toAddress: typeof backfillRawShipTo.street1 === 'string' ? backfillRawShipTo.street1 : undefined,
          toAddress2: typeof backfillRawShipTo.street2 === 'string' ? backfillRawShipTo.street2 : undefined,
          ...residentialEvidenceRateInput(residentialEvidence),
          dimsL: dims.length,
          dimsW: dims.width,
          dimsH: dims.height,
          storeId: row.storeId,
          clientId: row.clientId,
          orderId: row.id,
          orderNumber: row.orderNumber ?? null,
          sourceProvider: row.sourceProvider,
          sourceAccountId: row.sourceAccountId,
          rawOrder: row.raw,
        };
        const rateFetchDecision = buildBackfillRateFetchDecision({
          liveRecalculate,
          mode: opts.mode,
          preExpiryRefreshReason,
        });
        const resolvedRateInput = await resolveRateInput(rateInput, {
          priority: rateFetchDecision.priority,
        });
        // #750: retry a TIMED-OUT live fetch once — by the retry the initial burst has drained, so the
        // order that was stuck waiting for a limiter permit now gets its rate. Non-timeout errors throw
        // immediately (a real rate error is recorded honestly). Passive sweeps get no retry.
        // Durable chunks rely on cancellable provider deadlines plus the queue's
        // fail-closed handler deadline. Do not use a promise-race timeout that
        // can detach live rate/cache work before the shared lane is released.
        const shipStationWork = context.durableChunk
          ? getRates(resolvedRateInput, toGetRatesOptions(rateFetchDecision))
          : runWithTimeoutAndRetry(
              // PS-447: this batch backfill is lower-priority bulk work; manual Rate Browser
              // and Print Queue preflight attach to the backend job owner ahead of this lane.
              // stays interactive, while sync/polling remains in the background lane.
              (_attempt, signal) => getRates(
                { ...resolvedRateInput, signal },
                toGetRatesOptions(rateFetchDecision),
              ),
              {
                timeoutMs: perOrderTimeoutMs,
                maxRetries: rateFetchDecision.forceRefresh ? LIVE_MAX_RETRIES : 0,
                label: `getRates(order=${row.id})`,
                signal: context.signal,
              },
            );
        const result = await awaitSettledWork(
          shipStationWork,
          context.signal,
          `ShipStation rates for order ${row.id}`,
        );
        assertBackfillCanContinue(jobId, context.signal, `post-ShipStation rates order ${row.id}`);
        // PS-203 (stage 4): the persisted best rate is the COMBINED winner —
        // visible direct carriers (Shipp / Walmart Shipping / direct UPS) join
        // the comparison through the same canonical owner /browse delegates to.
        // A wholesale direct-fetch failure marks the universe incomplete (a
        // synthetic failed diagnostic) instead of self-certifying SS-only.
        // PS-350/PS-459: background backfill remains lower priority than manual Rate Browser and
        // Print Queue preflight, and cache-first exact-signature hits bypass provider work entirely.
        const directCarrierWork = getDirectCarrierRatesForRateInput({
            ...resolvedRateInput,
            includeVisibleDirectCarriers: true,
            orderId: row.id,
            orderNumber: row.orderNumber ?? undefined,
          }, {
            cacheFirst: !rateFetchDecision.forceRefresh,
            priority: 'batch',
          });
        const directResult = await (
          context.durableChunk
            ? awaitSettledWork(
                directCarrierWork,
                context.signal,
                `direct carrier rates for order ${row.id}`,
              )
            : withTimeout(
                directCarrierWork,
                perOrderTimeoutMs,
                `getDirectCarrierRates(order=${row.id})`,
              )
        ).catch((err) => ({
          rates: [],
          errors: [],
          metas: [],
          authorizationAccounts: [],
          providerFetches: 1,
          usedCachedRates: false,
          diagnostics: [{
            carrierId: 'se-direct-fetch',
            carrierCode: 'direct',
            nickname: 'direct carriers',
            status: 'failed' as const,
            rateCount: 0,
            error: err instanceof Error ? err.message.slice(0, 200) : 'direct rate fetch failed',
          }],
        }));
        assertBackfillCanContinue(jobId, context.signal, `post-direct rates order ${row.id}`);
        job.signatureCache = recordRateSignatureCacheLookup(job.signatureCache, {
          shipStationCached: result.cached,
          directCarrierCacheUsed: directResult.usedCachedRates,
          providerFetches: (result.cached ? 0 : 1) + directResult.providerFetches,
        });
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
          const packageSelection = await resolveOutboundPackageSelection({
            orderId: row.id,
            selectedPackageId: null,
            dimensions: dims,
          });
          const packageId = packageSelection.status === 'matched'
            ? packageSelection.packageId
            : null;
          const [packageRow] = packageId == null
            ? []
            : await db
                .select({ id: packages.id, type: packages.type, packageCode: packages.packageCode })
                .from(packages)
                .where(eq(packages.id, packageId))
                .limit(1);
          const rawShipTo = raw.shipTo && typeof raw.shipTo === 'object'
            ? raw.shipTo as Record<string, unknown>
            : {};
          const recipient = resolveCarrierRecipientName({
            name: typeof rawShipTo.name === 'string' ? rawShipTo.name : row.shipToName,
            company: typeof rawShipTo.company === 'string' ? rawShipTo.company : null,
            customerEmail: row.customerEmail,
          });
          const defaultLocation = await getDefaultLocation().catch(() => null);
          const shipFrom = resolvedRateInput.shipFrom ?? await getDefaultShipFrom();
          const options = normalizeShippingOptions(resolvedRateInput);
          const authorizationContext: ShippingQuoteAuthorizationContext = {
            version: 1,
            order: {
              orderId: row.id,
              clientId: row.clientId,
              storeId: row.storeId,
              sourceProvider: row.sourceProvider,
              sourceAccountId: row.sourceAccountId,
              sourceOrderId: row.sourceOrderId,
            },
            shipment: {
              shipFromLocationId: defaultLocation?.id ?? null,
              shipFrom: normalizeShippingQuoteAddress(shipFrom),
              shipTo: normalizeShippingQuoteAddress({
                ...rawShipTo,
                name: recipient.name,
                company: recipient.company,
                city: rawShipTo.city ?? row.shipToCity,
                state: rawShipTo.state ?? row.shipToState,
                postalCode: rawShipTo.postalCode ?? rawShipTo.postal_code ?? row.shipToPostalCode,
                country: rawShipTo.country ?? toCountry,
              }),
              package: {
                id: packageRow?.id ?? packageId,
                type: packageRow?.type ?? null,
                code: packageRow?.packageCode ?? null,
              },
              weightOz: Number(resolvedRateInput.weightOz),
              dimensions: dims,
              residential: resolvedRateInput.residential === true,
              confirmation: options.confirmation,
              insuranceProvider: options.insuranceProvider,
              insuredValue: Number(options.insuredValue ?? 0) || 0,
            },
          };
          const presentProviderIds = new Set(
            combined.combinedRates
              .map((rate) => shippingProviderIdFromAuthorizedRate(rate as Record<string, unknown>))
              .filter((id): id is number => id != null),
          );
          const authorizationAccounts = [
            ...shipStationQuoteAccountAuthorizations({
              rates: combined.combinedRates as Array<Record<string, unknown>>,
              clientId: resolvedRateInput.clientId ?? null,
              sourceClientId: resolvedRateInput.sourceClientId ?? null,
              apiKeyV2: resolvedRateInput.apiKeyV2 ?? null,
            }),
            ...(directResult.authorizationAccounts ?? []),
          ].filter((account, index, list) =>
            presentProviderIds.has(account.shippingProviderId)
            && list.findIndex((candidate) =>
              candidate.shippingProviderId === account.shippingProviderId
              && candidate.providerFamily === account.providerFamily,
            ) === index,
          );
          const quoteAuthorization = {
            context: authorizationContext,
            accounts: authorizationAccounts,
          };
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
          assertBackfillCanContinue(jobId, context.signal, `quote snapshot order ${row.id}`);
          const { bestRate: finalizedBest } = await finalizeBestRateWithQuote({
            bestRate: best as unknown as Record<string, unknown>,
            rates: combined.combinedRates as Array<Record<string, unknown>>,
            cacheKey: combined.combinedRequestKey,
            bestRateComplete: combined.bestRateComplete,
            fetchedAt: result.fetchedAt,
            purchaseProofEligible: rateSourcesArePurchaseProofEligible({
              shipStationCached: result.cached,
              directCarrierCacheUsed: directResult.usedCachedRates,
            }),
            authorization: quoteAuthorization,
          });
          assertBackfillCanContinue(jobId, context.signal, `post-quote snapshot order ${row.id}`);
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
              ? stampRateSourceDisplay({
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
                })
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
          // Backfill is a persisted-rate producer, so it must use the same
          // backend provenance owner as the live Rate Browser response.
          const sourceStampedBest = stampRateSourceDisplay(stampedBest as Record<string, unknown>);
          // PS-271: no-downgrade ratchet (automated persist site). Keep a CHEAPER fresh best for the
          // SAME shipment inputs (same requestFingerprint) instead of overwriting it with a thin Shipp
          // re-quote that dropped UPS/USPS; a different fingerprint (inputs changed) or a cheaper-or-
          // equal incoming always overwrites. The operator's deliberate FE save is a separate path.
          assertBackfillCanContinue(jobId, context.signal, `best-rate persistence order ${row.id}`);
          const persisted = await persistBestRateWithRatchet(row.id, {
            bestRateJson: sourceStampedBest,
            bestRateDims: dimsLabel,
            bestRateAt: now,
            updatedAt: now,
          });
          assertBackfillCanContinue(jobId, context.signal, `post-persistence order ${row.id}`);
          if (persisted.blocked) {
            job.skipped++;
            recordPreExpiryOutcome(sourceStampedBest, false, {
              forceRefresh: rateFetchDecision.forceRefresh,
              cached: result.cached,
            });
            recordRateBackfillDiagnostic(
              job,
              'skip',
              `order ${row.id} (${row.orderNumber}): kept cheaper fresh best (PS-271 no-downgrade) — re-quote was more expensive for the same inputs`,
            );
          } else {
            job.updated++;
            recordPreExpiryOutcome(sourceStampedBest, true, {
              forceRefresh: rateFetchDecision.forceRefresh,
              cached: result.cached,
            });
          }
        }
      } catch (err) {
        if (
          context.signal?.aborted
          || activeJobId !== jobId
          || jobs.get(jobId)?.status !== 'running'
        ) {
          throw err;
        }
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
        job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed; ${signatureCacheSummary(job.signatureCache)}`;
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
    job.message = `Done — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed (of ${job.total}); ${signatureCacheSummary(job.signatureCache)}`;
    console.info('[rates-backfill]', job.message);
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
    pruneCompletedBackfillJobs();
  }
  return chunkOutcome;
}
