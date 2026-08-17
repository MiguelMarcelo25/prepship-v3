#!/usr/bin/env tsx
/**
 * PS-500 — mutation matrix for the rate-money guard.
 *
 * A guard passing against correct code proves nothing. It proves something only
 * if it goes RED when the defect is put back, and red for the RIGHT reason.
 *
 * This reintroduces each defect PS-500 removed, one at a time, and requires the
 * guard to fail at the specific check that owns it. "Some check failed" is not
 * good enough: a mutation that trips an unrelated assertion would let a bare
 * spot hide behind a neighbour.
 *
 * How the reason is verified: the guard prints `  ok  <label>` per passing
 * check. A clean run gives the canonical ordered label list. Under a mutation,
 * the FIRST absent label must be exactly the one that owns the defect.
 *
 * This found a real hole. Before it was written the guard had 28 green checks
 * and `rateBlockedReason` could be stripped of its money check entirely with the
 * pack still green — the fix from the previous corrective pass was documented by
 * the guard, not defended by it.
 *
 * Every file is restored in a finally block. Run it on a clean tree.
 */
// The runner lives in ./lib/mutation-matrix so PS-500 and PS-502 cannot drift apart. A
// matrix that quietly stops verifying WHICH check went red still reports passes, so two
// copies of that logic is the one duplication most worth removing.
import { runMutationMatrix, type Mutation } from './lib/mutation-matrix';

const GUARD = 'scripts/ps-500-rate-money-classifier-guard.ts';

const CLASSIFIER = 'src/services/shipping-workflow/shipping-rate-money-classifier.ts';
const BROWSE = 'src/services/rate-browser-display-fields.ts';
const MODAL = 'web/src/components/RateBrowserModal.tsx';
const REDACTION = 'src/services/rate-browser-money-redaction.ts';

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    defect: 'browse boundary stamps a verdict it did not compute',
    file: BROWSE,
    find: 'rateMoneyComplete: moneyVerdict.rateMoneyComplete,',
    replace: 'rateMoneyComplete: true,',
    expect: 'the browse producer stamps the verdict on a live row',
  },
  {
    id: 'M2',
    defect: 'browse boundary carries no verdict at all (the original FAIL)',
    file: BROWSE,
    find: /return \{\r?\n\s*\.\.\.stamped,\r?\n[\s\S]*?\r?\n\s*\};/,
    replace: 'return stamped;',
    expect: 'the browse producer stamps the verdict on a live row',
  },
  {
    id: 'M3',
    defect: 'availability computes the money reason and discards it',
    file: MODAL,
    find: 'if (moneyReason) return moneyReason;',
    replace: 'void moneyReason;',
    expect: 'availability consults the money verdict FIRST',
  },
  {
    id: 'M4',
    defect: 'manual Apply stops gating on availability',
    file: MODAL,
    find: 'if (isBackendUnavailableRate(r, order, currentRateShippingOptions)) return;',
    replace: 'void isBackendUnavailableRate(r, order, currentRateShippingOptions);',
    expect: 'every emitting path gates on that one boundary',
  },
  {
    id: 'M4b',
    defect: 'auto-best emission stops gating on availability',
    file: MODAL,
    find: 'if (isBackendUnavailableRate(r, order, currentRateShippingOptions)) return null;',
    replace: 'void isBackendUnavailableRate(r, order, currentRateShippingOptions);',
    expect: 'every emitting path gates on that one boundary',
  },
  {
    id: 'M4c',
    defect: 'the gate stops delegating to the reason owner that reads the verdict',
    file: MODAL,
    find: 'return rateBlockedReason(rate, order, shippingOptions) != null;',
    replace: 'return false;',
    expect: 'the availability boundary is the one the gate calls',
  },
  {
    id: 'M5',
    defect: 'the persisted seed accepts incomplete money',
    file: MODAL,
    find: 'if (!rateMoneyIsComplete(bestRate)) return null;',
    replace: 'void rateMoneyIsComplete(bestRate);',
    expect: 'the seed refuses incomplete money before building a row',
  },
  {
    id: 'M6',
    defect: 'a TOTAL is accepted as the shipment COMPONENT (the headline defect)',
    file: CLASSIFIER,
    find: "const SHIPMENT_COST_KEYS = ['shipmentCost', 'shipment_cost'] as const;",
    replace: "const SHIPMENT_COST_KEYS = ['shipmentCost', 'shipment_cost', 'amount'] as const;",
    expect: '`amount` alone NEVER satisfies the shipment component',
  },
  {
    id: 'M7',
    defect: 'a total contradicting its components is no longer surfaced',
    file: CLASSIFIER,
    find: "return fail(shipmentCost, otherCost, 'total_contradicts_components');",
    replace: '/* contradiction ignored */',
    expect: 'a DOCUMENTED total contradicting its components fails closed',
  },
  {
    id: 'M9',
    defect: 'the classifier cannot read provider payloads again (the browse outage)',
    file: CLASSIFIER,
    find: 'const structured = readMoneyObject(rate, raw, STRUCTURED_SHIPMENT_KEY);',
    replace: 'const structured = null;',
    expect: 'shipping_amount.amount is the shipment component',
  },
  {
    id: 'M10',
    defect: 'a structured add-on stops being summed into otherCost',
    file: CLASSIFIER,
    find: "const STRUCTURED_OTHER_KEYS = ['other_amount', 'confirmation_amount', 'insurance_amount'] as const;",
    replace: "const STRUCTURED_OTHER_KEYS = ['other_amount', 'confirmation_amount'] as const;",
    expect: 'the structured add-ons are summed',
  },
  {
    id: 'M11',
    defect: 'a bare `amount` is treated as a documented total again',
    file: CLASSIFIER,
    find: "const TOTAL_KEYS = ['totalCost', 'total_cost', 'selectedRateCost', 'selected_rate_cost'] as const;",
    replace: "const TOTAL_KEYS = ['totalCost', 'total_cost', 'selectedRateCost', 'selected_rate_cost', 'amount'] as const;",
    expect: 'a bare `amount` is NOT read as a total',
  },
  {
    id: 'M12',
    defect: 'the no-add-ons concession leaks out of the provider convention into flat rows',
    file: CLASSIFIER,
    find: 'if (!shipmentIsStructured) return ABSENT;',
    replace: 'void shipmentIsStructured;',
    // Owned by the ORIGINAL absent-is-not-zero check, not by the newer
    // flat-row check that restates it. The matrix rejected the newer one as the
    // expected owner, which is the correct answer: the older check is the one
    // that has always held this line.
    expect: 'absent otherCost is ABSENT, never zero',
  },
  {
    id: 'M14',
    defect: 'the verdict is redacted away, blocking restricted viewers only',
    file: REDACTION,
    find: "  'houseMargin',",
    replace: "  'houseMargin',\n  'rateMoneyComplete',",
    expect: 'the verdict survives money redaction',
  },
  {
    id: 'M13',
    defect: 'a negative add-on line is netted away by a positive sibling',
    file: CLASSIFIER,
    find: 'if (field.value! < 0) return field;',
    replace: 'void field.value;',
    expect: 'an unparseable or negative provider component is refused',
  },
  {
    id: 'M8',
    defect: 'absent add-ons silently become $0.00 again',
    file: CLASSIFIER,
    find: "return fail(shipmentCost, otherCost, 'other_cost_absent');",
    replace: 'otherCost.value = 0;',
    expect: 'absent otherCost is ABSENT, never zero',
  },
];

process.exit(runMutationMatrix({
  title: 'PS-500 mutation matrix',
  guard: GUARD,
  mutations: MUTATIONS,
}));
