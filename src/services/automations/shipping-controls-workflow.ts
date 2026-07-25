import { db } from '../../db/client.js';
import { clients } from '../../db/schema/clients.js';
import { filterClientsForScope, type ClientStoreScope } from '../../lib/client-store-scope.js';
import {
  HUGRAB_CARRIER_DISABLE_PROTECTED_REASON,
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  evaluateShippingServiceEligibility,
  findDisabledCarrierAutomationRule,
  isHugrabCarrierDisableProtected,
  isHugrabShippingContext,
  isUpsGroundSaverOrSurePostService,
  type ShippingAutomationRule,
} from '../../lib/shipping-service-eligibility.js';
import type { CarriersResponse } from '../../lib/shipstation/types.js';
import { isResourceInScope } from '../../lib/scope-predicates.js';
import { listCarrierAccounts } from '../carrier-connector-orchestrator.js';
import { getCarrierAccountsForRateContext } from '../rates.js';
import {
  loadShippingAutomationControls,
  upsertShippingAutomationControl,
  upsertShippingAutomationControls,
} from './shipping-controls.js';

export class ShippingControlPolicyError extends Error {
  readonly status = 409;
  readonly locked = true;

  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'ShippingControlPolicyError';
  }
}

type AutomationStoreRow = {
  storeId: number;
  clientId: number;
  clientName: string;
  active: boolean;
};

type AutomationServiceCatalogEntry = {
  serviceCode: string | null;
  name: string;
  domestic: boolean | null;
  international: boolean | null;
};

function publicStoreRows(rows: Array<typeof clients.$inferSelect>): AutomationStoreRow[] {
  const stores: AutomationStoreRow[] = [];
  for (const client of rows) {
    if (client.active === false) continue;
    const storeIds = Array.isArray(client.storeIds) ? client.storeIds : [];
    for (const storeId of storeIds) {
      stores.push({ storeId, clientId: client.id, clientName: client.name, active: true });
    }
  }
  return stores.sort((left, right) => left.clientName.localeCompare(right.clientName) || left.storeId - right.storeId);
}

function normalizeCatalogKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function serviceCatalogByCarrier(carriers: CarriersResponse['carriers']) {
  const catalog = new Map<string, AutomationServiceCatalogEntry[]>();
  for (const carrier of carriers ?? []) {
    const services = (carrier.services ?? []).map((service) => ({
      serviceCode: service.service_code ?? null,
      name: service.name ?? service.service_code ?? 'Service',
      domestic: service.domestic ?? true,
      international: service.international ?? false,
    }));
    for (const key of [carrier.carrier_id, carrier.carrier_code].map(normalizeCatalogKey).filter(Boolean)) {
      catalog.set(key, services);
    }
  }
  return catalog;
}

function fallbackServicesForCarrier(carrierCode: string | null | undefined): AutomationServiceCatalogEntry[] {
  if (!normalizeCatalogKey(carrierCode).includes('ups')) return [];
  return [
    { serviceCode: 'ups_ground', name: 'UPS Ground', domestic: true, international: false },
    { serviceCode: 'ups_2nd_day_air', name: 'UPS 2nd Day Air', domestic: true, international: false },
    { serviceCode: 'ups_3_day_select', name: 'UPS 3 Day Select', domestic: true, international: false },
    { serviceCode: 'ups_ground_saver', name: 'UPS Ground Saver', domestic: true, international: false },
    { serviceCode: 'ups_surepost_1_lb_or_greater', name: 'UPS Ground Saver (1 lb+)', domestic: true, international: false },
    { serviceCode: 'ups_surepost_less_than_1_lb', name: 'UPS Ground Saver (<1 lb)', domestic: true, international: false },
  ];
}

function servicesForCarrier(
  carrier: { carrier_id?: string | null; carrier_code?: string | null },
  catalog: Map<string, AutomationServiceCatalogEntry[]>,
) {
  for (const key of [carrier.carrier_id, carrier.carrier_code].map(normalizeCatalogKey).filter(Boolean)) {
    const services = catalog.get(key);
    if (services?.length) return services;
  }
  return fallbackServicesForCarrier(carrier.carrier_code);
}

function carrierDisabledReason(
  carrier: { carrier_id?: string | null; carrier_code?: string | null },
  store: AutomationStoreRow,
  controls: ShippingAutomationRule[],
): string | null {
  const matched = findDisabledCarrierAutomationRule(
    { clientId: store.clientId, clientName: store.clientName, storeId: store.storeId },
    { carrierId: carrier.carrier_id, carrierCode: carrier.carrier_code },
    controls,
  );
  return matched?.reason ?? null;
}

