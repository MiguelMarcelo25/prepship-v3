// PS-078 — store-source × carrier-provider compatibility matrix.
//
// This is the SINGLE source of truth that composes the two independent connector
// boundaries and certifies (or explicitly blocks) every combination BEFORE any
// postage side effect:
//   - CarrierConnector owns rate shopping + label creation (who can buy a label).
//   - StoreConnector owns source confirmation (who tells the marketplace shipped).
//
// It is derived from the real connectorCapabilityMatrix + implementation status,
// so it cannot drift from the connectors. The PS-078 guard asserts the
// label-capable set matches the Vercel /carriers/labels whitelist.
import { connectorCapabilityMatrix } from './matrix';
import { connectorImplementationStatus } from './implementation-status';
import type { ConnectorProvider } from './types';

// Carriers that can ACTUALLY buy a label end-to-end today. ShipStation buys via
// the Render /labels path; the direct carriers buy via the Vercel
// /carriers/labels function. Every other carrier exposes a labels.create
// capability SLOT but ships a stub implementation, so it is rates-only and must
// be blocked before postage. (The guard asserts the direct subset of this list
// equals the Vercel endpoint's LABEL_CREATE_CONNECTOR_CAPABILITIES whitelist.)
export const LABEL_CAPABLE_CARRIERS: ConnectorProvider[] = [
  'shipstation',
  'shipp',
  'walmart_shipping',
  'ups',
  'easypost',
];

// Direct carriers (everything label-capable except ShipStation) buy via Vercel.
export const DIRECT_LABEL_CARRIERS: ConnectorProvider[] = LABEL_CAPABLE_CARRIERS.filter(
  (c) => c !== 'shipstation',
);

export type StoreSource =
  | 'shipstation'
  | 'walmart'
  | 'ebay'
  | 'shopify'
  | 'amazon'
  | 'manual';

export type LabelEndpoint =
  | 'shipstation_render' // POST /labels (Render, ShipStation carrier)
  | 'carrier_vercel' // POST /carriers/labels (Vercel, direct carrier_accounts)
  | 'store_account_blocked' // direct store_accounts rate — cannot buy a label
  | 'none'; // rates-only carrier — no label endpoint

// Explicit confirmation lifecycle expectation — NEVER null after a label.
export type ConfirmationExpectedState = 'pending' | 'not_required' | 'not_supported';

export interface CompatibilityRow {
  storeSource: string;
  carrierProvider: string;
  labelEndpoint: LabelEndpoint;
  confirmationOwner: string;
  confirmationState: ConfirmationExpectedState;
  certified: boolean;
  reason: string;
}

export function carrierCanCreateLabel(carrier: ConnectorProvider): boolean {
  return (
    LABEL_CAPABLE_CARRIERS.includes(carrier) &&
    (connectorCapabilityMatrix[carrier] ?? []).includes('labels.create') &&
    connectorImplementationStatus[carrier]?.status === 'live'
  );
}

function labelEndpointFor(carrier: ConnectorProvider): LabelEndpoint {
  if (carrier === 'shipstation') return 'shipstation_render';
  return 'carrier_vercel';
}

// Source-provider drives confirmation ownership (NOT the carrier). A live
// shipment.confirm connector enqueues a `pending` confirmation; a registered-but-
// stub or contract-blocked source yields an explicit `not_supported` (never
// null); a manual / no-marketplace order is `not_required`.
export function sourceConfirmation(source: StoreSource): {
  owner: string;
  state: ConfirmationExpectedState;
} {
  if (source === 'manual') return { owner: 'none', state: 'not_required' };
  const caps = connectorCapabilityMatrix[source as ConnectorProvider] ?? [];
  const impl = connectorImplementationStatus[source as ConnectorProvider];
  const liveConfirm = caps.includes('shipment.confirm') && impl?.status === 'live';
  return liveConfirm
    ? { owner: source, state: 'pending' }
    : { owner: source, state: 'not_supported' };
}

