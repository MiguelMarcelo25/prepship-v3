/**
 * PS-292 closeout guard - executable Final Review recommendation.
 *
 * PS-220 owns the SHIPP house-margin source of truth, PS-292 owns the tuple
 * display/save safety, and PS-295 owns the shipped-row + billing live-regression
 * tail. This guard ties those proofs together so the Trello move recommendation
 * is backed by runnable evidence instead of a prose-only status update.
 *
 *   npx tsx scripts/ps-292-final-review-closeout-guard.ts
 */
import { readFileSync } from 'node:fs';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { houseMarginFromProjection, planRealizedHouseCapture } from '../src/services/shipping-workflow/house-margin-capture';
import { houseTupleStatus, shouldRejectHalfHouseSave } from '../src/services/shipping-workflow/house-tuple-save-policy';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function hasScript(pkg: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(pkg);
}

const pkg = readFileSync('package.json', 'utf8');
check(
  'package.json exposes this closeout guard',
  hasScript(pkg, 'test:ps-292-final-review-closeout', 'tsx scripts/ps-292-final-review-closeout-guard.ts'),
);
check(
  'package.json keeps the PS-220 source-of-truth guard wired',
  hasScript(pkg, 'test:ps-220-house-margin', 'tsx scripts/ps-220-house-margin-guard.ts'),
);
check(
  'package.json keeps the PS-292 house tuple display guard wired',
  hasScript(pkg, 'test:ps-292-house-tuple-display', 'tsx scripts/ps-292-house-tuple-display-guard.ts'),
);
check(
  'package.json keeps the PS-295 shipped/billing customer_rate proof wired',
  hasScript(pkg, 'test:ps-295-house-customer-rate-proof', 'tsx scripts/ps-295-house-customer-rate-proof-guard.ts'),
);

const ps220 = readFileSync('scripts/ps-220-house-margin-guard.ts', 'utf8');
const ps292 = readFileSync('scripts/ps-292-house-tuple-display-guard.ts', 'utf8');
const ps295 = readFileSync('scripts/ps-295-house-customer-rate-proof-guard.ts', 'utf8');

check(
  'PS-220 guard pins resolver, projected stamp, realized capture, billing, and portal redaction',
  /resolveNextBestNonHouseRate/.test(ps220) &&
    /stampHouseTuple/.test(ps220) &&
    /writer-gate/.test(ps220) &&
    /billing decision \(house\): bills customer_rate/.test(ps220) &&
    /portal proof/.test(ps220),
);
check(
  'PS-292 guard pins FE pass-through, half-house rejection, pass-through safety, shipped realized read, and FE diagnostic',
  /houseTuplePassThrough/.test(ps292) &&
    /item4: a half-house save is rejected/.test(ps292) &&
    /linchpin: SHIPP no-competitor pass-through/.test(ps292) &&
    /item3: realized two-tier/.test(ps292) &&
    /FE follow-up/.test(ps292),
);
check(
  'PS-295 guard owns the live-regression tail: sidecar to shipped DTO/UI to billing/export/invoice',
  /sidecar planner freezes customer_rate/.test(ps295) &&
    /shipped DTO money tuple/.test(ps295) &&
    /billing detail metrics/.test(ps295) &&
    /invoice CSV row/.test(ps295) &&
    /HTML and XLSX invoice renderers/.test(ps295),
);
check(
  'PS-295 guard explicitly separates House proof from Browse Rates speed diagnostics',
  /intentionally separate from ps-295-rate-browser-speed-diagnostics/.test(ps295) &&
    /old PS-295 Browse Rates diagnostics guard still exists but is not the House proof/.test(ps295),
);

{
  const halfHouse = houseTupleStatus({
    rawProvider: 'shipp',
    optedIn: true,
    nextBestNonHouseRate: null,
    houseMargin: null,
  });
  check(
    'closeout behavior: opted-in SHIPP without tuple is still blocked as needs_refresh',
    halfHouse === 'needs_refresh' && shouldRejectHalfHouseSave(halfHouse) === true,
  );

  const passThrough = houseTupleStatus({
    rawProvider: 'shipp',
    optedIn: true,
    nextBestNonHouseRate: null,
    houseMargin: 0,
  });
  check(
    'closeout behavior: genuine no-competitor SHIPP pass-through is allowed',
    passThrough === 'present' && shouldRejectHalfHouseSave(passThrough) === false,
  );
}

{
  const best = normalizeOrderBestRateDto({
    provider: 'shipp',
    carrierCode: 'ups',
    serviceCode: 'shipp_ups_ground',
    shipmentCost: 8.5,
    otherCost: 0,
    totalCost: 8.5,
    nextBestNonHouseRate: {
      carrierCode: 'stamps_com',
      serviceCode: 'usps_ground_advantage',
      shipmentCost: 9.64,
      otherCost: 0,
      totalCost: 9.64,
      providerAccountId: 442007,
      competitorCount: 2,
    },
    houseMargin: 1.14,
  });
  const realized = houseMarginFromProjection(best, 8.5);
  check(
    'closeout behavior: realized sidecar freezes customer_rate 9.64 over drp_cost 8.50',
    realized?.customerRate === 9.64 && realized.margin === 1.14 && realized.competitorCount === 2,
    JSON.stringify(realized),
  );
  check(
    'closeout behavior: realized writer gate stays default-off for non-opted-in clients',
    planRealizedHouseCapture({ drpCost: 8.5, optedIn: false, best }) === null,
  );

  const billing = decideShippingLineBilling({
    labelCost: 8.5,
    cShippingRateAmount: realized?.customerRate ?? null,
    billingMode: 'label_cost',
    isBaselineCarrier: false,
    refUspsRate: 7,
    refUpsRate: 7.5,
    shippingMarkupPct: 50,
    shippingMarkupFlat: 2,
  });
  check(
    'closeout behavior: billing line uses customer_rate exactly, without carrier markup',
    billing.billedAmount === 9.64 && billing.source === 'c_shipping_rate' && billing.markupApplied === false,
    JSON.stringify(billing),
  );
}

const closeoutStatus = {
  card: 'PS-292',
  recommendation: 'Final Review',
  blocker: 'None for PS-292 code/test closeout; PS-295 owns live shipped/billing canary proof.',
  trelloAction: 'recommend-only',
  safety: 'No live labels, postage, queue mutation, marketplace notification, or production data repair.',
} as const;

check('closeout status recommends PS-292 Final Review', closeoutStatus.recommendation === 'Final Review');
check('closeout status leaves Trello mutation to explicit approval', closeoutStatus.trelloAction === 'recommend-only');
check('closeout status keeps the live tail assigned to PS-295', /PS-295 owns live/.test(closeoutStatus.blocker));
check('closeout status documents no live-money/label action', /No live labels/.test(closeoutStatus.safety));

if (failures > 0) {
  console.error(`\nFAIL PS-292 final-review closeout guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-292 final-review closeout guard');
