import { sql as pg } from '../../db/client';
import { loadClientCredentials } from '../../lib/shipstation/credentials';
import { resolveStoreConnector } from '../../connectors/store-resolution';

type OrderForConfirmation = {
  id: number;
  externalOrderId: string | null;
  clientId: number | null;
  orderNumber: string | null;
};

type EnqueueShipmentConfirmationInput = {
  order: OrderForConfirmation;
  shipmentId: number;
  trackingNumber: string | null;
  carrierCode: string | null;
  shipDate: string;
  confirmationProvider?: string | null;
  payload?: Record<string, unknown>;
};

type OutboxRow = {
  id: number;
  order_id: number;
  shipment_id: number | null;
  provider: string;
  payload: Record<string, unknown>;
  attempts: number;
};

const MAX_ATTEMPTS = 6;

let schemaEnsured: Promise<void> | null = null;

export function inferStoreProvider(externalOrderId: string | null | undefined): string {
  if (!externalOrderId) return 'shipstation';
  const match = externalOrderId.match(/^([a-z_]+)-(.+)$/i);
  if (!match) return 'shipstation';
  const provider = match[1]?.toLowerCase() ?? 'shipstation';
  if (provider === 'walmart') return 'walmart';
  if (provider === 'ebay') return 'ebay';
  if (provider === 'amazon') return 'amazon';
  if (provider === 'shopify') return 'shopify';
  return provider;
}

function sourceOrderId(externalOrderId: string | null | undefined): string | null {
  if (!externalOrderId) return null;
  const match = externalOrderId.match(/^[a-z_]+-(.+)$/i);
  return match?.[1] ?? externalOrderId;
}

