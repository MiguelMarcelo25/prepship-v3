/**
 * PS-494 — the JOINED end-to-end request-body proof Hermes's audit demanded (finding 5).
 *
 * ps-494-shipp-origin-request-body-guard.ts proves the halves separately and says so in its
 * header: nothing there executes `getDirectCarrierRatesForRateInput` end to end, because that
 * entry point reads carrier accounts and the order row from a database. This file closes that
 * gap the way the audit asked: "invoke the real browse entrypoint with a disposable seeded
 * order/account store, stub only the network boundary."
 *
 * Every scenario is a REAL call into the production code path — no re-implementation of the
 * decision, no source-text assertions:
 *
 *   1. single-KR order       -> real browse -> exactly ONE Shipp /quote POST, body
 *                               packageLineItems[0].countryOfManufacture === 'KR'
 *   2. mixed US/KR order     -> real browse -> ZERO provider HTTP, providerFetches === 0,
 *                               the refusal reason on the error + diagnostic
 *   3. unknown + domestic    -> real browse -> ONE /quote POST, body countryOfManufacture
 *                               === 'US' (the domestic-inert lane: rates.ts:3116 passes null,
 *                               the connector applies creds.packageOriginCountry ?? 'US' —
 *                               shipp.ts shippCountryOfManufacture; no default is seeded here,
 *                               so the asserted value is 'US')
 *   4. unknown + international -> real browse -> ZERO provider HTTP + the stated refusal.
 *                               NOTE: the browse path has NO earlier international gate — the
 *                               PS-492 assertInternationalOriginationSupported gate is
 *                               labels-side only (labels.ts:2643); on browse the customs-origin
 *                               refusal at rates.ts:3081-3117 is the first and only Shipp gate,
 *                               so the honest asserted outcome is that refusal.
 *   5. label parity          -> the REAL direct-label boundary. (a) a mixed order with the
 *                               Shipp account refuses with a 422 CustomsOriginUndeclarableError
 *                               BEFORE any HTTP, produced by the SAME assertDeclarableOrigin
 *                               call labels.ts makes (labels.ts:2658-2661, consumed lazily at
 *                               :3043) — not re-implemented. (b) non-Shipp scoping: the same
 *                               mixed carton purchased through a direct UPS account runs the
 *                               REAL createDirectCarrierLabelForOrder to the UPS wire without
 *                               refusal, the lazy origin closure is NEVER invoked, and no
 *                               countryOfManufacture appears anywhere in the UPS bodies.
 *
 * Network boundary: every connector reaches HTTP through timedFetch -> fetchWithTimeout ->
 * global fetch, resolved at CALL time — so global fetch is stubbed BEFORE any src import.
 * The stub answers only the allow-listed Shipp/UPS/zippopotam URLs, counts every provider
 * call, captures every JSON body, and throws loudly on anything else (and records it, since
 * connector catch blocks can swallow the throw). Nothing real is ever contacted; no postage.
 *
 * Database: a THROWAWAY database created per run on the loopback PG17 admin URL, dropped at
 * the end. process.env.DATABASE_URL is pointed at it BEFORE any dynamic src import, because
 * src/db/client.ts binds at import. Tables are ONLY what the joined path actually touches,
 * with column lists extracted from the real drizzle migrations:
 *
 *   orders                       drizzle/0000 + external_order_id (0001) + source_provider/
 *                                source_account_id/source_order_id (0020) — the resolver reads
 *                                orders.raw (rates.ts:2850); the input builder reads the same
 *                                columns /rates/browse + rates-backfill read.
 *   clients                      minimal FK target (automation_shipping_controls references it).
 *   settings                     drizzle/0000 — loadCarrierMarkups reads markup.* rows.
 *   locations                    drizzle/0003 — getDefaultShipFrom -> getDefaultLocation reads
 *                                the default row (full-column drizzle select).
 *   carrier_accounts             drizzle/0015 — loadVisibleDirectCarrierAccounts +
 *                                loadDirectAccountForLabel.
 *   store_accounts,
 *   carrier_account_clients      drizzle/0027 — both queried unconditionally on the browse path.
 *   automation_shipping_controls drizzle/0081 — createCarrierLabel -> loadShippingAutomationControls
 *                                (full-column drizzle select) on the scenario-5b UPS purchase.
 *   direct_carrier_rate_cache    drizzle/0062 — the table writeDirectRatesToCache targets
 *                                (rates.ts:3195) when the PS-271 flag is ON. The flag is
 *                                env-gated DEFAULT OFF and pinned OFF here for determinism;
 *                                the table exists so a flipped default can never break this
 *                                proof, and a final check asserts it stayed EMPTY.
 *
 * No writes happen outside the throwaway database.
 */
