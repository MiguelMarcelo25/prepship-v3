# Shipping Integration Remediation Checklist

This document tracks the executable remediation checklist for shipping integration problem statements PS-001 through PS-005.

## PS-001: Shipment Sync Stuck in Awaiting Shipment

### Problem Statement

`src/services/shipment-sync.ts` currently skips ShipStation shipments when the matched order already has a non-voided PrepShip-created shipment:

```ts
if (ord && prepshipOrderIds.has(ord.id)) continue;
```

That skip happens before the order is added to `shippedOrderIds`, so an `awaiting_shipment` order can remain stuck even when ShipStation has active shipment evidence.

The user provided the exact shipped-data override phrase `unlock shipped data` on 2026-05-21 for this PS-001 fix.

### Current State

- Not complete.
- The duplicate-row guard is still correct in intent, but it is placed too early.
- The fix must still avoid inserting duplicate ShipStation shipment rows for orders that already have authoritative PrepShip-created labels.
- Voided and return ShipStation labels must not promote an order to `shipped`.

### Checklist Items

- [x] `src/services/shipment-sync.ts` adds eligible awaiting orders to `shippedOrderIds` before skipping duplicate ShipStation shipment rows.
- [x] The PrepShip-created shipment guard still skips duplicate ShipStation shipment inserts and updates.
- [x] Voided ShipStation labels do not mark orders shipped.
- [x] Return labels do not mark orders shipped.
- [x] A static guard catches the `prepshipOrderIds` ordering regression.
- [x] `npm run test:shipstation-awaiting-parity` passes.
- [x] `npm run typecheck` passes.

### Fixes

- `src/services/shipment-sync.ts` duplicate-row skip -> replace:

  ```ts
  if (ord && prepshipOrderIds.has(ord.id)) continue;
  ```

  with:

  ```ts
  // Per user override `unlock shipped data` on 2026-05-21:
  // PrepShip-created shipment rows should suppress duplicate SS shipment rows,
  // but must not block active ShipStation shipment evidence from promoting
  // awaiting orders to shipped.
  if (ord && prepshipOrderIds.has(ord.id)) {
    if (
      ord.status === 'awaiting_shipment' &&
      Boolean(s.voided) === false &&
      Boolean(s.isReturnLabel) === false
    ) {
      shippedOrderIds.push(ord.id);
    }
    continue;
  }
  ```

- `scripts/shipstation-awaiting-parity-guard.ts` regression coverage -> add this assertion after `const shipmentSync = readFileSync(...)`:

  ```ts
  assert.match(
    shipmentSync,
    /prepshipOrderIds\.has\(ord\.id\)[\s\S]+shippedOrderIds\.push\(ord\.id\)[\s\S]+continue/,
    'shipment sync must collect awaiting PrepShip-label orders before skipping duplicate ShipStation shipment inserts',
  );
  ```

### Verification Commands

```bash
npm run test:shipstation-awaiting-parity
npm run typecheck
```

## PS-002: Direct Carrier Labels

### Problem Statement

Direct carrier label flows for Shipp, EasyPost, Walmart Shipping, and UPS exist in `api/carriers/labels.ts`, but they are not standardized through the connector architecture and do not all share the same canonical persistence, status-update, and marketplace-confirmation workflow.

### Current State

- Partially implemented.
- Shipp, Walmart Shipping, UPS, and EasyPost label-purchase paths exist in `api/carriers/labels.ts`.
- Shipp and Walmart Shipping have deeper order-status and shipment persistence behavior than UPS and EasyPost.
- UPS and EasyPost still use a separate lightweight persistence fallback in `api/carriers/labels.ts`.
- Marketplace confirmation is not uniformly expressed as a standard direct-label post-processing step.

### Checklist Items

