import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { requireInternalPermission } from '../middleware/auth';
import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  evaluateShippingServiceEligibility,
  isHugrabShippingContext,
  isUpsGroundSaverOrSurePostService,
  type ShippingAutomationRule,
} from '../lib/shipping-service-eligibility';
import type { CarriersResponse } from '../lib/shipstation/types';
import { listCarrierAccounts } from '../services/carrier-connector-orchestrator';
import { getCarrierAccountsForRateContext } from '../services/rates';
import {
  SHIPPING_AUTOMATION_RULES_KEY,
  loadShippingAutomationRules,
  upsertShippingAutomationRule,
} from '../services/shipping-automation';

const app = new Hono();

const serviceRuleBody = z.object({
  clientId: z.number().int().positive(),
  storeId: z.number().int().nullable().optional(),
  carrierId: z.string().nullable().optional(),
  carrierCode: z.string().nullable().optional(),
  serviceCode: z.union([z.string(), z.number()]).nullable().optional(),
  serviceName: z.string().nullable().optional(),
  disabled: z.boolean(),
  reason: z.string().max(240).nullable().optional(),
});

const carrierRuleBody = z.object({
  clientId: z.number().int().positive(),
  storeId: z.number().int().nullable().optional(),
  carrierId: z.string().min(1),
  carrierCode: z.string().nullable().optional(),
  disabled: z.boolean(),
  reason: z.string().max(240).nullable().optional(),
});

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
  for (const cli of rows) {
    if (cli.active === false) continue;
    const storeIds = Array.isArray(cli.storeIds) ? cli.storeIds : [];
    for (const storeId of storeIds) {
      stores.push({
        storeId,
        clientId: cli.id,
        clientName: cli.name,
        active: true,
      });
    }
  }
  return stores.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.storeId - b.storeId);
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
  const identity = normalizeCatalogKey(carrierCode);
  if (!identity.includes('ups')) return [];
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
  rules: ShippingAutomationRule[],
): string | null {
  const matched = rules.find((rule) => (
    rule.type === 'carrier' &&
    rule.disabled &&
    Number(rule.clientId) === store.clientId &&
    (rule.storeId == null || Number(rule.storeId) === store.storeId) &&
    (
      normalizeCatalogKey(rule.carrierId) === normalizeCatalogKey(carrier.carrier_id) ||
      normalizeCatalogKey(rule.carrierCode) === normalizeCatalogKey(carrier.carrier_code)
    )
  ));
  return matched?.reason ?? null;
}

app.get('/availability', requireInternalPermission('settings:read'), async (c) => {
  const rules = await loadShippingAutomationRules();
  const [clientRows, carrierPayload] = await Promise.all([
    db.select().from(clients),
    listCarrierAccounts('shipstation', { dedupeKey: 'automation:carrier-catalog' }).catch(() => ({ carriers: [] })),
  ]);
  const stores = publicStoreRows(clientRows);
  const catalog = serviceCatalogByCarrier((carrierPayload as CarriersResponse).carriers ?? []);

  const data = await Promise.all(stores.map(async (store) => {
    const carriers = await getCarrierAccountsForRateContext(
      { storeId: store.storeId, clientId: store.clientId },
      { includeAutomationDisabled: true },
    ).catch(() => []);
    return {
      store,
      carriers: carriers.map((carrier) => {
        const carrierDisabled = carrierDisabledReason(carrier, store, rules);
        const services = servicesForCarrier(carrier, catalog).map((service) => {
          const eligibility = evaluateShippingServiceEligibility(
            {
              clientId: store.clientId,
              clientName: store.clientName,
              storeId: store.storeId,
            },
            {
              carrierId: carrier.carrier_id,
              carrierCode: carrier.carrier_code,
              carrierName: carrier.nickname ?? carrier.friendly_name,
              serviceCode: service.serviceCode,
              serviceName: service.name,
              serviceType: service.name,
            },
            null,
            rules,
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

  return c.json({
    data,
    rules,
    settingsKey: SHIPPING_AUTOMATION_RULES_KEY,
    updatedAt: new Date().toISOString(),
  });
});

app.patch(
  '/carrier',
  requireInternalPermission('settings:write'),
  zValidator('json', carrierRuleBody),
  async (c) => {
    const body = c.req.valid('json');
    const rules = await upsertShippingAutomationRule({
      type: 'carrier',
      clientId: body.clientId,
      storeId: body.storeId ?? null,
      carrierId: body.carrierId,
      carrierCode: body.carrierCode ?? null,
      disabled: body.disabled,
      reason: body.reason ?? 'Carrier disabled by Automation settings.',
      source: 'settings-automation',
      updatedAt: new Date().toISOString(),
      updatedBy: c.get('email') ?? null,
    });
    return c.json({ data: { rules } });
  },
);

app.patch(
  '/service',
  requireInternalPermission('settings:write'),
  zValidator('json', serviceRuleBody),
  async (c) => {
    const body = c.req.valid('json');
    const descriptor = {
      carrierId: body.carrierId ?? null,
      carrierCode: body.carrierCode ?? null,
      serviceCode: body.serviceCode ?? null,
      serviceName: body.serviceName ?? null,
      serviceType: body.serviceName ?? null,
    };
    if (
      body.disabled === false &&
      isHugrabShippingContext({ clientId: body.clientId, storeId: body.storeId ?? null }) &&
      isUpsGroundSaverOrSurePostService(descriptor)
    ) {
      return c.json({
        error: HUGRAB_GROUND_SAVER_BLOCK_REASON,
        locked: true,
        reason: 'PS-057 locked',
      }, 409);
    }
    const rules = await upsertShippingAutomationRule({
      type: 'service',
      clientId: body.clientId,
      storeId: body.storeId ?? null,
      carrierId: body.carrierId ?? null,
      carrierCode: body.carrierCode ?? null,
      serviceCode: body.serviceCode ?? null,
      serviceName: body.serviceName ?? null,
      disabled: body.disabled,
      reason: body.reason ?? 'Service disabled by Automation settings.',
      source: 'settings-automation',
      updatedAt: new Date().toISOString(),
      updatedBy: c.get('email') ?? null,
    });
    return c.json({ data: { rules } });
  },
);

export default app;
