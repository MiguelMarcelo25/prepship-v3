import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema/settings';
import { requirePermission } from '../middleware/auth';
import { getSetting, listMarkupSettings, listUserSettings } from '../services/settings';
import { isAllowedSettingKey } from '../services/user-setting-policy';
// PS-234: durable audit trail for settings writes.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';
// Settings-backed 60s read caches — cleared on every settings write/delete so
// an edit takes effect immediately in this process (other instances converge
// within the TTL).
import { clearCarrierMarkupsCache } from '../services/rates';
import { clearMarketplaceFeeRulesCache } from '../services/marketplace-fee';

export { ALLOWED_SETTINGS, isAllowedSettingKey } from '../services/user-setting-policy';

const app = new Hono();

app.get('/', requirePermission('settings:read'), async (c) => {
  const rows = await listUserSettings();
  return c.json({ data: rows });
});

app.get('/markups', requirePermission('settings:read'), async (c) => {
  const rows = await listMarkupSettings();
  return c.json({ data: rows });
});

app.get('/:key', requirePermission('settings:read'), async (c) => {
  const key = c.req.param('key');
  if (!isAllowedSettingKey(key)) {
    return c.json({ error: `Setting key not allowed: ${key}` }, 400);
  }
  return c.json({ key, value: await getSetting(key) });
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
