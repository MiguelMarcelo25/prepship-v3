import type { CreatedExternalLabel } from '../lib/shipstation/labels';
import {
  recordExactShipStationReconciliationReceipt,
  type FulfillmentOperationDependencies,
} from './fulfillment-operation-ledger';
import {
  buildShipStationForwardLabelReceipt,
  readShipStationForwardLabelPersistenceFacts,
  type ShipStationForwardLabelPersistenceFacts,
} from './shipstation-forward-label-operation';

type PersistenceFactsInput = Omit<
  ShipStationForwardLabelPersistenceFacts,
  'version' | 'authority' | 'provider' | 'source' | 'insuranceProvider' | 'insuredValue'
> & {
  insuranceProvider?: unknown;
  insuredValue?: unknown;
};

/**
 * Dedicated trusted receipt writer reached only after the exact-ID provider GET,
 * immutable request hash, quote intent, and account checks all pass.
 */
export async function recordExactShipStationForwardLabelReceipt(
  operationId: number,
  created: CreatedExternalLabel,
  input: PersistenceFactsInput,
  injected: FulfillmentOperationDependencies = {},
): Promise<void> {
  // Per user override unlock shipped data on 2026-07-22: this boundary builds
  // and validates the sealed facts itself; arbitrary operator JSON cannot stamp
  // the reserved exact-reconciler provenance.
  const receipt = buildShipStationForwardLabelReceipt(created, input);
  readShipStationForwardLabelPersistenceFacts(receipt, {
    orderId: input.orderId,
    clientId: input.clientId,
  });
  await recordExactShipStationReconciliationReceipt(operationId, {
    note: 'Exact ShipStation external_shipment_id lookup verified the completed provider receipt.',
    receipt,
    providerOperationId: created.labelId ?? created.shipmentId,
    providerResultId: created.trackingNumber,
  }, injected);
}
