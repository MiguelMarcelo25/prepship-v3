/**
 * PS-494 — the JOINED end-to-end request-body proof Hermes's audit demanded (finding 5),
 * re-audited 2026-08-21 (FAIL 82%) and closed here on all three remaining gaps:
 *
 *   gap 1  scenario 3 now proves a CONFIGURED operator default: the Shipp account's
 *          credentials carry packageOriginCountry 'CA', and the captured quote body must
 *          say exactly 'CA' — not the bare 'US' terminal fallback. Scenario 1 (single-KR)
 *          runs against the SAME account, so KR on the wire while the account default is
 *          CA is the STRONGER proof: a resolved origin beats the credential default.
 *   gap 2  scenario 5a no longer reconstructs the labels.ts selection locally. It drives
 *          the REAL purchase funnel — createLabelV2 -> createLabelV2Impl -> the fulfillment
 *          operation ledger -> the dispatch execute callback — until labels.ts:3043 itself
 *          evaluates `directProviderKey === 'shipp' ? resolveDeclaredShippOrigin() : null`
 *          and the lazy closure (labels.ts:2658) throws CustomsOriginUndeclarableError.
 *          The selectionRef it purchases with is minted by the PRODUCTION producers
 *          (resolveRateInput -> getDirectCarrierRatesForRateInput ->
 *          finalizeBestRateWithQuote), then the order's customs items drift to a mixed
 *          carton BEFORE purchase — the exact production race the label-side re-check
 *          exists for (rate proof seals rate identity, not customs items).
 *   gap 3  this file is enrolled in ps-032-connector-boundary-guard.mjs as a stubbed
 *          joined-proof harness: provider URLs below exist only in the fetch stub's
 *          allow-list, and any unexpected outbound URL throws.
 *
 * The five scenarios:
 *
 *   1. single-KR order       -> real browse -> exactly ONE Shipp /quote POST, body
 *                               packageLineItems[0].countryOfManufacture === 'KR' even
 *                               though the account's configured default is 'CA'
 *   2. mixed US/KR order     -> real browse -> ZERO provider HTTP, providerFetches === 0,
 *                               the refusal reason on the error + diagnostic
 *   3. unknown + domestic    -> real browse -> ONE /quote POST, body countryOfManufacture
 *                               === 'CA' (the CONFIGURED operator default: rates.ts:3116
 *                               passes null on the domestic-inert lane and the connector
 *                               applies creds.packageOriginCountry — shipp.ts:226-239)
 *   4. unknown + international -> real browse -> ZERO provider HTTP + the stated refusal.
 *                               The browse path has NO earlier international gate — the
 *                               PS-492 assertInternationalOriginationSupported gate is
 *                               labels-side only (labels.ts:2643); on browse the
 *                               customs-origin refusal at rates.ts:3081-3117 fires first.
 *   5a. label funnel parity  -> the REAL createLabelV2 on a production-minted selectionRef
 *                               refuses the drifted mixed carton with a 422
 *                               CustomsOriginUndeclarableError, ZERO provider HTTP, and
 *                               the external_operations row lands 'failed_pre_dispatch'
 *                               carrying the refusal reason (classifyBuyErrorForIntent
 *                               recognizes CUSTOMS_ORIGIN_UNDECLARABLE as provably
 *                               pre-purchase — the production fix this proof surfaced;
 *                               before it, the refusal was parked reconcile_required).
 *   5b. non-Shipp scoping    -> the same mixed-carton shape purchased through a direct
 *                               UPS account runs the REAL createDirectCarrierLabelForOrder
 *                               to the UPS wire WITHOUT refusal, the lazy origin closure
 *                               is never invoked, and no countryOfManufacture appears
 *                               anywhere in the transmitted UPS bodies.
 *
 * Network boundary: every connector reaches HTTP through timedFetch -> fetchWithTimeout ->
 * global fetch, resolved at CALL time — so global fetch is stubbed BEFORE any src import.
 * The stub answers only the allow-listed URLs (Shipp login/quote, UPS OAuth/ship, the
 * ShipStation /v2/carriers discovery with an EMPTY carrier list, and the zippopotam zip
 * helper), counts every provider call, captures every JSON body, and throws loudly on any
 * unexpected outbound URL — recording it too, since connector layers catch thrown errors.
 *
 * Database: a THROWAWAY database created per run on the loopback PG17 admin URL and
 * dropped at the end. process.env.DATABASE_URL points at it BEFORE any dynamic src import
 * (src/db/client.ts binds at import). The schema is the REAL migration chain: every
 * drizzle/*.sql applied verbatim in filename order — the same procedure (and tolerated-
 * failure discipline) as scripts/ps-507-qa-stack.mjs applyAllMigrations, with the expected
 * failure reasons adjusted for a real PostgreSQL 17 server. That is what lets the funnel's
 * schema-readiness gates (assertRuntimeSchemaReady's ~55 relations,
 * assertFulfillmentSchemaReady, the automation engine's tables) pass without hand-built
 * DDL that could drift from production.
 *
 * No writes happen outside the throwaway database. No postage. Nothing real is contacted.
 */
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
// Exported by the PS-507 QA stack; executes nothing at import (its CLI gate checks argv).
import { bootstrapForeignOwnedTables } from './ps-507-qa-stack.mjs';

// ── Admin URL: unskippable, loopback-only (PS-502 harness conventions) ────────
const ADMIN_URL =
  process.env.PS494_PG17_ADMIN_URL
  ?? process.env.PS502_PG17_ADMIN_URL
  ?? process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'FAIL: none of PS494_PG17_ADMIN_URL / PS502_PG17_ADMIN_URL / PS488_PG17_ADMIN_URL is set.\n'
    + '      This proof is unskippable in CI — Hermes finding 5 requires the JOINED execution\n'
    + '      (seeded store -> real browse/label entrypoint -> captured request body), and\n'
    + '      silently passing without a server would be worse than not running.',
  );
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error(`FAIL: refusing non-ephemeral host "${host}"`);
    process.exit(1);
  }
}

