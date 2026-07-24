import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { LabelPurchaseInProgressError } from '../lib/label-purchase-lock.js';
import { scopeFromContext } from '../lib/order-scope.js';
import { hasAppPermission, requireInternalPermission } from '../middleware/auth.js';
import { auditActorFromContext } from '../services/audit-log.js';
import {
  getOrderHazmat,
  OrderHazmatError,
  saveOrderHazmatDeclaration,
  validateOrderHazmatDraft,
} from '../services/order-hazmat.js';

const app = new Hono();

const nullableText = z.string().trim().max(500).nullable().optional();
const nullableBoolean = z.boolean().nullable().optional();
const materialSchema = z.object({
  sequence: z.number().int().positive().optional(),
  unNaNumber: nullableText,
  properShippingName: nullableText,
  technicalName: nullableText,
  hazardClass: nullableText,
  subsidiaryHazardClass: nullableText,
  packingGroup: z.enum(['i', 'ii', 'iii']).nullable().optional(),
  amount: z.number().positive().nullable().optional(),
  amountUnit: nullableText,
  quantity: z.number().int().positive().nullable().optional(),
  packagingInstruction: nullableText,
  packagingInstructionSection: nullableText,
  packagingType: nullableText,
  transportMean: nullableText,
  transportCategory: nullableText,
  regulationAuthority: nullableText,
  regulationLevel: nullableText,
  radioactive: nullableBoolean,
  reportableQuantity: nullableBoolean,
  additionalDescription: nullableText,
}).strict();

const declarationSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  status: z.enum(['clear', 'active']),
  limitedQuantity: nullableBoolean,
  containsBattery: nullableBoolean,
  dryIce: nullableBoolean,
  dryIceWeightValue: z.number().positive().nullable().optional(),
  dryIceWeightUnit: nullableText,
  emergencyContactName: nullableText,
  emergencyContactPhone: nullableText,
  uspsCategory: nullableText,
  uspsPackageLevel: nullableBoolean,
  regulatedContentType: nullableText,
  materials: z.array(materialSchema).max(25).optional(),
}).strict();

const mutationBody = z.object({
  expectedRevision: z.number().int().nonnegative(),
  declaration: declarationSchema,
}).strict();

function orderId(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OrderHazmatError('Order id must be a positive integer.', 'ORDER_ID_INVALID');
  }
  return value;
}

function errorResponse(c: Context<any>, error: unknown) {
  if (error instanceof OrderHazmatError) {
    return c.json(
      { error: error.message, code: error.code, ...(error.details ?? {}) },
      error.status,
    );
  }
  if (error instanceof LabelPurchaseInProgressError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  throw error;
}

app.get('/:id{[0-9]+}/hazmat', requireInternalPermission('rates:quote'), async (c) => {
  try {
    const data = await getOrderHazmat(orderId(c.req.param('id')), scopeFromContext(c));
    const callerCanWrite = hasAppPermission({
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    }, 'hazmat:write');
    return c.json({
      data: {
        ...data,
        capabilities: {
          ...data.capabilities,
          writeEnabled: data.capabilities.writeEnabled && callerCanWrite,
        },
      },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post(
  '/:id{[0-9]+}/hazmat/validate',
  requireInternalPermission('hazmat:write'),
  zValidator('json', mutationBody),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const data = await validateOrderHazmatDraft({
        orderId: orderId(c.req.param('id')),
        expectedRevision: body.expectedRevision,
        declaration: body.declaration,
        scope: scopeFromContext(c),
      });
      return c.json({ data });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

app.put(
  '/:id{[0-9]+}/hazmat',
  requireInternalPermission('hazmat:write'),
  zValidator('json', mutationBody),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const data = await saveOrderHazmatDeclaration({
        orderId: orderId(c.req.param('id')),
        expectedRevision: body.expectedRevision,
        declaration: body.declaration,
        scope: scopeFromContext(c),
        actor: auditActorFromContext(c),
      });
      return c.json({ data });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

export default app;
