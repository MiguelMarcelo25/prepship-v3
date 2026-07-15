import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildLocalTariffModel,
  estimateLocalTariffs,
  type LocalTariffCalibrationPoint,
} from '../src/services/local-tariff-engine';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const point = (
  weightOz: number,
  customerAmount: number,
): LocalTariffCalibrationPoint => ({
  requestKey: `fixture-${weightOz}`,
  fromZip: '90248',
  toZip: '10001',
  residential: true,
  dimensions: { length: 12, width: 10, height: 6 },
  weightOz,
  capturedAt: '2026-07-15T00:00:00.000Z',
  rates: [{
    carrierId: 'se-fixture',
    carrierCode: 'ups',
    rateType: 'shipment',
    serviceCode: 'ups_ground',
    serviceType: 'UPS Ground',
    packageType: 'package',
    currency: 'usd',
    customerAmount,
  }],
});

const model = buildLocalTariffModel(
  [point(16, 10), point(32, 20)],
  '2026-07-15T01:00:00.000Z',
);
const base = {
  fromZip: '90248',
  toZip: '10001',
  residential: true,
  dimensions: { length: 12, width: 10, height: 6 },
};

const exact = estimateLocalTariffs(model, { ...base, weightOz: 16 });
assert.equal(exact.length, 1);
assert.equal(exact[0]?.estimatedCustomerAmount, 10);
assert.equal(exact[0]?.interpolation, 'exact');
assert.equal(exact[0]?.authority, 'advisory_only');
assert.equal(exact[0]?.purchasable, false);
assert.equal(exact[0]?.selectedRateProof, null);

const interpolated = estimateLocalTariffs(model, { ...base, weightOz: 24 });
assert.equal(interpolated.length, 1);
assert.equal(interpolated[0]?.estimatedCustomerAmount, 15);
assert.equal(interpolated[0]?.interpolation, 'linear');
assert.equal(interpolated[0]?.lowerWeightOz, 16);
assert.equal(interpolated[0]?.upperWeightOz, 32);

assert.deepEqual(estimateLocalTariffs(model, { ...base, weightOz: 8 }), [], 'never extrapolate below live evidence');
assert.deepEqual(estimateLocalTariffs(model, { ...base, weightOz: 40 }), [], 'never extrapolate above live evidence');
assert.deepEqual(estimateLocalTariffs(model, { ...base, toZip: '10002', weightOz: 16 }), [], 'destination changes miss the lane');
assert.deepEqual(estimateLocalTariffs(model, { ...base, residential: false, weightOz: 16 }), [], 'residential changes miss the lane');
assert.deepEqual(
  estimateLocalTariffs(model, { ...base, dimensions: { ...base.dimensions, height: 7 }, weightOz: 16 }),
  [],
  'dimensions changes miss the lane',
);

const engine = read('src/services/local-tariff-engine.ts');
const calibration = read('src/services/local-tariff-calibration.ts');
const scheduler = read('src/services/sync-job-queue.ts');
const lanes = read('src/services/sync-job-lanes.ts');
const env = read('src/lib/env.ts');
const doc = read('docs/ps-tickets/audit-5.2-local-tariff-calibration.md');
const audit = read('AUDIT-2026-07-13.md');

assert.doesNotMatch(engine, /from ['"].*(?:rates|db|orders|shipments|labels)/);
assert.doesNotMatch(engine, /\b(?:pickBestRate|combineCarrierUniverses)\s*\(/);
assert.match(engine, /selectedRateProof:\s*null/);
assert.match(engine, /purchasable:\s*false/);
assert.match(engine, /never extrapolates/);

assert.match(calibration, /resolveRateInput\(/);
assert.match(calibration, /fetchLiveRatesWithDiagnostics\(resolvedInput, \[\], 'background'\)/);
assert.match(calibration, /applyMarkups\(live\.rates, markups\)/);
assert.match(calibration, /rateTotal\(/);
assert.match(calibration, /analyticsCache/);
assert.doesNotMatch(calibration, /\bgetRates\s*\(/);
assert.doesNotMatch(calibration, /\bcombineCarrierUniverses\s*\(/);
assert.doesNotMatch(calibration, /(?:orders|shipments|labels)\.(?:insert|update|delete)|from ['"].*(?:orders|shipments|labels)/);

assert.match(env, /ENABLE_LOCAL_TARIFF_CALIBRATION_SCHEDULER:\s*booleanFlag\(false\)/);
assert.match(scheduler, /localTariffCalibration:\s*'prepship\.rates\.local-tariff-calibration'/);
assert.match(scheduler, /dailyAtEightUtc:\s*'0 8 \* \* \*'/);
assert.match(scheduler, /ENABLE_LOCAL_TARIFF_CALIBRATION_SCHEDULER && Boolean\(env\.SHIPSTATION_API_KEY_V2\)/);
assert.match(lanes, /\['prepship\.rates\.local-tariff-calibration', 'shipstation-sync'\]/);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}
assert.match(doc, /never becomes a `Rate`/);
assert.match(doc, /disabled by default/);
assert.match(audit, /- \[x\] 5\.2 \*\*Optional local tariff engine with nightly live-calibration probes complete\*\*/);

console.log('PASS Audit 5.2 advisory local-tariff calibration guard');