let passed = 0;
const check = (name: string, condition: boolean, detail?: string): void => {
  if (!condition) {
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`ok   ${name}`);
};

// ── The network boundary, stubbed GLOBALLY before any src import ──────────────
type CapturedCall = { url: string; body: unknown };
const captured: CapturedCall[] = [];
const unexpectedUrls: string[] = [];

const SHIPP_LOGIN_URL = 'https://shipp.to/api/supabase/login';
const SHIPP_QUOTE_URL = 'https://shipp.to/api/shipping/quote';
const UPS_TOKEN_URL = 'https://onlinetools.ups.com/security/v1/oauth/token';
const UPS_SHIP_URL = 'https://onlinetools.ups.com/api/shipments/v2403/ship';
const SHIPSTATION_CARRIERS_URL = 'https://api.shipstation.com/v2/carriers';

function parsedBody(init?: { body?: unknown }): unknown {
  try {
    return typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
  } catch {
    return init?.body ?? null;
  }
}
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
const providerCalls = () => captured.filter((c) => c.url.startsWith('https://shipp.to/') || c.url.startsWith('https://onlinetools.ups.com/'));
const callsTo = (url: string) => captured.filter((c) => c.url === url);
const resetCapture = () => { captured.length = 0; };

globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url?: string })?.url ?? '');
  // Auxiliary city/state lookup the Shipp connector performs (shipp.ts shippLookupUsZip).
  // Expected traffic, answered locally, never counted as a provider call.
  if (url.startsWith('https://api.zippopotam.us/us/')) {
    return json(200, { places: [{ 'place name': 'Gardena', 'state abbreviation': 'CA' }] });
  }
  // resolveRateInput's ShipStation carrier discovery (rates.ts getAllCarriers). Answered
  // with an EMPTY carrier list so the ShipStation universe stays empty — the same result
  // as an environment with no ShipStation credentials. Discovery traffic, not a quote.
  if (url === SHIPSTATION_CARRIERS_URL || url.startsWith(`${SHIPSTATION_CARRIERS_URL}?`)) {
    captured.push({ url, body: parsedBody(init) });
    return json(200, { carriers: [] });
  }
  if (url === SHIPP_LOGIN_URL) {
    captured.push({ url, body: parsedBody(init) });
    return json(200, { ok: true, session: { access_token: 'stub-access', refresh_token: 'stub-refresh' } }, {
      'set-cookie': 'sb-access-token=stub-access; Path=/',
    });
  }
  if (url === SHIPP_QUOTE_URL) {
    captured.push({ url, body: parsedBody(init) });
    // Shaped from quoteShippRatesRaw's parser: data.rates[], price > 0, quoted_shipment_id,
    // carrierType + serviceName/serviceType + deliveryDay — enough for at least one rate to
    // survive mapping/lift so the happy path completes.
    return json(200, {
      rates: [
        { carrierType: 'UPS', serviceName: 'Ground', serviceType: 'Ground', price: 8.11, deliveryDay: 3, quoted_shipment_id: 'q-ups-1' },
        { carrierType: 'FedEx', serviceName: 'Home Delivery', serviceType: 'GROUND_HOME_DELIVERY', price: 9.4, deliveryDay: 2, quoted_shipment_id: 'q-fedex-1' },
      ],
    });
  }
  if (url === UPS_TOKEN_URL) {
    captured.push({ url, body: parsedBody(init) });
    return json(200, { access_token: 'ups-stub-token' });
  }
  if (url === UPS_SHIP_URL) {
    captured.push({ url, body: parsedBody(init) });
    return json(200, {
      ShipmentResponse: {
        ShipmentResults: {
          PackageResults: { TrackingNumber: '1Z999PS494JOINED', ShippingLabel: { GraphicImage: 'R0lGODdhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=' } },
          ShipmentCharges: { TotalCharges: { MonetaryValue: '12.34', CurrencyCode: 'USD' } },
        },
      },
    });
  }
  // Anything else — including shipp.to/api/shipping/label/create and the UPS rating URL,
  // which this suite must never reach — is refused loudly AND recorded, because several
  // connector layers catch and sanitize thrown errors.
  unexpectedUrls.push(url);
  throw new Error(`PS-494 joined proof: unexpected outbound URL ${url} — nothing real may be contacted.`);
}) as typeof fetch;

// ── Throwaway-database plumbing (PS-502 harness conventions) ──────────────────
const admin = () => postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });

async function assertPostgres17(a: postgres.Sql): Promise<void> {
  const [row] = await a.unsafe('show server_version_num');
  const raw = (row as Record<string, unknown> | undefined)?.server_version_num;
  const version = Number(raw);
  if (!Number.isFinite(version) || version < 170000 || version >= 180000) {
    console.error(
      `FAIL: server_version_num ${String(raw)} is not PostgreSQL 17.\n`
      + '      This lane claims its execution ran on PostgreSQL 17 specifically.\n'
      + '      Nothing was created or dropped on this server.',
    );
    await a.end({ timeout: 5 });
    process.exit(1);
  }
  console.log(`ok   server is PostgreSQL 17 (server_version_num ${version})`);
}

const DB_NAME = `ps494_joined_${process.pid}`;

/**
 * The REAL migration chain, applied the way scripts/ps-507-qa-stack.mjs applyAllMigrations
 * does (every drizzle/*.sql in filename order, `--> statement-breakpoint` replaced with
 * `;`), with the tolerated-failure allowlist adjusted for a REAL PostgreSQL 17 server:
 * the postgres:17 image ships contrib, so 0058 gets past CREATE EXTENSION pg_trgm and then
 * fails on its CONCURRENTLY index instead (PGlite fails one step earlier). Same discipline
 * as the original: a tolerated file failing for a DIFFERENT reason than the one on record
 * is fatal, so a migration that starts failing a new way cannot be silently absorbed.
 */
