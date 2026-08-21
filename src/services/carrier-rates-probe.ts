/**
 * PS-200 S2 — Settings "test rates" probe for a single direct-carrier account.
 *
 * Port of the legacy Vercel /api/carriers/rates Settings-probe semantics: an
 * operator tests ONE account by id with a demo shipment — no order context,
 * no client-assignment visibility filter (an admin must be able to test an
 * account that isn't assigned to anyone yet), and RAW provider prices (no
 * markups — this is a connectivity check, not a quote an order will use).
 * Order-context quoting stays owned by getDirectCarrierRatesForRateInput +
 * combineCarrierUniverses (PS-199/PS-203) — this probe never feeds an order.
 */
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { carrierAccounts } from '../db/schema/carrier-accounts';
import { quoteCarrierRates } from './carrier-connector-orchestrator';
import { normalizeProviderKey } from '../lib/direct-carrier-scope';
import { resolveWalmartPurchaseOrder } from './walmart-po-resolution';
import { getDefaultShipFrom } from '../lib/ship-from';
import { normalizeShippingPostalCode } from './shipping-workflow/postal-code';
import { decideDeclaredOrigin } from './customs-origin';

export type CarrierRatesProbeInput = {
  carrierAccountId?: number | null;
  storeAccountId?: number | null;
  weightOz?: number | null;
  toZip?: string | null;
  fromZip?: string | null;
  dimsL?: number | null;
  dimsW?: number | null;
  dimsH?: number | null;
};

export type CarrierRatesProbeResult = {
  ok: boolean;
  provider?: string;
  rates?: unknown[];
  error?: string;
};

type ProbeAccount = {
  id: number;
  provider: string;
  label: string | null;
  credentials: Record<string, unknown>;
  active: boolean;
  sourceTable: 'carrier_accounts' | 'store_accounts';
};

async function loadProbeAccount(input: CarrierRatesProbeInput): Promise<ProbeAccount | null> {
  if (input.storeAccountId != null && Number.isFinite(Number(input.storeAccountId))) {
    const rows = await db.execute(sql`
      SELECT id, provider, label, credentials, active
      FROM store_accounts WHERE id = ${Number(input.storeAccountId)} LIMIT 1
    `);
    const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
    const row = (list as Array<any>)[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      provider: String(row.provider ?? ''),
      label: row.label ?? null,
      credentials: (row.credentials ?? {}) as Record<string, unknown>,
      active: row.active !== false,
      sourceTable: 'store_accounts',
    };
  }
  if (input.carrierAccountId != null && Number.isFinite(Number(input.carrierAccountId))) {
    const [row] = await db
      .select({
        id: carrierAccounts.id,
        provider: carrierAccounts.provider,
        label: carrierAccounts.label,
        credentials: carrierAccounts.credentials,
        active: carrierAccounts.active,
      })
      .from(carrierAccounts)
      .where(eq(carrierAccounts.id, Number(input.carrierAccountId)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      label: row.label ?? null,
      credentials: (row.credentials ?? {}) as Record<string, unknown>,
      active: row.active !== false,
      sourceTable: 'carrier_accounts',
    };
  }
  return null;
}

export async function probeCarrierAccountRates(
  input: CarrierRatesProbeInput,
): Promise<CarrierRatesProbeResult> {
  const account = await loadProbeAccount(input);
  if (!account) {
    return { ok: false, error: 'carrierAccountId or storeAccountId is required and must exist' };
  }
  const provider = normalizeProviderKey(account.provider);
  if (!account.active) {
    return { ok: false, provider, error: 'Account is inactive (hidden) — re-enable it to test rates.' };
  }

  try {
    // Walmart Shipping requires a purchaseOrderId; with no order context the
    // PS-199 'rates'-mode resolver falls back to the most recent Walmart
    // store_orders row — exactly the Settings "test the connection" behavior
    // the legacy dispatcher had.
    const walmartPo =
      provider === 'walmart_shipping'
        ? await resolveWalmartPurchaseOrder(
            {
              purchaseOrderId: null,
              orderId: null,
              externalOrderId: null,
              orderNumber: null,
              credentials: account.credentials,
              storeAccountId: account.sourceTable === 'store_accounts' ? account.id : null,
            },
            'rates',
          )
        : null;

    const defaultOrigin = input.fromZip ? null : await getDefaultShipFrom().catch(() => null);
    const fromZipRaw =
      input.fromZip ??
      ((defaultOrigin as any)?.postal_code ?? (defaultOrigin as any)?.postalCode ?? null);

    // PS-494 (Hermes gap 1): the probe has NO order and therefore no customs items, and
    // its demo shipment is always US-domestic — but it must still route through the ONE
    // named decision branch instead of falling to the connector's silent credential/'US'
    // default. unknown + Domestic is precisely the branch where a default is allowed
    // EXPLICITLY; anything else the owner returns would be a bug worth throwing on.
    const originDecision = decideDeclaredOrigin({
      resolution: { kind: 'unknown' },
      destination: 'Domestic',
      configuredDefault: (account.credentials as { packageOriginCountry?: string | null } | null)
        ?.packageOriginCountry ?? null,
    });
    if (originDecision.kind !== 'declare') {
      throw new Error(`carrier probe origin decision unexpectedly refused: ${originDecision.reason}`);
    }

    const quoted = await quoteCarrierRates(provider, {
      credentials: account.credentials,
      weightOz: Number(input.weightOz ?? 32),
      toZip: normalizeShippingPostalCode(input.toZip ?? '94601', 'US').zip5 ?? (input.toZip ?? '94601'),
      fromZip: fromZipRaw != null
        ? normalizeShippingPostalCode(String(fromZipRaw), 'US').zip5 ?? String(fromZipRaw)
        : undefined,
      dimsL: input.dimsL ?? 12,
      dimsW: input.dimsW ?? 10,
      dimsH: input.dimsH ?? 6,
      countryOfManufacture: originDecision.country,
      ...(walmartPo?.purchaseOrderId ? { purchaseOrderId: walmartPo.purchaseOrderId } : {}),
      ...(walmartPo?.rawOrder != null ? { rawOrder: walmartPo.rawOrder } : {}),
    } as Parameters<typeof quoteCarrierRates>[1]);

    const rates = Array.isArray(quoted.rates) ? quoted.rates : [];
    return { ok: rates.length > 0, provider, rates, ...(rates.length === 0 ? { error: 'No rates returned' } : {}) };
  } catch (err) {
    return { ok: false, provider, error: err instanceof Error ? err.message : String(err) };
  }
}
