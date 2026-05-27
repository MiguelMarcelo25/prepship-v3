export type {
  CarrierConnector,
  ConfirmationResult,
  ConnectorCapability as FulfillmentCapability,
  ConnectorProvider as FulfillmentProvider,
  ShipmentConfirmationInput,
  StoreConnector,
} from '../../connectors/types';

export type ConfirmationStatus =
  | 'not_required'
  | 'not_supported'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed';
