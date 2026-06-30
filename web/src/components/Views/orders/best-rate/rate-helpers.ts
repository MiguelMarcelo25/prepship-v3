// PS-317: the state-bound Best-Rate helpers, moved verbatim out of OrdersView. These 10 functions
// close over component state (autoBestRateEntries, orderDetailsById, shippingAccounts,
// carrierServiceCatalog), so they live in a factory the shell calls each render with the current
// values — identical to the old inline closures, just relocated. Still pure orchestration: every
// rate decision is the backend's; these build requests, project display state, and read DTOs.
import {
  toStringValue,
  getShippingModel,
} from '../../orders-row-display';
import { getDimensions, getOrderWeightOz, getShipTo } from '../../orders-items';
import { normalizeConfirmationForRates } from '../../orders-rate-input';
import { hasCompleteDims } from '../panel-shipment-dims';
import { classifyAwaitingBestRateDisplay } from '../../awaiting-best-rate-display-state';
import { SHIPPING_SERVICE_ELIGIBILITY_VERSION } from '../../../../../../src/lib/shipping-service-eligibility';
import { residentialForRate, buildRateRequestDraftKey, orderShippingHold, type StrictBestRateRequest } from './rate-request';
import { getSavedBestRateRecord } from './rate-proof';
import { hasSavedBestRateForRequest, hasAnySavedBestRateForDisplay, shippingWorkflowStateCanDisplayRate } from './rate-display-predicates';
import type { AutoBestRateEntry } from '../../orders-parity';
import type { OrderFullDto, OrderSummaryDto, CarrierAccountDto } from '../../../../types/api';

// Pure helper, used only by getCurrentBestRateDimsLabel.
function normalizeDimsLabel(value: unknown) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, '').toLowerCase()
    : null;
}

