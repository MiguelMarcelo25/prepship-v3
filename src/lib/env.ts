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
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(8),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
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
  USE_PG_BOSS_SCHEDULER: booleanFlag(true),
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
  // PS-279: default-OFF backend ownership of the Send-to-Queue ROUTE decision (the
  // money-path direct-buy-vs-backend-job ladder, ported from the FE classifier into
  // src/services/print-queue/queue-route-orchestrator.ts). When ON, the new
  // POST /print-queue/route-plan route returns the server-computed route plan so the
  // FE can delegate instead of owning the decision. When OFF the route is INERT (503
  // FEATURE_DISABLED before any work — no DB, no provider, no postage) and the existing
  // /batch-send path is byte-identical to today. The FE buy-path cutover is DEFERRED to
  // a DJ canary; DJ flips this on Render after route-plan reads parity-equal on a live order.
  PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false),
  // PS-279: separate, deliberate switch for the FE buy-path cutover. Decoupled
  // from PRINT_QUEUE_BACKEND_ORCHESTRATION (which only makes the /route-plan
  // endpoint live) so enabling the endpoint never auto-activates the money-path
  // FE delegation. Flip this ON only AFTER canarying a test label.
  PRINT_QUEUE_FE_DELEGATION: booleanFlag(false),
  // PS-306 (A1, money path): default-OFF. When ON — together with the two flags above — a
  // direct-carrier order that still needs a label routes to the BACKEND create job instead of
  // the FE 'direct-create' buy, because createLabelV2 already buys direct-carrier labels
  // server-side. This only ever turns a 'direct-create' into a 'backend' route (it can never
  // create a new buy), so OFF is byte-identical and the buy still happens exactly once.
  PRINT_QUEUE_DIRECT_VIA_BACKEND: booleanFlag(false),
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
