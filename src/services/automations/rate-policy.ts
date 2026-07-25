import { AutomationPreflightError, type AutomationWatermark } from './orchestrator.js';
import type { ClientStoreScope } from '../../lib/client-store-scope.js';
import { automationRulesVersionFromRequestFingerprint } from '../shipping-workflow/rate-fingerprint.js';
import { reconcileOrderAutomationsForShipping } from './runtime.js';

type RateIntent = {
  orderId?: number | null;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  automationRulesVersion?: string | null;
  automationExcludedCarrierIds?: string[];
  automationExcludedServiceIds?: string[];
};

export class AutomationRateProofError extends Error {
  readonly code = 'AUTOMATION_RATE_PROOF_STALE';
  readonly status = 409;

  constructor() {
    super('Automation rules changed after this rate was quoted. Re-rate the order before buying the label.');
    this.name = 'AutomationRateProofError';
  }
}

/** Thin rate adapter: consumes the authoritative reduced plan without
 * re-evaluating rules or choosing winners in the route/frontend. */
export function applyAutomationPlanToRateIntent<T extends RateIntent>(
  intent: T,
  watermark: AutomationWatermark,
): T {
  const plan = watermark.plan;
  const requiredInsurance = plan.insurance?.minimumValue ?? null;
  const currentInsurance = Number(intent.insuredValue ?? 0);
  return {
    ...intent,
    confirmation: plan.confirmation?.value ?? intent.confirmation,
    insuranceProvider: requiredInsurance != null && requiredInsurance > 0
      ? plan.insurance!.provider
      : intent.insuranceProvider,
    insuredValue: requiredInsurance == null
      ? intent.insuredValue
      : Math.max(Number.isFinite(currentInsurance) ? currentInsurance : 0, requiredInsurance),
    automationRulesVersion: watermark.rulesetDigest,
    automationExcludedCarrierIds: plan.excludedCarriers,
    automationExcludedServiceIds: plan.excludedServices,
  };
}

/** Backend shipping boundary: reconcile once, then consume the reduced plan.
 * This adapter never evaluates fields or resolves action conflicts itself. */
export async function prepareAutomationRateIntent<T extends RateIntent>(
  intent: T,
  scope: ClientStoreScope,
  reconcile: typeof reconcileOrderAutomationsForShipping = reconcileOrderAutomationsForShipping,
): Promise<T> {
  if (!intent.orderId) return intent;
  const watermark = await reconcile({
    orderId: intent.orderId,
    stage: 'before_rate',
    scope,
  });
  return applyAutomationPlanToRateIntent(intent, watermark);
}

export async function dispatchRateAfterAutomationPreflight<T extends RateIntent, TResult>(
  intent: T,
  scope: ClientStoreScope,
  dispatch: (prepared: T) => Promise<TResult>,
  reconcile: typeof reconcileOrderAutomationsForShipping = reconcileOrderAutomationsForShipping,
): Promise<TResult> {
  const prepared = await prepareAutomationRateIntent(intent, scope, reconcile);
  return dispatch(prepared);
}

export function assertAutomationRateProofCurrent(
  requestFingerprint: string | null | undefined,
  watermark: AutomationWatermark,
): void {
  const quotedVersion = automationRulesVersionFromRequestFingerprint(requestFingerprint);
  if (!quotedVersion || !quotedVersion.endsWith(`:${watermark.rulesetDigest}`)) {
    throw new AutomationRateProofError();
  }
}

/** Provider adapters that cannot consume the reduced shipping plan fail
 * closed; they never silently ignore an authoritative automation action. */
export function assertAutomationPlanSupportedByProvider(
  watermark: AutomationWatermark,
  provider: string,
): void {
  if (!watermark.plan.invalidatesRateProof) return;
  throw new AutomationPreflightError(
    'AUTOMATION_PROVIDER_PLAN_UNSUPPORTED',
    `${provider} cannot consume the current automation shipping plan; use a supported carrier path or revise the automation`,
  );
}
