import { GLOBAL_SCOPE } from '../../lib/client-store-scope.js';
import {
  getOrderHazmatForShipping,
  saveOrderHazmatDeclaration,
} from '../order-hazmat.js';
import {
  getApprovedAutomationHazmatProfileVersion,
  type ApprovedAutomationHazmatProfileVersion,
} from '../shipping-workflow/hazmat-automation-profile.js';
import type { AutomationHandler } from './orchestrator.js';

type CurrentOrderHazmat = Awaited<ReturnType<typeof getOrderHazmatForShipping>>;
type SaveOrderHazmatInput = Parameters<typeof saveOrderHazmatDeclaration>[0];
type SavedOrderHazmat = Awaited<ReturnType<typeof saveOrderHazmatDeclaration>>;

export type AutomationHazmatDependencies = {
  getProfileVersion(profileVersionId: string): ApprovedAutomationHazmatProfileVersion | null;
  getCurrent(orderId: number): Promise<CurrentOrderHazmat>;
  save(input: SaveOrderHazmatInput): Promise<SavedOrderHazmat>;
};

const productionDependencies: AutomationHazmatDependencies = {
  getProfileVersion: getApprovedAutomationHazmatProfileVersion,
  getCurrent: getOrderHazmatForShipping,
  save: saveOrderHazmatDeclaration,
};

export function createAutomationHazmatHandler(
  dependencies: AutomationHazmatDependencies = productionDependencies,
): AutomationHandler {
  return async ({ facts, intent, plan, idempotencyKey }) => {
    const profileVersionId = String(intent.action.config.profileVersionId ?? '').trim();
    const profile = dependencies.getProfileVersion(profileVersionId);
    if (!profile) {
      throw new Error('Automation hazmat profile version is not approved');
    }
    if (plan.hazmatProfileVersionId !== profile.id) {
      throw new Error('Automation hazmat plan does not resolve to one immutable profile version');
    }

    const current = await dependencies.getCurrent(facts.order.id);
    if (current.clientId !== facts.order.clientId) {
      throw new Error('Canonical hazmat client scope changed during automation evaluation');
    }
    if (
      current.declaration?.status === 'active'
      && current.semanticHash !== profile.semanticHash
    ) {
      throw new Error('An active hazmat declaration conflicts with the automation profile; operator review is required');
    }

    const before = {
      status: current.declaration?.status ?? 'none',
      revision: current.revision,
      semanticHash: current.semanticHash,
    };
    if (current.declaration?.status === 'active' && current.semanticHash === profile.semanticHash) {
      return {
        targetType: 'order_hazmat_declaration',
        targetId: String(facts.order.id),
        before,
        after: { ...before, changed: false, invalidatedRate: false, profileVersionId: profile.id },
        idempotencyKey,
      };
    }

    const saved = await dependencies.save({
      orderId: facts.order.id,
      expectedRevision: current.revision,
      declaration: profile.declaration,
      scope: GLOBAL_SCOPE,
      actor: {
        actorId: 'automation-engine',
        actorEmail: 'automation@prepship.internal',
      },
      provenance: {
        source: 'automation',
        evaluationId: idempotencyKey,
        ruleId: intent.ruleId,
        ruleVersionId: intent.versionId,
        profileVersionId: profile.id,
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
        changed: saved.changed,
        invalidatedRate: saved.invalidatedRate,
        profileVersionId: profile.id,
      },
      idempotencyKey,
    };
  };
}

export const automationHazmatHandler = createAutomationHazmatHandler();
