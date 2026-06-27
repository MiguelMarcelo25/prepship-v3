import { readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PS-340 Rate Browser bridge audit failed: ${message}`);
  }
}

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

assert(modal.includes('decideBestRateEmission'), 'Rate Browser must use backend canonical best emission gate');
assert(
  modal.includes('No backend canonical best for the eligible set'),
  'Rate Browser must surface unresolved state instead of emitting local cheapest',
);
assert(
  modal.includes('do not fabricate/persist a FE-ranked'),
  'Rate Browser must document that absent backend canonical best is not replaced by FE-ranked cheapest',
);
assert(
  !/emitBestRateResolved\(\s*(?:available|ratesToRank|liveFetchedRates)\.sort/s.test(modal),
  'Rate Browser must not emit a locally sorted cheapest rate',
);
assert(
  modal.includes('sortRateRowsByBackendDisplayRank'),
  'Visible row sorting must stay named as backend-display-rank sorting',
);
assert(
  /const seededBestRate = testMode[\s\S]{0,240}\.sort\(\(a, b\) => a\.shipmentCost \+ a\.otherCost - \(b\.shipmentCost \+ b\.otherCost\)\)\[0\]/.test(
    modal,
  ),
  'seeded local sort must remain testMode-only',
);
assert(
  modal.includes('manual estimate') && modal.includes('not label-safe'),
  'manual estimates must remain visibly not label-safe',
);

console.log('PS-340 Rate Browser bridge audit guard passed');