const TOLERATED_MIGRATION_FAILURES = new Map<string, { reason: string; expect: RegExp }>([
  ['0018e_indexes.sql', {
    reason: 'CREATE INDEX CONCURRENTLY cannot run in a multi-statement implicit transaction; indexes are performance, not correctness',
    expect: /CONCURRENTLY cannot run inside a transaction block/i,
  }],
  ['0039_fk_covering_indexes.sql', {
    reason: 'same CONCURRENTLY constraint',
    expect: /CONCURRENTLY cannot run inside a transaction block/i,
  }],
  ['0037_rls_reporting_metrics_inbound.sql', {
    reason: 'RLS over inbound_shipments, a table this repo does not own',
    expect: /relation "(?:public\.)?inbound_shipments" does not exist/i,
  }],
  ['0045_revoke_public_api_grants.sql', {
    reason: 'revokes from the Supabase `anon` role, which does not exist on a vanilla server',
    expect: /role "anon" does not exist/i,
  }],
  ['0069_public_billing_rls_hardening.sql', {
    reason: 'same Supabase-only role',
    expect: /role "anon" does not exist/i,
  }],
  ['0057_perf_indexes_api_audit.sql', {
    reason: 'same CONCURRENTLY constraint (perf indexes only)',
    expect: /CONCURRENTLY cannot run inside a transaction block/i,
  }],
  ['0058_search_trgm_indexes.sql', {
    reason: 'CONCURRENTLY trgm indexes; on PG17-with-contrib the extension creates and the CONCURRENTLY index then fails, on PGlite the extension itself is unavailable',
    expect: /CONCURRENTLY cannot run inside a transaction block|could not open extension control file|extension "pg_trgm" is not available/i,
  }],
  ['0094_pin_function_search_path.sql', {
    reason: 'pgboss schema is created by the pg-boss library at runtime; this harness never starts the worker',
    expect: /schema "pgboss" does not exist/i,
  }],
]);

async function applyAllMigrationsPg17(throwawayUrl: string): Promise<{ applied: number; tolerated: string[] }> {
  // ONE dedicated session (max: 1), like a real migration runner: some hand-written files
  // (apply-test-client-purge.sql) open their own BEGIN/COMMIT, which postgres.js refuses to
  // pass through a pooled connection (UNSAFE_TRANSACTION).
  const migrator = postgres(throwawayUrl, { max: 1, prepare: false, onnotice: () => {} });
  const applied: string[] = [];
  const tolerated: string[] = [];
  try {
    // The Client-Portal-owned tables migrations 0088/0089/0092 extend (ps-507 exports this).
    await bootstrapForeignOwnedTables({ exec: (sql: string) => migrator.unsafe(sql) }, () => {});
    const files = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(`drizzle/${file}`, 'utf8');
      try {
        await migrator.unsafe(sql.replace(/-->\s*statement-breakpoint/g, ';'));
        applied.push(file);
      } catch (error) {
        const entry = TOLERATED_MIGRATION_FAILURES.get(file);
        const message = String((error as Error | null)?.message ?? error).split('\n')[0]!;
        if (!entry) {
          throw new Error(`STOP: migration ${file} failed for an untolerated reason:\n  ${message}`);
        }
        if (!entry.expect.test(message)) {
          throw new Error(
            `STOP: migration ${file} is tolerated, but failed for a DIFFERENT reason than the one on record.\n`
            + `  expected: ${entry.expect}\n  actual  : ${message}`,
          );
        }
        tolerated.push(`${file} — ${entry.reason}`);
      }
    }
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => {});
  }
  console.log(`ok   migration chain applied verbatim (${applied.length} applied, ${tolerated.length} tolerated)`);
  for (const entry of tolerated) console.log(`     skipped ${entry}`);
  return { applied: applied.length, tolerated };
}

// Client 77 owns the Shipp account and the browse-scenario orders; client 88 owns the
// direct UPS account and the scenario-5b order. The split matters:
// getDirectCarrierRatesForRateInput quotes EVERY account visible to the order's client, so
// with UPS assigned to 77 the mixed refusal cases could never assert providerFetches === 0
// — UPS would still legitimately quote.
const SHIPP_ACCOUNT_ID = 501;
const UPS_ACCOUNT_ID = 502;
const SHIPP_CLIENT = 77;
const UPS_CLIENT = 88;

const domesticShipTo = (name: string) => ({
  name,
  phone: '5555550100',
  street1: '1500 W Artesia Blvd',
  city: 'Gardena',
  state: 'CA',
  postalCode: '90248',
  country: 'US',
});
const customsItem = (countryOfOrigin: string | null, description: string) => ({
  description,
  quantity: 1,
  value: 12.5,
  countryOfOrigin,
  harmonizedTariffCode: null,
});
const MIXED_ITEMS = [customsItem('US', 'Domestic snack'), customsItem('KR', 'Korean cosmetics')];

type SeedOrder = {
  id: number;
  clientId: number;
  shipTo: Record<string, unknown>;
  customsItems: Array<Record<string, unknown>> | null;
};