- [x] Shipp labels use a shared direct-label persistence helper.
- [x] Walmart Shipping labels use the same shared direct-label persistence helper.
- [x] UPS labels use the same shared direct-label persistence helper.
- [x] EasyPost labels use the same shared direct-label persistence helper.
- [x] Direct carrier labels update only `awaiting_shipment` orders.
- [x] Direct carrier label attempts reject `shipped` and `cancelled` orders.
- [x] Direct carrier label success enqueues marketplace confirmation when the order source requires it.
- [x] Direct carrier label failures return safe structured errors.
- [x] A static guard prevents reintroducing ad hoc direct-label persistence.

### Fixes

- Add shared persistence helper -> create `src/services/direct-label-persistence.ts`:

  ```ts
  import { sql as pg } from '../db/client';

  export type DirectLabelPersistenceInput = {
    orderId: number;
    clientId: number | null;
    orderNumber: string | null;
    carrierProvider: string;
    carrierAccountId: number | string | null;
    carrierLabel: string | null;
    carrierCode: string | null;
    serviceCode: string | null;
    trackingNumber: string;
    labelUrl: string | null;
    labelFormat: string | null;
    cost: number;
    currency: string;
    weightOz: number;
    dimsL: number | null;
    dimsW: number | null;
    dimsH: number | null;
    selectedRateJson: Record<string, unknown>;
    source: string;
  };

  export async function persistDirectCarrierLabel(input: DirectLabelPersistenceInput): Promise<{
    localShipmentId: number;
    orderNumber: string | null;
    clientId: number | null;
    orderStatus: 'shipped';
  }> {
    return pg.begin(async (tx) => {
      const [order] = await tx<Array<{ id: number; client_id: number | null; order_number: string | null; order_status: string }>>`
        SELECT id, client_id, order_number, order_status
        FROM orders
        WHERE id = ${Math.trunc(input.orderId)}
        FOR UPDATE
      `;
      if (!order) throw new Error('Order not found');
      if (order.order_status === 'shipped' || order.order_status === 'cancelled') {
        throw new Error(`Cannot create ${input.carrierProvider} label for ${order.order_status} order`);
      }

      const [shipment] = await tx<Array<{ id: number }>>`
        INSERT INTO shipments (
          order_id, client_id, order_number,
          carrier_code, service_code, tracking_number,
          ship_date, create_date, weight_oz, dims_l, dims_w, dims_h,
          cost, label_url, label_created_at, label_format,
          label_carrier, label_service, label_tracking, label_cost,
          label_ship_date, selected_rate_json,
          provider_account_id, provider_account_nickname,
          voided, source, is_return, created_at, updated_at
        )
        VALUES (
          ${order.id}, ${order.client_id}, ${order.order_number},
          ${input.carrierCode}, ${input.serviceCode}, ${input.trackingNumber},
          NOW(), NOW(), ${input.weightOz}, ${input.dimsL}, ${input.dimsW}, ${input.dimsH},
          ${input.cost.toFixed(2)}, ${input.labelUrl}, NOW(), ${input.labelFormat},
          ${input.carrierCode}, ${input.serviceCode}, ${input.trackingNumber}, ${input.cost.toFixed(2)},
          NOW(), ${pg.json(input.selectedRateJson)},
          ${input.carrierAccountId == null ? null : String(input.carrierAccountId)}, ${input.carrierLabel},
          false, ${input.source}, false, NOW(), NOW()
        )
        RETURNING id
      `;

      await tx`
        UPDATE orders
        SET order_status = 'shipped', updated_at = NOW()
        WHERE id = ${order.id} AND order_status = 'awaiting_shipment'
      `;

      await tx`
        DELETE FROM print_queue_orders
        WHERE order_id = ${String(order.id)}
      `;

      return {
        localShipmentId: shipment.id,
        orderNumber: order.order_number,
        clientId: order.client_id,
        orderStatus: 'shipped',
      };
    });
  }
  ```

- `api/carriers/labels.ts` Shipp/Walmart/UPS/EasyPost persistence -> replace `persistShippShipment(...)`, `persistWalmartShipment(...)`, and the lightweight UPS/EasyPost `CREATE TABLE IF NOT EXISTS shipments` block with calls to `persistDirectCarrierLabel(...)`.

