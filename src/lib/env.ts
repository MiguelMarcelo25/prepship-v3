import 'dotenv/config';
import { z } from 'zod';

const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue;
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    });

const optionalBooleanFlag = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  });

// On Vercel/Lambda serverless functions (e.g. /api/carriers/*) the Render-only
// Supabase ADMIN secrets are not provisioned — those functions only need
// DATABASE_URL (+ their own request-time auth). Hard-requiring them there made
// loading the db/connector tree call process.exit(1) below, which surfaces as an
// uncatchable FUNCTION_INVOCATION_FAILED. In serverless, don't require them (the
// label path never uses them); the long-running Render server stays strict.
const isServerless = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_REGION,
);
const renderOnlySecret = isServerless ? z.string().default('') : z.string().min(1);

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: renderOnlySecret,
  SUPABASE_SERVICE_ROLE_KEY: renderOnlySecret,
  SUPABASE_JWT_SECRET: renderOnlySecret,
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Audit 4.6 (PL-11): stop admission immediately, then give active API
  // requests most of Render's termination window to finish before force-close.
  API_GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(25_000),
  // A single escaped background failure remains observable and survivable, but
  // repeated escapes indicate poisoned process state and request a supervisor restart.
  API_UNCAUGHT_FAILURE_LIMIT: z.coerce.number().int().min(1).max(100).default(3),
  WEB_ORIGIN: z.string().optional(),
  // Public base URL of this API. Used when we need to emit an absolute link
  // back to the frontend (e.g. mock label PDFs opened via window.open).
  PUBLIC_API_URL: z.string().url().optional(),
  CRON_SECRET: z.string().optional(),
  // PS-128/PS-129: inbound store/marketplace webhook ingestion. Shared HMAC secret for
  // the public POST /webhooks/:provider route; per-provider overrides take precedence
  // (e.g. SHOPIFY_WEBHOOK_SECRET). When unset, the route rejects all events (fail-safe).
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  // Shopify direct store polling (client-submitted store accounts promoted by
  // operators). Default OFF: deploys never start pulling client stores until DJ
  // flips this canary in the target environment.
  SHOPIFY_SYNC_ENABLED: booleanFlag(false),
  SHIPSTATION_WEBHOOK_SECRET: z.string().optional(),
  WALMART_WEBHOOK_SECRET: z.string().optional(),
  EBAY_WEBHOOK_SECRET: z.string().optional(),
  // PS-128: how the pre-label safety guard treats a HIGH-RISK but UNVERIFIABLE source row
  // (e.g. a Walmart-origin order with no store linkage we can confirm). 'audit_only'
  // (default) logs a would-block but lets the label proceed; 'enforce' hard-blocks before
  // postage. Definite signals (local cancelled/shipped, trusted upstream cancel/ship
  // event, externally_shipped) ALWAYS hard-block regardless of this policy.
  SHIPPING_SAFETY_UNVERIFIED_POLICY: z.enum(['audit_only', 'enforce']).default('audit_only'),
  // Max inbound webhook body size (bytes) before rejection.
  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_000_000),
  DB_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  DB_POOL_MAX: z.coerce.number().int().positive().max(20).default(4),
  DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
  // Audit 1.9 (2026-07-13, read-only incident hardening): max lifetime of a
  // pooled connection before postgres.js recycles it. Role-level GUC defaults
  // (e.g. Supabase's default_transaction_read_only=on during a disk event) are
  // captured at CONNECT time — a session opened inside such a window stays
  // read-only after the window lifts. postgres.js's default recycle is a random
  // 30-60 min; 15 min bounds how long a poisoned session can linger.
  DB_MAX_LIFETIME_SECONDS: z.coerce.number().int().positive().default(900),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(8),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  // Audit PL-8 (2026-07-13): the inventory-deduction kill switch now flows through
  // validated env. OLD semantics (fulfillment-deductions.ts): only the exact strings
  // false/0/off/no disabled it — any typo ('fasle', 'disabled') silently left
  // auto-deduction ON, i.e. the documented emergency lockdown could appear engaged
  // while inert. booleanFlag semantics: unset -> true (unchanged default); only
  // true/1/yes enable — so a typo now fails TOWARD the switch's purpose (deductions
  // off) instead of silently ignoring the operator. Resolved value is logged at
  // first use by fulfillment-deductions.ts.
  INVENTORY_AUTO_DEDUCT: booleanFlag(true),
  STRICT_JWT_CLAIMS: booleanFlag(false),
  // Runtime split controls. Default RUN_SYNC_SCHEDULER=true keeps legacy API
  // deploys working until Render envs are explicitly flipped during rollout.
  RUN_SYNC_SCHEDULER: booleanFlag(true),
  WORKER_PLACEHOLDER: booleanFlag(false),
  RUN_ORDERS_PERFORMANCE_MAINTENANCE: optionalBooleanFlag,
  // PS-256 (durable worker-status events): when ON, worker heartbeat/job/staleness
  // events are appended to a durable, append-only worker_status_events table so a
  // restart no longer erases the operator-visible history of worker liveness (e.g.
  // "worker was stuck 14:32-15:17"). Default OFF — a safe canary; the OFF path is a
  // true no-op (no DB, no schema ensure). DJ flips this on Render after a canary.
  WORKER_STATUS_EVENTS_DURABLE: booleanFlag(false),
  // PS-256 (restart-safe print-queue merged PDF): when ON, the already-generated merged
  // batch-label PDF is persisted to a durable print_queue_merged_pdfs table and rehydrated on
  // an in-memory miss, so the view/download/signed-url routes can still serve the batch after a
  // server restart (today the bytes live only in process memory and a restart 404s them).
  // Default OFF — a safe canary; the OFF path is a true no-op (no DB, no schema ensure). DJ flips
  // this on Render after a canary. Stores/reads the immutable PDF artifact only — never
  // re-generates labels, buys postage, or mutates shipped/cancelled orders or shipments.
  DURABLE_PRINT_QUEUE_PDF: booleanFlag(false),
  ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER: booleanFlag(false),
  ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY: booleanFlag(false),
  // Per user override unlock shipped data on 2026-06-27: the automatic
  // external-shipped classifier must cover the Orders table's Last 30 Days
  // shipped/cancelled views, not only the 7-day steady-state window, so older
  // cancelled marketplace labels do not require manual cleanup.
  EXTERNAL_SHIPPED_CLASSIFIER_LOOKBACK_DAYS: z.coerce.number().int().min(30).max(90).default(30),
  // Tracking-driven print-queue retirement (delivered → History). Two-stage
  // rollout mirroring the pair above: the SCHEDULER flag turns polling on
  // (observe-only — shipment_tracking_status fills, panel shows status, queue
  // untouched); AUTO_RETIRE additionally lets a carrier-confirmed delivery move
  // a queued entry to 'delivered'. Both default OFF; unsetting AUTO_RETIRE is
  // the instant kill-switch.
  ENABLE_SHIPMENT_TRACKING_SCHEDULER: booleanFlag(false),
  TRACKING_AUTO_RETIRE_ENABLED: booleanFlag(false),
  // PS-200 S3: daily Walmart selling-fee sync, relocated from the legacy
  // Vercel cron (09:00 UTC). Defaults ON — unlike the dark-rollout flags
  // above, this is EXISTING production behavior moving homes, so the flag is
  // a kill-switch, not an opt-in. Unset to stop the daily pull.
  ENABLE_WALMART_FEES_SCHEDULER: booleanFlag(true),
  PG_BOSS_SCHEMA: z.string().min(1).default('pgboss'),
  PG_BOSS_POOL_MAX: z.coerce.number().int().positive().max(5).default(1),
  SHIPSTATION_API_KEY: z.string().optional(),
  SHIPSTATION_API_SECRET: z.string().optional(),
  SHIPSTATION_API_KEY_V2: z.string().optional(),
  SHIP_FROM_NAME: z.string().optional(),
  SHIP_FROM_COMPANY: z.string().optional(),
  SHIP_FROM_STREET1: z.string().optional(),
  SHIP_FROM_STREET2: z.string().optional(),
  SHIP_FROM_CITY: z.string().optional(),
  SHIP_FROM_STATE: z.string().optional(),
  SHIP_FROM_POSTAL_CODE: z.string().optional(),
  SHIP_FROM_COUNTRY: z.string().default('US'),
  SHIP_FROM_PHONE: z.string().optional(),
  ENABLE_RATE_BACKFILL_SCHEDULER: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  DISABLE_RATE_BACKFILL_SCHEDULER: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  // Audit 5.2: optional advisory-only local tariff calibration. The durable
  // worker schedule is OFF by default because enabling it performs bounded,
  // read-only live quote calls. It never participates in official Best Rate.
  ENABLE_LOCAL_TARIFF_CALIBRATION_SCHEDULER: booleanFlag(false),
  LOCAL_TARIFF_CALIBRATION_DESTINATIONS: z.string().default('94105,80202,60601,10001'),
  LOCAL_TARIFF_CALIBRATION_WEIGHTS_OZ: z.string().default('16,32,80'),
  LOCAL_TARIFF_CALIBRATION_MAX_PROBES: z.coerce.number().int().min(1).max(40).default(20),
  // PS-271 (Layer 2): 60s per-carrier union cache for direct-carrier rates (the additive
  // backstop for Shipp's non-deterministic thin response — see #1502/HUGRAB). When ON, live
  // direct-carrier rates are unioned with fresh-cached rows (live-wins-per-carrier) so a thin
  // pass that drops UPS still surfaces the recently-cached UPS, and each live rate is written
  // back best-effort. Default OFF — the OFF path is a TRUE no-op (no DB, no schema ensure) and
  // is byte-identical to today's ShipStation-only cache. DJ flips this on Render after a canary.
  DIRECT_CARRIER_RATE_CACHE: booleanFlag(false),
  // PS-271 (Layer 2): cache + negative-memory cooldown TTL in seconds (default 60s). The cooldown
  // (Layer 1 guardrail) is keyed (account_id, lane fingerprint, carrier_code) and lives in the same
  // direct_carrier_rate_cache table (durable, survives both worker processes); it bounds how often a
  // missing observed carrier triggers a re-quote. Kept >= the order-sync cadence so a phantom retry
  // can't fire fleet-wide. Only consulted when DIRECT_CARRIER_RATE_CACHE is ON.
  DIRECT_CARRIER_RATE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  DIRECT_CARRIER_QUOTE_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(180),
  // Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears
  // stale pgboss active rows only, never shipped/cancelled order/shipment data.
  // PS-272: default-OFF "stuck-active pgboss job reaper". When ON, a boot + 10-min reaper flips
  // orphaned pgboss 'active' rows (worker died mid-job during a Render redeploy; pg-boss's
  // expireInMinutes reap didn't fire) to 'failed' so the heavy syncs can drain their 'created'
  // backlog. Allow-list is idempotent sync/reporting/tracking jobs only — never marketplace
  // confirmations, never order/shipment data. Default OFF — the OFF path is a TRUE no-op (no DB, no
  // mutation). DJ flips this on Render.
  SYNC_STUCK_JOB_REAPER: booleanFlag(false),
  // PS-361: API-side shipment-sync watchdog. This is the independent control-plane observer for
  // the failure where order sync stays fresh but shipment/label sync stalls, causing shipped rows
  // without shipment SOT records. It logs/exposes health by default; recovery is cooldown-bound and
  // restarts require SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS plus Render API credentials.
  SHIPMENT_SYNC_WATCHDOG_ENABLED: booleanFlag(true),
  SHIPMENT_SYNC_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SHIPMENT_SYNC_WATCHDOG_WORKER_STALE_SECONDS: z.coerce.number().int().positive().default(5 * 60),
  SHIPMENT_SYNC_WATCHDOG_ORDER_FRESH_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  SHIPMENT_SYNC_WATCHDOG_SHIPMENT_STALE_SECONDS: z.coerce.number().int().positive().default(30 * 60),
  SHIPMENT_SYNC_WATCHDOG_ACTIVE_JOB_STUCK_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  SHIPMENT_SYNC_WATCHDOG_QUEUE_BACKLOG_THRESHOLD: z.coerce.number().int().nonnegative().default(5),
  SHIPMENT_SYNC_WATCHDOG_QUEUE_BACKLOG_CHECKS: z.coerce.number().int().positive().default(2),
  SHIPMENT_SYNC_WATCHDOG_MISSING_COUNT_THRESHOLD: z.coerce.number().int().nonnegative().default(5),
  SHIPMENT_SYNC_WATCHDOG_MISSING_RATE_THRESHOLD: z.coerce.number().positive().max(1).default(0.25),
  SHIPMENT_SYNC_WATCHDOG_RECENT_HOURS: z.coerce.number().int().positive().default(24),
  SHIPMENT_SYNC_WATCHDOG_RECOVERY_COOLDOWN_MS: z.coerce.number().int().positive().default(5 * 60_000),
  SHIPMENT_SYNC_WATCHDOG_NO_PROGRESS_RESTART_MS: z.coerce.number().int().positive().default(20 * 60_000),
  SHIPMENT_SYNC_WATCHDOG_RESTART_COOLDOWN_MS: z.coerce.number().int().positive().default(15 * 60_000),
  SHIPMENT_SYNC_WATCHDOG_MAX_RESTARTS_PER_HOUR: z.coerce.number().int().nonnegative().default(2),
  SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS: booleanFlag(false),
  SHIPMENT_SYNC_WATCHDOG_RENDER_SERVICE_ID: z.string().optional(),
  RENDER_WORKER_SERVICE_ID: z.string().optional(),
  RENDER_SERVICE_ID: z.string().optional(),
  RENDER_API_KEY: z.string().optional(),
  // PS-279/PS-359: default-OFF backend diagnostics/canary endpoint for the
  // Send-to-Queue route decision. Live Send-to-Queue no longer depends on a
  // frontend delegation flag; the backend create/recover job owns routing.
  // When OFF the route-plan endpoint is INERT (503 FEATURE_DISABLED before any
  // work — no DB, no provider, no postage).
  PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false),
  // Dedicated Print Queue worker rollout. API enqueue is separate from worker
  // consumption so the service can be deployed dark, then canaried without
  // changing the operator's Print to Queue workflow.
  PRINT_QUEUE_WORKER_ENABLED: booleanFlag(true),
  RUN_PRINT_QUEUE_WORKER: booleanFlag(false),
  PRINT_QUEUE_WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),
  // PS-306 (A1, money path): default-OFF. When ON with backend orchestration, a
  // direct-carrier order that still needs a label routes to the BACKEND create job instead of
  // the FE 'direct-create' buy, because createLabelV2 already buys direct-carrier labels
  // server-side. This only ever turns a 'direct-create' into a 'backend' route (it can never
  // create a new buy), so OFF is byte-identical and the buy still happens exactly once.
  PRINT_QUEUE_DIRECT_VIA_BACKEND: booleanFlag(false),
  // Batch-print pipeline (docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md):
  // the BATCH_PRINT_VIA_QUEUE rollout flag was retired 2026-07-07 after DJ's live canary —
  // the batch "Create + Print Label" chain is now the unconditional path (legacy loop deleted).
  // Per user override unlock shipped data on 2026-07-07: merge-job label fetch concurrency
  // (batch-print pipeline design). Default 1 = at most one fetch in flight, walked in merge
  // order — today's serial behavior on the wire. DJ raises to ~4 on Render after a canary
  // Print All. Read-only label fetch mechanics — never postage, never a shipped/cancelled
  // mutation.
  PRINT_QUEUE_MERGE_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  // PS-312 (combined-shipment keystone, shipped-data path): default-OFF canary. When ON, after the
  // operator's existing flow buys the ONE label for a bundle PRIMARY, createLabelV2 stamps the shared
  // label facts (tracking/carrier/service/url/shipment ids/package) onto the bundle's additive
  // shipment_bundles row so its child orders resolve to the primary's real tracking instead of
  // "Shipment sync error" — the keystone the bill-once / deduct-once / confirm-per-child policies all
  // gate on (they no-op while the bundle is still 'draft'). OFF is byte-identical: no bundle is ever
  // stamped, no extra query/write happens. Buys no postage; never UPDATEs shipments or shipped order
  // rows (linkBundleShipment writes ONLY the additive bundle sidecar, with its own no-regression
  // guard). DJ canaries on Render after a live combined-shipment buy. Per user override unlock shipped
  // data on 2026-06-24.
  BUNDLE_LINK_ON_LABEL: booleanFlag(false),
  // PS-312 (combined-shipment deduct-once, shipped-data/inventory path): default-OFF canary. A bundle
  // has ONE label (on the primary), so the per-label inventory trigger deducts only the primary and
  // UNDER-deducts the children. REQUIRES BUNDLE_LINK_ON_LABEL: when both are ON, deductBundleMembersOnce
  // is CHAINED right after the link stamp in the SAME background task (so it always sees the bundle as
  // 'labeled' and can never race the stamp into a silent under-deduct), and deducts every OTHER member
  // exactly once — reusing the SAME locked deductInventoryForOrder owner UNCHANGED (still gated by
  // INVENTORY_AUTO_DEDUCT, still idempotent via the per-(orderId,inventoryId) ship-ledger). OFF (or with
  // BUNDLE_LINK_ON_LABEL OFF) is byte-identical: no extra deduction. Buys no postage; never marks orders
  // shipped. DJ canaries on Render with BOTH flags on. Per user override unlock shipped data on 2026-06-24.
  BUNDLE_DEDUCT_ONCE: booleanFlag(false),
  // PS-312 (combined-shipment bill-once, billing path): default-OFF canary. A bundle ships under ONE
  // label, so shipping + box are billed ONCE on the PRIMARY; each CHILD is suppressed and shown as a
  // $0 "Included — bundled with #<primary>" line (auditable, never inflates the invoice total). When
  // ON, generateLineItems loads the additive bundle read-model and delegates the per-order treatment to
  // the pure decideBundleBillingTreatment policy. OFF is byte-identical: the map is never loaded, every
  // order bills normally. Reads the bundle read-model + shipped rows only; NEVER UPDATEs shipped
  // orders/shipments (it only emits derived $0 billing_line_items). Keyed per ORDER (no shared-shipment
  // coupling). DJ canaries on Render. Per user override unlock shipped data on 2026-06-24.
  BUNDLE_BILL_ONCE: booleanFlag(false),
  // PS-262 (money/liability path): default-OFF canary that generalizes the PS-262b
  // Walmart-Shipping safety fix — a DIRECT (non-ShipStation) carrier must resolve to
  // 'carrier' (it insures, audited) or 'blocked' (it can't), NEVER 'parcelguard'
  // (a ShipStation-only product a direct carrier can't actually buy, which would
  // silently ship the insured order UNINSURED). When OFF, resolveAccountInsuranceCapability
  // is BYTE-IDENTICAL to today (PS-262b Walmart block + PS-170 UPS gate + ParcelGuard
  // fallback). When ON, direct-only unambiguous codes (easypost/shipp/walmart_shipping/
  // ebay_shipping/amazon_shipping) map to carrier|blocked; ShipStation-brokered accounts
  // keep ParcelGuard unchanged. DJ flips this on Render after a canary.
  DIRECT_CARRIER_PARCELGUARD_FIX: booleanFlag(false),
  // PS-262 per-connector verify gates (DIRECT_CARRIER_PARCELGUARD_FIX only). Default OFF:
  // the audited-insuring direct connectors resolve to 'blocked' until proven, never to
  // 'carrier' (no under-charge) and never to 'parcelguard' (no silent-uninsured). Flip ON
  // once a read-only check (or DJ confirmation) proves the connector applies the insurance.
  EASYPOST_INSURANCE_VERIFIED: booleanFlag(false),
  SHIPP_INSURANCE_VERIFIED: booleanFlag(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const fieldErrors = parsed.error.flatten().fieldErrors;
  console.error('Invalid environment variables:');
  console.error(fieldErrors);
  // NEVER process.exit() in a serverless function — it kills the request with an
  // uncatchable FUNCTION_INVOCATION_FAILED. Throw so the caller's try/catch
  // returns a clean, actionable 500 listing the missing vars. The Render server
  // keeps fail-fast on startup.
  if (isServerless) {
    // PS-232: the missing-var NAMES are logged server-side above; do NOT echo them
    // in the thrown message (it surfaces in the client 500 body). Generic message.
    throw new Error('Server misconfigured: required environment variables are missing.');
  }
  process.exit(1);
}

export const env = parsed.data;