const SEED_ORDERS: SeedOrder[] = [
  { id: 101, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Single KR Buyer'), customsItems: [customsItem('KR', 'Korean cosmetics'), customsItem('KR', 'Korean ramen')] },
  { id: 102, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Mixed Buyer'), customsItems: MIXED_ITEMS },
  { id: 103, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Unknown Origin Buyer'), customsItems: null },
  {
    id: 104,
    clientId: SHIPP_CLIENT,
    shipTo: { name: 'International Buyer', phone: '5555550101', street1: '800 Robson St', city: 'Vancouver', state: 'BC', postalCode: 'V6Z 2E7', country: 'CA' },
    customsItems: null,
  },
  // Scenario 5a starts DECLARABLE (KR-only) so the production browse mints a purchasable
  // selectionRef; the customs items then DRIFT to a mixed carton before purchase.
  { id: 105, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Drifting Label Buyer'), customsItems: [customsItem('KR', 'Korean electronics')] },
  { id: 106, clientId: UPS_CLIENT, shipTo: { name: 'Mixed Buyer B', phone: '5555550102', street1: '9 Maple Ave', city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' }, customsItems: MIXED_ITEMS },
];

function orderRawPayload(order: SeedOrder): Record<string, unknown> {
  return {
    shipTo: order.shipTo,
    ...(order.customsItems ? { internationalOptions: { customsItems: order.customsItems } } : {}),
  };
}

async function seed(raw: postgres.Sql): Promise<void> {
  await raw`insert into clients (id, name) values (${SHIPP_CLIENT}, 'Joined Proof Client'), (${UPS_CLIENT}, 'Joined Proof Client B')`;
  // The canonical default origin the browse and label paths resolve through
  // getDefaultShipFrom / resolveAuthorizedQuoteOrigin -> getDefaultLocation. Deliberately a
  // DB row, not SHIP_FROM_* env — the joined proof must exercise the database lane.
  await raw`
    insert into locations (name, company, street1, city, state, postal_code, country, phone, is_default, active)
    values ('Carson Warehouse', 'DR Prepper', '345 W Gardena Blvd', 'Carson', 'CA', '90248', 'US', '3103295555', true, true)
  `;
  // Hermes gap 1: the Shipp credentials carry a CONFIGURED, non-US operator default
  // (packageOriginCountry 'CA'). Scenario 3 must transmit exactly this configured value on
  // the domestic-inert lane, and scenario 1 must transmit the RESOLVED 'KR' anyway —
  // proving a recorded fact beats the operator default, not merely the terminal 'US'.
  await raw`
    insert into carrier_accounts (id, client_id, provider, label, account_identifier, credentials, active)
    values
      (${SHIPP_ACCOUNT_ID}, ${SHIPP_CLIENT}, 'shipp', 'Shipp (joined proof)', 'shipp-joined',
        ${JSON.stringify({ apiKey: 'stub-key', email: 'ops@example.test', password: 'stub-pass', packageOriginCountry: 'CA' })}::jsonb, true),
      (${UPS_ACCOUNT_ID}, ${UPS_CLIENT}, 'ups', 'Direct UPS (joined proof)', 'ups-joined',
        ${JSON.stringify({ clientId: 'ups-oauth-id', clientSecret: 'ups-oauth-secret', accountNumber: 'A1B2C3' })}::jsonb, true)
  `;
  for (const order of SEED_ORDERS) {
    await raw`
      insert into orders (
        id, client_id, order_number, order_status, store_id, customer_email,
        ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code,
        weight_oz, raw, source_provider, source_account_id, source_order_id, external_order_id
      ) values (
        ${order.id}, ${order.clientId}, ${`JOINED-${order.id}`}, 'awaiting_shipment', null,
        'buyer@example.test',
        ${String(order.shipTo.name ?? '')}, ${String(order.shipTo.city ?? '')},
        ${String(order.shipTo.state ?? '')}, ${String(order.shipTo.postalCode ?? '')},
        32, ${JSON.stringify(orderRawPayload(order))}::jsonb,
        'shipstation', 'ss-joined', ${`sso-${order.id}`}, ${`ext-${order.id}`}
      )
    `;
  }
  // Scenario 5a's purchase-side dimensions come from order_overrides.rate_dims_* — that is
  // where the production purchase reads "current" dims (labels.ts:2512-2517), and the
  // quote-time authorization context must match them exactly.
  await raw`
    insert into order_overrides (order_id, rate_dims_l, rate_dims_w, rate_dims_h)
    values (105, 12, 10, 3)
  `;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function main(): Promise<void> {
  // Env BEFORE any dynamic src import: src/lib/env.ts validates on load and src/db/client.ts
  // binds DATABASE_URL at import. Set values win over .env (dotenv never overrides existing
  // process.env keys). Same dummy set as scripts/ps-508-outbound-freeze-integration.ts.
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  // Pin the PS-271 union cache at its production default (OFF) even if a local .env arms it:
  // the joined assertions count EXACT provider calls, and a warm cache would legitimately
  // change them. The table exists (real migration chain) and is asserted EMPTY below.
  process.env.DIRECT_CARRIER_RATE_CACHE = 'false';
  // The orchestrator's replay seam must stay dark so the REAL production branch runs.
  delete process.env.CARRIER_TEST_MODE;
  // A developer .env may carry live ShipStation keys; pin them empty so carrier discovery
  // in resolveRateInput cannot depend on ambient credentials (the stub answers it empty
  // either way, but the run must be deterministic on a clean machine AND a developer one).
  process.env.SHIPSTATION_API_KEY = '';
  process.env.SHIPSTATION_API_SECRET = '';
  process.env.SHIPSTATION_API_KEY_V2 = '';
  // Defense in depth only — scenario 5b never persists a shipment, so no deduction path
  // runs; pinned OFF anyway so a future extension cannot silently reach inventory.
  process.env.INVENTORY_AUTO_DEDUCT = 'off';

  const a = admin();
  try {
    await assertPostgres17(a);
    await a.unsafe(`drop database if exists ${DB_NAME}`);
    await a.unsafe(`create database ${DB_NAME}`);
  } finally {
    await a.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${DB_NAME}`;
  const throwawayUrl = url.toString();
  process.env.DATABASE_URL = throwawayUrl;

  const raw = postgres(throwawayUrl, { max: 4, prepare: false, onnotice: () => {} });
  let appSqlEnd: (() => Promise<void>) | null = null;
  try {
    await applyAllMigrationsPg17(throwawayUrl);
    await seed(raw);

    // ── Dynamic imports AFTER env binding ─────────────────────────────────────
    const { getDirectCarrierRatesForRateInput, resolveRateInput, rateCacheKey } =
      await import('../src/services/rates');
    const { loadDirectAccountForLabel, createDirectCarrierLabelForOrder, DIRECT_CARRIER_PROVIDER_ID_OFFSET } =
      await import('../src/services/labels-direct');
    const { createLabelV2 } = await import('../src/services/labels');
    const { assertDeclarableOrigin, CustomsOriginUndeclarableError, resolveOrderCustomsOrigin } =
      await import('../src/services/customs-origin');
    const { classifyDestinationCountry } = await import('../src/services/billing-destination-international');
    const { normalizeProviderKey } = await import('../src/lib/direct-carrier-scope');
    const { normalizeShippingOptions } = await import('../src/lib/shipping-options');
    const { getDefaultShipFrom } = await import('../src/lib/ship-from');
    const { getDefaultLocation } = await import('../src/services/locations');
    const { finalizeBestRateWithQuote } = await import('../src/services/shipping-workflow/rate-quote-snapshot-store');
    const { normalizeShippingQuoteAddress, parseShippingQuoteSelectionRef, shippingProviderIdFromAuthorizedRate } =
      await import('../src/services/shipping-workflow/shipping-quote-authorization');
    const { resolveOutboundPackageSelection } = await import('../src/services/package-consumption');
    const { resolveRecipientForShipping } = await import('../src/services/order-recipient-override');
    const { resolveCarrierRecipientName } = await import('../src/services/carrier-recipient-name');
    const { GLOBAL_SCOPE } = await import('../src/lib/client-store-scope');
    const { db, sql: appSql } = await import('../src/db/client');
    const { orders } = await import('../src/db/schema/orders');
    const { eq } = await import('drizzle-orm');
    appSqlEnd = () => appSql.end({ timeout: 5 });

    type OrderRow = {
      id: number;
      clientId: number | null;
      storeId: number | null;
      orderNumber: string | null;
      weightOz: number | null;
      customerEmail: string | null;
      shipToName: string | null;
      shipToCity: string | null;
      shipToState: string | null;
      shipToPostalCode: string | null;
      sourceProvider: string | null;
      sourceAccountId: string | null;
      sourceOrderId: string | null;
      raw: unknown;
    };
    const loadOrderRow = async (orderId: number): Promise<OrderRow> => {
      const [row] = await db
        .select({
          id: orders.id,
          clientId: orders.clientId,
          storeId: orders.storeId,
          orderNumber: orders.orderNumber,
          weightOz: orders.weightOz,
          customerEmail: orders.customerEmail,
          shipToName: orders.shipToName,
          shipToCity: orders.shipToCity,
          shipToState: orders.shipToState,
          shipToPostalCode: orders.shipToPostalCode,
          sourceProvider: orders.sourceProvider,
          sourceAccountId: orders.sourceAccountId,
          sourceOrderId: orders.sourceOrderId,
          raw: orders.raw,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!row) throw new Error(`seed order ${orderId} missing`);
      return row;
    };

    /**
     * The RateInput, built the way production builds it from the order row — the same field
     * mapping rates-backfill.ts:1231-1251 and rate-browse-response-producer.ts:273-314 use
     * (to* from raw.shipTo with column fallbacks, weight from the order, marketplace context
     * from the source columns, rawOrder = the retained payload, includeVisibleDirectCarriers
     * like rates-backfill:1298). Dims ride the request like the FE `rest.dims*` lane.
     */
    const rateInputFromOrderRow = (row: OrderRow) => {
      const shipTo = ((row.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
      return {
        weightOz: Number(row.weightOz ?? 32),
        toZip: readText(shipTo.postalCode) ?? row.shipToPostalCode ?? '',
        toCountry: readText(shipTo.country),
        toState: readText(shipTo.state) ?? row.shipToState ?? undefined,
        toCity: readText(shipTo.city) ?? row.shipToCity ?? undefined,
        toName: readText(shipTo.name),
        toAddress: readText(shipTo.street1),
        dimsL: 12,
        dimsW: 10,
        dimsH: 3,
        storeId: row.storeId,
        clientId: row.clientId,
        orderId: row.id,
        orderNumber: row.orderNumber,
        sourceProvider: row.sourceProvider,
        sourceAccountId: row.sourceAccountId,
        rawOrder: row.raw,
        includeVisibleDirectCarriers: true,
      };
    };

    // ── Scenario 1: single KR origin reaches the wire through the REAL browse ─
    console.log('\nscenario 1 — single KR order through getDirectCarrierRatesForRateInput');
    {
      resetCapture();
      const result = await getDirectCarrierRatesForRateInput(rateInputFromOrderRow(await loadOrderRow(101)));
      const quotes = callsTo(SHIPP_QUOTE_URL);
      check('exactly ONE Shipp /quote POST left the process', quotes.length === 1, `saw ${quotes.length}`);
      const line = (quotes[0]?.body as { packageLineItems?: Array<Record<string, unknown>> } | undefined)?.packageLineItems;
      // STRONGER than the original assertion (Hermes gap 1): the account's configured
      // default is 'CA', so 'KR' here proves the RESOLVED origin beats the operator
      // default — not merely that some origin was transmitted.
      check("the request body declares the RESOLVED origin KR — beating the account's configured 'CA' default",
        line?.[0]?.countryOfManufacture === 'KR', JSON.stringify(line?.[0]));
      check('the body carries the single synthetic line item the refusal rationale rests on',
        Array.isArray(line) && line.length === 1, `lines=${line?.length}`);
      check('the result reports exactly one provider fetch', result.providerFetches === 1, String(result.providerFetches));
      check('the happy path completed with at least one lifted rate', result.rates.length >= 1,
        `rates=${result.rates.length} errors=${JSON.stringify(result.errors)}`);
    }

    // ── Scenario 2: mixed US/KR refuses BEFORE provider HTTP ──────────────────
    console.log('\nscenario 2 — mixed US/KR order refuses before any provider HTTP');
    {
      resetCapture();
      const result = await getDirectCarrierRatesForRateInput(rateInputFromOrderRow(await loadOrderRow(102)));
      check('ZERO provider HTTP calls were made', providerCalls().length === 0,
        providerCalls().map((c) => c.url).join(', '));
      check('the result reports providerFetches === 0', result.providerFetches === 0, String(result.providerFetches));
      const message = result.errors[0]?.message ?? '';
      check('the per-carrier error carries the refusal reason naming both origins',
        /US/.test(message) && /KR/.test(message) && /cannot declare more than one country/.test(message), message);
      const diagnostic = result.diagnostics[0];
      check('the diagnostic is a non-retryable failure carrying the same reason',
        diagnostic?.status === 'failed' && diagnostic?.error === message, JSON.stringify(diagnostic));
      check('no rate was fabricated for the refused account', result.rates.length === 0, String(result.rates.length));
    }

    // ── Scenario 3: unknown + domestic declares the CONFIGURED operator default ─
    console.log('\nscenario 3 — unknown origin + domestic destination sends the configured default');
    {
      resetCapture();
      const result = await getDirectCarrierRatesForRateInput(rateInputFromOrderRow(await loadOrderRow(103)));
      const quotes = callsTo(SHIPP_QUOTE_URL);
      check('exactly ONE Shipp /quote POST left the process', quotes.length === 1, `saw ${quotes.length}`);
      const line = (quotes[0]?.body as { packageLineItems?: Array<Record<string, unknown>> } | undefined)?.packageLineItems;
      // Hermes gap 1: the seeded credentials configure packageOriginCountry 'CA', so the
      // domestic-inert lane must transmit exactly the CONFIGURED default — proving the
      // operator's setting reaches the wire, not the connector's terminal 'US' fallback.
      check("the domestic-inert lane transmits the CONFIGURED operator default 'CA'",
        line?.[0]?.countryOfManufacture === 'CA', JSON.stringify(line?.[0]));
      check('the result reports exactly one provider fetch', result.providerFetches === 1, String(result.providerFetches));
    }

    // ── Scenario 4: unknown + international refuses before provider HTTP ──────
    console.log('\nscenario 4 — unknown origin + international destination refuses');
    {
      resetCapture();
      const result = await getDirectCarrierRatesForRateInput(rateInputFromOrderRow(await loadOrderRow(104)));
      check('ZERO provider HTTP calls were made', providerCalls().length === 0,
        providerCalls().map((c) => c.url).join(', '));
      check('the result reports providerFetches === 0', result.providerFetches === 0, String(result.providerFetches));
      // Honest outcome, verified against the code: getDirectCarrierRatesForRateInput has no
      // earlier international gate (PS-492's assertInternationalOriginationSupported lives on
      // the label path, labels.ts:2643), so the STATED reason is the customs-origin refusal.
      const message = result.errors[0]?.message ?? '';
      check('the stated reason is the customs-origin refusal for a non-domestic guess',
        /not domestic/.test(message) && /International/.test(message), message);
    }

    // ── Scenario 5a: the REAL purchase funnel refuses the drifted mixed carton ─
    console.log('\nscenario 5a — createLabelV2 funnel refusal at the production ternary');
    {
      // MINT — every artifact is produced by the PRODUCTION owners:
      //   resolveRateInput           runs the PS-466 automation preflight and stamps the
      //                              prefixed automationRulesVersion the purchase-side
      //                              assertAutomationRateProofCurrent requires
      //   getDirectCarrierRates...   quotes the REAL Shipp connector (order 105 is KR-only
      //                              at this point, so the mint is itself another
      //                              single-origin wire proof)
      //   finalizeBestRateWithQuote  seals the snapshot + authorization and mints the
      //                              selectionRef exactly as /rates/browse does
      resetCapture();
      const mintRow = await loadOrderRow(105);
      const resolved = await resolveRateInput(rateInputFromOrderRow(mintRow));
      const browse = await getDirectCarrierRatesForRateInput({
        ...resolved,
        includeVisibleDirectCarriers: true,
        orderId: mintRow.id,
        orderNumber: mintRow.orderNumber ?? undefined,
      });
      const mintQuotes = callsTo(SHIPP_QUOTE_URL);
      const mintLine = (mintQuotes[0]?.body as { packageLineItems?: Array<Record<string, unknown>> } | undefined)?.packageLineItems;
      check('the mint browse quoted Shipp once and transmitted the declarable KR origin',
        mintQuotes.length === 1 && mintLine?.[0]?.countryOfManufacture === 'KR',
        JSON.stringify({ quotes: mintQuotes.length, line: mintLine?.[0] }));
      check('the mint browse lifted at least one purchasable rate', browse.rates.length >= 1,
        JSON.stringify(browse.errors));

      // The cheapest lifted rate — the one-account universe makes min-by-charge equivalent
      // to the combined ranking production applies (combineCarrierUniverses).
      const cheapest = [...browse.rates].sort((left, right) =>
        Number((left as Record<string, unknown>).cShippingRateAmount ?? Infinity)
        - Number((right as Record<string, unknown>).cShippingRateAmount ?? Infinity))[0]! as Record<string, unknown>;

      // The authorization CONTEXT, built exactly as rate-browse-response-producer.ts:489-586
      // builds it (same production helpers; locationRateAddress mirrored from :113-125).
      const defaultLocation = await getDefaultLocation();
      if (!defaultLocation) throw new Error('seeded default location missing');
      const authorizedOrigin = {
        locationId: defaultLocation.id,
        address: {
          name: defaultLocation.name,
          company_name: defaultLocation.company ?? undefined,
          address_line1: defaultLocation.street1 ?? undefined,
          address_line2: defaultLocation.street2 ?? undefined,
          city_locality: defaultLocation.city ?? undefined,
          state_province: defaultLocation.state ?? undefined,
          postal_code: defaultLocation.postalCode ?? undefined,
          country_code: defaultLocation.country,
          phone: defaultLocation.phone ?? undefined,
        },
      };
      const rawShipTo = ((mintRow.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
      const canonicalShipTo = resolveRecipientForShipping({
        override: null,
        rawShipTo,
        fallback: {
          name: mintRow.shipToName,
          city: mintRow.shipToCity,
          state: mintRow.shipToState,
          postalCode: mintRow.shipToPostalCode,
        },
      }).address;
      const carrierRecipient = resolveCarrierRecipientName({
        name: readText(canonicalShipTo.name),
        company: readText(canonicalShipTo.company),
        customerEmail: mintRow.customerEmail,
      });
      const packageSelection = await resolveOutboundPackageSelection({
        orderId: mintRow.id,
        selectedPackageId: null,
        dimensions: { length: resolved.dimsL ?? null, width: resolved.dimsW ?? null, height: resolved.dimsH ?? null },
      });
      const packageId = packageSelection.status === 'matched' ? packageSelection.packageId : null;
      const effectiveOptions = normalizeShippingOptions({
        confirmation: resolved.confirmation,
        insuranceProvider: resolved.effectiveInsuranceProvider ?? resolved.insuranceProvider,
        insuredValue: resolved.effectiveInsuredValue ?? resolved.insuredValue,
      });
      const context = {
        version: 1 as const,
        order: {
          orderId: mintRow.id,
          clientId: mintRow.clientId,
          storeId: mintRow.storeId,
          sourceProvider: mintRow.sourceProvider,
          sourceAccountId: mintRow.sourceAccountId,
          sourceOrderId: mintRow.sourceOrderId,
        },
        shipment: {
          shipFromLocationId: authorizedOrigin.locationId,
          shipFrom: normalizeShippingQuoteAddress(authorizedOrigin.address),
          shipTo: normalizeShippingQuoteAddress({
            ...canonicalShipTo,
            name: carrierRecipient.name,
            company: carrierRecipient.company,
          }),
          package: { id: packageId, type: null, code: null },
          weightOz: Number(resolved.weightOz),
          dimensions: {
            length: resolved.dimsL ?? null,
            width: resolved.dimsW ?? null,
            height: resolved.dimsH ?? null,
          },
          residential: resolved.residential === true,
          confirmation: effectiveOptions.confirmation,
          insuranceProvider: effectiveOptions.insuranceProvider,
          insuredValue: Number(effectiveOptions.insuredValue ?? 0) || 0,
        },
      };
      const presentProviderIds = new Set(
        browse.rates.map(shippingProviderIdFromAuthorizedRate).filter((id): id is number => id != null),
      );
      const accounts = browse.authorizationAccounts.filter(
        (account) => presentProviderIds.has(account.shippingProviderId),
      );
      const finalized = await finalizeBestRateWithQuote({
        bestRate: cheapest,
        rates: browse.rates as Array<Record<string, unknown>>,
        cacheKey: rateCacheKey(resolved),
        bestRateComplete: true,
        fetchedAt: new Date().toISOString(),
        purchaseProofEligible: true,
        authorization: { context, accounts },
      });
      const selectionRef = (finalized.bestRate as { selectionRef?: string }).selectionRef ?? null;
      check('the production finalizer minted a parseable purchase selectionRef',
        !!selectionRef && parseShippingQuoteSelectionRef(selectionRef) != null, String(selectionRef));

      // THE DRIFT. The customs items change AFTER the quote was sealed — the rate proof
      // seals rate identity, not customs items, so the purchase-time re-check at
      // labels.ts:3043 is the only thing standing between this carton and the broker.
      await raw`
        update orders
        set raw = ${JSON.stringify(orderRawPayload({ ...SEED_ORDERS.find((o) => o.id === 105)!, customsItems: MIXED_ITEMS }))}::jsonb
        where id = 105
      `;

      // PURCHASE — the real funnel, from the top.
      resetCapture();
      let thrown: unknown = null;
      try {
        await createLabelV2(
          { orderId: 105, selectionRef } as Parameters<typeof createLabelV2>[0],
          GLOBAL_SCOPE,
        );
      } catch (error) {
        thrown = error;
      }
      check('createLabelV2 REFUSED the drifted mixed carton', thrown != null, 'purchase unexpectedly succeeded');
      check('the refusal is CustomsOriginUndeclarableError with status 422 — thrown by the production ternary',
        thrown instanceof CustomsOriginUndeclarableError && thrown.status === 422,
        `${(thrown as { name?: string } | null)?.name} status=${(thrown as { status?: number } | null)?.status} :: ${String(thrown)}`);
      check('the 422 reason names both recorded origins',
        /US/.test(String(thrown)) && /KR/.test(String(thrown)), String(thrown));
      check('the funnel refusal made ZERO provider HTTP calls', providerCalls().length === 0,
        providerCalls().map((c) => c.url).join(', '));
      // The ledger proves WHERE the refusal happened: the operation was claimed for
      // dispatch, the execute callback threw while building the connector arguments, and
      // classifyBuyErrorForIntent (with the PS-494 CUSTOMS_ORIGIN_UNDECLARABLE branch)
      // classified it provably-pre-purchase — failed_pre_dispatch, not a reconcile hold.
      const [operation] = await raw<Array<{ state: string; kind: string; provider: string; subject_id: string; last_error: string | null }>>`
        select state, kind, provider, subject_id, last_error
        from external_operations
        where subject_type = 'order' and subject_id = '105'
        order by id desc limit 1
      `;
      check('the fulfillment operation exists for the refused purchase (the funnel reached dispatch)',
        operation?.kind === 'forward_label' && operation?.provider === 'shipp', JSON.stringify(operation));
      check("the operation landed 'failed_pre_dispatch' — no provider contact, no reconcile hold",
        operation?.state === 'failed_pre_dispatch', operation?.state);
      check('the ledger carries the actionable refusal reason',
        /cannot declare more than one country/.test(operation?.last_error ?? ''), operation?.last_error ?? '');
    }

    // ── Scenario 5b: non-Shipp scoping through the REAL direct-label boundary ─
    console.log('\nscenario 5b — non-Shipp scoping: mixed carton purchases via direct UPS');
    {
      resetCapture();
      const upsAccount = await loadDirectAccountForLabel(
        { sourceTable: 'carrier_accounts', accountId: UPS_ACCOUNT_ID },
        { clientId: UPS_CLIENT, storeId: null, sourceProvider: 'shipstation', sourceAccountId: 'ss-joined' },
      );
      const upsProviderKey = normalizeProviderKey(upsAccount.provider);
      const upsOrder = await loadOrderRow(106);
      const upsOrderShipTo = ((upsOrder.raw as { shipTo?: Record<string, unknown> })?.shipTo) ?? {};
      let upsClosureCalls = 0;
      // labels.ts:2658-2661 verbatim shape — the decision itself is NOT re-implemented here.
      const resolveDeclaredUpsSideOrigin = (): string | null => {
        upsClosureCalls += 1;
        return assertDeclarableOrigin({
          resolution: resolveOrderCustomsOrigin(upsOrder),
          destination: classifyDestinationCountry(String(upsOrderShipTo.country ?? '')).destination,
        });
      };
      // labels.ts:3043 — the lazy closure is consumed only when the provider is Shipp.
      const upsOriginArg = upsProviderKey === 'shipp' ? resolveDeclaredUpsSideOrigin() : null;
      check('the non-Shipp provider never consumes the origin closure', upsClosureCalls === 0, String(upsClosureCalls));

      // labels.ts builds the connector ship-from from getDefaultShipFrom exactly like this
      // (labels.ts:2547-2558); the ship-to mirrors the sealed carrierShipTo record shape.
      const fromLoc = await getDefaultShipFrom();
      const labelShipFrom = {
        name: fromLoc.name,
        company: fromLoc.company_name,
        street1: fromLoc.address_line1,
        street2: fromLoc.address_line2,
        city: fromLoc.city_locality,
        state: fromLoc.state_province,
        postalCode: fromLoc.postal_code,
        country: fromLoc.country_code,
        phone: fromLoc.phone,
      };
      const purchase = await createDirectCarrierLabelForOrder({
        account: upsAccount,
        providerAccountId: DIRECT_CARRIER_PROVIDER_ID_OFFSET + UPS_ACCOUNT_ID,
        orderId: upsOrder.id,
        orderNumber: upsOrder.orderNumber,
        externalOrderId: `ext-${upsOrder.id}`,
        clientId: upsOrder.clientId,
        storeId: upsOrder.storeId,
        serviceCode: '03',
        serviceName: 'UPS Ground',
        weightOz: Number(upsOrder.weightOz ?? 32),
        length: 12,
        width: 10,
        height: 3,
        shipTo: {
          name: String(upsOrderShipTo.name ?? ''),
          phone: String(upsOrderShipTo.phone ?? ''),
          street1: String(upsOrderShipTo.street1 ?? ''),
          street2: null,
          city: String(upsOrderShipTo.city ?? ''),
          state: String(upsOrderShipTo.state ?? ''),
          zip: String(upsOrderShipTo.postalCode ?? ''),
          postalCode: String(upsOrderShipTo.postalCode ?? ''),
          country: String(upsOrderShipTo.country ?? 'US'),
          residential: true,
        },
        shipFrom: labelShipFrom,
        shippingOptions: normalizeShippingOptions({}),
        rawOrder: upsOrder.raw,
        countryOfManufacture: upsOriginArg,
      });
      check('the UPS purchase COMPLETED for the same mixed carton — no fleet-wide refusal',
        purchase.created.trackingNumber === '1Z999PS494JOINED', JSON.stringify(purchase.created.trackingNumber));
      check('the UPS purchase performed its real provider calls (OAuth + ship)',
        callsTo(UPS_TOKEN_URL).length === 1 && callsTo(UPS_SHIP_URL).length === 1,
        providerCalls().map((c) => c.url).join(', '));
      const upsBodies = JSON.stringify(callsTo(UPS_SHIP_URL).map((c) => c.body));
      check('no countryOfManufacture appears anywhere in the transmitted UPS bodies',
        !upsBodies.includes('countryOfManufacture'), upsBodies.slice(0, 300));
      check('the UPS purchase touched no Shipp endpoint',
        captured.every((c) => !c.url.startsWith('https://shipp.to/')),
        captured.map((c) => c.url).join(', '));
    }

    // ── Cross-cutting: the boundary held ──────────────────────────────────────
    console.log('\nboundary checks');
    {
      check('no unexpected outbound URL was ever attempted', unexpectedUrls.length === 0, unexpectedUrls.join(', '));
      const [cacheCount] = await raw`select count(*)::int as c from direct_carrier_rate_cache`;
      check('the PS-271 rate cache stayed EMPTY (flag pinned OFF — its OFF path is a true no-op)',
        Number((cacheCount as { c?: number } | undefined)?.c ?? -1) === 0, JSON.stringify(cacheCount));
      const [shipmentCount] = await raw`select count(*)::int as c from shipments`;
      check('no shipment row was ever persisted — both label scenarios stop before persistence',
        Number((shipmentCount as { c?: number } | undefined)?.c ?? -1) === 0, JSON.stringify(shipmentCount));
    }

    console.log(`\nPS-494 joined origin proof: ${passed} checks against the REAL browse and label boundaries.`);
    console.log('No provider contacted. No postage. All writes confined to the throwaway database.');
  } finally {
    if (appSqlEnd) await appSqlEnd().catch(() => {});
    await raw.end({ timeout: 5 }).catch(() => {});
    const cleanup = admin();
    try {
      await cleanup.unsafe(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname='${DB_NAME}' and pid <> pg_backend_pid()`,
      );
      await cleanup.unsafe(`drop database if exists ${DB_NAME}`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