- `api/carriers/labels.ts` marketplace confirmation -> after every successful `persistDirectCarrierLabel(...)`, call `enqueueShipmentConfirmationSql(...)` with:

  ```ts
  carrierProvider: providerKey,
  carrierAccountId,
  confirmationProvider: inferStoreProviderFromExternalId(externalOrderId),
  ```

  Use `confirmationProvider: 'walmart'` for `walmart_shipping`.

- Add static guard -> create `scripts/direct-carrier-label-guard.mjs`:

  ```js
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';

  const labels = readFileSync('api/carriers/labels.ts', 'utf8');

  assert(labels.includes('persistDirectCarrierLabel'), 'direct labels must use shared persistence helper');
  assert(!labels.includes('CREATE TABLE IF NOT EXISTS shipments'), 'direct labels must not create shipments table at request time');
  assert(labels.includes('enqueueShipmentConfirmationSql'), 'direct labels must enqueue source confirmation');
  for (const provider of ['shipp', 'walmart_shipping', 'ups', 'easypost']) {
    assert(labels.includes(`providerKey === '${provider}'`), `direct labels missing ${provider} branch`);
  }
  ```

- `package.json` test script -> add:

  ```json
  "test:direct-carrier-labels": "node scripts/direct-carrier-label-guard.mjs"
  ```

### Verification Commands

```bash
npm run test:direct-carrier-labels
npm run typecheck
```

## PS-003: Connector/Workflow Architecture

### Problem Statement

`src/connectors/registry.ts` is incomplete and does not represent every carrier integration already present in the codebase.

Current registry:

```ts
export const carrierConnectors = {
  shipstation: shipStationCarrierConnector,
};

export const storeConnectors = {
  shipstation: shipStationStoreConnector,
  walmart: walmartStoreConnector,
};
```

Shipp, EasyPost, Walmart Shipping, and UPS are wired through `api/carriers/*`, not through `src/connectors/registry.ts`.

### Current State

- Partially implemented.
- ShipStation is the only registered carrier connector.
- Walmart is registered only as a store connector.
- Shipp, EasyPost, Walmart Shipping, and UPS have provider-specific direct code in `api/carriers/rates.ts`, `api/carriers/labels.ts`, and `api/carriers/verify.ts`.
- The Settings UI knows about these provider keys in `web/src/components/Settings/CarrierIntegrationsCard.tsx`.
- There is no single connector matrix for rate, label, void, tracking, order import, and confirmation capabilities.

### Checklist Items

- [x] `carrierConnectors` registers `shipstation`, `shipp`, `easypost`, `walmart_shipping`, and `ups`.
- [x] `storeConnectors` registers source-confirmation providers separately from carrier-label providers.
- [x] Carrier connector capabilities include `getRates`, `createLabel`, optional `voidLabel`, and optional `trackShipment`.
- [x] Provider keys in Settings match connector registry keys.
- [~] Direct provider switchboards call connector implementations instead of owning all business logic. Deferred: direct endpoints remain the live behavior path; newly registered non-ShipStation connector files are guarded placeholders until the large provider extraction can be done without changing live label/rate behavior.
- [x] A static connector registry guard prevents missing providers.

### Fixes

- `src/domain/fulfillment/types.ts` carrier interface -> replace the current `CarrierConnector` interface with:

  ```ts
  export interface CarrierConnector<RateInput = unknown, RateResult = unknown, LabelInput = unknown, LabelResult = unknown> {
    provider: FulfillmentProvider;
    getRates(input: RateInput): Promise<RateResult[]>;
    createLabel(input: LabelInput): Promise<LabelResult>;
    voidLabel?(input: unknown): Promise<unknown>;
    trackShipment?(trackingNumber: string): Promise<unknown>;
  }
  ```

- Add carrier connector files:

  ```text
  src/connectors/carrier/shipp.ts
  src/connectors/carrier/easypost.ts
  src/connectors/carrier/walmart-shipping.ts
  src/connectors/carrier/ups.ts
  ```

