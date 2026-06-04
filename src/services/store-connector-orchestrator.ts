import { resolveStoreConnector } from '../connectors/store-resolution.js';
import type {
  ConfirmationResult,
  ConnectorCapability,
  NormalizedOrder,
  NormalizedStoreOrderImportResult,
  NormalizedStoreOrderStatusSyncResult,
  ShipmentConfirmationInput,
  StoreOrderFetchInput,
  StoreOrderImportInput,
  StoreOrderStatusSyncInput,
} from '../connectors/types.js';

function missingStoreConnector(provider: string | null | undefined, capability: ConnectorCapability): Error {
  return new Error(`No store connector registered for ${provider ?? '(missing)'} with capability ${capability}`);
}

export async function importStoreOrders(
  provider: string | null | undefined,
  input: StoreOrderImportInput,
): Promise<NormalizedStoreOrderImportResult> {
  const resolved = resolveStoreConnector(provider, 'orders.import');
  if (!resolved?.connector.importOrders) {
    throw missingStoreConnector(provider, 'orders.import');
  }

  const result = await resolved.connector.importOrders(input);
  if (Array.isArray(result)) {
    return {
      provider: resolved.provider,
      accountId: input.accountId,
      orders: result,
      cursor: input.cursor ?? null,
    };
  }

  return result;
}

export async function syncStoreOrderStatuses(
  provider: string | null | undefined,
  input: StoreOrderStatusSyncInput,
): Promise<NormalizedStoreOrderStatusSyncResult> {
  const resolved = resolveStoreConnector(provider, 'orders.statusSync');
  if (!resolved?.connector.syncOrderStatuses) {
    throw missingStoreConnector(provider, 'orders.statusSync');
  }

  const result = await resolved.connector.syncOrderStatuses(input);
  return result ?? {
    provider: resolved.provider,
    accountId: input.accountId,
    updated: 0,
  };
}

export async function fetchStoreOrder(
  provider: string | null | undefined,
  input: StoreOrderFetchInput,
): Promise<NormalizedOrder | null> {
  const resolved = resolveStoreConnector(provider, 'orders.import');
  if (!resolved?.connector.fetchOrder) {
    throw missingStoreConnector(provider, 'orders.import');
  }

  return resolved.connector.fetchOrder(input);
}

export async function confirmStoreShipment(
  provider: string | null | undefined,
  input: ShipmentConfirmationInput,
): Promise<ConfirmationResult> {
  const resolved = resolveStoreConnector(provider, 'shipment.confirm');
  if (!resolved?.connector.confirmShipment) {
    throw missingStoreConnector(provider, 'shipment.confirm');
  }

  return resolved.connector.confirmShipment(input);
}
