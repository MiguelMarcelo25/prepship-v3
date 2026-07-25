import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getInternalOpsClientStoreScope } from '../lib/client-store-scope.js';
import { assertResourceInScope, ResourceScopeError } from '../lib/scope-predicates.js';
import { requireInternalPermission, type AuthVars } from '../middleware/auth.js';
import { getAutomationCatalog } from '../services/automations/catalog.js';
import type { AutomationRuleDocument } from '../services/automations/contracts.js';
import {
  AutomationConflictError,
  confirmAutomationReprocess,
  createAutomationDraft,
  getAutomationRule,
  getAutomationRun,
  listAutomationRules,
  listAutomationRuns,
  previewAutomationReprocess,
  publishAutomationDraft,
  setAutomationRuleStatus,
  simulateAutomationDraft,
  updateAutomationDraft,
} from '../services/automations/repository.js';
import { evaluateOrderAutomations } from '../services/automations/runtime.js';
import { ShippingControlLockedError } from '../services/automations/shipping-controls.js';
import {
  listShippingControlAvailability,
  setCarrierShippingControl,
  setServiceShippingControl,
  setStoreCarrierShippingControls,
  ShippingControlPolicyError,
} from '../services/automations/shipping-controls-workflow.js';

const app = new Hono<{ Variables: AuthVars }>();

const documentSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  trigger: z.enum([
    'order_imported',
    'order_facts_updated',
    'order_items_changed',
    'address_changed',
    'before_rate',
    'before_label_purchase',
    'manual_reprocess',
  ]),
  priority: z.number().int().min(0).max(100_000),
  position: z.number().int().min(0),
  unknownPolicy: z.enum(['no_match', 'block']),
  scope: z.object({
    clientIds: z.array(z.number().int().positive()).max(1),
    storeIds: z.array(z.number().int().positive()).max(1),
  }),
  condition: z.unknown(),
  actions: z.array(z.unknown()).min(1).max(12),
}).strict();

