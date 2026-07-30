import {
  getOrderHazmatForShipping,
  saveOrderHazmatDeclaration,
} from '../order-hazmat.js';
import {
  hazmatSemanticHash,
  normalizeHazmatDeclaration,
} from '../shipping-workflow/hazmat-declaration.js';
import type { AutomationHandler } from './orchestrator.js';

type CurrentOrderHazmat = Awaited<ReturnType<typeof getOrderHazmatForShipping>>;
type SaveOrderHazmatInput = Parameters<typeof saveOrderHazmatDeclaration>[0];
type SavedOrderHazmat = Awaited<ReturnType<typeof saveOrderHazmatDeclaration>>;

export type AutomationHazmatDependencies = {
  getCurrent(orderId: number): Promise<CurrentOrderHazmat>;
  save(input: SaveOrderHazmatInput): Promise<SavedOrderHazmat>;
};

const productionDependencies: AutomationHazmatDependencies = {
  getCurrent: getOrderHazmatForShipping,
  save: saveOrderHazmatDeclaration,
};

export function createAutomationHazmatHandler(
  dependencies: AutomationHazmatDependencies = productionDependencies,
): AutomationHandler {
  return async ({ facts, intent, plan, trigger, idempotencyKey, scope, labelPurchaseLock }) => {
    if (plan.hazmatIntentId !== intent.intentId) {
      return {
        targetType: 'order_hazmat_declaration',
        targetId: String(facts.order.id),
        after: { changed: false, duplicate: true },
        idempotencyKey,
      };
    }

    const desired = normalizeHazmatDeclaration({
      status: 'active',
      emergencyContactName: intent.action.config.contactName,
      emergencyContactPhone: intent.action.config.contactPhone,
    });
    const desiredSemanticHash = hazmatSemanticHash(desired);
    const current = await dependencies.getCurrent(facts.order.id);
    if (current.clientId !== facts.order.clientId) {
      throw new Error('Canonical hazmat client scope changed during automation evaluation');
    }

    const before = {
      status: current.declaration?.status ?? 'none',
      revision: current.revision,
      semanticHash: current.semanticHash,
      decisionSource: current.decisionSource,
    };
    if (current.decisionSource === 'manual' && trigger !== 'manual_reprocess') {
      return {
        targetType: 'order_hazmat_declaration',
        targetId: String(facts.order.id),
        before,
        after: { ...before, changed: false, preservedManualDecision: true },
        idempotencyKey,
      };
    }
    if (
      current.declaration?.status === 'active'
      && current.semanticHash === desiredSemanticHash
    ) {
      return {
        targetType: 'order_hazmat_declaration',
        targetId: String(facts.order.id),
        before,
        after: { ...before, changed: false, invalidatedRate: false },
        idempotencyKey,
      };
    }

    const saved = await dependencies.save({
      orderId: facts.order.id,
      expectedRevision: current.revision,
      declaration: desired,
      decisionSource: 'automation',
      scope,
      purchaseLock: labelPurchaseLock,
      actor: {
        actorId: 'automation-engine',
        actorEmail: 'automation@prepship.internal',
      },
      provenance: {
        source: 'automation',
        evaluationId: idempotencyKey,
        ruleId: intent.ruleId,
        ruleVersionId: intent.versionId,
      },
    });
    return {
      targetType: 'order_hazmat_declaration',
      targetId: String(facts.order.id),
      before,
      after: {
        status: saved.declaration?.status ?? 'none',
        revision: saved.revision,
        semanticHash: saved.semanticHash,
        decisionSource: saved.decisionSource,
        changed: saved.changed,
        invalidatedRate: saved.invalidatedRate,
      },
      idempotencyKey,
    };
  };
}

export const automationHazmatHandler = createAutomationHazmatHandler();

/**
 * PS-475: take the mark back off when no rule declares hazmat any more.
 *
 * The engine synthesises the intent (see hazmat-retraction-intent.ts); this
 * applies it. Two refusals are the point of the whole feature:
 *
 *   - a MANUAL declaration is never retracted. Pausing a rule must not erase a
 *     person's explicit compliance decision. Mirrors the same guard in the
 *     add handler above.
 *   - a declaration that is not already 'active' is a no-op, so repeated
 *     evaluations converge instead of writing a revision every tick.
 */
export function createAutomationHazmatRetraction(
  dependencies: AutomationHazmatDependencies = productionDependencies,
) {
  return async ({ facts, scope, labelPurchaseLock }: {
    facts: Parameters<AutomationHandler>[0]['facts'];
    scope: Parameters<AutomationHandler>[0]['scope'];
    labelPurchaseLock?: Parameters<AutomationHandler>[0]['labelPurchaseLock'];
  }) => {
    const current = await dependencies.getCurrent(facts.order.id);
    if (current.clientId !== facts.order.clientId) {
      throw new Error('Canonical hazmat client scope changed during automation evaluation');
    }

    const before = {
      status: current.declaration?.status ?? 'none',
      revision: current.revision,
      semanticHash: current.semanticHash,
      decisionSource: current.decisionSource,
    };

    // A human tick outranks the rules. Never retract a manual declaration.
    if (current.decisionSource === 'manual') {
      return { ...before, changed: false, preservedManualDecision: true };
    }
    // Idempotent: repeated convergence on an already-cleared order is a no-op,
    // so this cannot churn revisions. That matters because this runs outside the
    // effect-lease machinery.
    if (current.declaration?.status !== 'active') {
      return { ...before, changed: false, alreadyCleared: true };
    }

    const saved = await dependencies.save({
      orderId: facts.order.id,
      // Optimistic concurrency is the safety net in place of the effect lease:
      // a concurrent writer bumps the revision and this save loses cleanly.
      expectedRevision: current.revision,
      declaration: normalizeHazmatDeclaration({ status: 'clear' }),
      decisionSource: 'automation',
      scope,
      purchaseLock: labelPurchaseLock,
      actor: {
        actorId: 'automation-engine',
        actorEmail: 'automation@prepship.internal',
      },
      // No provenance block on purpose. It requires ruleId/ruleVersionId, and a
      // retraction has no rule behind it -- inventing ids would put a rule that
      // did not act into a compliance audit trail. The record stays complete
      // without it: revision, decision_source 'automation', the automation-engine
      // actor, and the append-only hazmat snapshot.
    });
    return {
      status: saved.declaration?.status ?? 'none',
      revision: saved.revision,
      semanticHash: saved.semanticHash,
      decisionSource: saved.decisionSource,
      changed: saved.changed,
      invalidatedRate: saved.invalidatedRate,
      retracted: true,
    };
  };
}

export const automationHazmatRetraction = createAutomationHazmatRetraction();
