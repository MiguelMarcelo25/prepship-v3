/**
 * PS-271 (Layer 4) — thin-source completeness HONESTY guard.
 *
 * Proves the accepted-thin signal flows end-to-end through the REAL pure owners, and that the OFF path
 * is byte-identical to today:
 *
 *   1. The thin marker rides NON-ENUMERABLY on a rate array (attach/read round-trips) and is INVISIBLE
 *      to a plain consumer: JSON.stringify, spread, Object.keys, .length, .map are unchanged. With an
 *      EMPTY missing-set the array is returned untouched (no marker) — the flag-OFF Shipp path.
 *   2. isBestRateComplete (the PS-111 canonical owner) treats a THIN carrier as NOT-complete, exactly
 *      like loading/error — while a complete UPS+FedEx set stays complete.
 *   3. combineCarrierUniverses (the combined best-rate owner) propagates the thin diagnostic onto the
 *      carrier status, makes the selection NOT complete, and tags the cheapest as bestRateThin when the
 *      winner came from the thin pass — but a full pass yields bestRateComplete=true, bestRateThin=false.
 *   4. Marker OFF when the flag is OFF: a non-thin direct diagnostic produces NO thin status, a complete
 *      selection, and bestRateThin=false (today's behavior, unchanged).
 *
 * Pure: no DB, no network, no provider calls, no postage. Imports the real modules.
 *
 *   npx tsx scripts/ps-271-completeness-honesty-guard.ts
 */
import {
  attachObservedIncomplete,
  readObservedIncomplete,
} from '../src/connectors/carrier/shipp-observed-incomplete-marker';
import {
  isBestRateComplete,
  type BestRateWorkflowCarrierStatus,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';
import {
  combineCarrierUniverses,
  type CombinableSsDiagnostic,
} from '../src/services/rates-combined';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1) the non-enumerable marker round-trips and is invisible to plain consumers ──
{
  const rates = [{ carrier_id: 'se-shipp', cost: 11.66 }];
  const before = JSON.stringify(rates);
  const tagged = attachObservedIncomplete(rates, ['ups']);
  check('attach returns the SAME array reference', tagged === rates);
  check('the marker is readable', readObservedIncomplete(tagged)?.observedIncomplete === true);
  check('the marker carries the missing carrier(s)',
    JSON.stringify(readObservedIncomplete(tagged)?.missing) === JSON.stringify(['ups']));
  check('JSON.stringify is byte-identical (marker is non-enumerable)', JSON.stringify(tagged) === before);
  check('Object.keys does not expose the marker',
    !Object.keys(tagged).includes('__ps271ObservedIncomplete'));
  check('spread + length are unchanged', [...tagged].length === 1 && tagged.length === 1);

  // EMPTY missing-set -> no marker attached (the flag-OFF Shipp return path).
  const off = attachObservedIncomplete([{ carrier_id: 'se-shipp', cost: 11.66 }], []);
  check('OFF path: empty missing -> no marker attached', readObservedIncomplete(off) === null);
  check('readObservedIncomplete tolerates a non-array', readObservedIncomplete(null) === null);
}

// ── 2) isBestRateComplete: a THIN carrier is not-complete (like loading/error) ──
{
  const cs = (
    status: BestRateWorkflowCarrierStatus['status'],
    extra: Partial<BestRateWorkflowCarrierStatus> = {},
  ): BestRateWorkflowCarrierStatus => ({ carrierId: `se-${status}`, status, rateCount: 1, ...extra });

  check('complete UPS+FedEx (both live, non-thin) -> complete',
    isBestRateComplete([cs('live', { carrierId: 'se-ups' }), cs('live', { carrierId: 'se-fedex' })]) === true);
  check('a THIN carrier -> NOT complete (terminal but unproven)',
    isBestRateComplete([cs('live', { carrierId: 'se-fedex', thin: true })]) === false);
  check('thin alongside a clean carrier still -> NOT complete',
    isBestRateComplete([cs('live', { carrierId: 'se-ups' }), cs('live', { carrierId: 'se-shipp', thin: true })]) === false);
  check('a still-loading carrier -> NOT complete (unchanged PS-111)',
    isBestRateComplete([cs('loading')]) === false);
}

// ── 3) combineCarrierUniverses: thin diagnostic -> thin status, not-complete, bestRateThin ──
{
  const directThin: CombinableSsDiagnostic = {
    carrierId: 'se-30000001', carrierCode: 'shipp', nickname: 'Shipp', status: 'ok', rateCount: 1, thin: true,
  };
  const combined = combineCarrierUniverses({
    ssRates: [],
    ssCacheKey: 'fp',
    ssCached: false,
    ssDiagnostics: [],
    // The Shipp (thin) pass returned only the dearer FedEx $11.66 (the #1502 shape).
    directRates: [{ carrier_id: 'se-30000001', shipping_amount: { amount: 11.66 } }],
    directDiagnostics: [directThin],
    accountNamesByCarrierId: new Map(),
    accountCarrierIds: [],
    isCachedOnlyLookup: false,
  });
  check('thin direct diagnostic -> direct carrier status flagged thin',
    combined.directCarrierStatuses.some((s) => s.carrierId === 'se-30000001' && s.thin === true));
  check('a best from a thin pass -> selection NOT complete',
    combined.bestRateComplete === false);
  check('a best from a thin pass -> bestRateThin=true',
    combined.bestRateThin === true);
  check('the cheapest is still RETURNED (we never drop a real rate that came back)',
    combined.cheapest != null && Number(combined.cheapest.shipping_amount?.amount) === 11.66);
  // The combined statuses feed the route's isBestRateComplete -> a thin carrier makes it incomplete too.
  check('combinedCarrierStatuses flow the thin signal into isBestRateComplete',
    isBestRateComplete(combined.combinedCarrierStatuses) === false);
}

// ── 4) OFF path: a non-thin direct pass is complete and not thin (today's behavior) ──
{
  const directOk: CombinableSsDiagnostic = {
    carrierId: 'se-30000001', carrierCode: 'shipp', nickname: 'Shipp', status: 'ok', rateCount: 2,
  };
  const combined = combineCarrierUniverses({
    ssRates: [],
    ssCacheKey: 'fp',
    ssCached: false,
    ssDiagnostics: [],
    // A full pass: cheaper UPS $10.14 + FedEx $11.66 both came back.
    directRates: [
      { carrier_id: 'se-30000001', shipping_amount: { amount: 10.14 } },
      { carrier_id: 'se-30000001', shipping_amount: { amount: 11.66 } },
    ],
    directDiagnostics: [directOk],
    accountNamesByCarrierId: new Map(),
    accountCarrierIds: [],
    isCachedOnlyLookup: false,
  });
  check('OFF path: no thin flag on any direct status',
    combined.directCarrierStatuses.every((s) => s.thin !== true));
  check('OFF path: selection is COMPLETE', combined.bestRateComplete === true);
  check('OFF path: bestRateThin=false', combined.bestRateThin === false);
  check('OFF path: the cheapest is UPS $10.14 (the #1502 win)',
    Number(combined.cheapest?.shipping_amount?.amount) === 10.14);
}

if (failures > 0) {
  console.error(`\nFAIL PS-271 completeness honesty guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-271 completeness honesty guard');
