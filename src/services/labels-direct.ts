/**
 * PS-202 — v4-owned DIRECT-carrier label purchase (Shipp, Walmart Shipping,
 * direct UPS, EasyPost).
 *
 * Before this module, apiClient.createLabel routed direct carrier-account
 * rates (synthetic provider ids = 10,000,000 + carrier_accounts row id /
 * 20,000,000 + store_accounts row id) to the LEGACY Vercel function
 * api/carriers/labels.ts — real postage purchased on a stack with a forked
 * auth verifier, separately-deployed copies of the v4 money services, and NO
 * inventory/package deduction. createLabelV2 now owns the purchase end to
 * end: the SAME proof gate, shipping-safety, eligibility, persistence,
 * deduction, and marketplace-confirmation tail as ShipStation labels — only
 * the connector call differs.
 *
 * Per user override unlock shipped data on 2026-06-12: this module CREATES
 * new shipment rows through the existing sanctioned persistCreatedLabel
 * writer (via createLabelV2); it never mutates shipped/cancelled rows.
 *
 * The connector input shapes are the contracts the v4 connectors already
 * expose (the legacy endpoint called this repo's own orchestrator — the
 * shapes below are ports of its proven call sites, not guesses).
 */
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { carrierAccounts } from '../db/schema/carrier-accounts';
import { eq } from 'drizzle-orm';
import { createCarrierLabel } from './carrier-connector-orchestrator';
import { normalizeProviderKey, directCarrierVisibleForScope } from '../lib/direct-carrier-scope';
import { resolveWalmartPurchaseOrder, type WalmartPoResolution } from './walmart-po-resolution';
import type { CreatedExternalLabel } from '../lib/shipstation/labels';
import type { NormalizedShippingOptions } from '../lib/shipping-options';
import { generateFakeShipmentId } from './mock-label-generator';

// The synthetic provider-id ranges the Rate Browser assigns to direct
// accounts (same constants as the rate side; values are part of the public
// rate contract — se-1xxxxxxx / se-2xxxxxxx carrier ids).
export const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;
export const DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000;

export type DirectLabelAccountRef = {
  sourceTable: 'carrier_accounts' | 'store_accounts';
  accountId: number;
};

/** Map a synthetic shippingProviderId to its owning account row, or null for ShipStation ids. */
export function directLabelAccountRefFromProviderId(providerId: unknown): DirectLabelAccountRef | null {
  const pid = typeof providerId === 'number' ? providerId : Number(providerId);
  if (!Number.isFinite(pid)) return null;
  if (pid >= DIRECT_STORE_PROVIDER_ID_OFFSET) {
    return { sourceTable: 'store_accounts', accountId: Math.trunc(pid - DIRECT_STORE_PROVIDER_ID_OFFSET) };
  }
  if (pid >= DIRECT_CARRIER_PROVIDER_ID_OFFSET) {
    return { sourceTable: 'carrier_accounts', accountId: Math.trunc(pid - DIRECT_CARRIER_PROVIDER_ID_OFFSET) };
  }
  return null;
}

type DirectLabelAccount = {
  id: number;
  clientId: number | null;
  provider: string;
  label: string | null;
  credentials: Record<string, unknown>;
  sourceTable: 'carrier_accounts' | 'store_accounts';
  assignedClientIds: number[];
};

/**
 * Load + authorize the direct account for a label purchase. Enforces the
 * PS-083 assignment-scope rule (an unassigned direct carrier is hidden/blocked
 * everywhere — the same gate the rate side applies) BEFORE any postage call.
 */
export async function loadDirectAccountForLabel(
  ref: DirectLabelAccountRef,
  scope: { clientId: number | null; storeId: number | null },
): Promise<DirectLabelAccount> {
  let account: DirectLabelAccount | null = null;
  if (ref.sourceTable === 'carrier_accounts') {
    const [row] = await db
      .select({
        id: carrierAccounts.id,
        clientId: carrierAccounts.clientId,
        provider: carrierAccounts.provider,
        label: carrierAccounts.label,
        credentials: carrierAccounts.credentials,
        active: carrierAccounts.active,
      })
      .from(carrierAccounts)
      .where(eq(carrierAccounts.id, ref.accountId))
      .limit(1);
    if (row && row.active !== false) {
      const assignments = await db.execute(sql<{ client_id: number }>`
        SELECT client_id FROM carrier_account_clients WHERE carrier_account_id = ${ref.accountId}
      `);
      const assignedRows = Array.isArray(assignments) ? assignments : (assignments as any).rows ?? [];
      account = {
        id: row.id,
        clientId: row.clientId ?? null,
        provider: row.provider,
        label: row.label ?? null,
        credentials: (row.credentials ?? {}) as Record<string, unknown>,
        sourceTable: 'carrier_accounts',
        assignedClientIds: (assignedRows as Array<{ client_id: number }>).map((r) => Number(r.client_id)),
      };
    }
  } else {
    const rows = await db.execute(sql<{
      id: number;
      client_id: number | null;
      provider: string;
      label: string | null;
      credentials: Record<string, unknown>;
      active: boolean;
    }>`SELECT id, client_id, provider, label, credentials, active FROM store_accounts WHERE id = ${ref.accountId} LIMIT 1`);
    const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
    const row = (list as Array<any>)[0];
    if (row && row.active !== false) {
      account = {
        id: Number(row.id),
        clientId: row.client_id ?? null,
        provider: row.provider,
        label: row.label ?? null,
        credentials: (row.credentials ?? {}) as Record<string, unknown>,
        sourceTable: 'store_accounts',
        assignedClientIds: row.client_id != null ? [Number(row.client_id)] : [],
      };
    }
  }
  if (!account) {
    throw new Error(`Direct carrier account ${ref.sourceTable}:${ref.accountId} not found or inactive`);
  }
  if (!directCarrierVisibleForScope(account, { clientId: scope.clientId, storeId: scope.storeId, includeAllDirectCarriers: false })) {
    const err = new Error(
      `Direct carrier "${account.label ?? account.provider}" is not assigned to this order's client — label not purchased.`,
    ) as Error & { code?: string };
    err.code = 'DIRECT_CARRIER_NOT_ASSIGNED';
    throw err;
  }
  return account;
}

