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
