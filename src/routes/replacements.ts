import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import {
  replacements,
  replacementItems,
  replacementOriginalOrderHolds,
} from '../db/schema/replacements';
import { env } from '../lib/env';
import { requireInternalPermission, type AuthVars } from '../middleware/auth';
import { isOrderRowInScope, orderScopePredicate, scopeFromContext } from '../lib/order-scope';
import { createReplacement } from '../services/replacement-create-command';
import {
  approveReplacement,
  cancelReplacement,
  rejectReplacement,
  resolveReplacementReview,
} from '../services/replacement-lifecycle-command';
import {
  raiseReplacementOriginalOrderHoldsInTransaction,
} from '../services/replacement-original-order-hold';
import { collectReplacementDiagnostics } from '../services/replacement-diagnostics';

/**
 * PS-502 item 13 — the operator HTTP surface for replacements.
 *
 * ── DEFAULT OFF, AS A WHOLE ROUTER ──────────────────────────────────────────────────────
 *
 * Every path here answers 403 REPLACEMENTS_DISABLED unless REPLACEMENTS_ENABLED is on.
 *
 * NOT 404: this router already uses 404 for "no such replacement", and an operator debugging
 * a request must be able to tell a disabled surface from a missing row. The flag is
 * operational configuration, not a secret worth hiding behind an ambiguous status.
 * NOT 503 either — that is reserved for readiness here, and Render restarts on it.
 *
 * A distinct CODE rather than a bare 403 for the same reason: "you lack a permission" and
 * "this is switched off" send an operator to two different places.
 *
 * The gate is still a router-level middleware, not a per-handler check. A per-handler check is one
 * `git revert` away from protecting five of six routes, and the sixth is the one that buys
 * postage.
 *
 * ── THE ROUTE NEVER DECIDES THE STATUS CODE ─────────────────────────────────────────────
 *
 * Every replacement command throws an error carrying its OWN `httpStatus` and `code`. The
 * mapper below reads them. A route that re-derived the status would be a second opinion about
 * what a conflict is, and the two would drift — a state conflict becoming a 400 the day
 * someone tidies a switch statement.
 *
 * ── SCOPE IS THE ORDER'S SCOPE ──────────────────────────────────────────────────────────
 *
 * A replacement hangs off an original order, so "may this caller touch it" is exactly "may
 * this caller touch that order". That question already has an owner — order-scope.ts, written
 * after /rates/browse turned out to read any tenant's order — and this delegates rather than
 * re-deriving it. An out-of-scope id 404s, so a client cannot probe which replacements exist.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────
 *
 * Label purchase, label void and ship. They depend on the customer-money freeze site, which
 * does not exist yet: `purchaseReplacementLabel` writes only the carrier receipt, so nothing
 * currently produces the frozen tuple AC-10's fence requires. Exposing them now would mean
 * shipping a route whose billing path can only refuse.
 */

const app = new Hono<{ Variables: AuthVars }>();

/** The feature gate. Router-wide, before anything else runs. */
app.use('*', async (c, next) => {
  if (!env.REPLACEMENTS_ENABLED) {
    return c.json(
      { error: 'The replacements surface is not enabled', code: 'REPLACEMENTS_DISABLED' },
      403,
    );
  }
  await next();
});

type ReplacementActor = {
  email: string | null;
  type: string;
  permissions: readonly string[];
};

/**
 * The actor the COMMANDS expect — email, type and permissions.
 *
 * Permissions are passed through rather than pre-checked here: `replacements:override` and
 * `replacements:label` are enforced INSIDE their commands, where the decision that needs them
 * is actually made. Checking them again at the route would create a second authority that can
 * disagree, and the command is the one that must not be bypassable.
 */
function replacementActor(c: { get: (k: never) => unknown }): ReplacementActor {
  return {
    email: (c.get('email' as never) as string | undefined) ?? null,
    type: (c.get('role' as never) as string | undefined) ?? 'operator',
    permissions: (c.get('permissions' as never) as string[] | undefined) ?? [],
  };
}

type CodedError = { code?: unknown; httpStatus?: unknown; message?: unknown; details?: unknown };

/** Status and code come from the command. This only shapes them into a response. */
function respondToCommandError(c: { json: (body: unknown, status: never) => Response }, error: unknown): Response {
  const e = error as CodedError;
  // Re-thrown, not swallowed. A command that failed for a reason it never named is a bug,
  // and dressing it as a coded refusal would make it look handled in the logs forever.
  if (typeof e?.httpStatus !== 'number' || typeof e?.code !== 'string') throw error;
  const status = e.httpStatus;
  const code = e.code;
  const message = typeof e?.message === 'string' ? e.message : 'replacement command failed';
  return c.json(
    { error: message, code, ...(e?.details ? { details: e.details } : {}) },
    status as never,
  );
}

