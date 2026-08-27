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
import {
  APP_PERMISSIONS,
  hasAppPermission,
  requireInternalPermission,
  type AuthVars,
} from '../middleware/auth';
import { isOrderRowInScope, orderScopePredicate, scopeFromContext } from '../lib/order-scope';
import { createReplacement } from '../services/replacement-create-command';
import { getReplacementReasonContract } from '../services/replacement-reason-contract';
import {
  processReplacementFinancialAction,
  readReplacementFinancialAction,
  requestReplacementFinancialReversal,
} from '../services/replacement-financial-action';
import {
  approveReplacement,
  cancelReplacement,
  rejectReplacement,
  resolveReplacementReview,
} from '../services/replacement-lifecycle-command';
import {
  REPLACEMENT_HOLD_RESOLUTIONS,
  raiseReplacementOriginalOrderHoldsInTransaction,
  resolveReplacementOriginalOrderHold,
} from '../services/replacement-original-order-hold';
import { collectReplacementDiagnostics } from '../services/replacement-diagnostics';
import {
  assertReplacementLabelEnabled,
  purchaseReplacementLabel,
  retryFailedReplacementLabel,
  type ReplacementLabelProvider,
} from '../services/replacement-label-purchase-command';
import { reconcileReplacementLabelPricing } from '../services/replacement-label-pricing-reconcile';
import {
  reconcileReplacementPurchaseIntent,
  reconcileReplacementVoidOutcome,
  voidReplacementLabel,
  type ReplacementLabelVoidProvider,
} from '../services/replacement-label-void-command';
import { insertReplacementShipment } from '../services/replacement-shipment-command';
import { shipReplacement } from '../services/replacement-shipped-command';
import {
  consumeReplacementPackage,
  writeReplacementBilling,
} from '../services/replacement-shipping-execution';
import { replacementLabelProviderFor } from '../services/replacement-label-provider';

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
 * Per user override `unlock shipped data` on 2026-08-19: the shipped-data routes below stay
 * behind this router's default-off gate and their command-owned permissions. Mounting the
 * code does not enable replacements, purchase postage, or run a live canary.
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
 * Effective permissions (role grants, explicit claims and admin identity) are passed through:
 * `replacements:override`, `replacements:label`, and the two financial permissions are still
 * enforced INSIDE their commands, where the decision that needs them is made. The route gates
 * exposure; the command remains the non-bypassable mutation authority.
 */
