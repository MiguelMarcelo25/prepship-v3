/**
 * PS-293 (slice 2) — ONE canonical owner stamps the SHIPP house tuple for BOTH rating paths.
 *
 * THE GAP: /rates/browse stamped nextBestNonHouseRate/houseMargin inline, but the rates-backfill job
 * (Recalculate All + the PS-293 Awaiting passive-overflow handoff) had NO house-tuple logic at all —
 * so a HUGRAB house order rated by the backend backfill got a tuple-LESS best rate while the same order
 * via Rate Browser got the tuple ("two competing rate truths"). Slice 1's overflow handoff was hollow
 * for HUGRAB house orders until this lands.
 *
 * THE FIX: extract the stamp into src/services/shipping-workflow/house-tuple-stamp.ts (stampHouseTuple)
 * and have BOTH rates.ts and rates-backfill.ts call it. Default-OFF inert (non-SHIPP winner / non-
 * opted-in client => best rate unchanged), so it's byte-identical until a client opts into the house account.
 *
 *   npx tsx scripts/ps-293-canonical-house-tuple-guard.ts
 */
import { readFileSync } from 'node:fs';
import { stampHouseTuple } from '../src/services/shipping-workflow/house-tuple-stamp';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

async function main() {
  // ── behavioral: the inert paths (no DB, no stamp) ───────────────────────────
  {
    // A non-SHIPP winner is returned UNCHANGED (same reference) — the isHouseShippRate gate is sync and
    // returns before any clientHouseAccountEnabled DB read, so this runs offline.
    const best = { carrierCode: 'usps', amount: 9.64 };
    const out = await stampHouseTuple(best, {
      cheapest: { provider: 'usps', carrier_code: 'usps' } as never,
      combinedRates: [],
      clientId: 1,
      storeId: null,
    });
    check('non-SHIPP winner => best rate returned UNCHANGED (inert, no stamp)',
      out === best && !('nextBestNonHouseRate' in out));
  }

  // ── static: ONE owner, BOTH call sites ──────────────────────────────────────
  const owner = readFileSync('src/services/shipping-workflow/house-tuple-stamp.ts', 'utf8');
  check('the shared owner exists and resolves the tuple via the canonical resolver + policy gate',
    /export async function stampHouseTuple\(/.test(owner) &&
    /resolveNextBestNonHouseRate\(/.test(owner) &&
    /shippingMarginPolicyForClient\(/.test(owner) &&
    !/isInternalHouseRate\(/.test(owner));

  // Repointed (guard rot): /rates/browse was extracted from src/routes/rates.ts into
  // src/services/rate-browse-response-producer.ts — the producer now owns the browse-side
  // stampHouseTuple call; the route stays a thin delegate to produceRateBrowsePayload.
  const browseProducer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
  check('rate-browse producer (/rates/browse) delegates to the shared stampHouseTuple owner',
    /import \{ stampHouseTuple \}/.test(browseProducer) && /await stampHouseTuple\(/.test(browseProducer));
  const rates = readFileSync('src/routes/rates.ts', 'utf8');
  check('neither producer nor route inlines the resolver/opt-in (single owner, no duplicate logic)',
    !/resolveNextBestNonHouseRate\(/.test(browseProducer) && !/clientHouseAccountEnabled\(/.test(browseProducer) &&
    !/resolveNextBestNonHouseRate\(/.test(rates) && !/clientHouseAccountEnabled\(/.test(rates));
  check('routes/rates.ts stays thin (browse delegates to produceRateBrowsePayload)',
    /produceRateBrowsePayload/.test(rates));

  const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
  check('rates-backfill delegates to the SAME stampHouseTuple owner',
    /import \{ stampHouseTuple \}/.test(backfill) && /await stampHouseTuple\(/.test(backfill));
  check('rates-backfill PERSISTS the stamped best (bestRateJson: stampedBest), not the un-stamped one',
    /const stampedBest = await stampHouseTuple\(/.test(backfill) &&
    /bestRateJson:\s*stampedBest(?:\s+as\s+unknown)?/.test(backfill) &&
    !/bestRateJson: bestWithMetadata as unknown/.test(backfill));

  if (failures > 0) {
    console.error(`\nFAIL PS-293 canonical house-tuple guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-293 canonical house-tuple guard');
}

void main();