- Export existing direct rate/label helpers from `api/carriers/rates.ts` and `api/carriers/labels.ts` or move them into reusable `src/lib/carriers/<provider>.ts` modules, then wrap them in the new connector files.

- `src/connectors/registry.ts` -> update to:

  ```ts
  import { shipStationCarrierConnector } from './carrier/shipstation';
  import { easyPostCarrierConnector } from './carrier/easypost';
  import { shippCarrierConnector } from './carrier/shipp';
  import { upsCarrierConnector } from './carrier/ups';
  import { walmartShippingCarrierConnector } from './carrier/walmart-shipping';
  import { shipStationStoreConnector } from './store/shipstation';
  import { walmartStoreConnector } from './store/walmart';

  export const carrierConnectors = {
    shipstation: shipStationCarrierConnector,
    shipp: shippCarrierConnector,
    easypost: easyPostCarrierConnector,
    walmart_shipping: walmartShippingCarrierConnector,
    ups: upsCarrierConnector,
  };

  export const storeConnectors = {
    shipstation: shipStationStoreConnector,
    walmart: walmartStoreConnector,
  };
  ```

- Add registry guard -> create `scripts/connector-registry-guard.mjs`:

  ```js
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';

  const registry = readFileSync('src/connectors/registry.ts', 'utf8');
  for (const key of ['shipstation', 'shipp', 'easypost', 'walmart_shipping', 'ups']) {
    assert(registry.includes(`${key}:`), `carrierConnectors missing ${key}`);
  }
  for (const key of ['shipstation', 'walmart']) {
    assert(registry.includes(`${key}:`), `storeConnectors missing ${key}`);
  }
  ```

- `package.json` test script -> add:

  ```json
  "test:connector-registry": "node scripts/connector-registry-guard.mjs"
  ```

### Verification Commands

```bash
npm run test:connector-registry
npm run typecheck
```

## PS-004: Timing Diagnostics

### Problem Statement

Timing diagnostics are partially implemented, but visibility is still incomplete across route steps, DB queries, external carrier calls, authentication, and frontend auth/fetch phases.

### Current State

- `src/main.ts` already has request IDs via `X-Request-Id`.
- `src/main.ts` already exposes `Server-Timing`.
- `src/main.ts` already logs slow API requests with `[api:timing]`.
- `web/src/lib/api.ts` already sends `X-Request-Id`.
- `web/src/lib/api.ts` already supports opt-in `[api:client-timing]`.
- Some hot routes, such as `src/routes/orders.ts` and `src/routes/inventory.ts`, already have step timing.
- External API timing and DB timing are not standardized.
- Auth timing is not separately visible.
- Timeout logs do not consistently include auth/fetch breakdowns.

### Checklist Items

- [x] API request logs include request ID, method, path, status, duration, and response size.
- [x] Auth middleware records auth duration.
- [x] `Server-Timing` includes `app` and `auth` durations.
- [x] Hot route logs include per-step timings.
- [x] Slow DB query helper logs label and duration.
- [x] ShipStation external calls log provider, endpoint, status, duration, and request ID when available.
- [x] Walmart external calls log provider, endpoint, status, duration, and correlation ID.
- [x] Direct carrier external calls log provider, endpoint, status, and duration.
- [x] Frontend API timing can be enabled via `localStorage` or `VITE_API_TIMING=1`.
- [x] Timeout errors include request ID and elapsed phase breakdown.

### Fixes

- Add generic timing helper -> create `src/lib/http/timing.ts`:

  ```ts
  export async function timed<T>(
    label: string,
    fn: () => Promise<T>,
    log: (event: { label: string; durationMs: number; ok: boolean; error?: string }) => void,
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await fn();
      log({ label, durationMs: Math.round(performance.now() - startedAt), ok: true });
      return result;
    } catch (err) {
      log({
        label,
        durationMs: Math.round(performance.now() - startedAt),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  ```