function replacementActor(c: { get: (k: never) => unknown }): ReplacementActor {
  const auth = {
    email: (c.get('email' as never) as string | undefined),
    role: (c.get('role' as never) as string | undefined),
    permissions: (c.get('permissions' as never) as string[] | undefined),
  };
  return {
    email: auth.email ?? null,
    type: auth.role ?? 'operator',
    // Commands are security boundaries too. Give them the same EFFECTIVE permission view as
    // route middleware (role grants + explicit claims + admin email), rather than only the raw
    // JWT list; otherwise an admin passes the route and is then falsely denied by the command.
    permissions: APP_PERMISSIONS.filter((permission) => hasAppPermission(auth, permission)),
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

/**
 * The customer-safe reason contract — the four codes, their labels, and a version. CP-061
 * renders these labels instead of keeping its own map (DJ 2026-08-12); the Client Portal
 * consumes it through its bearer-forwarding proxy.
 *
 * Deliberately NOT `requireInternalPermission`: a portal (client_user) session must reach it to
 * render the labels, and it discloses only four static product strings — no order, tenant, or
 * shipped-data read — so any authenticated session may read it. It still sits behind the
 * router-wide REPLACEMENTS_ENABLED gate, so it lights up with the rest of the surface and fails
 * closed (403 REPLACEMENTS_DISABLED) while the feature is off.
 */
app.get('/reason-contract', (c) => c.json(getReplacementReasonContract()));

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

const resolveHoldBody = z.object({
  replacementId: z.coerce.number().int().positive(),
  expectedStateVersion: z.coerce.number().int().min(0),
  resolution: z.enum(REPLACEMENT_HOLD_RESOLUTIONS),
  reason: z.string().trim().min(1).max(2000),
}).strict();

/** Close an AC-16 question only after the command owner verifies its prerequisite receipt. */
app.post(
  '/holds/:holdId{[0-9]+}/resolve',
  requireInternalPermission('replacements:hold'),
  zValidator('json', resolveHoldBody),
  async (c) => {
    const holdId = Number(c.req.param('holdId'));
    const body = c.req.valid('json');
    const scope = scopeFromContext(c);
    const [scoped] = await db
      .select({ id: replacementOriginalOrderHolds.id })
      .from(replacementOriginalOrderHolds)
      .innerJoin(orders, eq(orders.id, replacementOriginalOrderHolds.orderId))
      .where(and(
        eq(replacementOriginalOrderHolds.id, holdId),
        eq(replacementOriginalOrderHolds.replacementId, body.replacementId),
        orderScopePredicate(scope),
      ))
      .limit(1);
    if (!scoped) return c.json({ error: 'Not found' }, 404);

    try {
      return c.json(await resolveReplacementOriginalOrderHold({
        holdId,
        replacementId: body.replacementId,
        expectedStateVersion: body.expectedStateVersion,
        resolution: body.resolution,
        reason: body.reason,
        actor: replacementActor(c),
      }));
    } catch (error) {
      return respondToCommandError(c, error);
    }
  },
);

/**
 * Item 14 — the states nothing downstream will notice on its own.
 *
 * Read only and installation-wide, so it requires the explicit global-scope capability in
 * addition to replacement read. Internal principals may still be client/store-scoped.
 */
app.get(
  '/diagnostics',
  requireInternalPermission('replacements:read'),
  requireInternalPermission('scope:global'),
  async (c) => c.json(await collectReplacementDiagnostics()),
);

// ── Create ──────────────────────────────────────────────────────────────────────────────

const createBody = z.object({
  orderId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1),
  liabilityOwner: z.enum(['operator', 'client']),
  items: z.array(z.object({
    orderLineIndex: z.coerce.number().int().min(0),
    quantity: z.coerce.number().int().positive(),
  }).strict()).min(1),
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
      const actor = replacementActor(c);
      const reason = c.req.valid('json').reason;
      try {
        const result = await run(replacement.id, actor, reason);
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
/**
 * Cancelling also cancels the CHARGE.
 *
 * The lifecycle command moved the row and stopped there, so a cancelled replacement kept any
 * billing lines it had. Pre-ship there are normally none — billing is written at ship — but
 * "normally none" is not "never", and a line nobody removed is money on an invoice for
 * something that was called off.
 */
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
      const actor = replacementActor(c);
      const result = await resolveReplacementReview({
        replacementId: replacement.id,
        to: body.to,
        actor,
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

// ── Side-effect handoff: purchase, void, ship, and AC-13 financial reversal ─────────────

const purchaseLabelBody = z.object({
  overrideReason: z.string().trim().min(1).max(2000),
  address: z.object({
    name: z.string().trim().min(1),
    line1: z.string().trim().min(1),
    line2: z.string().trim().nullable().optional(),
    city: z.string().trim().min(1),
    state: z.string().trim().min(1),
    postalCode: z.string().trim().min(1),
    country: z.string().trim().min(2),
    residential: z.boolean().nullable().optional(),
  }).strict(),
  carrier: z.object({
    carrierCode: z.string().trim().min(1),
    serviceCode: z.string().trim().min(1),
    providerAccountId: z.coerce.number().int().positive(),
  }).strict(),
  package: z.object({
    packageId: z.string().trim().min(1),
    weightOz: z.coerce.number().positive(),
    dimsL: z.coerce.number().positive(),
    dimsW: z.coerce.number().positive(),
    dimsH: z.coerce.number().positive(),
  }).strict(),
}).strict();

const voidLabelBody = z.object({
  reason: z.string().trim().min(1).max(2000),
  expectedStatus: z.string().trim().min(1).optional(),
  expectedStateVersion: z.coerce.number().int().min(0).optional(),
}).strict();

const retryLabelBody = purchaseLabelBody.extend({
  retryReason: z.string().trim().min(1).max(2000),
  expectedPurchaseAttempt: z.coerce.number().int().positive(),
}).strict();

const reconcileLabelBody = z.object({
  reason: z.string().trim().min(1).max(2000),
}).strict();

const shipBody = z.object({
  inventoryLines: z.array(z.object({
    replacementItemId: z.coerce.number().int().positive(),
    inventoryId: z.coerce.number().int().positive(),
  }).strict()).min(1),
}).strict();

const financialReversalBody = z.object({
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

type ScopedReplacementLoader = typeof loadInScope;
type CombinedReplacementLabelProvider = ReplacementLabelProvider & ReplacementLabelVoidProvider;

export type ReplacementSideEffectRouteDependencies = {
  loadScopedReplacement: ScopedReplacementLoader;
  assertLabelEnabled: typeof assertReplacementLabelEnabled;
  insertShipment: typeof insertReplacementShipment;
  purchaseLabel: typeof purchaseReplacementLabel;
  retryLabel: typeof retryFailedReplacementLabel;
  reconcileLabelPricing: typeof reconcileReplacementLabelPricing;
  voidLabel: typeof voidReplacementLabel;
  reconcilePurchaseIntent: typeof reconcileReplacementPurchaseIntent;
  reconcileVoidOutcome: typeof reconcileReplacementVoidOutcome;
  ship: typeof shipReplacement;
  providerFor: (replacementId: number) => CombinedReplacementLabelProvider;
  consumePackage: typeof consumeReplacementPackage;
  writeBilling: typeof writeReplacementBilling;
  requestFinancialReversal: typeof requestReplacementFinancialReversal;
  processFinancialAction: typeof processReplacementFinancialAction;
  readFinancialAction: typeof readReplacementFinancialAction;
};

const defaultSideEffectDependencies: ReplacementSideEffectRouteDependencies = {
  loadScopedReplacement: loadInScope,
  assertLabelEnabled: assertReplacementLabelEnabled,
  insertShipment: insertReplacementShipment,
  purchaseLabel: purchaseReplacementLabel,
  retryLabel: retryFailedReplacementLabel,
  reconcileLabelPricing: reconcileReplacementLabelPricing,
  voidLabel: voidReplacementLabel,
  reconcilePurchaseIntent: reconcileReplacementPurchaseIntent,
  reconcileVoidOutcome: reconcileReplacementVoidOutcome,
  ship: shipReplacement,
  providerFor: replacementLabelProviderFor,
  consumePackage: consumeReplacementPackage,
  writeBilling: writeReplacementBilling,
  requestFinancialReversal: requestReplacementFinancialReversal,
  processFinancialAction: processReplacementFinancialAction,
  readFinancialAction: readReplacementFinancialAction,
};

/**
 * Exported factory so request-boundary tests can prove auth/scope/provider isolation with fakes.
 * Production mounts the same handlers below with the canonical dependencies above.
 */
export function createReplacementSideEffectRouter(
  overrides: Partial<ReplacementSideEffectRouteDependencies> = {},
) {
  const deps = { ...defaultSideEffectDependencies, ...overrides };
  const routes = new Hono<{ Variables: AuthVars }>();

  const requireLabelFeature = async (c: any, next: () => Promise<void>) => {
    try {
      deps.assertLabelEnabled();
      await next();
    } catch (error) {
      return respondToCommandError(c, error);
    }
  };

  routes.post(
    '/:id{[0-9]+}/label/purchase',
    requireInternalPermission('replacements:label'),
    requireLabelFeature,
    zValidator('json', purchaseLabelBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      const actor = replacementActor(c);
      const body = c.req.valid('json');
      try {
        // Per user override `unlock shipped data` on 2026-08-19: attach only a dedicated
        // replacement shipment. A failure after this point leaves an idempotently reusable
        // empty vessel, never a second shipment on retry.
        await deps.insertShipment({
          replacementId: replacement.id,
          actor,
          shipment: {
            carrierCode: body.carrier.carrierCode,
            serviceCode: body.carrier.serviceCode,
            weightOz: body.package.weightOz,
            dimsL: body.package.dimsL,
            dimsW: body.package.dimsW,
            dimsH: body.package.dimsH,
            providerAccountId: body.carrier.providerAccountId,
            selectedPackageId: body.package.packageId,
          },
        });
        const provenance = {
          source: 'operator_override' as const,
          chosenBy: actor.email,
          reason: body.overrideReason,
        };
        const result = await deps.purchaseLabel({
          replacementId: replacement.id,
          actor,
          purchaseInputs: {
            address: { value: body.address, ...provenance },
            carrier: { value: body.carrier, ...provenance },
            package: { value: body.package, ...provenance },
          },
        }, deps.providerFor(replacement.id));
        return c.json(result, result.purchased ? 201 : 200);
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  routes.post(
    '/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/retry',
    requireInternalPermission('replacements:label'),
    requireLabelFeature,
    zValidator('json', retryLabelBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      const actor = replacementActor(c);
      const body = c.req.valid('json');
      try {
        const provenance = {
          source: 'operator_override' as const,
          chosenBy: actor.email,
          reason: body.overrideReason,
        };
        const result = await deps.retryLabel({
          replacementId: replacement.id,
          expectedFailedIntentId: Number(c.req.param('intentId')),
          expectedPurchaseAttempt: body.expectedPurchaseAttempt,
          retryReason: body.retryReason,
          actor,
          purchaseInputs: {
            address: { value: body.address, ...provenance },
            carrier: { value: body.carrier, ...provenance },
            package: { value: body.package, ...provenance },
          },
        }, deps.providerFor(replacement.id));
        return c.json(result, result.purchased ? 201 : 200);
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  routes.post(
    '/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/reconcile',
    requireInternalPermission('replacements:label'),
    requireLabelFeature,
    zValidator('json', reconcileLabelBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      try {
        const result = await deps.reconcilePurchaseIntent({
          replacementId: replacement.id,
          intentId: Number(c.req.param('intentId')),
          actor: replacementActor(c),
          reason: c.req.valid('json').reason,
        }, deps.providerFor(replacement.id));
        return c.json(result, result.outcome === 'still_unknown' ? 202 : 200);
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  routes.post(
    '/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/pricing-reconcile',
    requireInternalPermission('replacements:label'),
    requireLabelFeature,
    zValidator('json', reconcileLabelBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      try {
        return c.json(await deps.reconcileLabelPricing({
          replacementId: replacement.id,
          intentId: Number(c.req.param('intentId')),
          actor: replacementActor(c),
          reason: c.req.valid('json').reason,
        }));
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  routes.post(
    '/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/void/reconcile',
    requireInternalPermission('replacements:label'),
    requireLabelFeature,
    zValidator('json', reconcileLabelBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      try {
        const result = await deps.reconcileVoidOutcome({
          replacementId: replacement.id,
          intentId: Number(c.req.param('intentId')),
          actor: replacementActor(c),
          reason: c.req.valid('json').reason,
        }, deps.providerFor(replacement.id));
        return c.json(result, result.outcome === 'still_unknown' ? 202 : 200);
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  routes.post(
    '/:id{[0-9]+}/label/void',
    requireInternalPermission('replacements:label'),
    requireLabelFeature,
    zValidator('json', voidLabelBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      const body = c.req.valid('json');
      try {
        const result = await deps.voidLabel({
          replacementId: replacement.id,
          actor: replacementActor(c),
          reason: body.reason,
          expectedStatus: body.expectedStatus,
          expectedStateVersion: body.expectedStateVersion,
        }, deps.providerFor(replacement.id));
        return c.json(result);
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  routes.post(
    '/:id{[0-9]+}/ship',
    requireInternalPermission('replacements:write'),
    requireInternalPermission('inventory:write'),
    requireLabelFeature,
    zValidator('json', shipBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      try {
        const result = await deps.ship({
          replacementId: replacement.id,
          actor: replacementActor(c),
          inventoryLines: c.req.valid('json').inventoryLines,
          consumePackage: deps.consumePackage,
          writeBilling: deps.writeBilling,
        });
        return c.json(result);
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  // AC-13: post-ship financial reversal, never a lifecycle cancellation.
  routes.post(
    '/:id{[0-9]+}/financial-reversal',
    requireInternalPermission('replacements:billing'),
    zValidator('json', financialReversalBody),
    async (c) => {
      const replacement = await deps.loadScopedReplacement(c, Number(c.req.param('id')));
      if (!replacement) return c.json({ error: 'Not found' }, 404);
      const body = c.req.valid('json');
      try {
        const requested = await deps.requestFinancialReversal({
          replacementId: replacement.id,
          actor: replacementActor(c),
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        });

        // Best-effort immediate drain for operator feedback. The request already committed to
        // the durable ledger, so a disconnect or process death leaves the worker an obligation.
        let action = requested.action;
        if (action.status !== 'completed' && action.status !== 'review_required') {
          try {
            action = (await deps.processFinancialAction(Number(action.id))) ?? action;
          } catch {
            action = (await deps.readFinancialAction(Number(action.id))) ?? action;
          }
        }
        return c.json(
          { action, alreadyRequested: requested.alreadyRequested },
          (action.status === 'completed' ? 200 : 202) as 200 | 202,
        );
      } catch (error) {
        return respondToCommandError(c, error);
      }
    },
  );

  return routes;
}

app.route('/', createReplacementSideEffectRouter());

export default app;
