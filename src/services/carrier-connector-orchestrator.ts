import { resolveCarrierConnector } from '../connectors/carrier-resolution';
import type {
  CarrierLabelInput,
  CarrierRateInput,
  CarrierTrackingInput,
  CarrierVoidInput,
  ConnectorCapability,
  NormalizedCarrierLabelResult,
  NormalizedCarrierRateQuoteResult,
  NormalizedCarrierVoidResult,
  NormalizedTrackingStatus,
} from '../connectors/types';

function missingCarrierConnector(provider: string | null | undefined, capability: ConnectorCapability): Error {
  return new Error(`No carrier connector registered for ${provider ?? '(missing)'} with capability ${capability}`);
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
