import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireInternalPermission } from '../middleware/auth';
import { auditActorFromContext, recordAuditEvent } from '../services/audit-log';
import {
  applyStoreSourceCutover,
  dryRunStoreSourceCutover,
  listStoreSourceCutovers,
  updateStoreSourceCutoverMode,
} from '../services/store-source-cutover';

const app = new Hono();

const cutoverBody = z.object({
  clientId: z.coerce.number().int().positive(),
  shopifyStoreAccountId: z.coerce.number().int().positive(),
  shipstationStoreIds: z.array(z.coerce.number().int().positive()).min(1).max(25),
  syncAnchorAt: z.string().datetime().nullable().optional(),
});

const modeBody = z.object({
  mode: z.enum(['active', 'paused']),
});

app.get('/', requireInternalPermission('settings:read'), async (c) => {
  const url = new URL(c.req.url);
  const clientIdRaw = url.searchParams.get('clientId');
  const targetRaw = url.searchParams.get('targetStoreAccountId');
  const modeRaw = url.searchParams.get('mode');
  const mode = modeRaw === 'active' || modeRaw === 'paused' ? modeRaw : undefined;
  const clientId = clientIdRaw ? Number(clientIdRaw) : undefined;
  const targetStoreAccountId = targetRaw ? Number(targetRaw) : undefined;
  const data = await listStoreSourceCutovers({
    clientId: Number.isFinite(clientId) ? clientId : undefined,
    targetStoreAccountId: Number.isFinite(targetStoreAccountId) ? targetStoreAccountId : undefined,
    mode,
  });
  return c.json({ data });
});

app.post(
  '/dry-run',
  requireInternalPermission('settings:write'),
  zValidator('json', cutoverBody),
  async (c) => {
    const body = c.req.valid('json');
    const dryRun = await dryRunStoreSourceCutover(body);
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'store_source_cutover',
      resourceType: 'store_account',
      resourceId: body.shopifyStoreAccountId,
      action: 'dry_run',
      details: {
        clientId: body.clientId,
        shipstationStoreIds: body.shipstationStoreIds,
        duplicateCandidateCount: dryRun.duplicateCandidates.length,
        shipstationAwaitingCount: dryRun.shipstationAwaitingCount,
        shopifyExistingCount: dryRun.shopifyExistingCount,
      },
    });
    return c.json({ data: dryRun });
  },
);

app.post(
  '/apply',
  requireInternalPermission('settings:write'),
  zValidator('json', cutoverBody),
  async (c) => {
    const body = c.req.valid('json');
    const actor = c.get('email') ?? c.get('userId') ?? null;
    const data = await applyStoreSourceCutover({ ...body, actor });
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'store_source_cutover',
      resourceType: 'store_account',
      resourceId: body.shopifyStoreAccountId,
      action: 'apply',
      details: {
        clientId: body.clientId,
        shipstationStoreIds: body.shipstationStoreIds,
        cutoverIds: data.cutovers.map((row) => row.id),
        duplicateCandidateCount: data.dryRun.duplicateCandidates.length,
        syncAnchorAt: data.dryRun.syncAnchorAt,
      },
    });
    return c.json({ data });
  },
);

app.patch(
  '/:id{[0-9]+}',
  requireInternalPermission('settings:write'),
  zValidator('json', modeBody),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const data = await updateStoreSourceCutoverMode({
      id,
      mode: body.mode,
      actor: c.get('email') ?? c.get('userId') ?? null,
    });
    if (!data) return c.json({ error: `store_source_cutovers row #${id} not found` }, 404);
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'store_source_cutover',
      resourceType: 'store_source_cutover',
      resourceId: id,
      action: body.mode === 'active' ? 'resume' : 'pause',
      details: {
        clientId: data.clientId,
        legacyProvider: data.legacyProvider,
        legacyStoreId: data.legacyStoreId,
        targetProvider: data.targetProvider,
        targetStoreAccountId: data.targetStoreAccountId,
        mode: data.mode,
      },
    });
    return c.json({ data });
  },
);

export default app;
