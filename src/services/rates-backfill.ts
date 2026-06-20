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
} from './shipping-workflow/order-rate-job-status';
// #750 resilience: shared timeout + retry-on-timeout owner. The live Recalculate All re-rates every
// order with forceRefresh, so each fan-out queues behind the global rate limiter and the per-order
// timeout wrapped the QUEUE WAIT — under a 40+ order burst most orders timed out waiting for a permit.
import { runWithTimeoutAndRetry, withTimeout } from './with-timeout-retry';
// PS-293: the SHIPP house-tuple stamp owner shared with /rates/browse — the backfill previously
// persisted a tuple-LESS best rate for HUGRAB house orders, so which surface rated the row decided
// whether the House tuple appeared. Now both stamp it identically (default-OFF inert).
import { stampHouseTuple } from './shipping-workflow/house-tuple-stamp';

type ServiceTier = 'overnight' | 'two_day' | 'standard';

function classifyTier(code?: string | null): ServiceTier {
  if (!code) return 'standard';
  const c = code.toLowerCase();
  if (
    c.includes('next_day') ||
    c.includes('overnight') ||
    c.includes('priority_mail_express')
  ) {
    return 'overnight';
  }
  if (
    c.includes('2day') ||
    c.includes('2nd_day') ||
    c.includes('second_day')
  ) {
    return 'two_day';
  }
  return 'standard';
}

function pickBestForTier(rates: Rate[], tier: ServiceTier): Rate | null {
  const pool = tier === 'standard'
    ? rates
    : rates.filter((r) => classifyTier(r.service_code) === tier);
  // Fall back to all rates if no match in requested tier (customer gets
  // shipped something — cheapest-available beats nothing).
  const candidates = pool.length ? pool : rates;
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) => a.shipping_amount.amount - b.shipping_amount.amount
  )[0]!;
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
  failureSamples: string[];
  startedAt: number;
  finishedAt: number | null;
};

export type BackfillJobMode = 'manual_force_live' | 'cache_friendly';

