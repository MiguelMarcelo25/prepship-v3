// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.6) — the operator
// review-resolver route. THIN: validate -> call the canonical service -> return the DTO. It never owns the
// disposition rule (that lives in resolve-occurrence-review.ts + line-supply-policy.ts) and never moves stock
// (execution stays with the dedicated occurrence worker + the three flags). Mounted under requireAuth in
// main.ts, so only an authenticated operator reaches it.
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db/client';
import { requireInternalPermission } from '../middleware/auth';
import { resolveOccurrenceReviewClaim } from '../services/fulfillment/resolve-occurrence-review';
import { supersedeFulfillmentOccurrence } from '../services/fulfillment/supersede-fulfillment-occurrence';

const app = new Hono<{ Variables: { email?: string } }>();

const bodySchema = z.object({ decision: z.enum(['pending', 'not_applicable']) });
const supersedeBody = z.object({
  orderId: z.number().int().positive(),
  fromOccurrenceId: z.number().int().positive(),
  toOccurrenceId: z.number().int().positive(),
});

// Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.6 correction) — resolving a
// shipped claim mutates inventory-bound state, so it requires the internal inventory:write permission (NOT
// merely authentication). This excludes portal/client_user/read_only_support roles.
app.post('/claims/:claimId/resolve', requireInternalPermission('inventory:write'), zValidator('json', bodySchema), async (c) => {
  const claimId = Number(c.req.param('claimId'));
  if (!Number.isInteger(claimId) || claimId <= 0) {
    return c.json({ error: 'claimId must be a positive integer' }, 400);
  }
  const { decision } = c.req.valid('json');
  const email = c.get('email') ?? null;
  try {
    const result = await db.transaction((tx) =>
      resolveOccurrenceReviewClaim(tx, { claimId, decision, operator: { email } }),
    );
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'review resolution failed' }, 400);
  }
});

// Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.5 correction, Hermes #6c) — the
// production caller for occurrence supersession. THIN: validate -> canonical service in ONE transaction ->
// DTO. Same inventory:write gate (it mutates shipped occurrence/claim state). The service owns the invariants
// (same-order, no self/cycle, refuse if any claim already applied, transition only unapplied claims).
app.post('/occurrences/supersede', requireInternalPermission('inventory:write'), zValidator('json', supersedeBody), async (c) => {
  const input = c.req.valid('json');
  try {
    const result = await db.transaction((tx) => supersedeFulfillmentOccurrence(tx, input));
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'supersession failed' }, 400);
  }
});

export default app;
