// PS-304 — the backend-owned, display-safe package-facts read-model for an OrdersView
// ROW (the order-list grid, not just the detail panel). Pure: it projects the PS-301
// row state axes (packageState/rateState) + lifecycle/label context into a single
// display-safe object so the FE renders package status instead of re-deriving it.
// Converges PS-301 (packageState) and PS-304 (the card's named package fields). No I/O,
// no purchase authority, no mutation — immutableReason REINFORCES the shipped/cancelled
// lock by telling the FE a row's package is not editable and why.

import type { OrderRowPackageState, OrderRowRateState } from './order-row-states';

export type OrderRowPackageImmutableReason = 'shipped' | 'cancelled' | 'has_label' | null;

export type OrderRowPackageDims = { length: number; width: number; height: number };

export type OrderRowPackageFacts = {
  state: OrderRowPackageState;
  weightOz: number | null;
  dims: OrderRowPackageDims | null;
  selectedPackageId: string | null;
  requiresRerate: boolean;
  staleRateImpact: boolean;
  immutableReason: OrderRowPackageImmutableReason;
};

export type BuildOrderRowPackageFactsInput = {
  orderStatus: string | null;
  externallyShipped: boolean;
  canonicalStatus: string | null;
  hasActiveLabel: boolean;
  // PS-301 axes — the preferred source of truth (convergence). Null for rows with no
  // workflow DTO (e.g. non-house shipped rows), in which case state falls back to dims.
  packageState?: OrderRowPackageState | null;
  rateState?: OrderRowRateState | null;
  requiresRerate?: boolean | null;
  weightOz: number | null;
  dims: OrderRowPackageDims | null;
  selectedPackageId: string | null;
};

function immutableReasonFor(input: BuildOrderRowPackageFactsInput): OrderRowPackageImmutableReason {
  if (input.orderStatus === 'cancelled' || input.canonicalStatus === 'cancelled') return 'cancelled';
  if (input.externallyShipped === true || input.orderStatus === 'shipped') return 'shipped';
  if (input.hasActiveLabel) return 'has_label';
  return null;
}

export function buildOrderRowPackageFacts(input: BuildOrderRowPackageFactsInput): OrderRowPackageFacts {
  const immutableReason = immutableReasonFor(input);
  const locked = immutableReason === 'shipped' || immutableReason === 'cancelled';
  const hasCompletePackage = input.weightOz != null && input.weightOz > 0 && input.dims != null;
  const state: OrderRowPackageState = input.packageState ?? (hasCompletePackage ? 'resolved' : 'needs_dims');
  // A saved rate that is stale/expired no longer reflects the current package → re-rate
  // before purchase. Closed rows (shipped/cancelled) are realized, never re-rate-able.
  const staleRateImpact = !locked && (input.rateState === 'stale' || input.rateState === 'expired');
  const requiresRerate = !locked && (input.requiresRerate === true || staleRateImpact);
  return {
    state,
    weightOz: input.weightOz,
    dims: input.dims,
    selectedPackageId: input.selectedPackageId,
    requiresRerate,
    staleRateImpact,
    immutableReason,
  };
}