/**
 * Load a replacement the caller is allowed to see, or null.
 *
 * Joined to `orders` so the scope predicate applies to the ORIGINAL order — the row that
 * actually carries client and store. Returning null (and 404 above) rather than 403 keeps the
 * existence of another tenant's replacement unobservable.
 */
async function loadInScope(c: Parameters<typeof scopeFromContext>[0], replacementId: number) {
  const scope = scopeFromContext(c);
  const [row] = await db
    .select({
      replacement: replacements,
      orderClientId: orders.clientId,
      orderStoreId: orders.storeId,
    })
    .from(replacements)
    .innerJoin(orders, eq(orders.id, replacements.orderId))
    .where(eq(replacements.id, replacementId))
    .limit(1);
  if (!row) return null;
  if (!isOrderRowInScope({ clientId: row.orderClientId, storeId: row.orderStoreId }, scope)) {
    return null;
  }
  return row.replacement;
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────

app.get('/', requireInternalPermission('replacements:read'), async (c) => {
  const scope = scopeFromContext(c);
  const scopePredicate = orderScopePredicate(scope);
  const rows = await db
    .select({ replacement: replacements })
    .from(replacements)
    .innerJoin(orders, eq(orders.id, replacements.orderId))
    .where(scopePredicate)
    .orderBy(desc(replacements.id))
    .limit(200);
  return c.json({ replacements: rows.map((r) => r.replacement) });
});

app.get('/:id{[0-9]+}', requireInternalPermission('replacements:read'), async (c) => {
  const replacement = await loadInScope(c, Number(c.req.param('id')));
  if (!replacement) return c.json({ error: 'Not found' }, 404);
  const items = await db
    .select()
    .from(replacementItems)
    .where(eq(replacementItems.replacementId, replacement.id));
  return c.json({ replacement, items });
});

/** The AC-16 queue: what a human still owes an answer to. */
app.get('/holds/open', requireInternalPermission('replacements:read'), async (c) => {
  const scope = scopeFromContext(c);
  const rows = await db
    .select({ hold: replacementOriginalOrderHolds })
    .from(replacementOriginalOrderHolds)
    .innerJoin(orders, eq(orders.id, replacementOriginalOrderHolds.orderId))
    .where(and(isNull(replacementOriginalOrderHolds.resolvedAt), orderScopePredicate(scope)))
    .orderBy(desc(replacementOriginalOrderHolds.createdAt))
    .limit(200);
  return c.json({ holds: rows.map((r) => r.hold) });
});

/**
 * Item 14 — the states nothing downstream will notice on its own.
 *
 * Read only, and deliberately NOT client-scoped: it reports counts and sample ids across the
 * whole installation because it exists for the operator diagnosing the SYSTEM, and it is
 * already behind requireInternalPermission, which refuses every portal session outright.
 */
app.get('/diagnostics', requireInternalPermission('replacements:read'), async (c) => {
  return c.json(await collectReplacementDiagnostics());
});

// ── Create ──────────────────────────────────────────────────────────────────────────────

const createBody = z.object({
  orderId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1),
  liabilityOwner: z.enum(['operator', 'client']),
  items: z.array(z.object({
    orderLineIndex: z.coerce.number().int().min(0),
    quantity: z.coerce.number().int().positive(),
  })).min(1),
  requestIdempotencyKey: z.string().trim().min(1).max(200),
  requestedBillable: z.boolean().optional(),
  billabilityReason: z.string().trim().max(2000).optional(),
  overrideReason: z.string().trim().max(2000).optional(),
}).strict();

