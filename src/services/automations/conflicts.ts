import type { AutomationIntent } from './contracts';

export type AutomationConflict = {
  actionClass: string;
  actionType: string;
  priority: number;
  intentIds: string[];
  reason: string;
};

type ScalarChoice = { value: string; intentId: string; priority: number };

export type ReducedAutomationPlan = {
  tags: string[];
  hold: { required: boolean; reasons: string[] };
  insurance: { minimumValue: number; provider: 'parcelguard' | 'carrier'; profileId: string | null } | null;
  package: ScalarChoice | null;
  confirmation: ScalarChoice | null;
  preferredCarrier: ScalarChoice | null;
  preferredService: ScalarChoice | null;
  excludedCarriers: string[];
  excludedServices: string[];
  invalidatesRateProof: boolean;
};

function stableIntentOrder(left: AutomationIntent, right: AutomationIntent): number {
  return left.priority - right.priority
    || left.position - right.position
    || left.ruleId.localeCompare(right.ruleId)
    || left.versionId.localeCompare(right.versionId)
    || left.actionIndex - right.actionIndex;
}

function stringConfig(intent: AutomationIntent, key: string): string {
  return String(intent.action.config[key] ?? '').trim();
}

function scalar(
  intents: AutomationIntent[],
  type: AutomationIntent['action']['type'],
  key: string,
  conflicts: AutomationConflict[],
): ScalarChoice | null {
  const candidates = intents.filter((intent) => intent.action.type === type).sort(stableIntentOrder);
  if (candidates.length === 0) return null;
  const bestPriority = candidates[0]!.priority;
  const peers = candidates.filter((candidate) => candidate.priority === bestPriority);
  const distinct = [...new Set(peers.map((candidate) => stringConfig(candidate, key)))];
  if (distinct.length > 1) {
    conflicts.push({
      actionClass: 'scalar',
      actionType: type,
      priority: bestPriority,
      intentIds: peers.map((candidate) => candidate.intentId),
      reason: `Same-priority ${type} intents disagree`,
    });
    return null;
  }
  return { value: distinct[0]!, intentId: peers[0]!.intentId, priority: bestPriority };
}

function stableUnion(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function reduceAutomationIntents(rawIntents: AutomationIntent[]) {
  const intents = [...rawIntents].sort(stableIntentOrder);
  const conflicts: AutomationConflict[] = [];
  const tags = stableUnion(intents.filter((intent) => intent.action.type === 'tag.add').map((intent) => stringConfig(intent, 'tag')));
  const holdReasons = stableUnion(intents.filter((intent) => intent.action.type === 'hold.for_review').map((intent) => stringConfig(intent, 'reason')));
  const insuranceCandidates = intents
    .filter((intent) => intent.action.type === 'insurance.require')
    .map((intent) => ({
      minimumValue: Number(intent.action.config.minimumValue),
      provider: intent.action.config.provider === 'carrier' ? 'carrier' as const : 'parcelguard' as const,
      profileId: intent.action.config.profileId == null ? null : String(intent.action.config.profileId),
    }))
    .sort((left, right) => right.minimumValue - left.minimumValue);
  const packageChoice = scalar(intents, 'package.set', 'packagePresetId', conflicts);
  const confirmation = scalar(intents, 'confirmation.set', 'confirmation', conflicts);
  const preferredCarrier = scalar(intents, 'carrier.prefer', 'id', conflicts);
  const preferredService = scalar(intents, 'service.prefer', 'id', conflicts);
  const excludedCarriers = stableUnion(intents
    .filter((intent) => intent.action.type === 'carrier.exclude')
    .flatMap((intent) => Array.isArray(intent.action.config.ids) ? intent.action.config.ids.map(String) : []));
  const excludedServices = stableUnion(intents
    .filter((intent) => intent.action.type === 'service.exclude')
    .flatMap((intent) => Array.isArray(intent.action.config.ids) ? intent.action.config.ids.map(String) : []));

  const plan: ReducedAutomationPlan = {
    tags,
    hold: { required: holdReasons.length > 0 || conflicts.length > 0, reasons: holdReasons },
    insurance: insuranceCandidates[0] ?? null,
    package: packageChoice,
    confirmation,
    preferredCarrier,
    preferredService,
    excludedCarriers,
    excludedServices,
    invalidatesRateProof: intents.some((intent) => intent.action.type !== 'tag.add'),
  };
  return {
    plan,
    conflicts,
    holdRequired: plan.hold.required,
    winningIntentIds: intents
      .filter((intent) => !conflicts.some((conflict) => conflict.intentIds.includes(intent.intentId)))
      .map((intent) => intent.intentId),
    shadowedIntentIds: intents
      .filter((intent) => conflicts.some((conflict) => conflict.intentIds.includes(intent.intentId)))
      .map((intent) => intent.intentId),
  };
}
