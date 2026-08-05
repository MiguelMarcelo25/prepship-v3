/**
 * Guard: Rate Browser carrier-account clicks must browse/filter within the
 * modal. Applying a rate is reserved for actual rate rows.
 *
 * This is a static UI wiring guard for the operator flow:
 * Browse Rates -> click "EasyPost Carrier" in Carrier Accounts -> modal stays
 * open and shows EasyPost rates. Click an EasyPost rate row -> panel adopts
 * that carrier/account via the normal apply-rate path.
 *
 * PS-157 decomposed RateBrowserModal: the carrier-account column renders in
 * RateBrowserCarrierSidebar (click delegated via onSelectCarrier) and the rate
 * row in RateRowItem (click delegated via onRateClick). The modal still owns
 * all selection state and the apply path, so each behavior is pinned at BOTH
 * ends: the extracted markup and the modal wiring that binds it to the real
 * handler.
 *
 * Read-only: no DB, no network, no provider calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const modalSource = readFileSync(resolve('web/src/components/RateBrowserModal.tsx'), 'utf8');
const sidebarSource = readFileSync(resolve('web/src/components/RateBrowserCarrierSidebar.tsx'), 'utf8');
const rateRowSource = readFileSync(resolve('web/src/components/RateRowItem.tsx'), 'utf8');

const checks = [
  {
    name: 'carrier-account click is filter-only',
    ok:
      // Sidebar account row click delegates ONLY to onSelectCarrier...
      /onClick=\{\(\) => \{\s*onSelectCarrier\(c\.shippingProviderId\);\s*\}\}/.test(sidebarSource) &&
      // ...and the modal binds onSelectCarrier to filter-state updates only.
      /onSelectCarrier=\{\(pid\) => \{\s*setSelectedPid\(pid\);\s*setViewMode\('carriers'\);\s*\}\}/.test(modalSource) &&
      !modalSource.includes('onClick={() => handleCarrierAccountClick(c, rates)}') &&
      !sidebarSource.includes('handleCarrierAccountClick'),
  },
  {
    name: 'carrier-account click does not call rate apply path',
    ok:
      !/function handleCarrierAccountClick[\s\S]*handleRateClick/.test(modalSource) &&
      // The extracted sidebar has no route to the apply path at all.
      !/handleRateClick|onApplyRate|onRateClick/.test(sidebarSource),
  },
  {
    name: 'rate row click applies through handleRateClick',
    ok:
      rateRowSource.includes('onClick={blocked ? undefined : () => onRateClick(r)}') &&
      modalSource.includes('onRateClick={handleRateClick}'),
  },
  {
    name: 'rate row apply path closes the modal after onApplyRate',
    ok: /function handleRateClick[\s\S]*onApplyRate\(\{[\s\S]*\}\);\s*onClose\(\);/.test(modalSource),
  },
  {
    name: 'account count still reflects only available rates when hidden rates are filtered',
    // Repointed 2026-08-05. This required, verbatim:
    //   rates.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions)).length
    //   isBlockedRate={isBlockedRate}
    // `isBlockedRate` no longer exists in the modal. The frontend used to re-derive
    // "is this rate blocked" from the order plus the current shipping options; it now
    // calls shouldHideRate -> rateBrowserShouldHideUnavailableRate ->
    // readBackendEligibilityBlockReason, i.e. it READS the backend-issued eligibility
    // block reason instead of recomputing eligibility client-side. That is the PS-316
    // direction, so the old spelling is exactly what should have disappeared.
    //
    // The count property is unchanged, so pin it at both ends the way this guard
    // already pins the click paths: the sidebar filters through the injected
    // predicate and does not re-derive hiding itself, and the modal binds that prop
    // to the canonical backend-reading predicate.
    ok:
      /rates\.filter\(\(r\) => !shouldHideRate\(r\)\)\.length/.test(sidebarSource) &&
      !/rateBrowserShouldHideUnavailableRate|readBackendEligibilityBlockReason|rateBlockedReason/.test(sidebarSource) &&
      /<RateBrowserCarrierSidebar[\s\S]{0,1200}?shouldHideRate=\{shouldHideUnavailableRate\}/.test(modalSource) &&
      /function shouldHideUnavailableRate\([\s\S]{0,200}?rateBrowserShouldHideUnavailableRate\(/.test(modalSource),
  },
];

let failures = 0;
for (const check of checks) {
  if (check.ok) {
    console.log(`ok   ${check.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${check.name}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL rate-browser carrier-account click guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS rate-browser carrier-account click guard');