app.post(
  '/',
  requireInternalPermission('replacements:write'),
  zValidator('json', createBody),
  async (c) => {
    const body = c.req.valid('json');
    const scope = scopeFromContext(c);
    const [order] = await db
      .select({ id: orders.id, clientId: orders.clientId, storeId: orders.storeId })
      .from(orders)
      .where(eq(orders.id, body.orderId))
      .limit(1);
    // Scope BEFORE the command: a caller must not learn from an eligibility error that
    // another tenant's order exists and is not shipped.
    if (!order || !isOrderRowInScope(order, scope)) {
      return c.json({ error: 'Not found' }, 404);
    }

    const actor = replacementActor(c);
    try {
      const result = await createReplacement({
        orderId: body.orderId,
        reason: body.reason,
        liabilityOwner: body.liabilityOwner,
        items: body.items,
        requestIdempotencyKey: body.requestIdempotencyKey,
        actor,
        requestedBillable: body.requestedBillable,
        billabilityReason: body.billabilityReason ?? null,
        // The command decides whether an override is permitted; the route only reports
        // whether the caller holds the permission and what they wrote.
        ...(body.overrideReason
          ? {
            override: {
              hasOverridePermission: actor.permissions.includes('replacements:override'),
              reason: body.overrideReason,
            },
          }
          : {}),
      });
      return c.json(result, 201);
    } catch (error) {
      return respondToCommandError(c, error);
    }
  },
);

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────

const reasonBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

/** Every transition is the same shape: scope, then delegate, then let the command's code speak. */
function transitionRoute(
  path: string,
  run: (replacementId: number, actor: ReplacementActor, reason: string) => Promise<unknown>,
) {
  app.post(
    path,
    requireInternalPermission('replacements:write'),
    zValidator('json', reasonBody),
    async (c) => {
      const replacement = await loadInScope(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      try {
        const result = await run(replacement.id, replacementActor(c), c.req.valid('json').reason);
        return c.json({ replacement: result });
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );
}

transitionRoute('/:id{[0-9]+}/approve', (replacementId, actor, reason) =>
  approveReplacement({ replacementId, actor, reason }));
transitionRoute('/:id{[0-9]+}/reject', (replacementId, actor, reason) =>
  rejectReplacement({ replacementId, actor, reason }));
transitionRoute('/:id{[0-9]+}/cancel', (replacementId, actor, reason) =>
  cancelReplacement({ replacementId, actor, reason }));

const resolveBody = reasonBody.extend({
  to: z.enum(['requested', 'approved', 'label_created', 'rejected', 'cancelled']),
}).strict();

app.post(
  '/:id{[0-9]+}/review/resolve',
  requireInternalPermission('replacements:write'),
  zValidator('json', resolveBody),
  async (c) => {
    const replacement = await loadInScope(c, Number(c.req.param('id')));
    if (!replacement) return c.json({ error: 'Not found' }, 404);
    const body = c.req.valid('json');
    try {
      const result = await resolveReplacementReview({
        replacementId: replacement.id,
        to: body.to,
        actor: replacementActor(c),
        reason: body.reason,
      });
      return c.json({ replacement: result });
    } catch (error) {
      return respondToCommandError(c, error);
    }
  },
);

// ── AC-16: an operator declares that an original order was cancelled or refunded ────────

const holdBody = z.object({
  orderId: z.coerce.number().int().positive(),
  triggerKind: z.enum(['order_cancelled', 'order_refunded']),
  reason: z.string().trim().min(1).max(2000),
}).strict();

/**
 * The ONLY producer of `order_refunded` holds, by design.
 *
 * There is no refund concept anywhere in this repo — no status, no column — so a refund cannot
 * be detected. It can only be declared, by a named person, with a written reason. That is why
 * `evidence_kind = 'operator_declaration'` requires `declared_by` to be non-null at the
 * database level: a declaration with nobody behind it is not evidence.
 *
 * Cancellations reach the hold sweep automatically from the upstream reconciler; this path
 * exists for the cases automation cannot see.
 */
app.post(
  '/holds',
  requireInternalPermission('replacements:hold'),
  zValidator('json', holdBody),
  async (c) => {
    const body = c.req.valid('json');
    const scope = scopeFromContext(c);
    const [order] = await db
      .select({ id: orders.id, clientId: orders.clientId, storeId: orders.storeId })
      .from(orders)
      .where(eq(orders.id, body.orderId))
      .limit(1);
    if (!order || !isOrderRowInScope(order, scope)) {
      return c.json({ error: 'Not found' }, 404);
    }

    const actor = replacementActor(c);
    if (!actor.email) {
      return c.json(
        { error: 'A named actor is required to declare a hold', code: 'REPLACEMENT_HOLD_ACTOR_REQUIRED' },
        401,
      );
    }

    try {
      const result = await db.transaction(async (tx) =>
        raiseReplacementOriginalOrderHoldsInTransaction(tx, {
          orderId: body.orderId,
          triggerKind: body.triggerKind,
          evidence: { kind: 'operator_declaration', declaredBy: actor.email! },
          reason: body.reason,
          actor,
        }));
      return c.json(result, 201);
    } catch (error) {
      return respondToCommandError(c, error);
    }
  },
);

export default app;