const draftBody = z.object({ document: documentSchema }).strict();
const simulationBody = z.object({ orderId: z.number().int().positive() }).strict();
const publishBody = z.object({ simulationHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const reprocessPreviewBody = z.object({ orderIds: z.array(z.number().int().positive()).min(1).max(100) }).strict();
const reprocessConfirmBody = reprocessPreviewBody.extend({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manualEvaluationBody = z.object({
  trigger: z.enum(['order_imported', 'order_facts_updated', 'order_items_changed', 'address_changed', 'manual_reprocess']).default('manual_reprocess'),
  sourceEventId: z.string().trim().min(1).max(160),
}).strict();
const carrierControlBody = z.object({
  clientId: z.number().int().positive(),
  storeId: z.number().int().positive().nullable().optional(),
  carrierId: z.string().trim().min(1),
  carrierCode: z.string().trim().nullable().optional(),
  disabled: z.boolean(),
  reason: z.string().trim().max(240).nullable().optional(),
}).strict();
const serviceControlBody = z.object({
  clientId: z.number().int().positive(),
  storeId: z.number().int().positive().nullable().optional(),
  carrierId: z.string().trim().nullable().optional(),
  carrierCode: z.string().trim().nullable().optional(),
  serviceCode: z.union([z.string().trim(), z.number()]).nullable().optional(),
  serviceName: z.string().trim().nullable().optional(),
  disabled: z.boolean(),
  reason: z.string().trim().max(240).nullable().optional(),
}).strict();
const storeCarrierControlsBody = z.object({
  clientId: z.number().int().positive(),
  storeId: z.number().int().positive(),
  disabled: z.boolean(),
  reason: z.string().trim().max(240).nullable().optional(),
}).strict();

function actor(c: { get(name: 'email'): string | undefined; get(name: 'userId'): string }): string {
  return c.get('email') ?? c.get('userId');
}

function scope(c: { get(name: 'email' | 'role' | 'permissions' | 'clientIds' | 'storeIds'): never }) {
  return getInternalOpsClientStoreScope({
    email: c.get('email'),
    role: c.get('role'),
    permissions: c.get('permissions'),
    clientIds: c.get('clientIds'),
    storeIds: c.get('storeIds'),
  });
}

function positiveId(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function expectedRevision(c: { req: { header(name: string): string | undefined } }): number | null {
  const raw = c.req.header('if-match')?.replace(/^W\//, '').replaceAll('"', '').trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function errorResponse(c: { json(value: Record<string, unknown>, status: 400 | 404 | 409): Response }, error: unknown) {
  if (error instanceof ShippingControlPolicyError) {
    return c.json({ error: error.message, locked: error.locked, reason: error.reason }, 409);
  }
  if (error instanceof ShippingControlLockedError) {
    return c.json({ error: error.message, locked: error.locked, reason: error.reason }, 409);
  }
  if (error instanceof AutomationConflictError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof ResourceScopeError || (error instanceof Error && /not found/i.test(error.message))) {
    return c.json({ error: 'Automation not found' }, 404);
  }
  return c.json({ error: error instanceof Error ? error.message : 'Automation request failed' }, 400);
}

app.get('/catalog', requireInternalPermission('automations:read'), (c) => c.json({ data: getAutomationCatalog() }));

app.get('/controls', requireInternalPermission('automations:read'), async (c) => {
  const result = await listShippingControlAvailability(scope(c as never));
  return c.json(result);
});

app.patch('/controls/carrier', requireInternalPermission('automations:write'), zValidator('json', carrierControlBody), async (c) => {
  try {
    const body = c.req.valid('json');
    assertResourceInScope(scope(c as never), body, 'Automation control not found');
    return c.json({ data: { controls: await setCarrierShippingControl(body, actor(c)) } });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.patch('/controls/service', requireInternalPermission('automations:write'), zValidator('json', serviceControlBody), async (c) => {
  try {
    const body = c.req.valid('json');
    assertResourceInScope(scope(c as never), body, 'Automation control not found');
    return c.json({ data: { controls: await setServiceShippingControl(body, actor(c)) } });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.patch('/controls/store-carriers', requireInternalPermission('automations:write'), zValidator('json', storeCarrierControlsBody), async (c) => {
  try {
    const body = c.req.valid('json');
    assertResourceInScope(scope(c as never), body, 'Automation control not found');
    return c.json({ data: await setStoreCarrierShippingControls(body, actor(c)) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/', requireInternalPermission('automations:read'), async (c) => {
  const data = await listAutomationRules(scope(c as never));
  return c.json({ data });
});

app.get('/runs', requireInternalPermission('automations:read'), async (c) => {
  const ruleId = c.req.query('ruleId') ? positiveId(c.req.query('ruleId')!) : undefined;
  const orderId = c.req.query('orderId') ? positiveId(c.req.query('orderId')!) : undefined;
  const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50));
  const data = await listAutomationRuns({ ruleId: ruleId ?? undefined, orderId: orderId ?? undefined, limit, scope: scope(c as never) });
  return c.json({ data });
});

app.get('/runs/:runId', requireInternalPermission('automations:read'), async (c) => {
  const runId = positiveId(c.req.param('runId'));
  if (!runId) return c.json({ error: 'Automation run not found' }, 404);
  try {
    return c.json({ data: await getAutomationRun(runId, scope(c as never)) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/', requireInternalPermission('automations:write'), zValidator('json', draftBody), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await createAutomationDraft({
      document: body.document as AutomationRuleDocument,
      actor: actor(c),
      scope: scope(c as never),
    });
    c.header('ETag', `"${data.version.draftRevision}"`);
    return c.json({ data }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get('/:id', requireInternalPermission('automations:read'), async (c) => {
  const ruleId = positiveId(c.req.param('id'));
  if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
  try {
    const data = await getAutomationRule(ruleId, scope(c as never));
    const draft = data.versions.find((version) => version.lifecycle === 'draft');
    if (draft) c.header('ETag', `"${draft.draftRevision}"`);
    return c.json({ data });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put('/:id/draft', requireInternalPermission('automations:write'), zValidator('json', draftBody), async (c) => {
  const ruleId = positiveId(c.req.param('id'));
  const revision = expectedRevision(c);
  if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
  if (!revision) return c.json({ error: 'If-Match draft revision is required' }, 409);
  try {
    const body = c.req.valid('json');
    const data = await updateAutomationDraft({
      ruleId,
      expectedRevision: revision,
      document: body.document as AutomationRuleDocument,
      actor: actor(c),
      scope: scope(c as never),
    });
    c.header('ETag', `"${data.version.draftRevision}"`);
    return c.json({ data });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/:id/simulate', requireInternalPermission('automations:read'), zValidator('json', simulationBody), async (c) => {
  const ruleId = positiveId(c.req.param('id'));
  const revision = expectedRevision(c);
  if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
  if (!revision) return c.json({ error: 'If-Match draft revision is required' }, 409);
  try {
    const body = c.req.valid('json');
    return c.json({ data: await simulateAutomationDraft({
      ruleId,
      orderId: body.orderId,
      expectedRevision: revision,
      scope: scope(c as never),
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/:id/publish', requireInternalPermission('automations:publish'), zValidator('json', publishBody), async (c) => {
  const ruleId = positiveId(c.req.param('id'));
  const revision = expectedRevision(c);
  if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
  if (!revision) return c.json({ error: 'If-Match draft revision is required' }, 409);
  try {
    const body = c.req.valid('json');
    return c.json({ data: await publishAutomationDraft({
      ruleId,
      expectedRevision: revision,
      simulationHash: body.simulationHash,
      actor: actor(c),
      scope: scope(c as never),
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/:id/reprocess-preview', requireInternalPermission('automations:reprocess'), zValidator('json', reprocessPreviewBody), async (c) => {
  const ruleId = positiveId(c.req.param('id'));
  if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
  try {
    return c.json({ data: await previewAutomationReprocess({
      ruleId,
      orderIds: c.req.valid('json').orderIds,
      scope: scope(c as never),
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/:id/reprocess', requireInternalPermission('automations:reprocess'), zValidator('json', reprocessConfirmBody), async (c) => {
  const ruleId = positiveId(c.req.param('id'));
  if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
  try {
    const body = c.req.valid('json');
    return c.json({ data: await confirmAutomationReprocess({
      ruleId,
      orderIds: body.orderIds,
      previewHash: body.previewHash,
      actor: actor(c),
      scope: scope(c as never),
    }) }, 202);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post('/orders/:orderId/evaluate', requireInternalPermission('automations:reprocess'), zValidator('json', manualEvaluationBody), async (c) => {
  const orderId = positiveId(c.req.param('orderId'));
  if (!orderId) return c.json({ error: 'Order not found' }, 404);
  try {
    const body = c.req.valid('json');
    return c.json({ data: await evaluateOrderAutomations({
      orderId,
      trigger: body.trigger,
      sourceEventId: body.sourceEventId,
      scope: scope(c as never),
    }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

for (const status of ['paused', 'archived'] as const) {
  app.post(`/:id/${status === 'paused' ? 'pause' : 'archive'}`, requireInternalPermission('automations:publish'), async (c) => {
    const ruleId = positiveId(c.req.param('id'));
    if (!ruleId) return c.json({ error: 'Automation not found' }, 404);
    try {
      return c.json({ data: await setAutomationRuleStatus({
        ruleId,
        status,
        actor: actor(c),
        scope: scope(c as never),
      }) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}

export default app;
