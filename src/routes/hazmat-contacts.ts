import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireInternalPermission, type AuthVars } from '../middleware/auth.js';
import {
  createHazmatContact,
  deleteHazmatContact,
  HazmatContactConflictError,
  HazmatContactNotFoundError,
  listHazmatContacts,
  updateHazmatContact,
} from '../services/hazmat/contacts.js';

/**
 * CRUD for the reusable dangerous-goods contact book.
 *
 * Thin on purpose: validate shape, call the service, return the DTO. Which
 * contacts are visible for a client, what counts as a duplicate, and whether a
 * delete is allowed all live in services/hazmat/contacts.ts.
 */
const app = new Hono<{ Variables: AuthVars }>();

// Same bounds as the hazmat automation action's own schema
// (services/automations/catalog.ts). A contact that the rule it feeds would
// reject is worse than no contact -- the operator would only find out at
// publish time, with the phone number already saved.
const contactBody = z.object({
  clientId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(30)
    .regex(/^[+()\-\d\s.]+$/, 'Dangerous-goods contact phone is invalid'),
}).strict();

const listQuery = z.object({
  // Omitted or empty means "no client scope" -> shared contacts only.
  clientId: z.coerce.number().int().positive().optional(),
}).strict();

function actor(c: { get(name: 'email'): string | undefined; get(name: 'userId'): string }): string {
  return c.get('email') ?? c.get('userId');
}

function errorResponse(
  c: { json(value: Record<string, unknown>, status: 404 | 409): Response },
  error: unknown,
) {
  if (error instanceof HazmatContactNotFoundError) {
    return c.json({ error: error.message, code: error.code }, 404);
  }
  if (error instanceof HazmatContactConflictError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  throw error;
}

app.get(
  '/',
  requireInternalPermission('automations:read'),
  zValidator('query', listQuery),
  async (c) => {
    const { clientId } = c.req.valid('query');
    return c.json({ data: await listHazmatContacts(clientId ?? null) });
  },
);

app.post(
  '/',
  requireInternalPermission('hazmat:write'),
  zValidator('json', contactBody),
  async (c) => {
    const body = c.req.valid('json');
    try {
      return c.json({
        data: await createHazmatContact({
          clientId: body.clientId ?? null,
          name: body.name,
          phone: body.phone,
          actor: actor(c as never),
        }),
      }, 201);
    } catch (error) {
      return errorResponse(c as never, error);
    }
  },
);

app.patch(
  '/:id{[0-9]+}',
  requireInternalPermission('hazmat:write'),
  zValidator('json', contactBody),
  async (c) => {
    const body = c.req.valid('json');
    try {
      return c.json({
        data: await updateHazmatContact({
          id: Number(c.req.param('id')),
          clientId: body.clientId ?? null,
          name: body.name,
          phone: body.phone,
          actor: actor(c as never),
        }),
      });
    } catch (error) {
      return errorResponse(c as never, error);
    }
  },
);

app.delete('/:id{[0-9]+}', requireInternalPermission('hazmat:write'), async (c) => {
  try {
    return c.json({
      data: await deleteHazmatContact({
        id: Number(c.req.param('id')),
        actor: actor(c as never),
      }),
    });
  } catch (error) {
    return errorResponse(c as never, error);
  }
});

export default app;
