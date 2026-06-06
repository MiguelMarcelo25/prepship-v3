/**
 * PS-106 guard (slice 1) — direct-store vs ShipStation carrier-family eligibility PRIMITIVE.
 *
 * Per user override unlock shipped data on 2026-06-06. Proves the canonical PURE
 * decision over the full source x carrier-family x mode matrix, plus the best-effort
 * classifiers. This slice adds NO enforcement wiring — it is the setup primitive.
 */
import { readFileSync } from 'node:fs';
import {
  evaluateCarrierFamilyEligibility,
  classifyCarrierFamily,
  classifyOrderSource,
  SHIPSTATION_DIRECT_STORE_RULE_ID,
  type OrderSource,
  type CarrierFamily,
  type CarrierEligibilityMode,
} from '../src/services/shipping-workflow/carrier-family-eligibility';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const e = (orderSource: OrderSource, carrierFamily: CarrierFamily, mode: CarrierEligibilityMode) =>
  evaluateCarrierFamilyEligibility({ orderSource, carrierFamily, mode });

// ── enforce mode: the core safety matrix ──
check('ShipStation order + ShipStation carrier = allowed', e('shipstation', 'shipstation', 'enforce').allowed === true);
check('ShipStation order + direct carrier = allowed', e('shipstation', 'direct', 'enforce').allowed === true);
check('direct-store order + direct carrier = allowed', e('direct_store', 'direct', 'enforce').allowed === true);
const blocked = e('direct_store', 'shipstation', 'enforce');
check('direct-store order + ShipStation carrier = BLOCKED', blocked.allowed === false && blocked.wouldBlock === true);
check('block reason is the canonical rule id', blocked.ruleId === SHIPSTATION_DIRECT_STORE_RULE_ID);
check('unknown/manual order + ShipStation carrier = BLOCKED (safe default)',
  e('manual_unknown', 'shipstation', 'enforce').allowed === false);
check('unknown order + direct carrier = allowed', e('manual_unknown', 'direct', 'enforce').allowed === true);

// ── audit_only: reports would-block but does NOT block ──
const audit = e('direct_store', 'shipstation', 'audit_only');
check('audit_only: direct-store + ShipStation is allowed but flagged wouldBlock',
  audit.allowed === true && audit.wouldBlock === true);

// ── disabled: never blocks, still computes wouldBlock for visibility ──
const disabled = e('direct_store', 'shipstation', 'disabled');
check('disabled: direct-store + ShipStation is allowed', disabled.allowed === true);
check('disabled: still reports wouldBlock for audit', disabled.wouldBlock === true);

// ── classifiers ──
check("classifyCarrierFamily: EasyPost -> direct", classifyCarrierFamily({ provider: 'EasyPost Carrier', kind: 'carrier' }) === 'direct');
check("classifyCarrierFamily: Shipp -> direct", classifyCarrierFamily({ carrierCode: 'shipp_ups_ground' }) === 'direct');
check("classifyCarrierFamily: stamps_com -> shipstation", classifyCarrierFamily({ carrierCode: 'stamps_com' }) === 'shipstation');
check("classifyCarrierFamily: isShipStation flag -> shipstation", classifyCarrierFamily({ isShipStation: true }) === 'shipstation');
check("classifyOrderSource: shipstation connector -> shipstation", classifyOrderSource({ sourceConnectorKind: 'shipstation' }) === 'shipstation');
check("classifyOrderSource: direct connector -> direct_store", classifyOrderSource({ sourceConnectorKind: 'direct' }) === 'direct_store');
check("classifyOrderSource: walmart provider -> direct_store", classifyOrderSource({ sourceProvider: 'walmart' }) === 'direct_store');
check("classifyOrderSource: connector kind wins over provider", classifyOrderSource({ sourceConnectorKind: 'shipstation', sourceProvider: 'walmart' }) === 'shipstation');
check("classifyOrderSource: empty -> manual_unknown", classifyOrderSource(null) === 'manual_unknown');

// ── primitive is PURE / no-enforcement-wiring + no bypass flags ──
const src = readFileSync('src/services/shipping-workflow/carrier-family-eligibility.ts', 'utf8');
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
check('primitive imports nothing (pure module, no DB/route coupling)', !/^import /m.test(src));
check('primitive adds no force/skip-eligibility bypass flag code',
  !/(force|skipEligibility|allowAnyway|ignoreSource)\s*[:=?]/i.test(codeOnly));

// ── exhaustive sweep: a ShipStation carrier on a non-ShipStation source always wouldBlock ──
for (const os of ['shipstation', 'direct_store', 'manual_unknown'] as OrderSource[]) {
  const r = evaluateCarrierFamilyEligibility({ orderSource: os, carrierFamily: 'shipstation', mode: 'enforce' });
  const expectBlock = os !== 'shipstation';
  check(`sweep: ShipStation carrier on ${os} -> ${expectBlock ? 'blocked' : 'allowed'}`, r.allowed === !expectBlock);
}

if (failures > 0) {
  console.error(`\nFAIL PS-106 carrier-family eligibility guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-106 carrier-family eligibility guard');
