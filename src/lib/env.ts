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
