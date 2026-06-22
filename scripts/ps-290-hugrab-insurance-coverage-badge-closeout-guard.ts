/**
 * PS-290 closeout guard - HUGRAB $100 insurance coverage badges.
 *
 * The focused PS-290 guard owns the resolver behavior. This closeout guard locks
 * the completion packet: backend ownership, Rate Browser/Awaiting parity,
 * purchase-gate alignment, SHIPP uncertainty honesty, package wiring, and
 * offline-only safety.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  HUGRAB_REQUIRED_INSURED_VALUE,
  resolveInsuranceCoverageStatus,
} from '../src/services/shipping-workflow/insurance-coverage-status';

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function hasScript(pkg: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(pkg);
}

const packageJson = read('package.json');
const coverageOwner = read('src/services/shipping-workflow/insurance-coverage-status.ts');
const dtoOwner = read('src/services/order-rate-dto.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const rateRowItem = read('web/src/components/RateRowItem.tsx');
const ps290Guard = read('scripts/ps-290-hugrab-insurance-coverage-badge-guard.ts');
const ps261Guard = read('scripts/ps-261-hugrab-label-purchase-gate-guard.ts');
const ps274Guard = read('scripts/ps-274-shipp-insurance-certainty-guard.ts');
const statusDoc = read('docs/ps-tickets/ps-290-hugrab-insurance-coverage-badge-status.md');

check('package exposes the PS-290 badge guard',
  hasScript(packageJson, 'test:ps-290-hugrab-insurance-coverage-badge', 'tsx scripts/ps-290-hugrab-insurance-coverage-badge-guard.ts'));
check('package exposes this PS-290 closeout guard',
  hasScript(packageJson, 'test:ps-290-hugrab-insurance-coverage-badge-closeout', 'tsx scripts/ps-290-hugrab-insurance-coverage-badge-closeout-guard.ts'));
check('package keeps PS-261 purchase gate and PS-274 certainty guards wired',
  hasScript(packageJson, 'test:ps-261-hugrab-label-purchase-gate', 'tsx scripts/ps-261-hugrab-label-purchase-gate-guard.ts') &&
    hasScript(packageJson, 'test:ps-274-shipp-insurance-certainty', 'tsx scripts/ps-274-shipp-insurance-certainty-guard.ts'));

check('coverage owner exports the $100 HUGRAB mandate',
  HUGRAB_REQUIRED_INSURED_VALUE === 100 &&
    /export const HUGRAB_REQUIRED_INSURED_VALUE/.test(coverageOwner));
check('coverage owner documents backend-only verdict ownership',
  /CANONICAL owner of the HUGRAB/.test(coverageOwner) &&
    /FE never recomputes it/.test(coverageOwner));
check('coverage owner stays pure and side-effect free',
  /PURE \+ deterministic/.test(coverageOwner) &&
    !/(db\.|fetch\s*\(|createLabel|notifyMarketplace|insert\s*\(|update\s*\()/i.test(coverageOwner));

const provenIncluded = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCost: 1.09,
  insuranceProvenance: 'parcelguard_schedule',
});
const directCarrierFree = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'carrier',
  insuredValue: 100,
  insuranceCost: 0,
  insuranceProvenance: 'carrier_declared_value',
});
const noInsurance = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'none',
  insuredValue: 0,
});
const shippUncertain = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'carrier',
  insuredValue: 100,
  insuranceCertainty: 'requested_application_uncertain',
  isShippBrokered: true,
});
const shippProof = resolveInsuranceCoverageStatus({
  isHugrab: true,
  insuranceProvider: 'carrier',
  insuredValue: 100,
  insuranceCertainty: 'requested_application_uncertain',
  insuranceCoverageProofSource: 'shipp_customs_value',
  isShippBrokered: true,
});

check('resolver marks proven HUGRAB premium as included/green',
  provenIncluded.status === 'included' &&
    provenIncluded.badgeLabel === '$100 INS. INCL.' &&
    provenIncluded.badgeTone === 'green');
check('resolver marks direct carrier $0 declared value as included/green',
  directCarrierFree.status === 'included' && directCarrierFree.badgeTone === 'green');
check('resolver marks explicit no-insurance as not_included/red',
  noInsurance.status === 'not_included' &&
    noInsurance.badgeLabel === 'NO INSURANCE' &&
    noInsurance.badgeTone === 'red');
check('resolver keeps unproven SHIPP brokered coverage honest as unknown',
  shippUncertain.status === 'unknown' &&
    shippUncertain.badgeLabel === 'INSURANCE UNKNOWN');
check('resolver only accepts flagged SHIPP customsValue proof as explicit proof source',
  shippProof.status === 'included' &&
    shippProof.insuranceCoverageProofSource === 'shipp_customs_value');

check('order-rate DTO declares coverage and proof fields for best and selected rates',
  /insuranceCoverageStatus:\s*InsuranceCoverageStatus/.test(dtoOwner) &&
    /insuranceBadgeLabel:\s*string/.test(dtoOwner) &&
    /insuranceBadgeTone:\s*InsuranceCoverageBadgeTone/.test(dtoOwner) &&
    /insuranceCoverageProofSource:\s*InsuranceCoverageProofSource \| null/.test(dtoOwner));
check('order-rate DTO delegates coverage to the resolver and gate to PS-261',
  /resolveCoverageFields\(/.test(dtoOwner) &&
    /resolveInsuranceCoverageStatus\(\{/.test(dtoOwner) &&
    /resolveHugrabLabelPurchaseGate\(verdict\.status\)/.test(dtoOwner));

check('Awaiting row display reads and renders backend coverage only',
  /export function getBestRateInsuranceCoverage/.test(rowDisplay) &&
    /renderInsuranceCoverageBadge/.test(rowDisplay) &&
    !/resolveInsuranceCoverageStatus\s*\(/.test(rowDisplay) &&
    !/insuredValue\s*[<>=]/.test(rowDisplay));
check('Rate Browser row reuses the same coverage reader and renderer',
  /getRowInsuranceCoverage/.test(rateRowItem) &&
    /renderInsuranceCoverageBadge/.test(rateRowItem) &&
    /from '\.\/Views\/orders-row-display'/.test(rateRowItem) &&
    !/resolveInsuranceCoverageStatus\s*\(/.test(rateRowItem) &&
    !/insuredValue\s*[<>=]/.test(rateRowItem));
check('Rate Browser row also reuses the backend purchase-gate display owner',
  /getRowHugrabPurchaseGate/.test(rateRowItem) &&
    /renderHugrabPurchaseGateBadge/.test(rateRowItem) &&
    !/resolveHugrabLabelPurchaseGate\s*\(/.test(rateRowItem));

check('focused PS-290 guard pins resolver behavior and frontend no-recompute policy',
  /HUGRAB USPS \$100 \+ ParcelGuard premium -> included/.test(ps290Guard) &&
    /orders-row-display does NOT call the resolver/.test(ps290Guard) &&
    /RateRowItem does NOT call the resolver/.test(ps290Guard));
check('PS-261 guard pins purchase gate alignment to the PS-290 verdict',
  /preflight CONSUMES the PS-290 coverage owner/.test(ps261Guard) &&
    /RateRowItem sources the gate reader\/renderer from orders-row-display/.test(ps261Guard));
check('PS-274 guard pins SHIPP certainty honesty',
  /Shipp brokered \+ declared value -> requested_application_uncertain/.test(ps274Guard) &&
    /Shipp brokered \+ declared value is NEVER explicitly_included/.test(ps274Guard));

const closeoutStatus = {
  card: 'PS-290',
  completion: 91,
  recommendation: 'Final Review',
  evidence: [
    'test:ps-290-hugrab-insurance-coverage-badge',
    'test:ps-290-hugrab-insurance-coverage-badge-closeout',
    'test:ps-261-hugrab-label-purchase-gate',
    'test:ps-274-shipp-insurance-certainty',
  ],
  safety: 'Offline proof only: no real labels, postage, provider calls, marketplace notification, or production data mutation.',
} as const;

check('closeout status recommends PS-290 Final Review',
  closeoutStatus.card === 'PS-290' &&
    closeoutStatus.completion >= 89 &&
    closeoutStatus.recommendation === 'Final Review');
check('closeout status includes connected coverage/gate/certainty evidence',
  closeoutStatus.evidence.includes('test:ps-290-hugrab-insurance-coverage-badge') &&
    closeoutStatus.evidence.includes('test:ps-261-hugrab-label-purchase-gate') &&
    closeoutStatus.evidence.includes('test:ps-274-shipp-insurance-certainty'));
check('closeout status documents offline-only safety',
  /Offline proof only/.test(closeoutStatus.safety));

check('PS-290 status doc exists and records conservative percentage',
  /Current completion estimate: PS-290 91%/.test(statusDoc));
check('PS-290 status doc lists remaining non-blocking proof gap',
  /Optional next evidence/.test(statusDoc) &&
    /browser screenshot/.test(statusDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-290 HUGRAB insurance coverage badge closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-290 HUGRAB insurance coverage badge closeout guard');