// Certify one (store source, carrier) combo. `certified` means the combo can go
// end-to-end without a silent gap: a real label is bought AND confirmation is
// either run by a live source connector or explicitly not_required.
export function certifyCombo(source: StoreSource, carrier: ConnectorProvider): CompatibilityRow {
  if (!carrierCanCreateLabel(carrier)) {
    return {
      storeSource: source,
      carrierProvider: carrier,
      labelEndpoint: 'none',
      confirmationOwner: '-',
      confirmationState: 'not_required',
      certified: false,
      reason: 'rates-only carrier (no live label connector) — blocked before postage',
    };
  }
  const conf = sourceConfirmation(source);
  const certified = conf.state !== 'not_supported';
  return {
    storeSource: source,
    carrierProvider: carrier,
    labelEndpoint: labelEndpointFor(carrier),
    confirmationOwner: conf.owner,
    confirmationState: conf.state,
    certified,
    reason: certified
      ? conf.state === 'not_required'
        ? 'label OK; manual order needs no marketplace confirmation'
        : `label OK; confirmation via ${conf.owner} StoreConnector (ShipStation-source + direct carrier uses external tracking + notifySalesChannel)`
      : `label OK but ${source} confirmation connector is a stub → confirmation_status=not_supported (explicit, never null)`,
  };
}

// Synthetic provider-id offsets must mirror web/src/lib/v2-apiClient.ts. A direct
// carrier_accounts rate buys via Vercel; a direct store_accounts rate cannot buy
// a label and must be blocked before postage (req 7).
export const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;
export const DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000;

export function classifyLabelEndpointById(shippingProviderId: number | null): LabelEndpoint {
  if (shippingProviderId == null) return 'shipstation_render';
  if (shippingProviderId >= DIRECT_STORE_PROVIDER_ID_OFFSET) return 'store_account_blocked';
  if (shippingProviderId >= DIRECT_CARRIER_PROVIDER_ID_OFFSET) return 'carrier_vercel';
  return 'shipstation_render';
}

// The minimum certification rows PS-078 requires, plus the direct selected-rate
// source rows. Returned as data so the guard can assert AND print the table.
export function buildCompatibilityMatrix(): CompatibilityRow[] {
  const rows: CompatibilityRow[] = [
    certifyCombo('shipstation', 'shipstation'),
    certifyCombo('shipstation', 'ups'),
    certifyCombo('shipstation', 'easypost'),
    certifyCombo('shipstation', 'shipp'),
    certifyCombo('shipstation', 'walmart_shipping'),
    certifyCombo('walmart', 'walmart_shipping'),
    certifyCombo('walmart', 'ups'),
    certifyCombo('walmart', 'easypost'),
    certifyCombo('walmart', 'shipp'),
    certifyCombo('walmart', 'shipstation'),
    certifyCombo('ebay', 'ups'),
    certifyCombo('ebay', 'easypost'),
    certifyCombo('ebay', 'shipp'),
    certifyCombo('ebay', 'shipstation'),
    certifyCombo('manual', 'ups'),
    certifyCombo('manual', 'shipstation'),
    // Rates-only carriers are blocked before postage regardless of source:
    certifyCombo('shipstation', 'fedex'),
    certifyCombo('shipstation', 'usps'),
    certifyCombo('walmart', 'ebay_shipping'),
    // Registered-but-stub store source: label OK, confirmation explicit not_supported.
    certifyCombo('shopify', 'ups'),
    certifyCombo('amazon', 'ups'),
  ];

  // Direct selected-rate SOURCE rows (provider-id routing, not a carrier name):
  rows.push({
    storeSource: 'direct carrier_accounts selected rate',
    carrierProvider: '(decoded carrier)',
    labelEndpoint: classifyLabelEndpointById(DIRECT_CARRIER_PROVIDER_ID_OFFSET + 1),
    confirmationOwner: 'order source provider',
    confirmationState: 'pending',
    certified: true,
    reason: 'carrier_accounts id decodes to Vercel /carriers/labels; confirmation by order source',
  });
  rows.push({
    storeSource: 'direct store_accounts selected rate',
    carrierProvider: '(marketplace store account)',
    labelEndpoint: classifyLabelEndpointById(DIRECT_STORE_PROVIDER_ID_OFFSET + 1),
    confirmationOwner: '-',
    confirmationState: 'not_required',
    certified: false,
    reason: 'store_accounts rate cannot buy a label — BLOCKED before postage (never falls through to ShipStation se-20000xxx)',
  });

  return rows;
}
