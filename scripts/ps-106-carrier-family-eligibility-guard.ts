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
import {
  assertCarrierFamilyEligibleForPurchase,
  CarrierFamilyEligibilityError,
  CARRIER_ELIGIBILITY_SETTING_KEY,
} from '../src/services/shipping-workflow/carrier-eligibility-policy';

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

// ── slice 2: settings-backed policy + purchase-boundary wiring (audit-first) ──
async function throwsEligibility(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return e instanceof CarrierFamilyEligibilityError; }
}
async function sliceTwoChecks() {
  const directStoreOrder = { sourceProvider: 'walmart', raw: { source_provider: 'walmart' } };
  const shipstationOrder = { sourceProvider: 'shipstation', raw: {} };

  check('enforce: direct-store + ShipStation purchase THROWS (blocks before provider call)',
    await throwsEligibility(() => assertCarrierFamilyEligibleForPurchase({ carrierFamily: 'shipstation', order: directStoreOrder, orderId: 1, modeOverride: 'enforce' })));
  check('audit_only: direct-store + ShipStation purchase does NOT throw (reports only)',
    !(await throwsEligibility(() => assertCarrierFamilyEligibleForPurchase({ carrierFamily: 'shipstation', order: directStoreOrder, orderId: 1, modeOverride: 'audit_only' }))));
  check('enforce: ShipStation-source order + ShipStation carrier is allowed',
    !(await throwsEligibility(() => assertCarrierFamilyEligibleForPurchase({ carrierFamily: 'shipstation', order: shipstationOrder, orderId: 1, modeOverride: 'enforce' }))));
  check('enforce: direct carrier is always allowed',
    !(await throwsEligibility(() => assertCarrierFamilyEligibleForPurchase({ carrierFamily: 'direct', order: directStoreOrder, orderId: 1, modeOverride: 'enforce' }))));
  check('thrown error carries the CARRIER_FAMILY_NOT_ELIGIBLE code',
    new CarrierFamilyEligibilityError('x').code === 'CARRIER_FAMILY_NOT_ELIGIBLE');

  // structural wiring: createLabelV2 enforces before the ShipStation provider call;
  // route maps the error; default mode is audit_only.
  const labelsService = readFileSync('src/services/labels.ts', 'utf8');
  const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
  const policy = readFileSync('src/services/shipping-workflow/carrier-eligibility-policy.ts', 'utf8');
  const eligIdx = labelsService.indexOf('await assertCarrierFamilyEligibleForPurchase(');
  const providerIdx = labelsService.indexOf("createCarrierLabel('shipstation'", eligIdx);
  check('createLabelV2 enforces carrier-family eligibility BEFORE the ShipStation provider call',
    eligIdx >= 0 && providerIdx > eligIdx);
  check('labels route maps CARRIER_FAMILY_NOT_ELIGIBLE to a safe 400',
    /e\.code === 'CARRIER_FAMILY_NOT_ELIGIBLE'/.test(labelsRoute));
  check('policy default mode is the SAFE audit_only',
    /return 'audit_only';/.test(policy) && policy.includes(CARRIER_ELIGIBILITY_SETTING_KEY));
  check('policy adds no force/bypass flag code',
    !/(force|bypass|allowAnyway|skipEligibility)\s*[:=?]/i.test(policy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')));
  check('mode read fails safe to audit_only on settings error',
    /catch[\s\S]{0,160}?return 'audit_only'|try \{[\s\S]{0,400}?\} catch/.test(policy) && /defaulting to audit_only/.test(policy));

  // slice 3: Settings UI + apiClient policy methods.
  const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
  const settingsView = readFileSync('web/src/components/Views/SettingsView.tsx', 'utf8');
  const card = readFileSync('web/src/components/Settings/CarrierEligibilityPolicyCard.tsx', 'utf8');
  check('apiClient reads/writes the carrier-eligibility setting',
    /fetchCarrierEligibilityPolicy/.test(apiClient) && /saveCarrierEligibilityPolicy/.test(apiClient) &&
      /\/settings\/block_shipstation_for_direct_store/.test(apiClient));
  check('Settings tab renders the carrier eligibility policy control',
    /CarrierEligibilityPolicyCard/.test(settingsView));
  check('policy card offers enforce / audit_only / disabled with audit_only default',
    /'enforce'/.test(card) && /'audit_only'/.test(card) && /'disabled'/.test(card) &&
      /useState<Mode>\('audit_only'\)/.test(card));
}

await sliceTwoChecks();

if (failures > 0) {
  console.error(`\nFAIL PS-106 carrier-family eligibility guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-106 carrier-family eligibility guard');
