import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema/settings';
import { requirePermission } from '../middleware/auth';
// PS-234: durable audit trail for settings writes.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';
// Settings-backed 60s read caches — cleared on every settings write/delete so
// an edit takes effect immediately in this process (other instances converge
// within the TTL).
import { clearCarrierMarkupsCache } from '../services/rates';
import { clearMarketplaceFeeRulesCache } from '../services/marketplace-fee';

// v2-parity ALLOWED_SETTINGS guard. v2 source:
//   packages/contracts/src/settings/contracts.ts#ALLOWED_SETTINGS
// v4 extends the v2 tuple with:
//   - `orders.columnPrefs` — in active use by web/src/lib/v2-apiClient.ts
//   - `markup.<carrierId|pid>` dynamic keys — web/src/contexts/MarkupsContext.tsx
//     persists carrier/package markups here (rates.ts reads them via
//     LIKE 'markup.%' at read time).
// Rather than an exact Zod enum, we use a refinement that accepts the v2
// allowlist PLUS these v4-only runtime patterns. Unknown keys fail with 400.
export const ALLOWED_SETTINGS = [
  'rbMarkups',
  'rbSettings',
  'colVisibility',
  'colPrefs',
  'colWidths',
  'dateRange',
  'pageSize',
  'defaultView',
  // v4-only exact keys in active use
  'orders.columnPrefs',
  // PS-239: per-client/store marketplace-fee rules ({version, rules:[]}).
  'marketplace_fee_rules',
] as const;

export type AllowedSettingKey = (typeof ALLOWED_SETTINGS)[number];

const allowedSet = new Set<string>(ALLOWED_SETTINGS);

export function isAllowedSettingKey(key: string): boolean {
  if (allowedSet.has(key)) return true;
  // Dynamic prefix: markup.<carrierId|pid> — persisted per-carrier/per-package.
  if (key.startsWith('markup.') && key.length > 'markup.'.length) return true;
  return false;
}

const app = new Hono();

app.get('/', requirePermission('settings:read'), async (c) => {
  const rows = await db.select().from(settings).orderBy(asc(settings.key));
  return c.json({ data: rows });
});

app.get('/:key', requirePermission('settings:read'), async (c) => {
  const key = c.req.param('key');
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) return c.json({ key, value: null });
  return c.json(row);
});

const putBody = z.object({ value: z.string() });

app.put('/:key', requirePermission('settings:write'), zValidator('json', putBody), async (c) => {
  const key = c.req.param('key');
  if (!isAllowedSettingKey(key)) {
    return c.json({ error: `Setting key not allowed: ${key}` }, 400);
  }
  const { value } = c.req.valid('json');
  const [row] = await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .returning();
  clearCarrierMarkupsCache();
  clearMarketplaceFeeRulesCache();
  // PS-234: audit the settings write (key only — value may carry config, never logged raw).
  await recordAuditEvent({
    ...auditActorFromContext(c),
    eventType: 'settings',
    resourceType: 'setting',
    resourceId: key,
    action: 'write',
    details: { key },
  });
  return c.json(row);
});

app.delete('/:key', requirePermission('settings:write'), async (c) => {
  const key = c.req.param('key');
  if (!isAllowedSettingKey(key)) {
    return c.json({ error: `Setting key not allowed: ${key}` }, 400);
  }
  const [row] = await db.delete(settings).where(eq(settings.key, key)).returning();
  clearCarrierMarkupsCache();
  clearMarketplaceFeeRulesCache();
  if (!row) return c.json({ error: 'Setting not found' }, 404);
  await recordAuditEvent({
    ...auditActorFromContext(c),
    eventType: 'settings',
    resourceType: 'setting',
    resourceId: key,
    action: 'delete',
  });
  return c.json({ deleted: true });
});

export default app;