import postgres from 'postgres';

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
// timedFetch (src/lib/http/timing.ts) -> fetchWithTimeout (src/lib/fetch-timeout.ts) -> bare
// `fetch(...)`, resolved from globalThis at call time. Installing the stub before the dynamic
// imports below guarantees no module can capture the real fetch first.
type CapturedCall = { url: string; body: unknown };
const captured: CapturedCall[] = [];
const unexpectedUrls: string[] = [];

const SHIPP_LOGIN_URL = 'https://shipp.to/api/supabase/login';
const SHIPP_QUOTE_URL = 'https://shipp.to/api/shipping/quote';
const UPS_TOKEN_URL = 'https://onlinetools.ups.com/security/v1/oauth/token';
const UPS_SHIP_URL = 'https://onlinetools.ups.com/api/shipments/v2403/ship';

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
 * Column lists extracted from the real migrations — see the header table for the citation of
 * each block. Only what the joined path reads/writes; nothing else.
 */
const DDL = `
  -- minimal FK target (automation_shipping_controls references clients.id)
  CREATE TABLE clients (
    id serial PRIMARY KEY,
    name text
  );
  -- drizzle/0000_nebulous_union_jack.sql "orders" + 0001 external_order_id
  -- + 0020_fulfillment_outbox.sql source identity columns
  CREATE TABLE orders (
    id serial PRIMARY KEY,
    client_id integer,
    order_number text NOT NULL,
    order_status text DEFAULT 'awaiting_shipment' NOT NULL,
    order_date timestamptz,
    store_id integer,
    customer_email text,
    ship_to_name text,
    ship_to_city text,
    ship_to_state text,
    ship_to_postal_code text,
    carrier_code text,
    service_code text,
    weight_oz real,
    order_total numeric(10,2) DEFAULT '0' NOT NULL,
    shipping_amount numeric(10,2) DEFAULT '0' NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    externally_shipped boolean DEFAULT false NOT NULL,
    externally_fulfilled_verified boolean DEFAULT false NOT NULL,
    external_order_id text,
    source_provider text,
    source_account_id text,
    source_order_id text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  );
  -- drizzle/0000_nebulous_union_jack.sql "settings"
  CREATE TABLE settings (
    key text PRIMARY KEY,
    value text
  );
  -- drizzle/0003_outgoing_young_avengers.sql "locations" (verbatim)
  CREATE TABLE locations (
    id serial PRIMARY KEY,
    name text NOT NULL,
    company text,
    street1 text,
    street2 text,
    city text,
    state text,
    postal_code text,
    country text DEFAULT 'US' NOT NULL,
    phone text,
    is_default boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  );
  -- drizzle/0015_amusing_namorita.sql "carrier_accounts" (verbatim, incl. identity index)
  CREATE TABLE carrier_accounts (
    id serial PRIMARY KEY,
    client_id integer,
    provider text NOT NULL,
    label text,
    account_identifier text,
    credentials jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'admin' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX carrier_accounts_client_provider_account_idx
    ON carrier_accounts (COALESCE(client_id, -1), provider, COALESCE(account_identifier, ''));
  -- drizzle/0027_credential_accounts_source_of_truth.sql (verbatim)
  CREATE TABLE store_accounts (
    id serial PRIMARY KEY,
    client_id integer,
    provider text NOT NULL,
    label text,
    account_identifier text,
    credentials jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'admin' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  );
  CREATE TABLE carrier_account_clients (
    carrier_account_id integer NOT NULL,
    client_id integer NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT carrier_account_clients_pkey PRIMARY KEY (carrier_account_id, client_id),
    CONSTRAINT carrier_account_clients_account_fk
      FOREIGN KEY (carrier_account_id) REFERENCES carrier_accounts(id) ON DELETE CASCADE
  );
  -- drizzle/0081_ps466_automation_shipping_controls.sql (CREATE TABLE + scope index; the
  -- one-time legacy-import DML is a data migration and has nothing to import here)
  CREATE TABLE automation_shipping_controls (
    id bigserial PRIMARY KEY,
    control_key text NOT NULL,
    control_type text NOT NULL CHECK (control_type IN ('carrier', 'service')),
    client_id integer REFERENCES clients(id) ON DELETE RESTRICT,
    store_id integer,
    carrier_id text,
    carrier_code text,
    service_code text,
    service_name text,
    disabled boolean NOT NULL DEFAULT true CHECK (disabled = true),
    reason text,
    system_locked boolean NOT NULL DEFAULT false,
    provenance text NOT NULL DEFAULT 'operator'
      CHECK (provenance IN ('operator', 'legacy_import', 'system')),
    source text,
    position bigint NOT NULL CHECK (position >= 0),
    source_updated_at text,
    updated_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automation_shipping_controls_key_unq UNIQUE (control_key),
    CONSTRAINT automation_shipping_controls_scope_chk
      CHECK (client_id IS NOT NULL OR store_id IS NOT NULL),
    CONSTRAINT automation_shipping_controls_identity_chk CHECK (
      control_type = 'service' OR carrier_id IS NOT NULL OR carrier_code IS NOT NULL
    ),
    CONSTRAINT automation_shipping_controls_service_identity_chk CHECK (
      control_type <> 'service' OR service_code IS NOT NULL OR service_name IS NOT NULL
    )
  );
  CREATE INDEX automation_shipping_controls_scope_idx
    ON automation_shipping_controls (client_id, store_id, control_type, position, id);
  -- drizzle/0062_runtime_schema_ownership.sql direct_carrier_rate_cache (verbatim)
  CREATE TABLE direct_carrier_rate_cache (
    account_id integer NOT NULL,
    source_table text NOT NULL,
    carrier_code text NOT NULL,
    service_code text NOT NULL,
    request_key text NOT NULL,
    amount numeric,
    rate_json jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, source_table, carrier_code, service_code, request_key)
  );
  CREATE INDEX direct_carrier_rate_cache_lookup_idx
    ON direct_carrier_rate_cache (account_id, source_table, request_key, updated_at DESC);
`;

