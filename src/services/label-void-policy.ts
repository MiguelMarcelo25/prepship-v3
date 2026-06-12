/**
 * PS-211 — label void dispatch policy (pure, zero imports, guard-testable).
 *
 * Decides HOW a persisted shipment row voids, from row facts alone:
 *
 *   - test rows (source 'test_offline' or an is_test client) void locally —
 *     there is no provider label to void.
 *   - ShipStation purchases (source 'prepship_v2', legacy NULL/'' sources, and
 *     v1-import sources) void at ShipStation via the connector, addressed by
 *     the numeric ShipStation shipment id (labelShipmentId).
 *   - Direct purchases (source = the provider key: 'shipp', 'ups',
 *     'walmart_shipping', 'easypost', …) void at THAT provider, addressed by
 *     the provider-native label id persisted in selectedRateJson.providerLabelId
 *     (PS-211 forward-persisted; pre-PS-211 rows fall back to the tracking
 *     number, which several provider void APIs accept). Whether the provider's
 *     connector can actually void is the orchestrator's capability decision —
 *     this module only routes.
 *
 * The invariant the whole ticket exists for: local void state is applied ONLY
 * after the provider void succeeds (or for test/local rows that have no
 * provider label). A row this policy cannot address at its provider is
 * 'not_voidable' — it must NOT be silently local-voided, because the postage
 * would stay purchased at the provider while PrepShip forgets the label.
 */

export type LabelVoidOutcomeStatus =
  | 'voided'
  | 'already_voided'
  | 'not_supported'
  | 'provider_failed'
  | 'not_voidable';

export type LabelVoidRowFacts = {
  source: string | null;
  labelShipmentId: number | null;
  voided: boolean;
  trackingNumber: string | null;
  /** selectedRateJson.providerLabelId — provider-native id (PS-211 persists it). */
  providerLabelId: string | null;
  clientIsTest: boolean;
};

export type LabelVoidDispatch =
  | { kind: 'already_voided' }
  | { kind: 'local_test' }
  | { kind: 'provider'; provider: string; voidKey: string; voidKeySource: 'shipstation_shipment_id' | 'provider_label_id' | 'tracking_number' }
  | { kind: 'not_voidable'; reason: string };

/** Sources that mean "this label was purchased through ShipStation". */
const SHIPSTATION_SOURCES = new Set(['prepship_v2', 'shipstation', 'v1_import', '']);

export function resolveLabelVoidDispatch(row: LabelVoidRowFacts): LabelVoidDispatch {
  if (row.voided) return { kind: 'already_voided' };
  if (row.source === 'test_offline' || row.clientIsTest) return { kind: 'local_test' };

  const source = String(row.source ?? '').trim().toLowerCase();
  if (SHIPSTATION_SOURCES.has(source)) {
    if (row.labelShipmentId == null) {
      return {
        kind: 'not_voidable',
        reason:
          'This ShipStation label has no stored ShipStation shipment id, so PrepShip cannot address it for a void. ' +
          'Void it in the ShipStation dashboard; the local record stays active until then.',
      };
    }
    return {
      kind: 'provider',
      provider: 'shipstation',
      voidKey: String(row.labelShipmentId),
      voidKeySource: 'shipstation_shipment_id',
    };
  }

  // Direct purchase: the source column carries the provider key (PS-202 kept
  // the legacy attribution: 'shipp' / 'walmart_shipping' / 'ups' / 'easypost').
  const providerLabelId = String(row.providerLabelId ?? '').trim();
  if (providerLabelId) {
    return { kind: 'provider', provider: source, voidKey: providerLabelId, voidKeySource: 'provider_label_id' };
  }
  const tracking = String(row.trackingNumber ?? '').trim();
  if (tracking) {
    return { kind: 'provider', provider: source, voidKey: tracking, voidKeySource: 'tracking_number' };
  }
  return {
    kind: 'not_voidable',
    reason:
      `This ${source || 'direct-carrier'} label has neither a provider label id nor a tracking number on record — ` +
      'PrepShip cannot address it for a void. Void it at the carrier portal; the local record stays active until then.',
  };
}

/**
 * Operator-actionable message for a provider whose connector cannot void.
 * The label stays ACTIVE locally on purpose — see the module invariant.
 */
export function voidNotSupportedMessage(provider: string): string {
  return (
    `PrepShip cannot void ${provider} labels yet — the ${provider} connector has no void implementation. ` +
    'Void/refund the label at the carrier portal; the local record stays active so the shipment history remains truthful.'
  );
}
