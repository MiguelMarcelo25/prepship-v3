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
import { resolveDirectLabelShipmentRef } from './direct-label-shipment-id';
import {
  isDirectShippingAccount,
  isStoreScopedCarrierProvider,
  resolveStoreAccountLink,
  safeCarrierAccountIdentifier,
  type StoreAccountIdentity,
} from './carrier-account-identity';

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
  accountIdentifier: string | null;
  linkedStoreAccountId: number | null;
  displayIdentity: string;
  identityBlockReason: string | null;
};

async function loadActiveStoreIdentitiesForLabel(): Promise<StoreAccountIdentity[]> {
  const result = await db.execute(sql<{
    id: number;
    client_id: number | null;
    provider: string;
    label: string | null;
    account_identifier: string | null;
    credentials: Record<string, unknown>;
    active: boolean;
  }>`
    SELECT id, client_id, provider, label, account_identifier, credentials, active
    FROM store_accounts
    WHERE active = true
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return (rows as Array<any>).map((store) => ({
    id: Number(store.id),
    clientId: store.client_id ?? null,
    provider: store.provider,
    label: store.label ?? null,
    accountIdentifier: store.account_identifier ?? null,
    credentials: (store.credentials ?? {}) as Record<string, unknown>,
    active: store.active,
  }));
}

/**
 * Load + authorize the direct account for a label purchase. Enforces the
 * PS-083 assignment-scope rule (an unassigned direct carrier is hidden/blocked
 * everywhere — the same gate the rate side applies) BEFORE any postage call.
 */
export async function loadDirectAccountForLabel(
  ref: DirectLabelAccountRef,
  scope: {
    clientId: number | null;
    storeId: number | null;
    sourceProvider: string | null;
    sourceAccountId: string | null;
  },
): Promise<DirectLabelAccount> {
  let account: DirectLabelAccount | null = null;
  if (ref.sourceTable === 'carrier_accounts') {
    const [row] = await db
      .select({
        id: carrierAccounts.id,
        clientId: carrierAccounts.clientId,
        provider: carrierAccounts.provider,
        label: carrierAccounts.label,
        accountIdentifier: carrierAccounts.accountIdentifier,
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
      const baseAccount = {
        id: row.id,
        clientId: row.clientId ?? null,
        provider: row.provider,
        label: row.label ?? null,
        accountIdentifier: row.accountIdentifier ?? null,
        credentials: (row.credentials ?? {}) as Record<string, unknown>,
        sourceTable: 'carrier_accounts',
        assignedClientIds: (assignedRows as Array<{ client_id: number }>).map((r) => Number(r.client_id)),
      };
      let linkedStore: StoreAccountIdentity | null = null;
      let identityBlockReason: string | null = null;
      if (isStoreScopedCarrierProvider(baseAccount.provider)) {
        const link = resolveStoreAccountLink(baseAccount, await loadActiveStoreIdentitiesForLabel());
        if (link.ok) linkedStore = link.store;
        else identityBlockReason = link.reason;
      }
      account = {
        ...baseAccount,
        sourceTable: 'carrier_accounts',
        linkedStoreAccountId: linkedStore?.id ?? null,
        displayIdentity: safeCarrierAccountIdentifier({ ...baseAccount, linkedStore }),
        identityBlockReason,
      };
    }
  } else {
    const rows = await db.execute(sql<{
      id: number;
      client_id: number | null;
      provider: string;
      label: string | null;
      account_identifier: string | null;
      credentials: Record<string, unknown>;
      active: boolean;
    }>`SELECT id, client_id, provider, label, account_identifier, credentials, active FROM store_accounts WHERE id = ${ref.accountId} LIMIT 1`);
    const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
    const row = (list as Array<any>)[0];
    if (row && row.active !== false) {
      const baseAccount = {
        id: Number(row.id),
        clientId: row.client_id ?? null,
        provider: row.provider,
        label: row.label ?? null,
        accountIdentifier: row.account_identifier ?? null,
        credentials: (row.credentials ?? {}) as Record<string, unknown>,
        sourceTable: 'store_accounts' as const,
        assignedClientIds: row.client_id != null ? [Number(row.client_id)] : [],
      };
      let linkedStore: StoreAccountIdentity | null = null;
      let identityBlockReason: string | null = null;
      if (isStoreScopedCarrierProvider(baseAccount.provider)) {
        const link = resolveStoreAccountLink(baseAccount, await loadActiveStoreIdentitiesForLabel());
        if (link.ok) linkedStore = link.store;
        else identityBlockReason = link.reason;
      }
      account = {
        ...baseAccount,
        linkedStoreAccountId: linkedStore?.id ?? (isStoreScopedCarrierProvider(baseAccount.provider) ? null : Number(row.id)),
        displayIdentity: safeCarrierAccountIdentifier({ ...baseAccount, linkedStore }),
        identityBlockReason,
      };
    }
  }
  if (!account) {
    throw new Error(`Direct carrier account ${ref.sourceTable}:${ref.accountId} not found or inactive`);
  }
  if (!isDirectShippingAccount(account.provider, account.sourceTable)) {
    const err = new Error('Marketplace store credentials cannot be used as a shipping carrier account.') as Error & { code?: string };
    err.code = 'DIRECT_CARRIER_ACCOUNT_NOT_SHIPPING';
    throw err;
  }
  if (
    account.identityBlockReason ||
    !directCarrierVisibleForScope(account, {
      clientId: scope.clientId,
      storeId: scope.storeId,
      sourceProvider: scope.sourceProvider,
      sourceAccountId: scope.sourceAccountId,
      includeAllDirectCarriers: false,
    })
  ) {
    const err = new Error(
      account.identityBlockReason ??
        `Direct carrier "${account.displayIdentity}" is not assigned to the exact account that owns this order - label not purchased.`,
    ) as Error & { code?: string };
    err.code = isStoreScopedCarrierProvider(account.provider)
      ? 'DIRECT_CARRIER_STORE_ACCOUNT_MISMATCH'
      : 'DIRECT_CARRIER_NOT_ASSIGNED';
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
  signal?: AbortSignal;
  idempotencyKey?: string;
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
    signal: args.signal,
    idempotencyKey: args.idempotencyKey,
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
  // PS-243: a direct label's LOCAL shipment id is ALWAYS synthetic (negative,
  // int4-safe, collision-proof) — never the provider's numeric id, which can
  // overflow shipments.labelShipmentId (integer) or collide with ShipStation's
  // id space. The provider's real id is preserved in labelId. Full rationale in
  // resolveDirectLabelShipmentRef.
  const providerShipmentId = resultRecord.shipmentId != null ? String(resultRecord.shipmentId) : null;
  const { shipmentId: directShipmentId, labelId: directLabelId } = resolveDirectLabelShipmentRef({
    providerShipmentId,
    providerLabelId: resultRecord.labelId != null ? String(resultRecord.labelId) : null,
    fallbackLabelId: `${provider}-${tracking}`,
  });
  // Per user override unlock shipped data on 2026-06-17 (PS-273): capture the
  // REAL direct account identity at purchase time. The synthetic providerAccountId
  // (10_000_000 + carrier_accounts.id) is NOT resolvable by any reader's static
  // carrier registry, so without a persisted nickname the Shipped "Shipping
  // Account" column fell back to carrier-family and fabricated the first shared
  // direct UPS account (GG6381 on order #1587). A Shipp-brokered label is bought
  // on Shipp's broker account — never a direct UPS account — so its nickname is
  // the literal "Shipp"; every other direct family uses the loaded account's
  // own label (e.g. a direct UPS account's own nickname). Identity FIRST,
  // carrier family second.
  const providerAccountNickname =
    provider === 'shipp'
      ? 'Shipp'
      : (args.account.displayIdentity || args.account.provider);
  const created: CreatedExternalLabel = {
    shipmentId: directShipmentId,
    labelId: directLabelId,
    trackingNumber: tracking,
    labelUrl,
    labelFormat: String(resultRecord.labelFormat ?? (labelUrl.startsWith('data:application/pdf') ? 'pdf' : 'png')),
    cost: Number(result.cost ?? 0) || 0,
    // PS-261 (Per user override unlock shipped data on 2026-06-17): the REAL insurance fee the
    // connector billed (EasyPost emits it via parseEasyPostInsuranceCost; createLabelEasyPost
    // returns insuranceCost). Threaded onto created.insuranceCost so persistCreatedLabel bills it
    // as otherCost with provenance 'easypost' instead of $0. Defensive: the parser returns
    // null/0 when unpriced (`?? 0`), so an unpriced label still persists $0 — never a phantom fee.
    insuranceCost: Number(resultRecord.insuranceCost ?? 0) || 0,
    voided: false,
    // For EasyPost the connector omits a carrierCode, so this resolves to provider 'easypost' —
    // the identity persistCreatedLabel keys the 'easypost' insurance provenance on (PS-261).
    carrierCode: String(resultRecord.carrierCode ?? provider),
    serviceCode: String(resultRecord.serviceCode ?? args.serviceCode),
    shipDate: new Date().toISOString(),
    providerAccountId: args.providerAccountId,
    providerAccountNickname,
  };

  return { created, walmartContext };
}