- Add DB timing helper -> create `src/lib/db/timed.ts`:

  ```ts
  export async function timedDb<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      const thresholdMs = Number.parseInt(process.env.DB_TIMING_LOG_MS ?? '500', 10);
      if (durationMs >= thresholdMs) {
        console.info('[db:timing]', { label, durationMs });
      }
    }
  }
  ```

- Auth timing -> in `src/middleware/auth.ts`, measure JWT/session verification:

  ```ts
  const startedAt = performance.now();
  try {
    // existing auth verification
  } finally {
    c.set('authDurationMs', Math.round(performance.now() - startedAt));
  }
  ```

- `src/main.ts` `Server-Timing` breakdown -> preserve existing `app;dur=...` and append auth when present:

  ```ts
  const authDurationMs = Number(c.get('authDurationMs') ?? 0);
  c.header(
    'Server-Timing',
    authDurationMs > 0
      ? `app;dur=${durationMs}, auth;dur=${authDurationMs}`
      : `app;dur=${durationMs}`
  );
  ```

- External ShipStation timing -> in `src/lib/shipstation/client.ts` and `src/lib/shipstation/v1-client.ts`, wrap `fetch` calls:

  ```ts
  const startedAt = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, options);
  console.info('[external:timing]', {
    provider: 'shipstation',
    endpoint: path,
    status: res.status,
    durationMs: Math.round(performance.now() - startedAt),
  });
  ```

- External Walmart timing -> in `src/connectors/store/walmart.ts`, `api/carriers/walmart/orders.ts`, `api/carriers/walmart/fees.ts`, and Walmart sections of `api/carriers/rates.ts` and `api/carriers/labels.ts`, log:

  ```ts
  console.info('[external:timing]', {
    provider: 'walmart',
    endpoint: url,
    status: res.status,
    durationMs: Math.round(performance.now() - startedAt),
    correlationId,
  });
  ```

- Frontend env timing -> in `web/src/lib/api.ts`, change `getClientApiTimingThresholdMs()` to:

  ```ts
  function getClientApiTimingThresholdMs(): number {
    if (typeof localStorage === 'undefined') return Number.POSITIVE_INFINITY;
    const enabled =
      localStorage.getItem('prepship:apiTiming') === '1' ||
      import.meta.env.VITE_API_TIMING === '1';
    if (!enabled) return Number.POSITIVE_INFINITY;
    const configured = Number.parseInt(localStorage.getItem('prepship:apiTimingMs') ?? '3000', 10);
    return Number.isFinite(configured) && configured >= 0 ? configured : 3000;
  }
  ```

### Verification Commands

```bash
npm run test:api-observability-metrics
npm run typecheck
```

## PS-005: Supabase Auth Lock / Frontend Delay

### Problem Statement

`web/src/lib/api.ts` calls `supabase.auth.getSession()` before every API request. That creates redundant auth-session work and makes frontend/API delay harder to diagnose.

### Current State

- `web/src/lib/api.ts` currently calls `supabase.auth.getSession()` inside the shared request function.
- `web/src/lib/v2-apiClient.ts`, `web/src/lib/vercelFunction.ts`, and `web/src/hooks/v2Hooks.ts` also call `supabase.auth.getSession()` directly.
- Frontend API timing exists in `web/src/lib/api.ts`, but auth duration and fetch duration are not separated.
- `@supabase/supabase-js` is currently pinned as `^2.47.10`.

### Checklist Items

- [x] `web/src/lib/api.ts` uses a cached auth token helper.
- [x] `web/src/lib/api.ts` no longer calls `supabase.auth.getSession()` per request.
- [x] `web/src/lib/v2-apiClient.ts` uses the same cached auth token helper.
- [x] `web/src/lib/vercelFunction.ts` uses the same cached auth token helper.
- [x] `web/src/hooks/v2Hooks.ts` uses the same cached auth token helper.
- [x] Frontend timing logs include auth duration.
- [x] Frontend timing logs include fetch and total duration breakdowns.
- [x] Timeout errors include request ID.
- [~] Supabase package is updated. Deferred by implementation plan: leave `@supabase/supabase-js` at `^2.47.10` to avoid dependency/lockfile churn in this remediation batch.
- [x] Static guard prevents direct frontend `getSession()` calls in shared API clients.

