// Per user override unlock shipped data on 2026-08-25: PS-497 Slice 2 Release B (S2.6) — the operator
// review-resolver route. THIN: validate -> call the canonical service -> return the DTO. It never owns the
// disposition rule (that lives in resolve-occurrence-review.ts + line-supply-policy.ts) and never moves stock
// (execution stays with the dedicated occurrence worker + the three flags). Mounted under requireAuth in
// main.ts, so only an authenticated operator reaches it.
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db/client';
import { resolveOccurrenceReviewClaim } from '../services/fulfillment/resolve-occurrence-review';

const app = new Hono<{ Variables: { email?: string } }>();

const bodySchema = z.object({ decision: z.enum(['pending', 'not_applicable']) });

app.post('/claims/:claimId/resolve', zValidator('json', bodySchema), async (c) => {
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

export default app;
