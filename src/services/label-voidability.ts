/**
 * PS-219 — read-only label voidability for the operator Void Label UI.
 *
 * Per user override unlock shipped data on 2026-06-13: this module READS shipped
 * shipment rows to expose a BACKEND-OWNED voidability verdict on the
 * order-detail DTO so the frontend never guesses whether a label can be voided.
 * It performs NO database writes — the single `shipments.voided = true` write
 * stays in voidLabelV2 (ps-211 guard pins exactly one). It reuses the SAME
 * owners the mutating path uses: resolveLabelVoidDispatch (the pure routing
 * policy) and carrierConnectorSupportsVoid (the capability matrix), so the UI's
 * enabled/disabled state always matches what voidLabelV2 would actually do.
 *
 * The FE consumes { shipmentId, voidable, reasonCode, providerLabel } and
 * branches on the reasonCode enum (never on message text). shipmentId is the
 * LOCAL shipments.id PK the void route addresses — never an order id, a
 * ShipStation shipment id, or a synthetic direct-carrier id.
 */
import { resolveLabelVoidDispatch } from './label-void-policy';
import { carrierConnectorSupportsVoid } from './carrier-connector-orchestrator';

export type LabelVoidReasonCode =
  | 'already_voided'
  | 'not_supported'
  | 'missing_provider_label_id'
  | 'no_active_shipment';

export type LabelVoidability = {
  /** Local shipments.id PK to POST to /labels/:shipmentId/void. Null = hide the action. */
  shipmentId: number | null;
  voidable: boolean;
  reasonCode: LabelVoidReasonCode | null;
  providerLabel: {
    carrier: string | null;
    service: string | null;
    accountLabel: string | null;
    trackingNumber: string | null;
  } | null;
};

/** The shipment-row fields this read-only resolver needs (a structural subset of
 *  the shipments select-all row). */
type VoidabilityShipmentRow = {
  id: number;
  source: string | null;
  labelShipmentId: number | null;
  voided: boolean | null;
  isReturn: boolean | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  providerAccountNickname: string | null;
  selectedRateJson: unknown;
};

const NO_ACTIVE_SHIPMENT: LabelVoidability = {
  shipmentId: null,
  voidable: false,
  reasonCode: 'no_active_shipment',
  providerLabel: null,
};

/**
 * Resolve voidability for an order from its shipment rows (newest first, as the
 * detail handlers load them). Picks the latest non-return shipment — the one
 * whose label the operator would void — and classifies it WITHOUT mutating.
 */
export function resolveOrderLabelVoidability(
  shipmentRows: VoidabilityShipmentRow[],
  clientIsTest: boolean,
): LabelVoidability {
  const row = shipmentRows.find((candidate) => !candidate.isReturn) ?? null;
  if (!row) return NO_ACTIVE_SHIPMENT;

  const selectedRate = (row.selectedRateJson ?? null) as Record<string, unknown> | null;
  const dispatch = resolveLabelVoidDispatch({
    source: row.source ?? null,
    labelShipmentId: row.labelShipmentId ?? null,
    voided: !!row.voided,
    trackingNumber: row.trackingNumber ?? null,
    providerLabelId:
      selectedRate && typeof selectedRate.providerLabelId === 'string' ? selectedRate.providerLabelId : null,
    clientIsTest,
  });

  const base = {
    shipmentId: row.id,
    providerLabel: {
      carrier: row.carrierCode ?? null,
      service: row.serviceCode ?? null,
      accountLabel: row.providerAccountNickname ?? null,
      trackingNumber: row.trackingNumber ?? null,
    },
  };

  switch (dispatch.kind) {
    case 'already_voided':
      return { ...base, voidable: false, reasonCode: 'already_voided' };
    case 'local_test':
      return { ...base, voidable: true, reasonCode: null };
    case 'provider':
      return carrierConnectorSupportsVoid(dispatch.provider)
        ? { ...base, voidable: true, reasonCode: null }
        : { ...base, voidable: false, reasonCode: 'not_supported' };
    case 'not_voidable':
      return { ...base, voidable: false, reasonCode: 'missing_provider_label_id' };
    default:
      return { ...base, voidable: false, reasonCode: 'missing_provider_label_id' };
  }
}