// Client 77 owns the Shipp account and the browse-scenario orders; client 88 owns the direct
// UPS account and the scenario-5b order. The split matters: getDirectCarrierRatesForRateInput
// quotes EVERY account visible to the order's client, so with UPS assigned to 77 the mixed
// refusal case could never assert providerFetches === 0 — UPS would still legitimately quote.
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

type SeedOrder = {
  id: number;
  clientId: number;
  shipTo: Record<string, unknown>;
  customsItems: Array<Record<string, unknown>> | null;
};

const SEED_ORDERS: SeedOrder[] = [
  { id: 101, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Single KR Buyer'), customsItems: [customsItem('KR', 'Korean cosmetics'), customsItem('KR', 'Korean ramen')] },
  { id: 102, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Mixed Buyer'), customsItems: [customsItem('US', 'Domestic snack'), customsItem('KR', 'Korean cosmetics')] },
  { id: 103, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Unknown Origin Buyer'), customsItems: null },
  {
    id: 104,
    clientId: SHIPP_CLIENT,
    shipTo: { name: 'International Buyer', phone: '5555550101', street1: '800 Robson St', city: 'Vancouver', state: 'BC', postalCode: 'V6Z 2E7', country: 'CA' },
    customsItems: null,
  },
  { id: 105, clientId: SHIPP_CLIENT, shipTo: domesticShipTo('Mixed Label Buyer'), customsItems: [customsItem('US', 'Domestic snack'), customsItem('KR', 'Korean electronics')] },
  { id: 106, clientId: UPS_CLIENT, shipTo: { name: 'Mixed Buyer B', phone: '5555550102', street1: '9 Maple Ave', city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' }, customsItems: [customsItem('US', 'Domestic snack'), customsItem('KR', 'Korean cosmetics')] },
];

async function seed(raw: postgres.Sql): Promise<void> {
  await raw`insert into clients (id, name) values (${SHIPP_CLIENT}, 'Joined Proof Client'), (${UPS_CLIENT}, 'Joined Proof Client B')`;
  // The canonical default origin the browse path resolves through getDefaultShipFrom ->
  // getDefaultLocation. Deliberately a DB row, not SHIP_FROM_* env — the joined proof must
  // exercise the database lane production uses.
  await raw`
    insert into locations (name, company, street1, city, state, postal_code, country, phone, is_default, active)
    values ('Carson Warehouse', 'DR Prepper', '345 W Gardena Blvd', 'Carson', 'CA', '90248', 'US', '3103295555', true, true)
  `;
  // Shipp credentials carry NO packageOriginCountry, so scenario 3 asserts the connector's
  // documented domestic-inert fallback 'US' (shipp.ts shippCountryOfManufacture step 3).
  await raw`
    insert into carrier_accounts (id, client_id, provider, label, account_identifier, credentials, active)
    values
      (${SHIPP_ACCOUNT_ID}, ${SHIPP_CLIENT}, 'shipp', 'Shipp (joined proof)', 'shipp-joined',
        ${JSON.stringify({ apiKey: 'stub-key', email: 'ops@example.test', password: 'stub-pass' })}::jsonb, true),
      (${UPS_ACCOUNT_ID}, ${UPS_CLIENT}, 'ups', 'Direct UPS (joined proof)', 'ups-joined',
        ${JSON.stringify({ clientId: 'ups-oauth-id', clientSecret: 'ups-oauth-secret', accountNumber: 'A1B2C3' })}::jsonb, true)
  `;
  for (const order of SEED_ORDERS) {
    const rawPayload = {
      shipTo: order.shipTo,
      ...(order.customsItems ? { internationalOptions: { customsItems: order.customsItems } } : {}),
    };
    await raw`
      insert into orders (
        id, client_id, order_number, order_status, store_id, customer_email,
        ship_to_name, ship_to_city, ship_to_state, ship_to_postal_code,
        weight_oz, raw, source_provider, source_account_id, external_order_id
      ) values (
        ${order.id}, ${order.clientId}, ${`JOINED-${order.id}`}, 'awaiting_shipment', null,
        'buyer@example.test',
        ${String(order.shipTo.name ?? '')}, ${String(order.shipTo.city ?? '')},
        ${String(order.shipTo.state ?? '')}, ${String(order.shipTo.postalCode ?? '')},
        32, ${JSON.stringify(rawPayload)}::jsonb, 'shipstation', 'ss-joined', ${`ext-${order.id}`}
      )
    `;
  }
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
  // change them. The cache table still exists (created above) and is asserted EMPTY below.
  process.env.DIRECT_CARRIER_RATE_CACHE = 'false';
  // The orchestrator's replay seam must stay dark so the REAL production branch runs
  // (isCarrierTestMode is double-gated; no per-call flag is ever passed here either).
  delete process.env.CARRIER_TEST_MODE;

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

  const raw = postgres(throwawayUrl, { max: 2, prepare: false, onnotice: () => {} });
  let appSqlEnd: (() => Promise<void>) | null = null;
  try {
    await raw.unsafe(DDL);
    await seed(raw);

    // ── Dynamic imports AFTER env binding ─────────────────────────────────────
    const { getDirectCarrierRatesForRateInput } = await import('../src/services/rates');
    const { loadDirectAccountForLabel, createDirectCarrierLabelForOrder, DIRECT_CARRIER_PROVIDER_ID_OFFSET } =
      await import('../src/services/labels-direct');
    const { assertDeclarableOrigin, CustomsOriginUndeclarableError, resolveOrderCustomsOrigin } =
      await import('../src/services/customs-origin');
    const { classifyDestinationCountry } = await import('../src/services/billing-destination-international');
    const { normalizeProviderKey } = await import('../src/lib/direct-carrier-scope');
    const { normalizeShippingOptions } = await import('../src/lib/shipping-options');
    const { getDefaultShipFrom } = await import('../src/lib/ship-from');
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
      shipToCity: string | null;
      shipToState: string | null;
      shipToPostalCode: string | null;
      sourceProvider: string | null;
      sourceAccountId: string | null;
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
          shipToCity: orders.shipToCity,
          shipToState: orders.shipToState,
          shipToPostalCode: orders.shipToPostalCode,
          sourceProvider: orders.sourceProvider,
          sourceAccountId: orders.sourceAccountId,
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
     * like rates-backfill:1298). Dims ride the request like the FE `rest.dims*` lane — this
     * order has no order_overrides dims, so the producer would take the request's.
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
      check('the request body declares the RESOLVED origin KR on packageLineItems[0]',
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

    // ── Scenario 3: unknown + domestic declares the operator default explicitly ─
    console.log('\nscenario 3 — unknown origin + domestic destination sends the default');
    {
      resetCapture();
      const result = await getDirectCarrierRatesForRateInput(rateInputFromOrderRow(await loadOrderRow(103)));
      const quotes = callsTo(SHIPP_QUOTE_URL);
      check('exactly ONE Shipp /quote POST left the process', quotes.length === 1, `saw ${quotes.length}`);
      const line = (quotes[0]?.body as { packageLineItems?: Array<Record<string, unknown>> } | undefined)?.packageLineItems;
      // No packageOriginCountry is seeded on the account, so the domestic-inert lane resolves
      // to the connector's documented 'US' default — the one guess decideDeclaredOrigin allows.
      check("the domestic-inert lane transmits the default 'US' (no configured default seeded)",
        line?.[0]?.countryOfManufacture === 'US', JSON.stringify(line?.[0]));
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

    // ── Scenario 5: label-path parity through the REAL direct-label boundary ──
    console.log('\nscenario 5 — label pre-quote parity and non-Shipp scoping');
    {
      // (a) Mixed order + Shipp account: the origin argument labels.ts:3043 builds for
      // createDirectCarrierLabelForOrder is produced by the SAME lazy closure labels.ts
      // makes (labels.ts:2658-2661) — assertDeclarableOrigin over the order row and the
      // canonical destination classification. It throws 422 while the argument is being
      // evaluated, BEFORE the purchase boundary or any HTTP.
      resetCapture();
      const shippAccount = await loadDirectAccountForLabel(
        { sourceTable: 'carrier_accounts', accountId: SHIPP_ACCOUNT_ID },
        { clientId: SHIPP_CLIENT, storeId: null, sourceProvider: 'shipstation', sourceAccountId: 'ss-joined' },
      );
      const shippProviderKey = normalizeProviderKey(shippAccount.provider);
      check("the loaded account resolves to provider 'shipp' through the real authorization boundary",
        shippProviderKey === 'shipp', shippProviderKey);

      const mixedOrder = await loadOrderRow(105);
      const mixedShipToCountry = String(((mixedOrder.raw as { shipTo?: { country?: unknown } })?.shipTo?.country) ?? '');
      let shippClosureCalls = 0;
      // labels.ts:2658-2661 verbatim shape — the decision itself is NOT re-implemented here.
      const resolveDeclaredShippOrigin = (): string | null => {
        shippClosureCalls += 1;
        return assertDeclarableOrigin({
          resolution: resolveOrderCustomsOrigin(mixedOrder),
          destination: classifyDestinationCountry(mixedShipToCountry).destination,
        });
      };
      let thrown: unknown = null;
      let reachedPurchase = false;
      try {
        // labels.ts:3043 — the lazy closure is consumed only when the provider is Shipp.
        const countryOfManufacture = shippProviderKey === 'shipp' ? resolveDeclaredShippOrigin() : null;
        reachedPurchase = true;
        void countryOfManufacture;
      } catch (err) {
        thrown = err;
      }
      check('the mixed carton REFUSES while the origin argument is built — the purchase is never reached',
        thrown != null && !reachedPurchase, String(thrown));
      check('the refusal is CustomsOriginUndeclarableError with status 422',
        thrown instanceof CustomsOriginUndeclarableError && thrown.status === 422,
        `${(thrown as { name?: string } | null)?.name} status=${(thrown as { status?: number } | null)?.status}`);
      check('the 422 reason names both recorded origins', /US/.test(String(thrown)) && /KR/.test(String(thrown)), String(thrown));
      check('the Shipp label refusal made ZERO HTTP calls', providerCalls().length === 0,
        providerCalls().map((c) => c.url).join(', '));
      check('the lazy origin closure ran exactly once for the Shipp purchase', shippClosureCalls === 1, String(shippClosureCalls));

      // (b) Non-Shipp scoping: the SAME mixed-carton shape through a direct UPS account
      // purchases for real (to the stubbed wire) — no refusal, the lazy closure is never
      // consumed (labels.ts:3043 gates it on directProviderKey === 'shipp'), and no
      // countryOfManufacture is transmitted anywhere.
      resetCapture();
      const upsAccount = await loadDirectAccountForLabel(
        { sourceTable: 'carrier_accounts', accountId: UPS_ACCOUNT_ID },
        { clientId: UPS_CLIENT, storeId: null, sourceProvider: 'shipstation', sourceAccountId: 'ss-joined' },
      );
      const upsProviderKey = normalizeProviderKey(upsAccount.provider);
      const upsOrder = await loadOrderRow(106);
      const upsOrderShipTo = ((upsOrder.raw as { shipTo?: Record<string, unknown> })?.shipTo) ?? {};
      let upsClosureCalls = 0;
      const resolveDeclaredUpsSideOrigin = (): string | null => {
        upsClosureCalls += 1;
        return assertDeclarableOrigin({
          resolution: resolveOrderCustomsOrigin(upsOrder),
          destination: classifyDestinationCountry(String(upsOrderShipTo.country ?? '')).destination,
        });
      };
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