export type DirectLabelPurchaseArgs = {
  account: DirectLabelAccount;
  providerAccountId: number;
  orderId: number;
  orderNumber: string | null;
  externalOrderId: string | null;
  clientId: number | null;
  storeId: number | null;
  serviceCode: string;
  serviceName: string | null;
  weightOz: number;
  length: number | null;
  width: number | null;
  height: number | null;
  shipTo: Record<string, unknown>;
  shipFrom: Record<string, unknown> | null;
  shippingOptions: NormalizedShippingOptions;
  rawOrder: unknown | null;
  /** Carrier test-mode passthrough (the orchestrator's $0 seam). */
  carrierTestMode?: boolean;
};

export type DirectLabelPurchaseResult = {
  created: CreatedExternalLabel;
  /** Present for walmart_shipping — feeds the marketplace confirmation payload. */
  walmartContext: (WalmartPoResolution & { storeAccountId: number | null }) | null;
};

export async function createDirectCarrierLabelForOrder(
  args: DirectLabelPurchaseArgs,
): Promise<DirectLabelPurchaseResult> {
  const provider = normalizeProviderKey(args.account.provider);

  // Walmart Shipping: the money path ALWAYS live-verifies the purchaseOrderId
  // (PS-199 labels mode — throws rather than buy against an unverified PO).
  const walmartContext =
    provider === 'walmart_shipping'
      ? {
          ...(await resolveWalmartPurchaseOrder(
            {
              orderId: args.orderId,
              externalOrderId: args.externalOrderId,
              orderNumber: args.orderNumber,
              credentials: args.account.credentials,
              storeAccountId: args.account.sourceTable === 'store_accounts' ? args.account.id : null,
            },
            'labels',
          )),
          storeAccountId: args.account.sourceTable === 'store_accounts' ? args.account.id : null,
        }
      : null;

  // Connector inputs are the proven legacy call shapes (the legacy endpoint
  // called this same orchestrator). walmart_shipping consumes a context block;
  // shipp + ups + easypost take the flat shipment fields.
  const baseInput: Record<string, unknown> = {
    credentials: args.account.credentials,
    clientId: args.clientId,
    storeId: args.storeId,
    serviceCode: args.serviceCode,
    serviceName: args.serviceName,
    weightOz: args.weightOz,
    dimsL: args.length,
    dimsW: args.width,
    dimsH: args.height,
    shipFrom: args.shipFrom,
    shipTo: args.shipTo,
    rawOrder: walmartContext?.rawOrder ?? args.rawOrder,
    externalOrderId: args.externalOrderId,
    orderNumber: args.orderNumber,
    shippingOptions: args.shippingOptions,
    ...(args.carrierTestMode ? { __carrierTestMode: true } : {}),
  };
  const input =
    provider === 'walmart_shipping'
      ? {
          ...baseInput,
          context: {
            purchaseOrderId: walmartContext!.purchaseOrderId,
            purchaseOrderSource: walmartContext!.purchaseOrderSource,
            storeAccountId: walmartContext!.storeAccountId,
            rawOrder: walmartContext!.rawOrder,
            externalOrderId: args.externalOrderId,
            orderNumber: args.orderNumber,
          },
          purchaseOrderId: walmartContext!.purchaseOrderId,
        }
      : baseInput;

  const result = await createCarrierLabel(provider, input);

  const tracking = String(result.trackingNumber ?? '').trim();
  if (!tracking) {
    throw new Error(`${provider} label purchase returned no tracking number — treating as failed.`);
  }
  const labelUrl = String(result.labelUrl ?? '').trim()
    || (typeof result.labelBase64 === 'string' && result.labelBase64
      ? `data:application/pdf;base64,${result.labelBase64}`
      : '');
  const resultRecord = result as Record<string, unknown>;
  // CreatedExternalLabel.shipmentId is numeric (ShipStation's id space). Direct
  // providers return string ids — keep the provider's id in labelId (string)
  // and synthesize a local numeric shipment id, exactly as the offline mock
  // path does for its locally-created shipments.
  const providerShipmentId = resultRecord.shipmentId != null ? String(resultRecord.shipmentId) : null;
  const numericShipmentId = Number(providerShipmentId);
  const created: CreatedExternalLabel = {
    shipmentId: Number.isFinite(numericShipmentId) && numericShipmentId > 0
      ? Math.trunc(numericShipmentId)
      : generateFakeShipmentId(),
    labelId: String(resultRecord.labelId ?? providerShipmentId ?? `${provider}-${tracking}`),
    trackingNumber: tracking,
    labelUrl,
    labelFormat: String(resultRecord.labelFormat ?? (labelUrl.startsWith('data:application/pdf') ? 'pdf' : 'png')),
    cost: Number(result.cost ?? 0) || 0,
    insuranceCost: Number(resultRecord.insuranceCost ?? 0) || 0,
    voided: false,
    carrierCode: String(resultRecord.carrierCode ?? provider),
    serviceCode: String(resultRecord.serviceCode ?? args.serviceCode),
    shipDate: new Date().toISOString(),
    providerAccountId: args.providerAccountId,
  };

  return { created, walmartContext };
}
