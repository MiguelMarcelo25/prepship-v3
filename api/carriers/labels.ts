// @ts-nocheck
// Vercel serverless function: purchase a shipping label via the carrier
// the user picked in Rate Browser. Closes the rate-quote loop end-to-end —
// before this endpoint, our direct integrations could ONLY get rates;
// actually buying the label still required ShipStation. With this in
// place, PrepShip can ship orders without ShipStation in the loop.
//
// Auth: Supabase JWT in Authorization: Bearer <token>.
//
// POST body:
//   {
//     carrierAccountId: number,            // saved carrier_accounts row id
//     externalOrderId?: string,            // e.g. "walmart-12345" — for ship-to + items
//     rateId?: string,                     // EasyPost-only: which of the rates to buy
//     serviceCode?: string,                // UPS/USPS/etc: pick a specific service
//     weightOz: number,
//     dimsL: number, dimsW: number, dimsH: number,
//     // Optional explicit ship-to override (useful when externalOrderId
//     // isn't a marketplace pull):
//     shipTo?: { name, street1, street2?, city, state, zip, country, phone? }
//   }
//
// Response (success):
//   { ok: true, provider, trackingNumber, labelUrl, labelFormat: 'PDF',
//     cost: number, currency: 'USD', shipmentId?: string }
// Response (failure):
//   { ok: false, error: string, meta?: ... }

import postgres from 'postgres';
// COLD-START FIX (label/print-queue audit 2026-06-11): the rate-quote-snapshot-store and
// shipping-safety modules were STATIC imports that transitively pull a module-load env/DB throw,
// crashing the WHOLE function as an uncatchable FUNCTION_INVOCATION_FAILED at COLD START — before
// the handler's try/catch — whenever a required Vercel env var (DATABASE_URL/SUPABASE_URL) was
// missing/invalid. That defeated env.ts's own design (env.ts:107-113 throws-not-process.exit on
// serverless precisely so the handler returns a clean, actionable 500 naming the missing var). The
// two cold-start env/DB pullers were:
//   • rate-quote-snapshot-store -> analytics-cache -> db/client  (pg pool + env at module load)
//   • shipping-safety           -> env                           (throws on missing DATABASE_URL/SUPABASE_URL)
// They are now deferred into ensureLabelDeps() (request time, inside the handler's try/catch) so an
// env/load failure is a catchable 500, not the opaque crash page. (evaluateDirectCarrierScope above
// and the residential classifier below are pure leaves — no env/db at module load — so they stay static.)
// COLD-START HARDENING (2026-06-11, FUNCTION_INVOCATION_FAILED recurrence): production probes
// showed THIS function crashing at module load (even a GET never reached the handler) while the
// sibling api/carriers/rates.ts — whose ONLY static deps are npm packages — stayed healthy. The
// remaining src/ static imports (direct-carrier-scope, address-classification) and the in-file
// jose JWKS verifier are now ALL deferred into ensureLabelDeps(), making this module's cold-start
// surface identical to the proven-healthy sibling: static imports = npm packages only. Whatever
// the bundler/runtime does to the src tree, a load failure is now a catchable JSON 500 naming the
// failed boundary — never the opaque platform crash page.

// ROOT CAUSE FIX (mirrors api/carriers/rates.ts): these were STATIC imports at
// module top. On Vercel, importing the carrier/store connector orchestrators +
// the shipping-eligibility tree pulls a wide src/ bundle that threw at COLD
// START, crashing the WHOLE function as FUNCTION_INVOCATION_FAILED *before the
// handler ran* — so EVERY direct-carrier label (shipp/ups/easypost/walmart)
// failed uniformly while ShipStation (a different, Render-side path) kept
// working. Defer them to request time (via ensureLabelDeps below) so a load
// failure becomes a clean, catchable 500 instead of an uncatchable crash.
let persistDirectCarrierLabel: any;
let assertFulfillmentSchemaReady: any;
let createCarrierLabel: any;
let confirmStoreShipment: any;
let lookupWalmartOrderByCustomerOrderIdForLabels: any;
let normalizeShippingOptions: any;
let assertShippingServiceEligible: any;
let processFulfillmentOutboxOnce: any;
let getDefaultShipFrom: any;
// Deferred (cold-start fix 2026-06-11) — these pull env/db at module load; loaded at request time.
let assertLabelPurchaseRateSelection: any;
let assertOrderSafeToShip: any;
let ShippingSafetyError: any;
// Deferred (cold-start hardening 2026-06-11) — the last src/ statics + the jose verifier.
let evaluateDirectCarrierScope: any;
let classifyShippingAddress: any;
let residentialForShipping: any;
let verifySupabaseJwt: any;
let _labelDepsLoaded = false;
async function ensureLabelDeps(): Promise<void> {
  if (_labelDepsLoaded) return;
  // Auth + pure-leaf classifiers — deferred so the module's static surface is npm-only.
  verifySupabaseJwt = (await import('../../src/lib/auth/verify-supabase-jwt.js')).verifySupabaseJwt;
  evaluateDirectCarrierScope = (await import('../../src/lib/direct-carrier-scope.js')).evaluateDirectCarrierScope;
  const addressClassification = await import('../../src/services/shipping-workflow/address-classification.js');
  classifyShippingAddress = addressClassification.classifyShippingAddress;
  residentialForShipping = addressClassification.residentialForShipping;
  persistDirectCarrierLabel = (await import('../../src/services/direct-label-persistence.js')).persistDirectCarrierLabel;
  assertFulfillmentSchemaReady = (await import('../../src/services/fulfillment/schema-readiness.js')).assertFulfillmentSchemaReady;
  createCarrierLabel = (await import('../../src/services/carrier-connector-orchestrator.js')).createCarrierLabel;
  confirmStoreShipment = (await import('../../src/services/store-connector-orchestrator.js')).confirmStoreShipment;
  lookupWalmartOrderByCustomerOrderIdForLabels = (await import('../../src/connectors/store/walmart.js')).lookupWalmartOrderByCustomerOrderId;
  normalizeShippingOptions = (await import('../../src/lib/shipping-options.js')).normalizeShippingOptions;
  assertShippingServiceEligible = (await import('../../src/lib/shipping-service-eligibility.js')).assertShippingServiceEligible;
  processFulfillmentOutboxOnce = (await import('../../src/services/fulfillment/outbox.js')).processFulfillmentOutboxOnce;
  getDefaultShipFrom = (await import('../../src/lib/ship-from.js')).getDefaultShipFrom;
  // Cold-start fix: deferred so a missing/invalid env var surfaces as a catchable 500 here (inside
  // the handler's try/catch) instead of an uncatchable FUNCTION_INVOCATION_FAILED at module load.
  assertLabelPurchaseRateSelection = (await import('../../src/services/shipping-workflow/rate-quote-snapshot-store.js')).assertLabelPurchaseRateSelection;
  const shippingSafetyMod = await import('../../src/services/fulfillment/shipping-safety.js');
  assertOrderSafeToShip = shippingSafetyMod.assertOrderSafeToShip;
  ShippingSafetyError = shippingSafetyMod.ShippingSafetyError;
  _labelDepsLoaded = true;
}

// POLICY (DJ, 2026-06-04): direct-carrier labels (shipp/ups/easypost/walmart)
// must use the default Location (Settings -> Location) as the authoritative
// ship-from — same source the ShipStation path already uses via
// getDefaultShipFrom(). Every direct connector reads creds.shipFrom* FIRST, so
// we overwrite those keys here, before any carrier branch runs. This kills the
// stale "SHIPPHQ WAREHOUSE" and the 'Seller'/'Warehouse'/'Carson' placeholders
// uniformly. If no default Location / SHIP_FROM_* env is configured,
// getDefaultShipFrom() throws and we leave creds untouched (prior behavior),
// so label creation never breaks because of this.
async function applyDefaultLocationShipFrom(creds: Record<string, unknown>): Promise<void> {
  try {
    const loc = await getDefaultShipFrom();
    if (!loc || !loc.address_line1 || !loc.city_locality || !loc.state_province || !loc.postal_code) return;
    creds.shipFromName = loc.name ?? creds.shipFromName;
    creds.shipFromCompany = loc.company_name ?? loc.name ?? creds.shipFromCompany;
    creds.shipFromAddress1 = loc.address_line1;
    creds.shipFromAddress2 = loc.address_line2 ?? '';
    creds.shipFromCity = loc.city_locality;
    creds.shipFromState = loc.state_province;
    creds.shipFromZip = loc.postal_code;
    if (loc.phone) creds.shipFromPhone = loc.phone;
  } catch {
    // No default Location / SHIP_FROM_* env configured — keep existing creds.
  }
}