export function createBestRateHelpers(deps: {
  autoBestRateEntries: Record<number, AutoBestRateEntry>;
  orderDetailsById: Map<number, OrderFullDto>;
  shippingAccounts: CarrierAccountDto[];
  carrierServiceCatalog: Record<string, Array<{ code: string; label: string }>>;
}) {
  const { autoBestRateEntries, orderDetailsById, shippingAccounts, carrierServiceCatalog } = deps;

  function getRateCarrierIdsForAccounts() {
    return [...new Set(
      shippingAccounts
        .map((account) => toStringValue(account.carrierId))
        .filter((carrierId): carrierId is string => Boolean(carrierId)),
    )];
  }

  function getServiceOptionsForAccount(accountId: string) {
    const account = shippingAccounts.find((candidate) => String(candidate.shippingProviderId) === accountId);
    if (!account) return [];
    return carrierServiceCatalog[account.code] ?? [];
  }

  function buildStrictBestRateRequest(
    order: OrderSummaryDto,
    input: {
      detail?: OrderFullDto | null;
      dims: { length: number; width: number; height: number } | null;
      weightOz: number;
      shipTo: ReturnType<typeof getShipTo>;
      confirmation: string;
      insuranceProvider?: string | null;
      insuredValue?: number | null;
    },
  ): StrictBestRateRequest | null {
    if (order.orderStatus !== 'awaiting_shipment') return null;
    // PS-129: do not rate a held order (cancelled upstream / externally shipped) as normal work.
    if (orderShippingHold(order)?.blocked) return null;
    const dims = input.dims;
    const weightOz = input.weightOz;
    if (!dims || !hasCompleteDims(dims) || weightOz <= 0) return null;
    if (!input.shipTo.postalCode) return null;

    const carrierIds = getRateCarrierIdsForAccounts();
    const dimsLabel = `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`;
    const confirmation = normalizeConfirmationForRates(input.confirmation);
    const insuranceProvider = input.insuranceProvider ?? 'none';
    const insuredValue = input.insuredValue ?? null;
    const draftKey = buildRateRequestDraftKey({
      weightOz,
      dims,
      shipTo: input.shipTo,
      residential: residentialForRate(order),
      carrierIds,
      storeId: order.storeId,
      clientId: order.clientId,
      confirmation,
      insuranceProvider,
      insuredValue,
    });
    const key = `${order.orderId}|${draftKey}`;

    return {
      detail: input.detail ?? null,
      dims,
      dimsLabel,
      weightOz,
      shipTo: input.shipTo,
      confirmation,
      carrierIds,
      insuranceProvider,
      insuredValue,
      draftKey,
      key,
    };
  }

  function getAutoBestRateRequest(order: OrderSummaryDto) {
    const detail = orderDetailsById.get(order.orderId) ?? null;
    const dims = getDimensions(order, detail);
    const weightOz = getOrderWeightOz(order, detail);
    const shipTo = getShipTo(order, detail);
    const confirmation = normalizeConfirmationForRates(
      toStringValue(order.selectedRate?.confirmation) ??
      toStringValue(getShippingModel(order)?.confirmation) ??
      'none',
    );
    // PS-123: auto/table Best Rate sends only operator intent; the backend resolves HUGRAB insurance.
    return buildStrictBestRateRequest(order, {
      detail,
      dims,
      weightOz,
      shipTo,
      confirmation,
      insuranceProvider: 'none',
      insuredValue: null,
    });
  }

  function getCurrentBestRateDimsLabel(order: OrderSummaryDto) {
    const detail = orderDetailsById.get(order.orderId) ?? null;
    const dims = getDimensions(order, detail);
    if (!hasCompleteDims(dims)) return null;
    return normalizeDimsLabel(`${dims.length}x${dims.width}x${dims.height}`);
  }

  function hasDisplayableBestRateForCurrentRequest(order: OrderSummaryDto) {
    if (shippingWorkflowStateCanDisplayRate(order)) return true;
    const request = getAutoBestRateRequest(order);
    if (!request) return false;
    const entry = autoBestRateEntries[order.orderId];
    if (entry?.key === request.key && entry.rate) return true;
    if (entry?.key === request.key && entry.error) return false;
    // A same-request refresh in progress must not wipe a still-valid backend saved rate.
    if (entry?.key === request.key && entry.rate === null && entry.pending !== true) return false;
    // PS-292: a persisted half-house SHIPP rate (backend verdict 'needs_refresh') is NOT displayable —
    // fall through to the 'House rate needs refresh' diagnostic instead of a confident SHIPP figure.
    if ((getSavedBestRateRecord(order) as { houseTupleStatus?: unknown } | null)?.houseTupleStatus === 'needs_refresh') {
      return false;
    }
    return hasSavedBestRateForRequest(order, request);
  }

  function getAwaitingBestRateDisplayState(order: OrderSummaryDto) {
    const savedRate = getSavedBestRateRecord(order);
    const dims = getDimensions(order, orderDetailsById.get(order.orderId) ?? null);
    const hasDimsAndWeight =
      hasCompleteDims(dims) && Boolean(order.weight?.value && order.weight.value > 0);
    return classifyAwaitingBestRateDisplay({
      hasSavedBestRate: hasAnySavedBestRateForDisplay(order),
      canDisplaySavedRate: hasDisplayableBestRateForCurrentRequest(order),
      isComplete: savedRate ? savedRate.isComplete === true : null,
      cacheExpiresAt: savedRate ? toStringValue(savedRate.cacheExpiresAt) : null,
      eligibilityVersion: savedRate ? toStringValue(savedRate.eligibilityVersion) : null,
      requiredEligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      hasDimsAndWeight,
      // PS-292: render the backend half-house verdict verbatim.
      houseTupleNeedsRefresh:
        (savedRate as { houseTupleStatus?: unknown } | null)?.houseTupleStatus === 'needs_refresh',
    });
  }

  function getOrderWithAutoBestRate(order: OrderSummaryDto) {
    return order;
  }

  return {
    getRateCarrierIdsForAccounts,
    getServiceOptionsForAccount,
    buildStrictBestRateRequest,
    getAutoBestRateRequest,
    getCurrentBestRateDimsLabel,
    hasDisplayableBestRateForCurrentRequest,
    getAwaitingBestRateDisplayState,
    getOrderWithAutoBestRate,
  };
}