### Fixes

- Add cached token helper -> create `web/src/lib/auth-session-cache.ts`:

  ```ts
  import { supabase } from './supabase';

  const SESSION_CACHE_TTL_MS = 30_000;
  let cachedToken: string | null = null;
  let cachedUntil = 0;
  let inFlight: Promise<string | null> | null = null;

  export function clearAuthSessionCache(): void {
    cachedToken = null;
    cachedUntil = 0;
    inFlight = null;
  }

  export async function getCachedAccessToken(): Promise<{
    token: string | null;
    authMs: number;
    cacheHit: boolean;
  }> {
    const now = Date.now();
    if (cachedUntil > now) {
      return { token: cachedToken, authMs: 0, cacheHit: true };
    }

    const startedAt = performance.now();
    inFlight ??= supabase.auth.getSession()
      .then(({ data }) => {
        cachedToken = data.session?.access_token ?? null;
        cachedUntil = Date.now() + SESSION_CACHE_TTL_MS;
        return cachedToken;
      })
      .finally(() => {
        inFlight = null;
      });

    const token = await inFlight;
    return {
      token,
      authMs: Math.round(performance.now() - startedAt),
      cacheHit: false,
    };
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    cachedToken = session?.access_token ?? null;
    cachedUntil = Date.now() + SESSION_CACHE_TTL_MS;
  });
  ```

- `web/src/lib/api.ts` request auth -> replace direct `supabase.auth.getSession()` with:

  ```ts
  const { token, authMs, cacheHit } = await withTimeout(
    getCachedAccessToken(),
    SESSION_TIMEOUT_MS,
    'Authentication session'
  );
  ```

  Then set:

  ```ts
  if (token) {
    finalHeaders['Authorization'] = `Bearer ${token}`;
  }
  ```

- `web/src/lib/api.ts` timing fields -> extend `logClientApiTiming(...)` input with:

  ```ts
  authMs?: number;
  authCacheHit?: boolean;
  ```

  Pass:

  ```ts
  authMs,
  authCacheHit: cacheHit,
  ```

  on success, error, cancellation, and timeout logs.

- Replace direct frontend session lookups -> in these files:

  ```text
  web/src/lib/v2-apiClient.ts
  web/src/lib/vercelFunction.ts
  web/src/hooks/v2Hooks.ts
  ```

  replace:

  ```ts
  const {
    data: { session },
  } = await supabase.auth.getSession();
  ```

  with:

  ```ts
  const { token } = await getCachedAccessToken();
  ```

  and replace `session?.access_token` header usage with `token`.

- Update Supabase package:

  ```bash
  npm install @supabase/supabase-js@latest
  ```

- Add static guard -> create `scripts/frontend-auth-cache-guard.mjs`:

  ```js
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';

  const api = readFileSync('web/src/lib/api.ts', 'utf8');
  assert(api.includes('getCachedAccessToken'), 'api.ts must use cached auth token helper');
  assert(!api.includes('supabase.auth.getSession()'), 'api.ts must not call getSession per request');

  for (const file of [
    'web/src/lib/v2-apiClient.ts',
    'web/src/lib/vercelFunction.ts',
    'web/src/hooks/v2Hooks.ts',
  ]) {
    const text = readFileSync(file, 'utf8');
    assert(!text.includes('supabase.auth.getSession()'), `${file} must use getCachedAccessToken`);
  }
  ```

- `package.json` test script -> add:

  ```json
  "test:frontend-auth-cache": "node scripts/frontend-auth-cache-guard.mjs"
  ```

### Verification Commands

```bash
npm run test:frontend-auth-cache
npm run typecheck
npm run build:web
```
