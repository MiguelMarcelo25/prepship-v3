export const NO_BOX_COST_BILLING_BADGE = 'NO_BOX_COST';

export type BillingBoxCostAlertInput = {
  packageCost?: unknown;
  hasPackageCostLine?: boolean;
  packageCostNeedsReview?: boolean;
  isNoChargeBoxCostLine?: boolean;
  canAlertMissing?: boolean;
  existingBadges?: unknown;
};

export type BillingBoxCostAlertResult = {
  boxCostAlert: boolean;
  billingBadges: string[];
};

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBadges(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const badges: string[] = [];
  for (const badge of value) {
    if (typeof badge !== 'string') continue;
    const trimmed = badge.trim();
    if (trimmed && !badges.includes(trimmed)) badges.push(trimmed);
  }
  return badges;
}

function withoutNoBoxCostBadge(badges: string[]): string[] {
  return badges.filter((badge) => badge !== NO_BOX_COST_BILLING_BADGE);
}

export function resolveBillingBoxCostAlert(input: BillingBoxCostAlertInput): BillingBoxCostAlertResult {
  const existingBadges = withoutNoBoxCostBadge(normalizeBadges(input.existingBadges));
  if (input.packageCostNeedsReview === true || input.isNoChargeBoxCostLine === true) {
    return { boxCostAlert: false, billingBadges: existingBadges };
  }

  const packageCost = toFiniteNumber(input.packageCost);
  if (packageCost != null && packageCost > 0) {
    return { boxCostAlert: false, billingBadges: existingBadges };
  }

  if (input.hasPackageCostLine === true && packageCost === 0) {
    return { boxCostAlert: false, billingBadges: existingBadges };
  }

  if (input.canAlertMissing === false) {
    return { boxCostAlert: false, billingBadges: existingBadges };
  }

  return {
    boxCostAlert: true,
    billingBadges: [...existingBadges, NO_BOX_COST_BILLING_BADGE],
  };
}
