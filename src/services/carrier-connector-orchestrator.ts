import { resolveCarrierConnector } from '../connectors/carrier-resolution';
import { assertShippingServiceEligible } from '../lib/shipping-service-eligibility';
import { normalizeShippingOptions } from '../lib/shipping-options';
import { loadShippingAutomationRules } from './shipping-automation';
import type {
  CarrierLabelInput,
  CarrierAccountListInput,
  CarrierRateInput,
  CarrierTrackingInput,
  CarrierVoidInput,
  ConnectorCapability,
  NormalizedCarrierAccountListResult,
  NormalizedCarrierLabelResult,
  NormalizedCarrierRateQuoteResult,
  NormalizedCarrierVoidResult,
  NormalizedTrackingStatus,
} from '../connectors/types';

function missingCarrierConnector(provider: string | null | undefined, capability: ConnectorCapability): Error {
  return new Error(`No carrier connector registered for ${provider ?? '(missing)'} with capability ${capability}`);
}

function labelInputRecord(input: CarrierLabelInput): Record<string, any> {
  return input && typeof input === 'object' ? input as Record<string, any> : {};
}

async function assertCarrierLabelServiceEligible(
  provider: string | null | undefined,
  input: CarrierLabelInput,
): Promise<void> {
  const row = labelInputRecord(input);
  const shipment = row.shipment && typeof row.shipment === 'object'
    ? row.shipment as Record<string, any>
    : {};
  const serviceCode = row.serviceCode ?? row.service_code ?? shipment.service_code ?? shipment.serviceCode;
  if (serviceCode == null || serviceCode === '') return;
  const automationRules = await loadShippingAutomationRules();
  assertShippingServiceEligible(
    {
      clientId: row.clientId ?? row.client_id ?? shipment.clientId ?? shipment.client_id ?? null,
      clientName: row.clientName ?? row.client_name ?? shipment.clientName ?? shipment.client_name ?? null,
      storeId: row.storeId ?? row.store_id ?? shipment.storeId ?? shipment.store_id ?? null,
    },
    {
      provider: provider ?? row.provider ?? null,
      carrierCode: row.carrierCode ?? row.carrier_code ?? shipment.carrier_code ?? shipment.carrierCode ?? null,
      carrierName: row.carrierName ?? row.carrier_name ?? null,
      serviceCode,
      serviceName: row.serviceName ?? row.service_name ?? shipment.service_type ?? shipment.serviceName ?? null,
      serviceType: row.serviceType ?? row.service_type ?? shipment.service_type ?? null,
    },
    normalizeShippingOptions(row.shippingOptions ?? row),
    automationRules,
  );
}

export async function quoteCarrierRates(
  provider: string | null | undefined,
  input: CarrierRateInput,
): Promise<NormalizedCarrierRateQuoteResult> {
  const resolved = resolveCarrierConnector(provider, 'rates.quote');
  if (!resolved?.connector.getRates) {
    throw missingCarrierConnector(provider, 'rates.quote');
  }

  const rates = await resolved.connector.getRates(input);
  return {
    provider: resolved.provider,
    rates,
  };
}

export async function createCarrierLabel(
  provider: string | null | undefined,
  input: CarrierLabelInput,
): Promise<NormalizedCarrierLabelResult> {
  await assertCarrierLabelServiceEligible(provider, input);
  const resolved = resolveCarrierConnector(provider, 'labels.create');
  if (!resolved?.connector.createLabel) {
    throw missingCarrierConnector(provider, 'labels.create');
  }

  const label = await resolved.connector.createLabel(input);
  return {
    provider: resolved.provider,
    ...label,
  };
}

export async function voidCarrierLabel(
  provider: string | null | undefined,
  input: CarrierVoidInput,
): Promise<NormalizedCarrierVoidResult> {
  const resolved = resolveCarrierConnector(provider, 'labels.void');
  if (!resolved?.connector.voidLabel) {
    throw missingCarrierConnector(provider, 'labels.void');
  }

  const result = await resolved.connector.voidLabel(input);
  return result ?? {
    provider: resolved.provider,
    voided: true,
  };
}

export async function trackCarrierShipment(
  provider: string | null | undefined,
  input: CarrierTrackingInput,
): Promise<NormalizedTrackingStatus> {
  const resolved = resolveCarrierConnector(provider, 'tracking.read');
  if (!resolved?.connector.trackShipment) {
    throw missingCarrierConnector(provider, 'tracking.read');
  }

  return resolved.connector.trackShipment(input);
}

export async function listCarrierAccounts(
  provider: string | null | undefined,
  input: CarrierAccountListInput = {},
): Promise<NormalizedCarrierAccountListResult> {
  const resolved = resolveCarrierConnector(provider);
  if (!resolved?.connector.listCarrierAccounts) {
    throw missingCarrierConnector(provider, 'rates.quote');
  }

  return resolved.connector.listCarrierAccounts(input);
}
