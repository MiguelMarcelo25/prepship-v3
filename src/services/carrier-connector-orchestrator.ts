import { resolveCarrierConnector } from '../connectors/carrier-resolution.js';
// PS-271 (Layer 4): read the thin-source marker the Shipp connector rides on its rate array.
import { readObservedIncomplete } from '../connectors/carrier/shipp-observed-incomplete-marker.js';
import { assertShippingServiceEligible } from '../lib/shipping-service-eligibility.js';
import { normalizeShippingOptions } from '../lib/shipping-options.js';
import { loadShippingAutomationControls } from './automations/shipping-controls.js';
import {
  isCarrierTestMode,
  resolveCarrierTestStrategy,
  assertNoLivePostageOrMarketplace,
  withReplayFixture,
} from './carrier-test-mode.js';
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
} from '../connectors/types.js';

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
  const automationRules = await loadShippingAutomationControls();
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
  // PS-271 (Layer 4): if the connector rode a thin-source marker on its rate array (the Shipp
  // accepted-thin partial), lift it into the result's `diagnostics` so the rates service can mark the
  // pass thin/unproven. Reads a NON-ENUMERABLE property — absent for every other connector and for the
  // OFF Shipp path, so `diagnostics` stays undefined exactly as today.
  const observedIncomplete = readObservedIncomplete(rates);
  return {
    provider: resolved.provider,
    rates,
    ...(observedIncomplete ? { diagnostics: { observedIncomplete } } : {}),
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

  // Carrier test-mode seam (double-gated; inert in production). When armed AND the
  // per-call __carrierTestMode flag is set, route through a $0, no-marketplace path:
  // sandbox = real HTTP with a TEST key; replay = recorded response through the real
  // parser. Otherwise the production call below runs UNCHANGED.
  let label;
  if (isCarrierTestMode(input)) {
    const strategy = resolveCarrierTestStrategy(resolved.provider);
    assertNoLivePostageOrMarketplace(resolved.provider, input, strategy);
    label =
      strategy === 'replay'
        ? await withReplayFixture(resolved.provider, input, () => resolved.connector!.createLabel!(input))
        : await resolved.connector.createLabel(input);
  } else {
    label = await resolved.connector.createLabel(input);
  }
  return {
    provider: resolved.provider,
    ...label,
  };
}

/**
 * PS-211 capability honesty: a provider "supports void" only when its
 * connector both advertises labels.void in the capability matrix AND actually
 * implements voidLabel. The service layer uses this to classify
 * 'not_supported' BEFORE attempting a dispatch (instead of pattern-matching a
 * thrown missing-connector message).
 */
export function carrierConnectorSupportsVoid(provider: string | null | undefined): boolean {
  const resolved = resolveCarrierConnector(provider, 'labels.void');
  return typeof resolved?.connector.voidLabel === 'function';
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
