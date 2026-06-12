/**
 * PS-211 guard — universal, provider-aware label void.
 *
 * Before: voidLabelV2 hardcoded ShipStation's void API for EVERY label — a
 * direct-carrier shipment's locally-synthesized labelShipmentId was sent to
 * ShipStation as if it were an SS id, and a row with NO labelShipmentId was
 * silently voided locally while the postage stayed purchased at the provider.
 * Nine connectors advertised 'labels.void' while only one implemented it.
 *
 * Certifies (offline, mocked only — no HTTP, no DB writes, no postage):
 *   1. The pure dispatch policy routes every row shape to its owning provider
 *      (or to an honest already_voided / local_test / not_voidable outcome).
 *   2. Capability honesty: the matrix advertises labels.void IFF the
 *      registered connector actually implements voidLabel — cross-checked
 *      DYNAMICALLY against the registry, so a future implementation flips the
 *      matrix or this guard fails.
 *   3. Local void state is applied ONLY after provider success — pinned as a
 *      source-ORDER property of voidLabelV2 (dispatch → provider_failed exit →
 *      the single voided:true write).
 *
 *   npx tsx scripts/ps-211-universal-void-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveLabelVoidDispatch,
  voidNotSupportedMessage,
  type LabelVoidRowFacts,
} from '../src/services/label-void-policy';
import {
  carrierConnectorSupportsVoid,
  voidCarrierLabel,
} from '../src/services/carrier-connector-orchestrator';
import { connectorCapabilityMatrix } from '../src/connectors/matrix';
import { carrierConnectors } from '../src/connectors/registry';

const row = (overrides: Partial<LabelVoidRowFacts>): LabelVoidRowFacts => ({
  source: 'prepship_v2',
  labelShipmentId: 987654,
  voided: false,
  trackingNumber: '1Z999AA10123456784',
  providerLabelId: null,
  clientIsTest: false,
  ...overrides,
});

// ── (1) Dispatch policy matrix ──────────────────────────────────────────────
// Already-voided wins over everything (idempotent void).
assert.deepEqual(resolveLabelVoidDispatch(row({ voided: true })), { kind: 'already_voided' });
assert.deepEqual(resolveLabelVoidDispatch(row({ voided: true, source: 'test_offline' })), { kind: 'already_voided' });
// Test rows void locally — there is no provider label.
assert.deepEqual(resolveLabelVoidDispatch(row({ source: 'test_offline' })), { kind: 'local_test' });
assert.deepEqual(resolveLabelVoidDispatch(row({ clientIsTest: true, source: 'shipp' })), { kind: 'local_test' });
// ShipStation purchases (incl. legacy null/'' sources) void at ShipStation by
// the NUMERIC SS shipment id.
assert.deepEqual(resolveLabelVoidDispatch(row({})), {
  kind: 'provider',
  provider: 'shipstation',
  voidKey: '987654',
  voidKeySource: 'shipstation_shipment_id',
});
assert.deepEqual(resolveLabelVoidDispatch(row({ source: null })).kind, 'provider');
assert.deepEqual(
  (resolveLabelVoidDispatch(row({ source: '' })) as { provider?: string }).provider,
  'shipstation',
);
// A ShipStation row with NO stored SS id is honestly not_voidable — the old
// code silently local-voided exactly this shape.
{
  const d = resolveLabelVoidDispatch(row({ labelShipmentId: null }));
  assert.equal(d.kind, 'not_voidable');
  assert.match((d as { reason: string }).reason, /cannot address it for a void/i);
}
// Direct purchases route to THEIR provider, preferring the provider-native
// label id (PS-211 persists it), falling back to tracking for pre-PS-211 rows.
assert.deepEqual(
  resolveLabelVoidDispatch(row({ source: 'shipp', providerLabelId: 'shp_label_8842' })),
  { kind: 'provider', provider: 'shipp', voidKey: 'shp_label_8842', voidKeySource: 'provider_label_id' },
);
assert.deepEqual(
  resolveLabelVoidDispatch(row({ source: 'walmart_shipping', providerLabelId: null })),
  { kind: 'provider', provider: 'walmart_shipping', voidKey: '1Z999AA10123456784', voidKeySource: 'tracking_number' },
);
// A direct row with neither identity is not_voidable — never silently local-voided.
assert.equal(
  resolveLabelVoidDispatch(row({ source: 'easypost', providerLabelId: null, trackingNumber: null })).kind,
  'not_voidable',
);
// The synthesized local labelShipmentId of a direct row must NEVER be the void
// key (it is not the provider's id space).
{
  const d = resolveLabelVoidDispatch(row({ source: 'ups', labelShipmentId: 73315522, providerLabelId: 'ups_native_9' }));
  assert.equal((d as { voidKey: string }).voidKey, 'ups_native_9');
}

// ── (2) Capability honesty — matrix ⟷ registry, dynamically ────────────────
for (const [provider, connector] of Object.entries(carrierConnectors)) {
  const advertises = (connectorCapabilityMatrix[provider as keyof typeof connectorCapabilityMatrix] ?? [])
    .includes('labels.void');
  const implementsVoid = typeof (connector as { voidLabel?: unknown }).voidLabel === 'function';
  assert.equal(
    advertises,
    implementsVoid,
    `capability honesty: ${provider} advertises labels.void=${advertises} but implements voidLabel=${implementsVoid}`,
  );
}
assert.equal(carrierConnectorSupportsVoid('shipstation'), true, 'shipstation void must be supported');
for (const provider of ['shipp', 'ups', 'walmart_shipping', 'easypost', 'fedex', 'usps', 'shipengine', 'ebay_shipping', 'amazon_shipping']) {
  assert.equal(carrierConnectorSupportsVoid(provider), false, `${provider} must honestly report void unsupported`);
}
// The orchestrator refuses an unsupported dispatch BEFORE any HTTP.
await assert.rejects(
  () => voidCarrierLabel('ups', { labelId: 'ups_native_9' }),
  /No carrier connector registered for ups with capability labels\.void/,
);
assert.match(voidNotSupportedMessage('shipp'), /stays active/i);

// ── (3) Source pins ─────────────────────────────────────────────────────────
const labelsSvc = readFileSync('src/services/labels.ts', 'utf8');
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
const ssConnector = readFileSync('src/connectors/carrier/shipstation.ts', 'utf8');

// voidLabelV2 dispatches through the policy + orchestrator — the ShipStation
// hardcode is gone from the service entirely (the connector owns ssVoidShipment).
assert.ok(labelsSvc.includes('resolveLabelVoidDispatch('), 'voidLabelV2 must route through the dispatch policy');
assert.ok(labelsSvc.includes('voidCarrierLabel(dispatch.provider'), 'voidLabelV2 must dispatch the void to the OWNING provider');
assert.ok(labelsSvc.includes('carrierConnectorSupportsVoid(dispatch.provider)'), 'unsupported providers must classify not_supported BEFORE dispatch');
assert.ok(!labelsSvc.includes('ssVoidShipment'), 'services/labels.ts must not call ShipStation void directly (connector owns it)');

// Local void only after provider success — a source-ORDER property:
// dispatch call → provider_failed early-return → the ONE voided:true write.
const voidedWrites = labelsSvc.match(/\.set\(\{ voided: true/g) ?? [];
assert.equal(voidedWrites.length, 1, 'exactly ONE local voided:true write may exist (the post-success write)');
const dispatchIdx = labelsSvc.indexOf('voidCarrierLabel(dispatch.provider');
const failExitIdx = labelsSvc.indexOf("'provider_failed',", dispatchIdx);
const localWriteIdx = labelsSvc.indexOf('.set({ voided: true', dispatchIdx);
assert.ok(
  dispatchIdx > -1 && failExitIdx > dispatchIdx && localWriteIdx > failExitIdx,
  'the provider dispatch must come first, the provider_failed exit second, and the single local void write LAST',
);

// The structured outcome statuses all exist as real code shapes.
for (const status of ["status: 'voided'", "status: 'already_voided'", "'not_supported'", "'not_voidable'", "'provider_failed'"]) {
  assert.ok(labelsSvc.includes(status), `voidLabelV2 must produce ${status}`);
}

// Provider-native identity is persisted at purchase time for future voids.
assert.ok(labelsSvc.includes('providerLabelId: created.labelId'), 'persistCreatedLabel must persist the provider-native label id');

// Route maps statuses to honest HTTP codes (502 provider failure; 409 refusals).
assert.ok(/provider_failed'\s*\?\s*502/.test(labelsRoute), 'route must return 502 for provider_failed');
assert.ok(/not_supported'\s*\|\|\s*result\.status === 'not_voidable'\s*\?\s*409/.test(labelsRoute), 'route must return 409 for not_supported/not_voidable');

// The ShipStation connector normalizes numeric ids so the v2 `se-` prefix is applied.
assert.ok(/\/\^\\d\+\$\/\.test\(raw\) \? Number\(raw\) : raw/.test(ssConnector), 'shipstation voidLabel must hand numeric ids to ssVoidShipment as numbers');

// npm wiring.
assert.ok(readFileSync('package.json', 'utf8').includes('"test:ps-211-universal-void"'), 'guard must be wired into package.json');

console.log('PASS ps-211 universal void guard');
