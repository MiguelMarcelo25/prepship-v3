/**
 * PS-404 guard - HUGRAB shipped insurance badges distinguish proof missing
 * from explicit no-insurance, and the legacy reconciliation plan carries proof
 * fields instead of relying on price shape.
 *
 * Source of truth:
 *   - Coverage verdict: src/services/shipping-workflow/insurance-coverage-status.ts
 *   - Selected-rate DTO: src/services/order-rate-dto.ts
 *   - Reconciliation plan: src/services/shipping-workflow/parcelguard-backfill.ts
 *
 * This guard is offline: no DB, no ShipStation, no labels, no shipped-row writes.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  resolveInsuranceCoverageStatus,
  type ResolveInsuranceCoverageStatusInput,
} from '../src/services/shipping-workflow/insurance-coverage-status';
import { normalizeOrderSelectedRateDto } from '../src/services/order-rate-dto';
import {
  planParcelGuardBackfillRow,
  type LocalShipmentAccounting,
} from '../src/services/shipping-workflow/parcelguard-backfill';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const legacyMissingProof: ResolveInsuranceCoverageStatusInput = {
  isHugrab: true,
  insuranceProvider: null,
  insuredValue: null,
  insuranceCost: null,
  insuranceProvenance: null,
};
const legacyVerdict = resolveInsuranceCoverageStatus(legacyMissingProof);
check('legacy HUGRAB row with missing proof -> unknown, not no-insurance',
  legacyVerdict.status === 'unknown' &&
    legacyVerdict.badgeTone === 'amber' &&
    legacyVerdict.badgeLabel === 'INSURANCE UNKNOWN',
  legacyVerdict);

const legacySelectedRate = normalizeOrderSelectedRateDto(
  {
    providerAccountId: 433542,
    shippingProviderId: 433542,
    providerAccountNickname: 'USPS Chase x7439',
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    serviceName: 'USPS Ground Advantage',
    shipmentCost: 9.04,
    otherCost: 0,
    totalCost: 9.04,
  },
  undefined,
  'ps404.legacySelectedRate',
  { isHugrab: true },
);
assert.ok(legacySelectedRate, 'legacy selected-rate DTO should normalize');
check('selected-rate DTO preserves missing proof as amber unknown',
  legacySelectedRate.insuranceCoverageStatus === 'unknown' &&
    legacySelectedRate.insuranceBadgeLabel === 'INSURANCE UNKNOWN',
  legacySelectedRate);

const explicitNoInsurance = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'none',
  insuredValue: 0,
});
check('explicit HUGRAB no-insurance remains red NO INSURANCE',
  explicitNoInsurance.status === 'not_included' &&
    explicitNoInsurance.badgeTone === 'red' &&
    explicitNoInsurance.badgeLabel === 'NO INSURANCE',
  explicitNoInsurance);

const provenInsurance = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCost: 1.09,
  insuranceProvenance: 'shipstation_v1_shipment',
});
check('provider-proven HUGRAB ParcelGuard -> green included',
  provenInsurance.status === 'included' &&
    provenInsurance.badgeTone === 'green' &&
    provenInsurance.badgeLabel === '$100 INS. INCL.',
  provenInsurance);

type Ps404BackfillRow = LocalShipmentAccounting & {
  selectedRateJson?: unknown;
  selectedRateCost?: number | string | null;
};

const missingProofBackfill = planParcelGuardBackfillRow(
  {
    shipmentId: 2331,
    orderId: 1457000,
    orderNumber: '2331',
    ssShipmentId: 292074298,
    cost: 7.95,
    otherCost: 0,
    selectedRateCost: null,
    selectedRateJson: {
      carrierCode: 'stamps_com',
      serviceCode: 'usps_ground_advantage',
      totalCost: 9.04,
    },
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
  } satisfies Ps404BackfillRow,
  {
    postageAmount: 7.95,
    insuranceAmount: 1.09,
    totalAmount: 9.04,
    provenance: 'shipstation_v1_shipment',
  },
);
check('backfill plan repairs missing proof when provider proves premium',
  missingProofBackfill.affected === true &&
    missingProofBackfill.reason === 'postage_only_missing_premium',
  missingProofBackfill);
check('backfill patch writes proof fields, not just money',
  missingProofBackfill.updates?.selectedRateJsonPatch.insuranceProvider === 'parcelguard' &&
    missingProofBackfill.updates.selectedRateJsonPatch.insuredValue === 100 &&
    missingProofBackfill.updates.selectedRateJsonPatch.insuranceCost === 1.09 &&
    missingProofBackfill.updates.selectedRateJsonPatch.insuranceProvenance === 'shipstation_v1_shipment' &&
    missingProofBackfill.updates.selectedRateCost === '9.04',
  missingProofBackfill.updates);

const alreadyProvenBackfill = planParcelGuardBackfillRow(
  {
    shipmentId: 2332,
    orderId: 1457001,
    orderNumber: '2332',
    ssShipmentId: 292074299,
    cost: 7.95,
    otherCost: 1.09,
    selectedRateCost: '9.04',
    selectedRateJson: {
      insuranceProvider: 'parcelguard',
      insuredValue: 100,
      insuranceCost: 1.09,
      insuranceProvenance: 'shipstation_v1_shipment',
      totalCost: 9.04,
    },
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
  } satisfies Ps404BackfillRow,
  {
    postageAmount: 7.95,
    insuranceAmount: 1.09,
    totalAmount: 9.04,
    provenance: 'shipstation_v1_shipment',
  },
);
check('backfill apply is idempotent for already-proven rows',
  alreadyProvenBackfill.affected === false &&
    alreadyProvenBackfill.reason === 'already_reconciled',
  alreadyProvenBackfill);

const unprovenBackfill = planParcelGuardBackfillRow(
  {
    shipmentId: 2333,
    orderId: 1457002,
    orderNumber: '2333',
    ssShipmentId: 292074300,
    cost: 9.04,
    otherCost: 0,
    selectedRateCost: null,
    selectedRateJson: {},
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
  } satisfies Ps404BackfillRow,
  null,
);
check('backfill dry-run cannot prove insurance without provider billing proof',
  unprovenBackfill.affected === false &&
    unprovenBackfill.reason === 'no_billed_cost' &&
    unprovenBackfill.updates === null,
  unprovenBackfill);

const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
check('frontend row display still does not call coverage resolver',
  !/resolveInsuranceCoverageStatus\s*\(/.test(rowDisplay));
check('frontend row display still reads backend badge fields only',
  rowDisplay.includes('insuranceCoverageStatus') &&
    rowDisplay.includes('insuranceBadgeLabel') &&
    rowDisplay.includes('insuranceBadgeTone'));

const backfillScript = read('scripts/ps-108-parcelguard-cost-backfill.ts');
check('backfill script remains dry-run by default and double-gated for apply',
  /const apply = hasFlag\('apply'\)/.test(backfillScript) &&
    /const confirmProduction = hasFlag\('confirm-production'\)/.test(backfillScript) &&
    /if \(!apply\)/.test(backfillScript) &&
    /if \(!confirmProduction\)/.test(backfillScript));
check('backfill apply writes selectedRateCost with the proof patch',
  /selectedRateCost:\s*plan\.updates\.selectedRateCost/.test(backfillScript) &&
    /selectedRateJson:\s*mergedRate/.test(backfillScript));

const pkg = read('package.json');
check('package.json wires the PS-404 guard',
  pkg.includes('"test:ps-404-hugrab-insurance-proof": "tsx scripts/ps-404-hugrab-insurance-proof-guard.ts"'));

if (failures > 0) {
  console.error(`\nFAIL PS-404 HUGRAB insurance proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-404 HUGRAB insurance proof guard');
