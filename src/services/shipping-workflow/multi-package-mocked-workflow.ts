/**
 * PS-289 - pure end-to-end mocked multi-package workflow.
 *
 * Composes the package plan, mocked labels, print queue candidates, and marketplace confirmation candidates.
 * No DB writes, provider calls, real labels, postage, print queue writes, marketplace API calls, or shipped/cancelled mutation happens here.
 */
import {
  buildMockedMultiPackageLabelFlow,
  type MockedMultiPackageLabelFlow,
} from './multi-package-mock-label-flow';
import {
  buildMultiPackageMarketplaceConfirmationPlan,
  type MultiPackageMarketplaceConfirmationPlan,
} from './multi-package-marketplace-confirmation-plan';
import {
  buildMultiPackagePrintQueuePlan,
  type MultiPackagePrintQueuePlan,
} from './multi-package-print-queue-plan';
import {
  buildMultiPackageShipmentPlan,
  type MultiPackageShipmentPlan,
  type MultiPackageShipmentPlanInput,
} from './multi-package-shipment-plan';

export type MockedMultiPackageWorkflow = {
  summary: {
    orderId: number;
    clientId: number | null;
    orderNumber: string | null;
    groupKey: string;
    status: 'mocked_workflow_planned';
    packageCount: number;
    trackingNumbers: string[];
    isLivePostage: false;
    isLiveMarketplaceNotification: false;
  };
  shipmentPlan: MultiPackageShipmentPlan;
  labelFlow: MockedMultiPackageLabelFlow;
  printQueuePlan: MultiPackagePrintQueuePlan;
  marketplaceConfirmationPlan: MultiPackageMarketplaceConfirmationPlan;
};

function plannedOrderNumber(
  shipmentPlan: MultiPackageShipmentPlan,
  override: string | number | null | undefined,
): string | null {
  if (override === undefined) return shipmentPlan.orderNumber;
  if (override == null) return null;
  const text = String(override).trim();
  return text || null;
}

export function buildMockedMultiPackageWorkflow(
  input: MultiPackageShipmentPlanInput,
  options: {
    clientId?: number | null;
    carrierName?: string;
    serviceLabel?: string;
    orderNumber?: string | number | null;
    existingLabelIdempotencyKeys?: string[];
    existingQueuedLabelIdempotencyKeys?: string[];
    existingConfirmationLabelIdempotencyKeys?: string[];
  } = {},
): MockedMultiPackageWorkflow {
  const shipmentPlan = buildMultiPackageShipmentPlan(input);
  const orderNumber = plannedOrderNumber(shipmentPlan, options.orderNumber);
  const labelFlow = buildMockedMultiPackageLabelFlow(shipmentPlan, {
    clientId: options.clientId,
    serviceLabel: options.serviceLabel,
    existingLabelIdempotencyKeys: options.existingLabelIdempotencyKeys,
  });
  const printQueuePlan = buildMultiPackagePrintQueuePlan(labelFlow, {
    orderNumber,
    existingQueuedLabelIdempotencyKeys: options.existingQueuedLabelIdempotencyKeys,
  });
  const marketplaceConfirmationPlan = buildMultiPackageMarketplaceConfirmationPlan(labelFlow, {
    carrierName: options.carrierName,
    serviceLabel: options.serviceLabel,
    orderNumber,
    existingConfirmationLabelIdempotencyKeys: options.existingConfirmationLabelIdempotencyKeys,
  });

  return {
    summary: {
      orderId: labelFlow.group.orderId,
      clientId: labelFlow.group.clientId,
      orderNumber,
      groupKey: shipmentPlan.shipmentGroupKey,
      status: 'mocked_workflow_planned',
      packageCount: shipmentPlan.packageCount,
      trackingNumbers: marketplaceConfirmationPlan.trackingNumbers,
      isLivePostage: false,
      isLiveMarketplaceNotification: false,
    },
    shipmentPlan,
    labelFlow,
    printQueuePlan,
    marketplaceConfirmationPlan,
  };
}