export async function listShippingControlAvailability(scope: ClientStoreScope) {
  const controls = await loadShippingAutomationControls();
  const visibleControls = controls.filter((control) => isResourceInScope(scope, {
    clientId: control.clientId == null ? null : Number(control.clientId),
    storeId: control.storeId == null ? null : Number(control.storeId),
  }));
  const [clientRows, carrierPayload] = await Promise.all([
    db.select().from(clients),
    listCarrierAccounts('shipstation', { dedupeKey: 'automation:carrier-catalog' }).catch(() => ({ carriers: [] })),
  ]);
  const stores = publicStoreRows(filterClientsForScope(clientRows, scope));
  const catalog = serviceCatalogByCarrier((carrierPayload as CarriersResponse).carriers ?? []);

  const data = await Promise.all(stores.map(async (store) => {
    const carriers = await getCarrierAccountsForRateContext(
      { storeId: store.storeId, clientId: store.clientId },
      { includeAutomationDisabled: true },
    ).catch(() => []);
    return {
      store,
      carriers: carriers.map((carrier) => {
        const carrierDisabled = carrierDisabledReason(carrier, store, controls);
        const services = servicesForCarrier(carrier, catalog).map((service) => {
          const eligibility = evaluateShippingServiceEligibility(
            { clientId: store.clientId, clientName: store.clientName, storeId: store.storeId },
            {
              carrierId: carrier.carrier_id,
              carrierCode: carrier.carrier_code,
              carrierName: carrier.nickname ?? carrier.friendly_name,
              serviceCode: service.serviceCode,
              serviceName: service.name,
              serviceType: service.name,
            },
            null,
            controls,
          );
          return {
            ...service,
            allowed: eligibility.allowed,
            disabled: !eligibility.allowed,
            locked: eligibility.ruleId === 'hugrab-ups-ground-saver',
            reason: eligibility.reason ?? null,
            ruleId: eligibility.ruleId ?? null,
          };
        });
        return {
          carrierId: carrier.carrier_id,
          carrierCode: carrier.carrier_code,
          nickname: carrier.nickname ?? carrier.friendly_name ?? null,
          friendlyName: carrier.friendly_name ?? carrier.nickname ?? null,
          sourceClientId: carrier.source_client_id,
          sourceClientName: carrier.source_client_name,
          disabled: Boolean(carrierDisabled),
          disabledReason: carrierDisabled,
          services,
        };
      }),
    };
  }));

  return { data, controls: visibleControls, authority: 'automation_shipping_controls', updatedAt: new Date().toISOString() };
}

type CarrierControlInput = {
  clientId: number;
  storeId?: number | null;
  carrierId: string;
  carrierCode?: string | null;
  disabled: boolean;
  reason?: string | null;
};

export async function setCarrierShippingControl(input: CarrierControlInput, actor: string) {
  if (input.disabled && isHugrabCarrierDisableProtected(
    { clientId: input.clientId, storeId: input.storeId ?? null },
    { carrierId: input.carrierId, carrierCode: input.carrierCode ?? null },
  )) {
    throw new ShippingControlPolicyError(
      HUGRAB_CARRIER_DISABLE_PROTECTED_REASON,
      'PS-057 locks services, not whole UPS carrier accounts',
    );
  }
  return upsertShippingAutomationControl({
    type: 'carrier',
    clientId: input.clientId,
    storeId: input.storeId ?? null,
    carrierId: input.carrierId,
    carrierCode: input.carrierCode ?? null,
    disabled: input.disabled,
    reason: input.reason ?? 'Carrier disabled by Automations workspace.',
    source: 'automations-workspace',
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });
}

type ServiceControlInput = Omit<CarrierControlInput, 'carrierId'> & {
  carrierId?: string | null;
  serviceCode?: string | number | null;
  serviceName?: string | null;
};

export async function setServiceShippingControl(input: ServiceControlInput, actor: string) {
  const descriptor = {
    carrierId: input.carrierId ?? null,
    carrierCode: input.carrierCode ?? null,
    serviceCode: input.serviceCode ?? null,
    serviceName: input.serviceName ?? null,
    serviceType: input.serviceName ?? null,
  };
  if (!input.disabled &&
      isHugrabShippingContext({ clientId: input.clientId, storeId: input.storeId ?? null }) &&
      isUpsGroundSaverOrSurePostService(descriptor)) {
    throw new ShippingControlPolicyError(HUGRAB_GROUND_SAVER_BLOCK_REASON, 'PS-057 locked');
  }
  return upsertShippingAutomationControl({
    type: 'service',
    clientId: input.clientId,
    storeId: input.storeId ?? null,
    carrierId: input.carrierId ?? null,
    carrierCode: input.carrierCode ?? null,
    serviceCode: input.serviceCode ?? null,
    serviceName: input.serviceName ?? null,
    disabled: input.disabled,
    reason: input.reason ?? 'Service disabled by Automations workspace.',
    source: 'automations-workspace',
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });
}

export async function setStoreCarrierShippingControls(input: {
  clientId: number;
  storeId: number;
  disabled: boolean;
  reason?: string | null;
}, actor: string) {
  const carriers = await getCarrierAccountsForRateContext(
    { storeId: input.storeId, clientId: input.clientId },
    { includeAutomationDisabled: true },
  ).catch(() => []);
  const skipped: Array<{ carrierId: string | null; carrierCode: string | null; reason: string }> = [];
  const updatedAt = new Date().toISOString();
  const changes: ShippingAutomationRule[] = [];
  for (const carrier of carriers) {
    const carrierId = carrier.carrier_id ?? null;
    const carrierCode = carrier.carrier_code ?? null;
    if (!carrierId && !carrierCode) continue;
    if (input.disabled && isHugrabCarrierDisableProtected(
      { clientId: input.clientId, storeId: input.storeId },
      { carrierId, carrierCode },
    )) {
      skipped.push({ carrierId, carrierCode, reason: HUGRAB_CARRIER_DISABLE_PROTECTED_REASON });
      continue;
    }
    changes.push({
      type: 'carrier',
      clientId: input.clientId,
      storeId: input.storeId,
      carrierId,
      carrierCode,
      disabled: input.disabled,
      reason: input.disabled ? input.reason ?? 'All carriers disabled by Automations workspace.' : null,
      source: 'automations-workspace',
      updatedAt,
      updatedBy: actor,
    });
  }
  const controls = await upsertShippingAutomationControls(changes);
  return { controls, applied: changes.length, skipped };
}
