import { asc, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../../db/client.js';
import { automationShippingControls } from '../../db/schema/automations.js';
import { advisoryLockKeyPair } from '../../lib/advisory-lock.js';
import type { ShippingAutomationRule } from '../../lib/shipping-service-eligibility.js';

const SHIPPING_CONTROLS_LOCK_KEY = 'automation_shipping_controls';

export class ShippingControlLockedError extends Error {
  readonly code = 'AUTOMATION_SHIPPING_CONTROL_LOCKED';
  readonly status = 409;
  readonly locked = true;
  readonly reason = 'System controls require a reviewed migration or policy change';

  constructor() {
    super('This carrier or service control is system-locked and cannot be enabled');
    this.name = 'ShippingControlLockedError';
  }
}

function normalizeNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeText(value: string | number | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

export function shippingAutomationControlKey(rule: ShippingAutomationRule): string {
  return [
    rule.type,
    normalizeNullableNumber(rule.clientId) ?? '',
    normalizeNullableNumber(rule.storeId) ?? '',
    normalizeText(rule.carrierId),
    normalizeText(rule.carrierCode),
    normalizeText(rule.serviceCode),
    normalizeText(rule.serviceName),
  ].join('|');
}

function validateControl(rule: ShippingAutomationRule): void {
  if (rule.type !== 'carrier' && rule.type !== 'service') {
    throw new Error('Shipping controls require a carrier or service type');
  }
  if (normalizeNullableNumber(rule.clientId) == null && normalizeNullableNumber(rule.storeId) == null) {
    throw new Error('Shipping controls require a client or store scope');
  }
  if (rule.type === 'carrier' && !normalizeText(rule.carrierId) && !normalizeText(rule.carrierCode)) {
    throw new Error('Shipping controls require a carrier identity');
  }
  if (rule.type === 'service' && !normalizeText(rule.serviceCode) && !normalizeText(rule.serviceName)) {
    throw new Error('Service controls require a service identity');
  }
}

function projectControl(
  row: typeof automationShippingControls.$inferSelect,
): ShippingAutomationRule {
  return {
    type: row.controlType as ShippingAutomationRule['type'],
    clientId: row.clientId,
    storeId: row.storeId,
    carrierId: row.carrierId,
    carrierCode: row.carrierCode,
    serviceCode: row.serviceCode,
    serviceName: row.serviceName,
    disabled: true,
    reason: row.reason,
    locked: row.systemLocked,
    source: row.source,
    updatedAt: row.sourceUpdatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function loadShippingAutomationControls(): Promise<ShippingAutomationRule[]> {
  const rows = await db
    .select()
    .from(automationShippingControls)
    .orderBy(asc(automationShippingControls.position), asc(automationShippingControls.id));
  return rows.map(projectControl);
}

export function shippingAutomationControlsFingerprint(rules: ShippingAutomationRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 12);
}

export async function upsertShippingAutomationControls(
  nextRules: ShippingAutomationRule[],
): Promise<ShippingAutomationRule[]> {
  if (nextRules.length === 0) return loadShippingAutomationControls();
  for (const rule of nextRules) validateControl(rule);

  const byKey = new Map(nextRules.map((rule) => [shippingAutomationControlKey(rule), rule]));
  const keys = [...byKey.keys()];
  const [classid, objid] = advisoryLockKeyPair(SHIPPING_CONTROLS_LOCK_KEY);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${classid}, ${objid})`);
    const current = await tx
      .select()
      .from(automationShippingControls)
      .orderBy(asc(automationShippingControls.position), asc(automationShippingControls.id));
    const matches = current.filter((row) => keys.includes(row.controlKey));
    for (const row of matches) {
      const next = byKey.get(row.controlKey)!;
      if (row.systemLocked && next.disabled !== true) throw new ShippingControlLockedError();
    }

    const removable = matches.filter((row) => !row.systemLocked).map((row) => row.controlKey);
    if (removable.length > 0) {
      await tx.delete(automationShippingControls).where(inArray(automationShippingControls.controlKey, removable));
    }

    let position = current.reduce((maximum, row) => Math.max(maximum, row.position), 0);
    const inserts = [...byKey.entries()]
      .filter(([key, rule]) => rule.disabled === true && !matches.some((row) => row.controlKey === key && row.systemLocked))
      .map(([controlKey, rule]) => ({
        controlKey,
        controlType: rule.type,
        clientId: normalizeNullableNumber(rule.clientId),
        storeId: normalizeNullableNumber(rule.storeId),
        carrierId: rule.carrierId == null ? null : String(rule.carrierId).trim() || null,
        carrierCode: rule.carrierCode == null ? null : String(rule.carrierCode).trim() || null,
        serviceCode: rule.serviceCode == null ? null : String(rule.serviceCode).trim() || null,
        serviceName: rule.serviceName == null ? null : String(rule.serviceName).trim() || null,
        disabled: true,
        reason: rule.reason?.trim() || null,
        systemLocked: rule.locked === true,
        provenance: rule.locked === true || rule.source === 'system' ? 'system' : 'operator',
        source: rule.source?.trim() || 'automations-workspace',
        position: ++position,
        sourceUpdatedAt: rule.updatedAt?.trim() || new Date().toISOString(),
        updatedBy: rule.updatedBy?.trim() || 'unknown-operator',
      }));
    if (inserts.length > 0) await tx.insert(automationShippingControls).values(inserts);

    const updated = await tx
      .select()
      .from(automationShippingControls)
      .orderBy(asc(automationShippingControls.position), asc(automationShippingControls.id));
    return updated.map(projectControl);
  });
}

export async function upsertShippingAutomationControl(
  nextRule: ShippingAutomationRule,
): Promise<ShippingAutomationRule[]> {
  return upsertShippingAutomationControls([nextRule]);
}