// PS-078 / direct-carrier end-to-end: after a direct-carrier label is bought and
// its source confirmation is ENQUEUED, the marketplace notification must actually
// FIRE in-request (Vercel freezes the function after the response, so it cannot be
// backgrounded). ShipStation's Render path already does this via
// processFulfillmentOutboxOnce; this mirrors it for the direct carriers so a
// Shipp/UPS/EasyPost label on a ShipStation- or eBay-sourced order still notifies
// the upstream marketplace and marks it shipped. Idempotent (succeeded outbox
// rows are skipped, so the Walmart immediate-confirm is not double-sent). Never
// throws — the label/postage is already real, so a confirmation hiccup is
// surfaced in meta and left as a retryable outbox row, not a 500.
async function processOrderConfirmationNow(
  orderId: number,
): Promise<{ processed: number; succeeded: number; failed: number } | null> {
  if (!Number.isFinite(orderId) || orderId <= 0) return null;
  try {
    const summary = await processFulfillmentOutboxOnce({ orderId, limit: 5 });
    return {
      processed: Number(summary?.processed ?? 0) || 0,
      succeeded: Number(summary?.succeeded ?? 0) || 0,
      failed: Number(summary?.failed ?? 0) || 0,
    };
  } catch (err) {
    console.warn('[carriers/labels] confirmation outbox processing failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Supabase JWT verification is deferred into ensureLabelDeps (the canonical
// src/lib/auth/verify-supabase-jwt owner) — the in-file jose JWKS copy is gone
// so this module's static surface stays npm-only (cold-start hardening 2026-06-11).

function inferStoreProviderFromExternalId(externalOrderId: string | null | undefined): string {
  if (!externalOrderId) return 'shipstation';
  const match = externalOrderId.match(/^([a-z_]+)-(.+)$/i);
  return match?.[1]?.toLowerCase() ?? 'shipstation';
}

function sourceOrderIdFromExternalId(externalOrderId: string | null | undefined): string | null {
  if (!externalOrderId) return null;
  const match = externalOrderId.match(/^[a-z_]+-(.+)$/i);
  return match?.[1] ?? externalOrderId;
}

function assertDirectCarrierServiceEligible(args: {
  body: Record<string, any>;
  orderRow: any;
  providerKey: string;
  serviceCode: string | number | null | undefined;
  serviceName?: string | null;
}) {
  assertShippingServiceEligible(
    {
      clientId: args.body?.clientId ?? args.orderRow?.client_id ?? null,
      clientName: args.body?.clientName ?? args.orderRow?.client_name ?? null,
      storeId: args.body?.storeId ?? args.orderRow?.store_id ?? null,
    },
    {
      provider: args.providerKey,
      carrierCode: args.providerKey,
      serviceCode: args.serviceCode,
      serviceName: args.serviceName ?? String(args.serviceCode ?? ''),
    },
    normalizeShippingOptions(args.body),
  );
}

async function ensureFulfillmentOutboxSql(sql: any): Promise<void> {
  // Per user override unlock shipped data on 2026-05-23: remove
  // request-time shipment/outbox DDL and require migration-owned schema.
  await assertFulfillmentSchemaReady(sql);
}

async function enqueueShipmentConfirmationSql(
  sql: any,
  args: {
    orderId: number;
    shipmentId: number;
    externalOrderId: string | null;
    clientId: number | null;
    orderNumber: string | null;
    trackingNumber: string;
    carrierCode: string | null;
    carrierProvider: string;
    carrierAccountId: number | string | null;
    confirmationProvider?: string | null;
    shipDate?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<{ queued: boolean; provider: string }> {
  await ensureFulfillmentOutboxSql(sql);
  // PS-136 (Per user override unlock shipped data on 2026-06-09): delegate the confirmation-
  // provider decision AND the support check to the CANONICAL owners — one source of truth —
  // instead of this file's local inferrer + a hardcoded provider list. Dynamic import keeps it
  // cold-start safe (matches this file's deferred connector-import pattern; this runs only after
  // a label is bought, never at module init). resolveShipmentConfirmationProvider returns null
  // for manual/internal/no-marketplace orders (=> not_required, no spurious confirmation), and
  // "supported" is the registry's LIVE shipment.confirm capability, NOT a hardcoded literal.
  const { resolveShipmentConfirmationProvider } = await import('../../src/services/fulfillment/outbox.js');
  const { resolveStoreConnector } = await import('../../src/connectors/store-resolution.js');
  const resolvedProvider = resolveShipmentConfirmationProvider({
    sourceProvider: args.confirmationProvider ?? null,
    externalOrderId: args.externalOrderId,
  });
  const confirmConnector = resolvedProvider ? resolveStoreConnector(resolvedProvider, 'shipment.confirm') : null;
  const supported = !!confirmConnector && confirmConnector.implementation.status === 'live';
  const confirmationLastError = supported
    ? null
    : resolvedProvider
      ? `${resolvedProvider} shipment confirmation connector is ${confirmConnector ? confirmConnector.implementation.status : 'unavailable'}`
      : null;
  await sql`
    UPDATE orders
    SET
      source_provider = COALESCE(source_provider, ${resolvedProvider}),
      source_order_id = COALESCE(source_order_id, ${sourceOrderIdFromExternalId(args.externalOrderId)}),
      source_order_number = COALESCE(source_order_number, ${args.orderNumber}),
      canonical_status = CASE
        WHEN ${supported} THEN 'shipped_pending_confirmation'
        ELSE COALESCE(canonical_status, order_status)
      END,
      updated_at = NOW()
    WHERE id = ${args.orderId}
  `;
  await sql`
    UPDATE shipments
    SET
      carrier_provider = ${args.carrierProvider},
      carrier_account_id = ${args.carrierAccountId == null ? null : String(args.carrierAccountId)},
      confirmation_provider = ${resolvedProvider},
      confirmation_status = ${supported ? 'pending' : 'not_required'},
      confirmation_last_error = ${confirmationLastError},
      updated_at = NOW()
    WHERE id = ${args.shipmentId}
  `;
  if (!supported) return { queued: false, provider: resolvedProvider ?? 'none' };
  const provider = resolvedProvider;

  const payload = {
    ...args.payload,
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    externalOrderId: args.externalOrderId,
    clientId: args.clientId,
    orderNumber: args.orderNumber,
    trackingNumber: args.trackingNumber,
    carrierCode: args.carrierCode,
    carrierProvider: args.carrierProvider,
    carrierAccountId: args.carrierAccountId,
    shipDate: args.shipDate ?? new Date().toISOString().slice(0, 10),
  };
  const dedupeKey = `shipment_confirmation_requested:${provider}:${args.orderId}:${args.shipmentId}`;
  await sql`
    INSERT INTO fulfillment_outbox (
      order_id, shipment_id, event_type, provider, dedupe_key, payload,
      status, attempts, next_run_at, updated_at
    )
    VALUES (
      ${args.orderId}, ${args.shipmentId}, 'shipment_confirmation_requested',
      ${provider}, ${dedupeKey}, ${sql.json(payload)}, 'pending', 0, NOW(), NOW()
    )
    ON CONFLICT (dedupe_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      status = CASE
        WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.status
        ELSE 'pending'
      END,
      next_run_at = CASE
        WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.next_run_at
        ELSE NOW()
      END,
      updated_at = NOW()
  `;
  return { queued: true, provider };
}

function readBody(req: any): Promise<unknown> {
  if (req.body) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// ─── UPS access-token helper (mirrors the one in rates.ts; we duplicate
//     to keep this file self-contained — the function is short and the
//     duplication is preferable to factoring out a shared module).
// ─── Resolve a ship-to address from various sources ──────────────────
// Order of preference: explicit body.shipTo → marketplace order's saved
// raw payload → throw (we genuinely need an address).
function validateResolvedShipTo(input: any, source: string) {
  const shipTo = {
    name: String(input?.name ?? 'Buyer').trim() || 'Buyer',
    street1: String(input?.street1 ?? '').trim(),
    street2: String(input?.street2 ?? '').trim(),
    city: String(input?.city ?? '').trim(),
    state: String(input?.state ?? '').trim(),
    zip: String(input?.zip ?? input?.postalCode ?? '').trim(),
    country: String(input?.country ?? input?.countryCode ?? 'US').trim() || 'US',
    phone: String(input?.phone ?? '0000000000').trim() || '0000000000',
  };
  if (!shipTo.name || !shipTo.street1 || !shipTo.city || !shipTo.state || !shipTo.zip || !shipTo.country) {
    throw new Error(`Could not resolve complete ship-to address from ${source}; no postage was purchased`);
  }
  return shipTo;
}

function resolveLocalOrderShipTo(orderRow: any) {
  const rawShipTo = orderRow?.raw?.shipTo ?? orderRow?.raw?.ship_to ?? {};
  const street1 = rawShipTo?.street1 ?? rawShipTo?.address1 ?? rawShipTo?.addressLine1 ?? rawShipTo?.address_line1;
  if (!orderRow && !street1) return null;
  return validateResolvedShipTo(
    {
      name: rawShipTo?.name ?? orderRow?.ship_to_name ?? orderRow?.shipToName,
      street1,
      street2: rawShipTo?.street2 ?? rawShipTo?.address2 ?? rawShipTo?.addressLine2 ?? rawShipTo?.address_line2,
      city: rawShipTo?.city ?? orderRow?.ship_to_city ?? orderRow?.shipToCity,
      state: rawShipTo?.state ?? rawShipTo?.stateOrProvince ?? orderRow?.ship_to_state ?? orderRow?.shipToState,
      zip: rawShipTo?.postalCode ?? rawShipTo?.zip ?? rawShipTo?.postal_code ?? orderRow?.ship_to_postal_code ?? orderRow?.shipToPostalCode,
      country: rawShipTo?.country ?? rawShipTo?.countryCode ?? rawShipTo?.country_code ?? 'US',
      phone: rawShipTo?.phone,
    },
    'local order',
  );
}

function resolveShipTo(body: any, rawOrder: any, orderRow: any) {
  if (body?.shipTo && typeof body.shipTo === 'object') {
    return validateResolvedShipTo({
      name: String(body.shipTo.name ?? 'Buyer'),
      street1: String(body.shipTo.street1 ?? body.shipTo.address1 ?? ''),
      street2: String(body.shipTo.street2 ?? body.shipTo.address2 ?? ''),
      city: String(body.shipTo.city ?? ''),
      state: String(body.shipTo.state ?? ''),
      zip: String(body.shipTo.zip ?? body.shipTo.postalCode ?? ''),
      country: String(body.shipTo.country ?? body.shipTo.countryCode ?? 'US'),
      phone: String(body.shipTo.phone ?? '0000000000'),
    }, 'request payload');
  }
  // Walmart order shape
  const wmAddr = rawOrder?.shippingInfo?.postalAddress;
  if (wmAddr) {
    return validateResolvedShipTo({
      name: wmAddr.name ?? 'Buyer',
      street1: wmAddr.address1 ?? '',
      street2: wmAddr.address2 ?? '',
      city: wmAddr.city ?? '',
      state: wmAddr.state ?? '',
      zip: wmAddr.postalCode ?? '',
      country: wmAddr.country ?? 'US',
      phone: rawOrder?.shippingInfo?.phone ?? '0000000000',
    }, 'Walmart order payload');
  }
  // eBay order shape
  const ebAddr = rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress;
  const ebFullName = rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName;
  if (ebAddr) {
    return validateResolvedShipTo({
      name: ebFullName ?? 'Buyer',
      street1: ebAddr.addressLine1 ?? '',
      street2: ebAddr.addressLine2 ?? '',
      city: ebAddr.city ?? '',
      state: ebAddr.stateOrProvince ?? '',
      zip: ebAddr.postalCode ?? '',
      country: ebAddr.countryCode ?? 'US',
      phone: rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.primaryPhone?.phoneNumber ?? '0000000000',
    }, 'eBay order payload');
  }
  // Amazon order shape
  if (rawOrder?.ShippingAddress) {
    const a = rawOrder.ShippingAddress;
    return validateResolvedShipTo({
      name: a.Name ?? 'Buyer',
      street1: a.AddressLine1 ?? '',
      street2: a.AddressLine2 ?? '',
      city: a.City ?? '',
      state: a.StateOrRegion ?? '',
      zip: a.PostalCode ?? '',
      country: a.CountryCode ?? 'US',
      phone: a.Phone ?? '0000000000',
    }, 'Amazon order payload');
  }
  const localShipTo = resolveLocalOrderShipTo(orderRow);
  if (localShipTo) return localShipTo;
  throw new Error('Could not resolve ship-to address — pass body.shipTo explicitly or use an externalOrderId from a marketplace pull');
}

function resolveShipFrom(creds: Record<string, unknown>) {
  const fromZip = String(creds?.shipFromZip ?? '').replace(/[^0-9]/g, '').slice(0, 5) || '90248';
  return {
    name: String(creds?.shipFromName ?? '').trim() || 'Seller',
    street1: String(creds?.shipFromAddress1 ?? '').trim() || 'Warehouse',
    city: String(creds?.shipFromCity ?? '').trim() || 'Carson',
    state: String(creds?.shipFromState ?? '').trim() || 'CA',
    zip: fromZip,
    country: 'US',
    phone: String(creds?.shipFromPhone ?? '').trim() || '0000000000',
  };
}

// Direct carrier label HTTP calls are owned by CarrierConnector implementations.
const SHIPP_PROVIDER_ID_OFFSET = 10_000_000;

function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const LABEL_CREATE_CONNECTOR_CAPABILITIES: Record<string, string[]> = {
  shipp: ['rates.quote', 'labels.create', 'tracking.read', 'credentials.verify'],
  walmart_shipping: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  ups: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify'],
  easypost: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read', 'credentials.verify', 'webhooks.receive'],
};

function labelCreateConnectorCapabilities(providerKey: string): string[] | null {
  return LABEL_CREATE_CONNECTOR_CAPABILITIES[providerKey] ?? null;
}

function slugRateService(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'rate';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeCarrierCodeForDirectRate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = normalizeProviderKey(raw);
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (compact.includes('fedex')) return 'fedex';
  if (compact.includes('usps') || compact.includes('postal')) return 'stamps_com';
  if (compact.includes('ups')) return 'ups';
  if (compact.includes('dhl')) return 'dhl_express';
  if (compact.includes('walmart')) return 'walmart_shipping';
  if (compact.includes('amazon')) return 'amazon_shipping';
  if (compact.includes('ebay')) return 'ebay_shipping';
  return normalized || null;
}

function inferCarrierCodeForDirectRate(provider: string, service: string): string {
  const p = normalizeProviderKey(provider);
  const s = service.toLowerCase();
  if (s.includes('usps') || s.includes('postal')) return 'stamps_com';
  if (s.includes('fedex')) return 'fedex';
  if (s.includes('ups')) return 'ups';
  if (s.includes('dhl')) return 'dhl_express';
  return p || 'direct_carrier';
}

function walmartEstimateCarrierName(rate: any): string {
  return firstString(
    rate?.carrierName,
    rate?.carrier?.shortName,
    rate?.carrierShortName,
    rate?.carrier,
    rate?.carrierDisplayName,
  );
}

function walmartEstimateServiceType(rate: any): string {
  return firstString(
    rate?.name,
    rate?.serviceType,
    rate?.carrierServiceType,
    rate?.carrierServiceName,
    rate?.serviceLevel,
    rate?.method,
    rate?.displayName,
  );
}

function walmartEstimateServiceName(rate: any): string {
  const carrier = firstString(
    rate?.carrierDisplayName,
    rate?.carrierFullName,
    rate?.carrierName,
    rate?.carrier?.shortName,
    rate?.carrierShortName,
    rate?.carrier,
    'Walmart',
  );
  const service = firstString(
    rate?.displayName,
    rate?.serviceTypeGroupDisplayName,
    rate?.serviceType,
    rate?.carrierServiceType,
    rate?.serviceLevel,
    rate?.method,
    rate?.name,
  );
  return service ? `${carrier} ${service}` : carrier;
}

function walmartEstimateServiceCode(rate: any): string {
  const provider = 'walmart_shipping';
  const serviceName = walmartEstimateServiceName(rate);
  const explicitCarrierCode = normalizeCarrierCodeForDirectRate(
    rate?.carrierCode ?? rate?.carrierType ?? rate?.carrierName ?? rate?.carrierDisplayName,
  );
  const carrierCode = explicitCarrierCode ?? inferCarrierCodeForDirectRate(provider, serviceName);
  const carrierServicePrefix = carrierCode && carrierCode !== provider ? `${carrierCode}_` : '';
  return `${provider}_${carrierServicePrefix}${slugRateService(serviceName)}`;
}

function walmartEstimateCost(rate: any): number {
  return Number(
    rate?.estimatedRate?.amount ??
    rate?.totalCost?.amount ??
    rate?.cost?.amount ??
    rate?.totalCost ??
    rate?.cost ??
    rate?.amount ??
    0,
  ) || 0;
}

function walmartEstimateCurrency(rate: any): string {
  return String(
    rate?.estimatedRate?.currency ??
    rate?.totalCost?.currency ??
    rate?.cost?.currency ??
    rate?.currency ??
    'USD',
  );
}

function walmartEstimateList(data: any): any[] {
  return (
    (Array.isArray(data?.data?.estimates) && data.data.estimates) ||
    (Array.isArray(data?.shippingEstimates) && data.shippingEstimates) ||
    (Array.isArray(data?.rates) && data.rates) ||
    (Array.isArray(data?.estimates) && data.estimates) ||
    (Array.isArray(data?.payload) && data.payload) ||
    (Array.isArray(data) ? data : [])
  );
}

function selectWalmartOrderByCustomerOrderId(
  data: unknown,
  customerOrderId: string,
): { purchaseOrderId: string; rawOrder: any } | null {
  const trimmed = customerOrderId.trim();
  const ordersRaw = ((data as any)?.list?.elements as { order?: unknown[] | unknown } | undefined)?.order;
  const orders = Array.isArray(ordersRaw) ? ordersRaw : ordersRaw ? [ordersRaw] : [];
  const match = orders.find((order) => String((order as any)?.customerOrderId ?? '').trim() === trimmed);
  if (!match) return null;
  const purchaseOrderId = String((match as any)?.purchaseOrderId ?? '').trim();
  return purchaseOrderId ? { purchaseOrderId, rawOrder: match } : null;
}

function walmartRawOrderUsable(rawOrder: any): boolean {
  return Boolean(
    Array.isArray(rawOrder?.orderLines?.orderLine) ||
    rawOrder?.shippingInfo?.postalAddress,
  );
}

async function resolveWalmartLabelContext(
  sql: any,
  creds: Record<string, unknown>,
  body: Record<string, any>,
  orderRow: any,
  initialRawOrder: any,
): Promise<{
  purchaseOrderId: string;
  purchaseOrderSource: string;
  storeAccountId: number | null;
  rawOrder: any;
  externalOrderId: string | null;
  orderNumber: string | null;
}> {
  let rawOrder = initialRawOrder;
  let externalOrderId = typeof body?.externalOrderId === 'string'
    ? body.externalOrderId
    : orderRow?.external_order_id ?? null;
  let orderNumber = typeof body?.orderNumber === 'string'
    ? body.orderNumber
    : orderRow?.order_number ?? null;
  let purchaseOrderId = firstString(body?.purchaseOrderId, rawOrder?.purchaseOrderId);
  let purchaseOrderSource = purchaseOrderId ? 'body.purchaseOrderId' : 'none';
  let storeAccountId: number | null = null;

  if (!purchaseOrderId && externalOrderId?.startsWith('walmart-')) {
    purchaseOrderId = externalOrderId.slice('walmart-'.length);
    purchaseOrderSource = 'orders.external_order_id';
  }

  const lookupA = purchaseOrderId ?? '';
  const lookupB = externalOrderId?.startsWith('walmart-')
    ? externalOrderId.slice('walmart-'.length)
    : externalOrderId ?? '';
  const lookupC = orderNumber ?? '';

  if (lookupA || lookupB || lookupC) {
    try {
      const orderRows = await sql<Array<{ carrier_account_id: number | null; external_order_id: string; customer_order_id?: string | null; raw: any }>>`
        SELECT carrier_account_id, external_order_id, customer_order_id, raw FROM store_orders
        WHERE provider = 'walmart'
          AND (
            external_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
            OR customer_order_id IN (${lookupA}, ${lookupB}, ${lookupC})
          )
        ORDER BY last_fetched_at DESC NULLS LAST
        LIMIT 1
      `;
      if (orderRows[0]) {
        purchaseOrderId = orderRows[0].external_order_id;
        storeAccountId = orderRows[0].carrier_account_id ?? storeAccountId;
        purchaseOrderSource = purchaseOrderSource === 'none'
          ? 'store_orders lookup'
          : purchaseOrderSource;
        rawOrder = orderRows[0].raw ?? rawOrder;
        externalOrderId = externalOrderId ?? `walmart-${purchaseOrderId}`;
        orderNumber = orderNumber ?? orderRows[0].customer_order_id ?? rawOrder?.customerOrderId ?? null;
      }
    } catch { /* non-fatal */ }
  }

  const candidateCustomerOrderId = (() => {
    const rawCustomerOrderId = firstString(rawOrder?.customerOrderId);
    if (lookupC && /^\d{8,}$/.test(lookupC.trim())) return lookupC.trim();
    if (rawCustomerOrderId && /^\d{8,}$/.test(rawCustomerOrderId.trim())) return rawCustomerOrderId.trim();
    return null;
  })();
  if (candidateCustomerOrderId) {
    const looked = await lookupWalmartOrderByCustomerOrderIdForLabels(creds, candidateCustomerOrderId);
    if (looked) {
      if (purchaseOrderId && purchaseOrderId !== looked.purchaseOrderId) {
        console.warn('[carriers/labels] walmart live PO verification replaced cached purchaseOrderId', {
          customerOrderId: candidateCustomerOrderId,
          previousPurchaseOrderId: purchaseOrderId,
          livePurchaseOrderId: looked.purchaseOrderId,
        });
      }
      purchaseOrderSource = 'walmart_marketplace_api';
      purchaseOrderId = looked.purchaseOrderId;
      rawOrder = looked.rawOrder ?? rawOrder;
      orderNumber = String((looked.rawOrder as any)?.customerOrderId ?? candidateCustomerOrderId);
      externalOrderId = `walmart-${purchaseOrderId}`;
    } else {
      throw new Error(
        `Could not verify live Walmart PO# for customerOrderId ${candidateCustomerOrderId}. Label not purchased.`,
      );
    }
  }

  if (purchaseOrderId && !walmartRawOrderUsable(rawOrder)) {
    try {
      const orderRows = await sql<Array<{ carrier_account_id: number | null; raw: any }>>`
        SELECT carrier_account_id, raw FROM store_orders
        WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
        LIMIT 1
      `;
      storeAccountId = orderRows[0]?.carrier_account_id ?? storeAccountId;
      rawOrder = orderRows[0]?.raw ?? null;
    } catch { /* non-fatal */ }
  }

  if (!purchaseOrderId) {
    throw new Error(
      'Walmart Shipping labels require a Walmart purchaseOrderId. Pull/refresh the Walmart order, then reopen Browse Rates from that order.',
    );
  }

  return {
    purchaseOrderId,
    purchaseOrderSource,
    storeAccountId,
    rawOrder,
    externalOrderId,
    orderNumber,
  };
}

// Walmart Shipping label purchase HTTP is owned by src/connectors/carrier/walmart-shipping.ts.
function walmartTrackingUrl(carrierName: string, trackingNumber: string): string {
  const carrier = normalizeProviderKey(carrierName);
  const encoded = encodeURIComponent(trackingNumber);
  if (carrier.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (carrier.includes('ups')) return `https://www.ups.com/track?tracknum=${encoded}`;
  if (carrier.includes('usps') || carrier.includes('postal')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  return '';
}

export function __test_selectWalmartOrderByCustomerOrderId(data: unknown, customerOrderId: string) {
  return selectWalmartOrderByCustomerOrderId(data, customerOrderId);
}

async function markWalmartConfirmationAttemptSql(
  sql: any,
  args: {
    orderId: number;
    shipmentId: number;
    provider: string;
    succeeded: boolean;
    error?: string | null;
  },
): Promise<void> {
  const dedupeKeyPrefix = `shipment_confirmation_requested:${args.provider}:${args.orderId}:${args.shipmentId}`;
  await sql`
    UPDATE shipments
    SET
      confirmation_status = ${args.succeeded ? 'succeeded' : 'failed'},
      confirmation_attempts = COALESCE(confirmation_attempts, 0) + 1,
      confirmation_last_error = ${args.succeeded ? null : args.error ?? 'Walmart confirmation failed'},
      marketplace_confirmed_at = CASE WHEN ${args.succeeded} THEN NOW() ELSE marketplace_confirmed_at END,
      updated_at = NOW()
    WHERE id = ${args.shipmentId}
  `;
  await sql`
    UPDATE fulfillment_outbox
    SET
      status = ${args.succeeded ? 'succeeded' : 'failed'},
      attempts = attempts + 1,
      last_error = ${args.succeeded ? null : args.error ?? 'Walmart confirmation failed'},
      next_run_at = CASE
        WHEN ${args.succeeded} THEN next_run_at
        ELSE NOW() + INTERVAL '2 minutes'
      END,
      updated_at = NOW()
    WHERE dedupe_key = ${dedupeKeyPrefix}
  `;
  await sql`
    UPDATE orders
    SET canonical_status = ${args.succeeded ? 'shipped' : 'confirmation_failed'}, updated_at = NOW()
    WHERE id = ${args.orderId}
  `;
}

async function loadWalmartStoreCredentialsForConfirmationSql(
  sql: any,
  args: {
    purchaseOrderId?: string | null;
    storeAccountId?: number | string | null;
    fallbackCreds: Record<string, unknown>;
  },
): Promise<{ credentials: Record<string, unknown>; storeAccountId: number | null; source: string }> {
  const explicitId = Number(args.storeAccountId);
  let accountId = Number.isFinite(explicitId) && explicitId > 0 ? Math.trunc(explicitId) : null;

  const loadById = async (id: number) => {
    const rows = await sql<Array<{ id: number; credentials: Record<string, unknown> }>>`
      SELECT id, credentials
      FROM store_accounts
      WHERE id = ${id} AND provider = 'walmart'
      LIMIT 1
    `;
    const row = rows[0];
    return row?.credentials ? { credentials: row.credentials, storeAccountId: row.id, source: `store_accounts.${row.id}` } : null;
  };

  if (accountId) {
    const explicit = await loadById(accountId).catch(() => null);
    if (explicit) return explicit;
    accountId = null;
  }

  const purchaseOrderId = firstString(args.purchaseOrderId);
  if (purchaseOrderId) {
    const rows = await sql<Array<{ carrier_account_id: number | null }>>`
      SELECT carrier_account_id
      FROM store_orders
      WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
      LIMIT 1
    `.catch(() => []) as Array<{ carrier_account_id: number | null }>;
    const inferredId = rows[0]?.carrier_account_id;
    if (inferredId) {
      const inferred = await loadById(inferredId).catch(() => null);
      if (inferred) return { ...inferred, source: `store_orders.${purchaseOrderId}->${inferred.source}` };
    }
  }

  return { credentials: args.fallbackCreds, storeAccountId: null, source: 'label_account_fallback' };
}

async function confirmWalmartSourceOrderAfterLabelSql(
  sql: any,
  args: {
    orderId: number;
    shipmentId: number;
    purchaseOrderId: string | null;
    rawOrder: any;
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string;
    shipDate?: string | null;
    storeAccountId?: number | string | null;
    fallbackCreds: Record<string, unknown>;
  },
): Promise<{
  confirmed: boolean;
  error: string | null;
  raw: any;
  storeAccountId: number | null;
  credentialSource: string;
}> {
  const purchaseOrderId = firstString(args.purchaseOrderId);
  if (!purchaseOrderId) {
    throw new Error('Walmart shipment confirmation missing purchaseOrderId');
  }

  const loaded = await loadWalmartStoreCredentialsForConfirmationSql(sql, {
    purchaseOrderId,
    storeAccountId: args.storeAccountId,
    fallbackCreds: args.fallbackCreds,
  });
  const confirmation = await confirmStoreShipment('walmart', {
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    externalOrderId: `walmart-${purchaseOrderId}`,
    clientId: null,
    orderNumber: null,
    trackingNumber: args.trackingNumber,
    carrierCode: args.carrierName,
    shipDate: args.shipDate ?? new Date().toISOString().slice(0, 10),
    credentials: loaded.credentials as Record<string, string | null | undefined>,
    payload: {
      purchaseOrderId,
      rawOrder: args.rawOrder,
      carrierName: args.carrierName,
      trackingUrl: args.trackingUrl,
    },
  });
  if (!confirmation.ok) {
    throw new Error(confirmation.message ?? 'Walmart shipment confirmation failed');
  }
  await markWalmartConfirmationAttemptSql(sql, {
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    provider: 'walmart',
    succeeded: true,
  });
  return {
    confirmed: true,
    error: null,
    raw: confirmation.raw,
    storeAccountId: loaded.storeAccountId,
    credentialSource: loaded.source,
  };
}

async function persistWalmartShipment(
  sql: any,
  args: {
    body: Record<string, any>;
    provider: string;
    carrierAccountId: number;
    syntheticProviderId: number;
    carrierLabel: string | null;
    result: any;
  },
) {
  const orderId = Number(args.body.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('orderId is required for Walmart Shipping label creation');
  }

  const selectedRateJson = {
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    serviceName: args.result.serviceName,
    carrierNickname: args.carrierLabel ?? 'Walmart Shipping',
    providerAccountNickname: args.carrierLabel ?? 'Walmart Shipping',
    providerAccountId: args.syntheticProviderId,
    shippingProviderId: args.syntheticProviderId,
    provider: 'walmart_shipping',
    source: 'carrier_accounts',
    amount: args.result.cost,
    cost: args.result.cost,
    shipmentCost: args.result.cost,
    otherCost: 0,
      deliveryDays: Number(args.result.selectedRate?.transitTime?.businessDays ?? args.result.selectedRate?.transitDays ?? args.result.selectedRate?.deliveryDays ?? 0) || null,
  };

  return persistDirectCarrierLabel(sql, {
    orderId,
    carrierProvider: 'Walmart Shipping',
    carrierAccountId: args.syntheticProviderId,
    carrierLabel: args.carrierLabel ?? 'Walmart Shipping',
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    trackingNumber: args.result.trackingNumber,
    labelUrl: args.result.labelUrl || null,
    labelFormat: args.result.labelUrl?.startsWith('data:application/pdf') ? 'pdf' : null,
    cost: args.result.cost,
    currency: args.result.currency,
    weightOz: Number(args.body.weightOz ?? 0),
    dimsL: Number(args.body.dimsL ?? args.body.length ?? 0) || null,
    dimsW: Number(args.body.dimsW ?? args.body.width ?? 0) || null,
    dimsH: Number(args.body.dimsH ?? args.body.height ?? 0) || null,
    selectedRateJson,
    labelProvider: args.syntheticProviderId,
    labelShipmentId: null,
    selectedPid: args.syntheticProviderId,
    selectedPackageId: args.body.customPackageId != null ? String(args.body.customPackageId) : null,
    source: 'walmart_shipping',
  });
}

// Shipp provider HTTP calls are owned by src/connectors/carrier/shipp.ts.
async function persistShippShipment(
  sql: any,
  args: {
    body: Record<string, any>;
    provider: string;
    carrierAccountId: number;
    syntheticProviderId: number;
    carrierLabel: string | null;
    result: any;
  },
) {
  const orderId = Number(args.body.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('orderId is required for Shipp label creation');
  }

  const selectedRateJson = {
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    serviceName: args.result.serviceName,
    carrierNickname: args.carrierLabel ?? 'Shipp',
    providerAccountNickname: args.carrierLabel ?? 'Shipp',
    providerAccountId: args.syntheticProviderId,
    shippingProviderId: args.syntheticProviderId,
    provider: 'shipp',
    source: 'carrier_accounts',
    amount: args.result.cost,
    cost: args.result.cost,
    shipmentCost: args.result.cost,
    otherCost: 0,
    deliveryDays: Number(args.result.deliveryDays ?? 0) || null,
  };

  return persistDirectCarrierLabel(sql, {
    orderId,
    carrierProvider: 'Shipp',
    carrierAccountId: args.syntheticProviderId,
    carrierLabel: args.carrierLabel ?? 'Shipp',
    carrierCode: args.result.carrierCode,
    serviceCode: args.result.serviceCode,
    trackingNumber: args.result.trackingNumber,
    labelUrl: args.result.labelUrl,
    labelFormat: args.result.labelUrl?.startsWith('data:application/pdf') ? 'pdf' : 'image',
    cost: args.result.cost,
    currency: args.result.currency,
    weightOz: Number(args.body.weightOz ?? 0),
    dimsL: Number(args.body.dimsL ?? args.body.length ?? 0) || null,
    dimsW: Number(args.body.dimsW ?? args.body.width ?? 0) || null,
    dimsH: Number(args.body.dimsH ?? args.body.height ?? 0) || null,
    selectedRateJson,
    labelProvider: args.syntheticProviderId,
    labelShipmentId: null,
    selectedPid: args.syntheticProviderId,
    selectedPackageId: args.body.customPackageId != null ? String(args.body.customPackageId) : null,
    source: 'shipp',
  });
}

export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // Cold-start hardening (2026-06-11): load the ENTIRE deferred src/ tree (incl. the auth
  // verifier) FIRST, with its own catch — a load failure returns a clean 500 naming the failed
  // boundary instead of the opaque FUNCTION_INVOCATION_FAILED crash page.
  try {
    await ensureLabelDeps();
  } catch (err) {
    const code = String((err as { code?: unknown })?.code ?? (err as { name?: unknown })?.name ?? 'Error').slice(0, 48);
    res.status(500).json({ error: 'Label function dependencies failed to load', type: code });
    return;
  }

  const auth = (req.headers?.authorization || req.headers?.Authorization || '') as string;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Missing Authorization' }); return; }
  const verified = await verifySupabaseJwt(token);
  if (!verified.ok) { res.status(401).json({ error: 'Invalid token', reason: verified.reason }); return; }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { res.status(500).json({ error: 'DATABASE_URL not configured' }); return; }
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 5 });

  try {
    const body = (await readBody(req)) as Record<string, any>;
    const carrierAccountId = Number(body?.carrierAccountId);
    const shippingOptions = normalizeShippingOptions(body);
    if (!Number.isFinite(carrierAccountId)) {
      res.status(400).json({ error: 'carrierAccountId is required' });
      return;
    }
    const weightOz = Number(body?.weightOz);
    const dimsL = Number(body?.dimsL);
    const dimsW = Number(body?.dimsW);
    const dimsH = Number(body?.dimsH);
    if (!weightOz || !dimsL || !dimsW || !dimsH) {
      res.status(400).json({ error: 'weightOz + dimsL/W/H are required' });
      return;
    }

    const carrierRows = await sql<Array<{ provider: string; credentials: any; label: string | null; client_id: number | null; assigned_client_ids: number[] | null }>>`
      SELECT
        provider, credentials, label, client_id,
        COALESCE(
          (
            SELECT array_agg(cac.client_id ORDER BY cac.client_id)
            FROM carrier_account_clients cac
            WHERE cac.carrier_account_id = carrier_accounts.id
          ),
          '{}'::int[]
        ) AS assigned_client_ids
      FROM carrier_accounts
      WHERE id = ${carrierAccountId} LIMIT 1
    `;
    if (carrierRows.length === 0) {
      res.status(404).json({ error: `carrier_account ${carrierAccountId} not found` });
      return;
    }
    const { provider, credentials, label } = carrierRows[0];
    const carrierAssignment = {
      clientId: carrierRows[0].client_id ?? null,
      assignedClientIds: carrierRows[0].assigned_client_ids ?? [],
    };
    const providerKey = normalizeProviderKey(provider);
    const connectorCapabilities = labelCreateConnectorCapabilities(providerKey);
    if (!connectorCapabilities) {
      res.status(400).json({
        ok: false,
        error: `Label purchase for "${provider}" is not registered as a carrier connector.`,
      });
      return;
    }
    const creds = (credentials ?? {}) as Record<string, unknown>;
    // Make the default Location (Settings -> Location) the authoritative
    // ship-from for ALL direct carriers. Overwrites creds.shipFrom* before any
    // carrier branch reads them. No-op if no default Location/env is configured.
    await applyDefaultLocationShipFrom(creds);

    // Fetch the saved order's raw payload to derive ship-to (when caller
    // didn't pass an explicit shipTo override).
    let rawOrder: any = null;
    let orderRow: any = null;
    let orderLookupError: string | null = null;
    const orderId = Number(body?.orderId);
    if (Number.isFinite(orderId) && orderId > 0) {
      try {
        const rows = await sql<Array<{
          id: number;
          client_id: number | null;
          store_id: number | null;
          client_name: string | null;
          order_number: string | null;
          external_order_id: string | null;
          order_status: string | null;
          canonical_status: string | null;
          externally_shipped: boolean | null;
          source_provider: string | null;
          source_order_id: string | null;
          source_order_number: string | null;
          ship_to_name: string | null;
          ship_to_city: string | null;
          ship_to_state: string | null;
          ship_to_postal_code: string | null;
          override_residential: boolean | null;
          raw: any;
        }>>`
          SELECT
            o.id, o.client_id, o.store_id, c.name as client_name,
            o.order_number, o.external_order_id, o.order_status,
            o.canonical_status, o.externally_shipped, o.source_provider,
            o.source_order_id, o.source_order_number,
            o.ship_to_name, o.ship_to_city, o.ship_to_state, o.ship_to_postal_code,
            ov.residential as override_residential,
            o.raw
          FROM orders o
          LEFT JOIN clients c ON c.id = o.client_id
          LEFT JOIN order_overrides ov ON ov.order_id = o.id
          WHERE o.id = ${Math.trunc(orderId)}
          LIMIT 1
        `;
        orderRow = rows[0] ?? null;
        rawOrder = orderRow?.raw ?? null;
      } catch (err) {
        orderLookupError = err instanceof Error ? err.message : String(err);
      }
    }

    // PS-083: gate label purchase on assignment scope BEFORE any postage is
    // bought. An unassigned direct carrier, or one assigned to a different
    // client than this order's, must be rejected here — frontend hiding alone
    // is not sufficient. Existing labels/shipments are untouched (this runs on
    // the awaiting-shipment buy path, ahead of carrier dispatch). The simulator
    // demo provider is exempt.
    if (providerKey !== 'simulator') {
      const scopeDecision = evaluateDirectCarrierScope(carrierAssignment, {
        clientId: orderRow?.client_id ?? body?.clientId ?? null,
        storeId: orderRow?.store_id ?? body?.storeId ?? null,
        orderId: body?.orderId ?? null,
      });
      if (!scopeDecision.allowed) {
        res.status(403).json({ ok: false, error: scopeDecision.reason, code: 'carrier_not_assigned' });
        return;
      }
    }
    // Per user override unlock shipped data on 2026-06-05: enforce the
    // selected-rate proof/fingerprint boundary before any direct-carrier
    // postage purchase. This guards all provider branches below.
    // Per user override unlock shipped data on 2026-06-06 (PS-105): prefer the
    // backend-owned rateQuoteId snapshot; fall back to the carried proof. Both run
    // the SAME strict validator — identical to legacy when no rateQuoteId is sent.
    await assertLabelPurchaseRateSelection({
      rateQuoteId: typeof body?.rateQuoteId === 'string' ? body.rateQuoteId : null,
      selectedRateKey: typeof body?.selectedRateKey === 'string' ? body.selectedRateKey : null,
      selectedRateProof: body?.selectedRateProof,
    });

    // PS-128 + PS-129: backend-owned shipping-safety guard for the direct-carrier postage
    // path (the second money path besides createLabelV2). Hard-blocks a duplicate/externally
    // shipped order (PS-128) or an upstream-cancelled order (PS-129) BEFORE any Shipp/Walmart
    // Shipping/UPS postage purchase below. The per-branch shipped/cancelled checks remain as
    // defense in depth. Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129):
    // reads shipped/cancelled signals to block; does not mutate shipped/cancelled rows.
    if (orderRow && providerKey !== 'simulator') {
      try {
        await assertOrderSafeToShip(
          {
            id: orderRow.id,
            orderStatus: orderRow.order_status,
            canonicalStatus: orderRow.canonical_status,
            externallyShipped: orderRow.externally_shipped,
            sourceProvider: orderRow.source_provider,
            sourceOrderId: orderRow.source_order_id,
            sourceOrderNumber: orderRow.source_order_number,
            orderNumber: orderRow.order_number,
            externalOrderId: orderRow.external_order_id,
            storeId: orderRow.store_id,
          },
          { entryPoint: 'api/carriers/labels' },
        );
      } catch (err) {
        if (err instanceof ShippingSafetyError) {
          res.status(err.status as 409).json({ ok: false, error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }

    const explicitExternalOrderId = typeof body?.externalOrderId === 'string'
      ? body.externalOrderId
      : null;
    const externalOrderId = explicitExternalOrderId ?? orderRow?.external_order_id ?? null;
    const orderNumber = typeof body?.orderNumber === 'string'
      ? body.orderNumber
      : orderRow?.order_number ?? null;
    if (externalOrderId) {
      const m = externalOrderId.match(/^([a-z_]+)-(.+)$/);
      if (m) {
        try {
          const rows = await sql<Array<{ raw: any }>>`
            SELECT raw FROM store_orders
            WHERE provider = ${m[1]} AND external_order_id = ${m[2]}
            LIMIT 1
          `;
          rawOrder = rows[0]?.raw ?? rawOrder;
        } catch { /* non-fatal */ }
      }
    }

    if (providerKey === 'shipp') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for Shipp label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying Shipp label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create Shipp label for ${orderRow.order_status} order` });
        return;
      }

      const serviceCode = String(body?.serviceCode ?? '').trim();
      if (!serviceCode) {
        res.status(400).json({ ok: false, error: 'serviceCode is required for Shipp label creation' });
        return;
      }
      assertDirectCarrierServiceEligible({ body, orderRow, providerKey, serviceCode, serviceName: body?.serviceName ?? serviceCode });

      const syntheticProviderId = Number.isFinite(Number(body?.shippingProviderId))
        ? Number(body.shippingProviderId)
        : SHIPP_PROVIDER_ID_OFFSET + carrierAccountId;
      const result = await createCarrierLabel('shipp', {
        credentials: creds,
        clientId: orderRow?.client_id ?? body?.clientId ?? null,
        storeId: orderRow?.store_id ?? body?.storeId ?? null,
        serviceCode,
        weightOz,
        dimsL,
        dimsW,
        dimsH,
        shipFrom: body?.shipFrom,
        shipTo: body?.shipTo,
        rawOrder,
        externalOrderId,
        orderNumber,
        shippingOptions,
      });
      const persisted = await persistShippShipment(sql, {
        body,
        provider: providerKey,
        carrierAccountId,
        syntheticProviderId,
        carrierLabel: label,
        result,
      });
      const confirmation = await enqueueShipmentConfirmationSql(sql, {
        orderId,
        shipmentId: persisted.localShipmentId,
        externalOrderId,
        clientId: persisted.clientId,
        orderNumber: persisted.orderNumber,
        trackingNumber: result.trackingNumber,
        carrierCode: result.carrierCode,
        carrierProvider: 'shipp',
        carrierAccountId,
        shipDate: new Date().toISOString().slice(0, 10),
        payload: {
          purchaseOrderId: sourceOrderIdFromExternalId(externalOrderId),
          rawOrder,
          carrierName: result.carrierName ?? result.carrierCode,
          trackingUrl: null,
          serviceCode: result.serviceCode,
          serviceName: result.serviceName,
        },
      }).catch((err) => {
        console.warn('[carriers/labels] confirmation outbox enqueue failed:', err instanceof Error ? err.message : err);
        return { queued: false, provider: inferStoreProviderFromExternalId(externalOrderId), error: err instanceof Error ? err.message : String(err) };
      });

      let marketplaceShipmentConfirmed: boolean | null = null;
      let marketplaceShipmentConfirmError: string | null = null;
      let marketplaceCredentialSource: string | null = null;
      let marketplaceStoreAccountId: number | null = null;
      if (confirmation.provider === 'walmart') {
        try {
          const confirmed = await confirmWalmartSourceOrderAfterLabelSql(sql, {
            orderId,
            shipmentId: persisted.localShipmentId,
            purchaseOrderId: sourceOrderIdFromExternalId(externalOrderId),
            rawOrder,
            carrierName: result.carrierName ?? result.carrierCode ?? 'Other',
            trackingNumber: result.trackingNumber,
            trackingUrl: walmartTrackingUrl(result.carrierName ?? result.carrierCode ?? '', result.trackingNumber),
            shipDate: new Date().toISOString().slice(0, 10),
            fallbackCreds: {},
          });
          marketplaceShipmentConfirmed = confirmed.confirmed;
          marketplaceShipmentConfirmError = confirmed.error;
          marketplaceCredentialSource = confirmed.credentialSource;
          marketplaceStoreAccountId = confirmed.storeAccountId;
        } catch (err) {
          marketplaceShipmentConfirmed = false;
          marketplaceShipmentConfirmError = err instanceof Error ? err.message : String(err);
          console.warn('[carriers/labels] walmart source confirmation after Shipp label failed:', marketplaceShipmentConfirmError);
          await markWalmartConfirmationAttemptSql(sql, {
            orderId,
            shipmentId: persisted.localShipmentId,
            provider: 'walmart',
            succeeded: false,
            error: marketplaceShipmentConfirmError,
          }).catch((markErr) => {
            console.warn('[carriers/labels] walmart source confirmation status update failed:', markErr instanceof Error ? markErr.message : markErr);
          });
        }
      }

      // Fire the source-provider confirmation NOW so the marketplace is notified
      // in-request (ShipStation/eBay sources rely on this; Walmart already did the
      // immediate confirm above and its outbox row is skipped as succeeded).
      const confirmProcessed = await processOrderConfirmationNow(orderId);

      res.status(200).json({
        ok: true,
        provider: providerKey,
        carrierLabel: label,
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        labelFormat: result.labelUrl?.startsWith('data:application/pdf') ? 'PDF' : 'IMAGE',
        cost: result.cost,
        currency: result.currency,
        shipmentId: persisted.localShipmentId,
        localShipmentId: persisted.localShipmentId,
        orderStatus: 'shipped',
        apiVersion: 'shipp',
        voided: false,
        meta: {
          externalOrderId,
          orderNumber,
          hasRawOrder: rawOrder != null,
          carrierAccountId,
          confirmationQueued: confirmation.queued,
          confirmationProvider: confirmation.provider,
          confirmationError: confirmation.error ?? null,
          marketplaceConfirmationProcessed: confirmProcessed,
          marketplaceShipmentConfirmed,
          marketplaceShipmentConfirmError,
          marketplaceStoreAccountId,
          marketplaceCredentialSource,
          shippShipmentId: result.shipmentId,
          selectedServiceCode: result.serviceCode,
          connectorCapabilities,
        },
      });
      return;
    }

    if (providerKey === 'walmart_shipping') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for Walmart Shipping label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying Walmart Shipping label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create Walmart Shipping label for ${orderRow.order_status} order` });
        return;
      }

      const syntheticProviderId = Number.isFinite(Number(body?.shippingProviderId))
        ? Number(body.shippingProviderId)
        : SHIPP_PROVIDER_ID_OFFSET + carrierAccountId;
      const context = await resolveWalmartLabelContext(sql, creds, body, orderRow, rawOrder);
      assertDirectCarrierServiceEligible({
        body,
        orderRow,
        providerKey,
        serviceCode: body?.serviceCode ?? context?.selectedServiceCode ?? null,
        serviceName: body?.serviceName ?? null,
      });
      const result = await createCarrierLabel('walmart_shipping', {
        credentials: creds,
        clientId: orderRow?.client_id ?? body?.clientId ?? null,
        storeId: orderRow?.store_id ?? body?.storeId ?? null,
        serviceCode: body?.serviceCode ?? null,
        body,
        context,
        rawOrder: context.rawOrder,
        weightOz,
        dimsL,
        dimsW,
        dimsH,
        shippingOptions,
      });
      const persisted = await persistWalmartShipment(sql, {
        body,
        provider: providerKey,
        carrierAccountId,
        syntheticProviderId,
        carrierLabel: label,
        result,
      });
      const confirmation = await enqueueShipmentConfirmationSql(sql, {
        orderId,
        shipmentId: persisted.localShipmentId,
        externalOrderId: result.context.externalOrderId,
        clientId: persisted.clientId,
        orderNumber: persisted.orderNumber,
        trackingNumber: result.trackingNumber,
        carrierCode: result.carrierCode,
        carrierProvider: 'walmart_shipping',
        carrierAccountId,
        confirmationProvider: 'walmart',
        shipDate: new Date().toISOString().slice(0, 10),
        payload: {
          storeAccountId: result.context.storeAccountId ?? undefined,
          purchaseOrderId: result.context.purchaseOrderId,
          rawOrder: result.context.rawOrder,
          carrierName: result.carrierName,
          trackingUrl: walmartTrackingUrl(result.carrierName, result.trackingNumber),
          serviceCode: result.serviceCode,
          serviceName: result.serviceName,
        },
      }).catch((err) => {
        console.warn('[carriers/labels] walmart confirmation outbox enqueue failed:', err instanceof Error ? err.message : err);
        return { queued: false, provider: 'walmart', error: err instanceof Error ? err.message : String(err) };
      });

      let walmartConfirmationCredentialSource: string | null = null;
      let walmartConfirmationStoreAccountId: number | null = result.context.storeAccountId ?? null;
      try {
        const confirmed = await confirmWalmartSourceOrderAfterLabelSql(sql, {
          orderId,
          shipmentId: persisted.localShipmentId,
          purchaseOrderId: result.context.purchaseOrderId,
          rawOrder: result.context.rawOrder,
          carrierName: result.carrierName,
          trackingNumber: result.trackingNumber,
          trackingUrl: walmartTrackingUrl(result.carrierName, result.trackingNumber),
          shipDate: new Date().toISOString().slice(0, 10),
          storeAccountId: result.context.storeAccountId,
          fallbackCreds: creds,
        });
        result.shipmentConfirmRaw = confirmed.raw;
        result.shipmentConfirmed = confirmed.confirmed;
        result.shipmentConfirmError = confirmed.error;
        walmartConfirmationCredentialSource = confirmed.credentialSource;
        walmartConfirmationStoreAccountId = confirmed.storeAccountId;
      } catch (err) {
        result.shipmentConfirmed = false;
        result.shipmentConfirmError = err instanceof Error ? err.message : String(err);
        console.warn('[carriers/labels] walmart immediate confirmation failed:', result.shipmentConfirmError);
        await markWalmartConfirmationAttemptSql(sql, {
          orderId,
          shipmentId: persisted.localShipmentId,
          provider: 'walmart',
          succeeded: false,
          error: result.shipmentConfirmError,
        }).catch((markErr) => {
          console.warn('[carriers/labels] walmart confirmation status update failed:', markErr instanceof Error ? markErr.message : markErr);
        });
      }

      // Idempotent safety net: Walmart already confirmed immediately above; this
      // processes the outbox (skips the succeeded row, retries a failed one).
      const confirmProcessed = await processOrderConfirmationNow(orderId);

      res.status(200).json({
        ok: true,
        provider: providerKey,
        carrierLabel: label,
        trackingNumber: result.trackingNumber,
        labelUrl: result.labelUrl,
        labelFormat: result.labelUrl?.startsWith('data:application/pdf') ? 'PDF' : null,
        cost: result.cost,
        currency: result.currency,
        shipmentId: persisted.localShipmentId,
        localShipmentId: persisted.localShipmentId,
        orderStatus: persisted.orderStatus,
        apiVersion: 'walmart_shipping',
        voided: false,
        meta: {
          externalOrderId: result.context.externalOrderId,
          orderNumber: result.context.orderNumber,
          purchaseOrderId: result.context.purchaseOrderId,
          purchaseOrderSource: result.context.purchaseOrderSource,
          marketplaceStoreAccountId: walmartConfirmationStoreAccountId,
          marketplaceCredentialSource: walmartConfirmationCredentialSource,
          hasRawOrder: result.context.rawOrder != null,
          carrierAccountId,
          confirmationQueued: confirmation.queued,
          marketplaceConfirmationProcessed: confirmProcessed,
          confirmationProvider: confirmation.provider,
          confirmationError: confirmation.error ?? null,
          selectedServiceCode: result.serviceCode,
          walmartTrackingNumber: result.trackingNumber,
          labelPdfReturned: Boolean(result.labelUrl),
          walmartShipmentConfirmed: result.shipmentConfirmed,
          walmartShipmentConfirmError: result.shipmentConfirmError,
          connectorCapabilities,
        },
      });
      return;
    }

    const shipTo = resolveShipTo(body, rawOrder, orderRow);
    const shipFrom = resolveShipFrom(creds);

    let result: any = null;
    let directServiceCode: string | null = null;
    if (providerKey === 'ups') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for UPS label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying UPS label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create UPS label for ${orderRow.order_status} order` });
        return;
      }
      // UPS service code default: "03" = Ground. Caller can pass
      // serviceCode like "01" (Next Day Air), "02" (2nd Day Air), etc.
      directServiceCode = String(body?.serviceCode ?? '03');
      assertDirectCarrierServiceEligible({ body, orderRow, providerKey, serviceCode: directServiceCode, serviceName: body?.serviceName ?? directServiceCode });
      // PS-135(a): resolve residential server-side from the PS-127 authority so the UPS label charge
      // matches the rate quote (FE is NOT the authority). company comes from the RAW order
      // (resolveShipTo strips it, so the company_heuristic branch would otherwise never fire);
      // manual override from order_overrides.residential; sourceResidential from the marketplace raw shipTo.
      const upsRawShipTo = (rawOrder?.shipTo ?? rawOrder?.ship_to ?? {}) as Record<string, unknown>;
      const upsLabelClassification = classifyShippingAddress({
        orderId: Math.trunc(orderId),
        clientId: orderRow?.client_id ?? null,
        storeId: orderRow?.store_id ?? null,
        shipTo: {
          name: shipTo.name,
          company: (upsRawShipTo.company ?? upsRawShipTo.companyName ?? null) as string | null | undefined,
          city: shipTo.city,
          state: shipTo.state,
          postalCode: shipTo.zip,
          country: shipTo.country,
        },
        manualOverrideResidential:
          typeof orderRow?.override_residential === 'boolean' ? orderRow.override_residential : null,
        sourceResidential:
          typeof upsRawShipTo.residential === 'boolean' ? (upsRawShipTo.residential as boolean) : null,
      });
      const upsLabelResidential = residentialForShipping(upsLabelClassification);
      result = await createCarrierLabel('ups', {
        credentials: creds,
        clientId: orderRow?.client_id ?? body?.clientId ?? null,
        storeId: orderRow?.store_id ?? body?.storeId ?? null,
        residential: upsLabelResidential,
        weightOz, dimsL, dimsW, dimsH, serviceCode: directServiceCode, serviceName: body?.serviceName ?? directServiceCode, shipFrom, shipTo, shippingOptions,
      });
    } else if (providerKey === 'easypost') {
      if (!Number.isFinite(orderId) || orderId <= 0) {
        res.status(400).json({ ok: false, error: 'orderId is required for EasyPost label creation' });
        return;
      }
      if (orderLookupError) {
        throw new Error(`Could not load order before buying EasyPost label: ${orderLookupError}`);
      }
      if (!orderRow) {
        res.status(404).json({ ok: false, error: `Order ${Math.trunc(orderId)} not found` });
        return;
      }
      if (orderRow.order_status === 'shipped' || orderRow.order_status === 'cancelled') {
        res.status(409).json({ ok: false, error: `Cannot create EasyPost label for ${orderRow.order_status} order` });
        return;
      }
      directServiceCode = String(body?.serviceCode ?? 'USPS Priority');
      assertDirectCarrierServiceEligible({ body, orderRow, providerKey, serviceCode: directServiceCode, serviceName: body?.serviceName ?? directServiceCode });
      result = await createCarrierLabel('easypost', {
        credentials: creds,
        clientId: orderRow?.client_id ?? body?.clientId ?? null,
        storeId: orderRow?.store_id ?? body?.storeId ?? null,
        weightOz, dimsL, dimsW, dimsH, serviceCode: directServiceCode, serviceName: body?.serviceName ?? directServiceCode, shipFrom, shipTo, shippingOptions,
      });
    } else {
      res.status(400).json({
        error: `Label purchase for "${provider}" is not implemented yet. Currently supported: ups, easypost, shipp.`,
      });
      return;
    }

    const selectedRateJson = {
      carrierCode: providerKey,
      serviceCode: directServiceCode,
      serviceName: body?.serviceName ?? directServiceCode,
      carrierNickname: label ?? providerKey,
      providerAccountNickname: label ?? providerKey,
      providerAccountId: carrierAccountId,
      shippingProviderId: carrierAccountId,
      provider: providerKey,
      source: 'carrier_accounts',
      amount: result.cost,
      cost: result.cost,
      shipmentCost: result.cost,
      otherCost: 0,
      raw: result.raw,
    };
    const persisted = await persistDirectCarrierLabel(sql, {
      orderId,
      carrierProvider: providerKey === 'ups' ? 'UPS' : 'EasyPost',
      carrierAccountId,
      carrierLabel: label ?? providerKey,
      carrierCode: providerKey,
      serviceCode: directServiceCode,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      labelFormat: providerKey === 'ups' ? 'gif' : 'pdf',
      cost: result.cost,
      currency: result.currency,
      weightOz,
      dimsL,
      dimsW,
      dimsH,
      selectedRateJson,
      labelProvider: carrierAccountId,
      labelShipmentId: null,
      selectedPid: carrierAccountId,
      selectedPackageId: body?.customPackageId != null ? String(body.customPackageId) : null,
      source: providerKey,
    });
    const confirmation = await enqueueShipmentConfirmationSql(sql, {
      orderId,
      shipmentId: persisted.localShipmentId,
      externalOrderId,
      clientId: persisted.clientId,
      orderNumber: persisted.orderNumber,
      trackingNumber: result.trackingNumber,
      carrierCode: providerKey,
      carrierProvider: providerKey,
      carrierAccountId,
      shipDate: new Date().toISOString().slice(0, 10),
      payload: {
        purchaseOrderId: sourceOrderIdFromExternalId(externalOrderId),
        rawOrder,
        carrierName: providerKey === 'ups' ? 'UPS' : 'EasyPost',
        trackingUrl: null,
        serviceCode: directServiceCode,
      },
    }).catch((err) => {
      console.warn('[carriers/labels] confirmation outbox enqueue failed:', err instanceof Error ? err.message : err);
      return { queued: false, provider: inferStoreProviderFromExternalId(externalOrderId), error: err instanceof Error ? err.message : String(err) };
    });

    // Fire the source-provider confirmation NOW so a UPS/EasyPost label on a
    // ShipStation- or eBay-sourced order actually notifies the marketplace and
    // marks it shipped in-request (Vercel cannot background this).
    const confirmProcessed = await processOrderConfirmationNow(orderId);

    res.status(200).json({
      ok: true,
      provider,
      carrierLabel: label,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      labelFormat: provider === 'ups' ? 'GIF' : 'PDF',
      cost: result.cost,
      currency: result.currency,
      shipmentId: persisted.localShipmentId,
      localShipmentId: persisted.localShipmentId,
      orderStatus: persisted.orderStatus,
      meta: {
        externalOrderId,
        hasRawOrder: rawOrder != null,
        carrierAccountId,
        carrierShipmentId: result.shipmentId ?? null,
        confirmationQueued: confirmation.queued,
        marketplaceConfirmationProcessed: confirmProcessed,
        confirmationProvider: confirmation.provider,
        confirmationError: confirmation.error ?? null,
        connectorCapabilities,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as any)?.code === 'SHIPPING_SERVICE_NOT_ELIGIBLE') {
      res.status(400).json({ ok: false, error: msg });
      return;
    }
    if ((err as any)?.code === 'SELECTED_RATE_PROOF_INVALID') {
      res.status(400).json({ ok: false, error: msg, code: (err as any).code, details: (err as any).details ?? null });
      return;
    }
    console.error('[carriers/labels]', msg);
    res.status(500).json({ ok: false, error: msg });
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}