type BackfillOptions = {
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
  failureSamples: string[];
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

const jobs = new Map<string, BackfillJob>();
let activeJobId: string | null = null;
let latestJobId: string | null = null;
const queuedBackfillRequests: QueuedBackfillRequest[] = [];

export function backfillJobModeForOptions(opts: BackfillOptions): BackfillJobMode {
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
    failureSamples: [...job.failureSamples],
    options: {
      clientId: opts.clientId,
      limit: opts.limit,
      maxAgeHours: opts.maxAgeHours,
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
  const parsed = JSON.parse(value) as BackfillJobSnapshot & { mode?: BackfillJobMode };
  return {
    ...parsed,
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
    failureSamples: [],
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

function startQueuedBackfillIfIdle(): void {
  const active = activeJobId ? jobs.get(activeJobId) : null;
  if (isActiveJob(active)) return;

  const next = queuedBackfillRequests.shift();
  if (!next) return;

  const job = jobs.get(next.jobId);
  if (!job) {
    startQueuedBackfillIfIdle();
    return;
  }

  activeJobId = job.jobId;
  job.message = 'Starting queued force-live backfill…';
  void persistBackfillJobSnapshot(job, next.opts);
  void runBackfill(job.jobId, next.opts);
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
  void runBackfill(job.jobId, opts);
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
    const liveRecalculate = opts.maxAgeHours === 0;
    // PS-121: when targeting a specific id set, bound the limit to that set.
    const targetedIds = opts.orderIds?.length ? opts.orderIds : null;
    const hardLimit = targetedIds
      ? Math.max(1, Math.min(targetedIds.length, 10000))
      : Math.max(1, Math.min(opts.limit ?? 5000, 10000));
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
          sql`${orders.weightOz} is not null and ${orders.weightOz} > 0`,
          sql`${orders.shipToPostalCode} is not null and ${orders.shipToPostalCode} <> ''`,
          or(needsRatePredicate, ineligibleSavedRatePredicate),
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
        weightOz: row.weightOz,
        shipToPostalCode: row.shipToPostalCode,
        shipToState: row.shipToState,
        shipToCity: row.shipToCity,
        rateDimsL: row.rateDimsL,
        rateDimsW: row.rateDimsW,
        rateDimsH: row.rateDimsH,
        raw: row.raw,
      });
    await Promise.all(
      rows.map(async (row) => {
        try {
          await setOrderRatePending(row.id, fingerprintForRow(row));
        } catch (err) {
          console.warn(
            '[rates-backfill] failed to set pending rate-job status:',
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );

    // #750: throttle the LIVE burst so 40+ forceRefresh orders don't starve each other for the global
    // rate-limiter's permits (the cause of the 30s queue-wait timeouts); passive sweeps keep 4.
    const CONCURRENCY = Math.max(1, Math.min(liveRecalculate ? LIVE_BACKFILL_CONCURRENCY : 4, RATE_FETCH_CONCURRENCY));
    // #750: the live path needs a larger per-order budget (it wraps the limiter queue wait), passive 30s.
    const perOrderTimeoutMs = liveRecalculate ? LIVE_PER_ORDER_TIMEOUT_MS : PER_ORDER_TIMEOUT_MS;
    const processOne = async (row: (typeof rows)[number]) => {
      if (jobs.get(jobId)?.status !== 'running') return;

      // PS-120 (producer): the job has PICKED this order up to rate it -> mark `rating`. The
      // FE classifier shows "actively rating" (calculating) for this row, bounded by the
      // bestRateStateAgeMs watchdog. Best-effort; never let a status write break rating.
      const jobFingerprint = computeOrderRateJobFingerprint({
        orderId: row.id,
        weightOz: row.weightOz,
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
        if (job.failureSamples.length < 5) {
          job.failureSamples.push(
            `order ${row.id} (${row.orderNumber}, w=${row.weightOz}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): missing real dimensions${eligibilityRefresh ? ' for PS-057 saved-rate refresh' : ''}`
          );
        }
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
          weightOz: Number(row.weightOz),
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
        // #750: retry a TIMED-OUT live fetch once — by the retry the initial burst has drained, so the
        // order that was stuck waiting for a limiter permit now gets its rate. Non-timeout errors throw
        // immediately (a real rate error is recorded honestly). Passive sweeps get no retry.
        const result = await runWithTimeoutAndRetry(
          () => getRates(rateInput, liveRecalculate ? { forceRefresh: true } : undefined),
          {
            timeoutMs: perOrderTimeoutMs,
            maxRetries: liveRecalculate ? LIVE_MAX_RETRIES : 0,
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
          }),
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
          if (job.failureSamples.length < 5) {
            job.failureSamples.push(
              `order ${row.id} (${row.orderNumber}, w=${row.weightOz}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): no rates returned`
            );
          }
        } else {
          const now = new Date();
          // PS-203 (stage 4): persist the RAW carrier amount, never the marked-up
          // charge. The display markup is applied at read time by the PS-177 row
          // money tuple — persisting marked amounts double-marked the display.
          const rawAmountBest: Record<string, unknown> = {
            ...best,
            ...(best.original_amount ? { shipping_amount: best.original_amount } : {}),
          };
          delete rawAmountBest.original_amount;
          delete rawAmountBest.markup;
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
          const { bestRate: finalizedBest } = await finalizeBestRateWithQuote({
            bestRate: rawAmountBest,
            rates: combined.combinedRates as Array<Record<string, unknown>>,
            cacheKey: combined.combinedRequestKey,
            bestRateComplete: combined.bestRateComplete,
            fetchedAt: result.fetchedAt,
          });
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
            ...finalizedBest,
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
            if (job.failureSamples.length < 5) {
              job.failureSamples.push(
                `order ${row.id} (${row.orderNumber}): kept cheaper fresh best (PS-271 no-downgrade) — re-quote was more expensive for the same inputs`
              );
            }
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
          }
        }
      } catch (err) {
        job.failed++;
        const msg = (err as Error).message ?? 'unknown';
        if (job.failureSamples.length < 5) {
          job.failureSamples.push(
            `order ${row.id} (w=${row.weightOz}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): ${msg.slice(0, 1500)}`
          );
        }
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
    if (activeJobId === jobId) activeJobId = null;
    startQueuedBackfillIfIdle();
  }
}