export async function ensureFulfillmentSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_provider TEXT`;
    await pg`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_account_id TEXT`;
    await pg`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_order_id TEXT`;
    await pg`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_order_number TEXT`;
    await pg`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_status TEXT`;
    await pg`ALTER TABLE orders ADD COLUMN IF NOT EXISTS canonical_status TEXT`;
    await pg`CREATE INDEX IF NOT EXISTS orders_source_provider_idx ON orders (source_provider)`;
    await pg`CREATE INDEX IF NOT EXISTS orders_canonical_status_idx ON orders (canonical_status)`;

    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_provider TEXT`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_account_id TEXT`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS label_provider_key TEXT`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_status TEXT`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_provider TEXT`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_attempts INTEGER NOT NULL DEFAULT 0`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS confirmation_last_error TEXT`;
    await pg`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS marketplace_confirmed_at TIMESTAMPTZ`;
    await pg`CREATE INDEX IF NOT EXISTS shipments_confirmation_status_idx ON shipments (confirmation_status)`;

    await pg`
      CREATE TABLE IF NOT EXISTS fulfillment_outbox (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        shipment_id INTEGER,
        event_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await pg`CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_outbox_dedupe_idx ON fulfillment_outbox (dedupe_key)`;
    await pg`CREATE INDEX IF NOT EXISTS fulfillment_outbox_due_idx ON fulfillment_outbox (status, next_run_at)`;
  })();

  return schemaEnsured;
}

export async function recordOrderSourceIfNeeded(order: OrderForConfirmation): Promise<void> {
  await ensureFulfillmentSchema();
  const provider = inferStoreProvider(order.externalOrderId);
  await pg`
    UPDATE orders
    SET
      source_provider = COALESCE(source_provider, ${provider}),
      source_order_id = COALESCE(source_order_id, ${sourceOrderId(order.externalOrderId)}),
      source_order_number = COALESCE(source_order_number, ${order.orderNumber}),
      canonical_status = COALESCE(canonical_status, order_status),
      updated_at = NOW()
    WHERE id = ${order.id}
  `;
}

export async function markShipmentConfirmationState(args: {
  shipmentId: number;
  carrierProvider: string;
  carrierAccountId?: string | number | null;
  confirmationProvider: string;
  status: 'not_required' | 'pending' | 'processing' | 'succeeded' | 'failed';
  attempts?: number;
  lastError?: string | null;
}): Promise<void> {
  await ensureFulfillmentSchema();
  await pg`
    UPDATE shipments
    SET
      carrier_provider = ${args.carrierProvider},
      carrier_account_id = ${args.carrierAccountId == null ? null : String(args.carrierAccountId)},
      confirmation_provider = ${args.confirmationProvider},
      confirmation_status = ${args.status},
      confirmation_attempts = COALESCE(${args.attempts ?? null}, confirmation_attempts),
      confirmation_last_error = ${args.lastError ?? null},
      marketplace_confirmed_at = CASE WHEN ${args.status} = 'succeeded' THEN NOW() ELSE marketplace_confirmed_at END,
      updated_at = NOW()
    WHERE id = ${args.shipmentId}
  `;
}

export async function enqueueShipmentConfirmation(
  input: EnqueueShipmentConfirmationInput,
): Promise<{ queued: boolean; provider: string; outboxId?: number }> {
  await ensureFulfillmentSchema();
  await recordOrderSourceIfNeeded(input.order);

  if (!input.trackingNumber) {
    await markShipmentConfirmationState({
      shipmentId: input.shipmentId,
      carrierProvider: 'unknown',
      confirmationProvider: 'none',
      status: 'not_required',
      lastError: 'No tracking number returned with label',
    });
    return { queued: false, provider: 'none' };
  }

  const provider = input.confirmationProvider ?? inferStoreProvider(input.order.externalOrderId);
  const supported = provider === 'shipstation' || provider === 'walmart';
  if (!supported) {
    await markShipmentConfirmationState({
      shipmentId: input.shipmentId,
      carrierProvider: String(input.payload?.carrierProvider ?? 'unknown'),
      carrierAccountId: input.payload?.carrierAccountId as string | number | null | undefined,
      confirmationProvider: provider,
      status: 'not_required',
      lastError: `${provider} confirmation connector is not implemented yet`,
    });
    return { queued: false, provider };
  }

  const payload = {
    ...input.payload,
    orderId: input.order.id,
    shipmentId: input.shipmentId,
    externalOrderId: input.order.externalOrderId,
    clientId: input.order.clientId,
    orderNumber: input.order.orderNumber,
    trackingNumber: input.trackingNumber,
    carrierCode: input.carrierCode,
    shipDate: input.shipDate,
  };
  const dedupeKey = `shipment_confirmation_requested:${provider}:${input.order.id}:${input.shipmentId}`;
  const rows = await pg`
    INSERT INTO fulfillment_outbox (
      order_id, shipment_id, event_type, provider, dedupe_key, payload,
      status, attempts, next_run_at, updated_at
    )
    VALUES (
      ${input.order.id}, ${input.shipmentId}, 'shipment_confirmation_requested',
      ${provider}, ${dedupeKey}, ${pg.json(payload)}, 'pending', 0, NOW(), NOW()
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
    RETURNING id
  ` as Array<{ id: number }>;

  await markShipmentConfirmationState({
    shipmentId: input.shipmentId,
    carrierProvider: String(input.payload?.carrierProvider ?? 'shipstation'),
    carrierAccountId: input.payload?.carrierAccountId as string | number | null | undefined,
    confirmationProvider: provider,
    status: 'pending',
  });

  await pg`
    UPDATE orders
    SET canonical_status = 'shipped_pending_confirmation', updated_at = NOW()
    WHERE id = ${input.order.id}
  `;

  return { queued: true, provider, outboxId: rows[0]?.id };
}

async function loadStoreCredentials(provider: string, payload: Record<string, unknown>, clientId: number | null): Promise<Record<string, string | null | undefined>> {
  if (provider === 'shipstation') {
    const creds = await loadClientCredentials(clientId);
    return {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiKeyV2: creds.apiKeyV2,
    };
  }

  if (provider !== 'walmart') return {};

  const explicitId = Number(payload.storeAccountId ?? payload.sourceAccountId ?? payload.marketplaceAccountId);
  let accountId = Number.isFinite(explicitId) && explicitId > 0 ? Math.trunc(explicitId) : null;
  const purchaseOrderId = String(payload.purchaseOrderId ?? '').trim();
  if (!accountId && purchaseOrderId) {
    const rows = await pg`
      SELECT carrier_account_id
      FROM store_orders
      WHERE provider = 'walmart' AND external_order_id = ${purchaseOrderId}
      LIMIT 1
    ` as Array<{ carrier_account_id: number | null }>;
    accountId = rows[0]?.carrier_account_id ?? null;
  }
  if (!accountId) return {};

  const storeRows = await pg`
    SELECT credentials FROM store_accounts WHERE id = ${accountId} LIMIT 1
  `.catch(() => []) as Array<{ credentials: Record<string, string | null | undefined> }>;
  if (storeRows[0]?.credentials) return storeRows[0].credentials;

  const carrierRows = await pg`
    SELECT credentials FROM carrier_accounts WHERE id = ${accountId} LIMIT 1
  `.catch(() => []) as Array<{ credentials: Record<string, string | null | undefined> }>;
  return carrierRows[0]?.credentials ?? {};
}

async function claimDueOutboxRows(limit: number, orderId?: number): Promise<OutboxRow[]> {
  await ensureFulfillmentSchema();
  return pg`
    UPDATE fulfillment_outbox
    SET status = 'processing', updated_at = NOW()
    WHERE id IN (
      SELECT id
      FROM fulfillment_outbox
      WHERE event_type = 'shipment_confirmation_requested'
        AND status IN ('pending', 'failed')
        AND next_run_at <= NOW()
        ${orderId ? pg`AND order_id = ${orderId}` : pg``}
      ORDER BY next_run_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, order_id, shipment_id, provider, payload, attempts
  ` as Promise<OutboxRow[]>;
}

function retryDelayMinutes(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

async function completeOutboxRow(row: OutboxRow): Promise<void> {
  await pg`
    UPDATE fulfillment_outbox
    SET status = 'succeeded', last_error = NULL, updated_at = NOW()
    WHERE id = ${row.id}
  `;
  if (row.shipment_id) {
    await markShipmentConfirmationState({
      shipmentId: row.shipment_id,
      carrierProvider: String(row.payload.carrierProvider ?? 'unknown'),
      carrierAccountId: row.payload.carrierAccountId as string | number | null | undefined,
      confirmationProvider: row.provider,
      status: 'succeeded',
      attempts: row.attempts + 1,
      lastError: null,
    });
  }
  await pg`
    UPDATE orders
    SET canonical_status = 'shipped', updated_at = NOW()
    WHERE id = ${row.order_id}
  `;
}

async function failOutboxRow(row: OutboxRow, err: unknown, retryable: boolean): Promise<void> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  const shouldRetry = retryable && attempts < MAX_ATTEMPTS;
  await pg`
    UPDATE fulfillment_outbox
    SET
      status = 'failed',
      attempts = ${attempts},
      last_error = ${message},
      next_run_at = CASE
        WHEN ${shouldRetry} THEN NOW() + (${retryDelayMinutes(attempts)} || ' minutes')::interval
        ELSE 'infinity'::timestamptz
      END,
      updated_at = NOW()
    WHERE id = ${row.id}
  `;
  if (row.shipment_id) {
    await markShipmentConfirmationState({
      shipmentId: row.shipment_id,
      carrierProvider: String(row.payload.carrierProvider ?? 'unknown'),
      carrierAccountId: row.payload.carrierAccountId as string | number | null | undefined,
      confirmationProvider: row.provider,
      status: 'failed',
      attempts,
      lastError: message,
    });
  }
  if (!shouldRetry) {
    await pg`
      UPDATE orders
      SET canonical_status = 'confirmation_failed', updated_at = NOW()
      WHERE id = ${row.order_id}
    `;
  }
}

async function processOutboxRow(row: OutboxRow): Promise<boolean> {
  const resolvedStoreConnector = resolveStoreConnector(row.provider, 'shipment.confirm');
  if (!resolvedStoreConnector) {
    await failOutboxRow(row, new Error(`No store connector registered for ${row.provider}`), false);
    return false;
  }
  const { connector, connectorCapabilities } = resolvedStoreConnector;

  const payload = row.payload ?? {};
  const credentials = await loadStoreCredentials(
    row.provider,
    payload,
    Number(payload.clientId ?? null) || null,
  );
  const trackingNumber = String(payload.trackingNumber ?? '').trim();
  if (!trackingNumber) {
    await failOutboxRow(row, new Error('Shipment confirmation missing trackingNumber'), false);
    return false;
  }

  const result = await connector.confirmShipment({
    orderId: Number(payload.orderId ?? row.order_id),
    shipmentId: Number(payload.shipmentId ?? row.shipment_id ?? 0),
    externalOrderId: typeof payload.externalOrderId === 'string' ? payload.externalOrderId : null,
    clientId: Number(payload.clientId ?? null) || null,
    orderNumber: typeof payload.orderNumber === 'string' ? payload.orderNumber : null,
    trackingNumber,
    carrierCode: typeof payload.carrierCode === 'string' ? payload.carrierCode : null,
    shipDate: typeof payload.shipDate === 'string' ? payload.shipDate : new Date().toISOString().slice(0, 10),
    notifyCustomer: payload.notifyCustomer === true,
    notifyMarketplace: payload.notifyMarketplace !== false,
    credentials,
    payload,
  });

  if (result.ok) {
    await completeOutboxRow(row);
    console.info('[fulfillment-outbox] confirmed shipment', {
      orderId: row.order_id,
      shipmentId: row.shipment_id,
      provider: row.provider,
      connectorCapabilities,
    });
    return true;
  }

  await failOutboxRow(row, new Error(result.message ?? 'Confirmation failed'), result.retryable !== false);
  return false;
}

export async function processFulfillmentOutboxOnce(options: {
  limit?: number;
  orderId?: number;
} = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const rows = await claimDueOutboxRows(options.limit ?? 25, options.orderId);
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (await processOutboxRow(row)) succeeded += 1;
      else failed += 1;
    } catch (err) {
      await failOutboxRow(row, err, true);
      failed += 1;
      console.warn(
        `[fulfillment-outbox] confirmation failed orderId=${row.order_id} shipmentId=${row.shipment_id} provider=${row.provider}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { processed: rows.length, succeeded, failed };
}
