import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { settings } from '../db/schema/settings.js';
import { advisoryLockKeyPair } from '../lib/advisory-lock.js';
import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  isHugrabShippingContext,
  isUpsGroundSaverOrSurePostService,
  type ShippingAutomationRule,
  type ShippingServiceDescriptor,
  type ShippingServiceEligibilityContext,
} from '../lib/shipping-service-eligibility.js';

export const SHIPPING_AUTOMATION_RULES_KEY = 'shipping_automation_rules';

type RulePayload = {
  version?: number;
  rules?: ShippingAutomationRule[];
};

function normalizeRule(rule: unknown): ShippingAutomationRule | null {
  if (!rule || typeof rule !== 'object') return null;
  const row = rule as Record<string, unknown>;
  const type = row.type === 'carrier' || row.type === 'service' ? row.type : null;
  if (!type) return null;
  const disabled = row.disabled === true;
  return {
    type,
    clientId: row.clientId as number | string | null | undefined,
    storeId: row.storeId as number | string | null | undefined,
    carrierId: typeof row.carrierId === 'string' ? row.carrierId : null,
    carrierCode: typeof row.carrierCode === 'string' ? row.carrierCode : null,
    serviceCode: row.serviceCode as string | number | null | undefined,
    serviceName: typeof row.serviceName === 'string' ? row.serviceName : null,
    disabled,
    reason: typeof row.reason === 'string' ? row.reason : null,
    locked: row.locked === true,
    source: typeof row.source === 'string' ? row.source : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null,
  };
}

function parseRules(value: string | null | undefined): ShippingAutomationRule[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as RulePayload | ShippingAutomationRule[];
    const rules = Array.isArray(parsed) ? parsed : parsed.rules;
    if (!Array.isArray(rules)) return [];
    return rules.map(normalizeRule).filter((rule): rule is ShippingAutomationRule => Boolean(rule));
  } catch {
    return [];
  }
}

function normalizeNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: string | number | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function sameScope(a: ShippingAutomationRule, b: ShippingAutomationRule): boolean {
  return (
    normalizeNullableNumber(a.clientId) === normalizeNullableNumber(b.clientId) &&
    normalizeNullableNumber(a.storeId) === normalizeNullableNumber(b.storeId)
  );
}

function sameCarrierRule(a: ShippingAutomationRule, b: ShippingAutomationRule): boolean {
  return (
    sameScope(a, b) &&
    normalizeText(a.carrierId) === normalizeText(b.carrierId) &&
    normalizeText(a.carrierCode) === normalizeText(b.carrierCode)
  );
}

function sameServiceRule(a: ShippingAutomationRule, b: ShippingAutomationRule): boolean {
  return (
    sameCarrierRule(a, b) &&
    normalizeText(a.serviceCode) === normalizeText(b.serviceCode) &&
    normalizeText(a.serviceName) === normalizeText(b.serviceName)
  );
}

export async function loadShippingAutomationRules(): Promise<ShippingAutomationRule[]> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SHIPPING_AUTOMATION_RULES_KEY))
    .limit(1);
  return parseRules(row?.value);
}

export async function saveShippingAutomationRules(rules: ShippingAutomationRule[]): Promise<void> {
  const payload: RulePayload = {
    version: 1,
    rules,
  };
  await db
    .insert(settings)
    .values({
      key: SHIPPING_AUTOMATION_RULES_KEY,
      value: JSON.stringify(payload),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(payload) },
    });
}

export function shippingAutomationRulesFingerprint(rules: ShippingAutomationRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 12);
}

export async function upsertShippingAutomationRule(
  nextRule: ShippingAutomationRule,
): Promise<ShippingAutomationRule[]> {
  // PS-253 (Card 8): the load -> filter -> save is read-modify-write. Without a lock,
  // two concurrent saves both read the old set and the last writer wins, silently
  // dropping the other's change. Serialize the whole sequence on ONE connection under a
  // transaction-scoped advisory lock (auto-released on commit) so each save sees the
  // prior one. The read + write run on `tx` so the lock actually covers them.
  const [classid, objid] = advisoryLockKeyPair(SHIPPING_AUTOMATION_RULES_KEY);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${classid}, ${objid})`);
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SHIPPING_AUTOMATION_RULES_KEY))
      .limit(1);
    const currentRules = parseRules(row?.value);
    const matcher = nextRule.type === 'carrier' ? sameCarrierRule : sameServiceRule;
    const filtered = currentRules.filter((rule) => !matcher(rule, nextRule));
    const nextRules = nextRule.disabled ? [...filtered, nextRule] : filtered;
    const payload: RulePayload = { version: 1, rules: nextRules };
    await tx
      .insert(settings)
      .values({ key: SHIPPING_AUTOMATION_RULES_KEY, value: JSON.stringify(payload) })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(payload) } });
    return nextRules;
  });
}

// PS-139: removed dead export buildHugrabLockedAutomationRule (0 callers).
