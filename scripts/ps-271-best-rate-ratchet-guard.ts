/**
 * PS-271 — no-downgrade persist ratchet guard (BEHAVIORAL).
 *
 * Imports the REAL pure decision (best-rate-ratchet.ts) and runs the rule against the actual #1502
 * divergence (persisted FedEx $11.66 when UPS $10.14 was available a tick earlier). Also pins the
 * structure: the pure module stays DB-free, the DB wrapper delegates to it, and BOTH automated persist
 * sites (backfill + strict-recalc) route through the wrapper. The operator FE PATCH save is exempt by
 * construction (it is not one of these two sites).
 *
 *   npx tsx scripts/ps-271-best-rate-ratchet-guard.ts
 */
import { readFileSync } from 'node:fs';
import { isNoDowngradeBlocked, comparableRateTotal } from '../src/services/best-rate-ratchet';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const FP = 'wt=31oz|90210|res';
const upsCheap = { shipmentCost: 10.14, otherCost: 0, totalCost: 10.14, requestFingerprint: FP };
const fedexDear = { shipmentCost: 11.66, otherCost: 0, totalCost: 11.66, requestFingerprint: FP };

// ── the #1502 bug: a thin FedEx re-quote must NOT overwrite the cheaper UPS best ──
check('blocks a more-expensive same-fingerprint downgrade (FedEx $11.66 over UPS $10.14)',
  isNoDowngradeBlocked(upsCheap, fedexDear) === true);
check('allows a cheaper incoming (UPS $10.14 replaces FedEx $11.66)',
  isNoDowngradeBlocked(fedexDear, upsCheap) === false);
check('allows an equal-price re-quote (idempotent re-persist)',
  isNoDowngradeBlocked(upsCheap, { ...upsCheap }) === false);

// ── never block when we cannot compare apples-to-apples ──
check('no prior -> allow (cold/first persist)', isNoDowngradeBlocked(null, fedexDear) === false);
check('no incoming -> allow', isNoDowngradeBlocked(upsCheap, null) === false);
check('different fingerprint -> allow (inputs changed, prior is stale)',
  isNoDowngradeBlocked(upsCheap, { ...fedexDear, requestFingerprint: 'wt=48oz|90210|res' }) === false);
check('missing prior fingerprint -> allow',
  isNoDowngradeBlocked({ ...upsCheap, requestFingerprint: null }, fedexDear) === false);
check('missing incoming fingerprint -> allow',
  isNoDowngradeBlocked(upsCheap, { ...fedexDear, requestFingerprint: null }) === false);

// ── sub-cent float noise must not trip the ratchet ──
check('sub-cent more-expensive (EPSILON) -> allow',
  isNoDowngradeBlocked(upsCheap, { ...upsCheap, shipmentCost: 10.142, totalCost: 10.142 }) === false);
check('a clear cent more-expensive -> block',
  isNoDowngradeBlocked(upsCheap, { ...upsCheap, shipmentCost: 10.15, totalCost: 10.15 }) === true);

// ── display-drift carve-out: a COMPLETE higher re-quote is the GENUINE current price and MUST
//    overwrite (the carrier raised it within the cache window); only a THIN/partial higher re-quote
//    (the #1502 Shipp flicker) stays blocked. isComplete is the proven-completeness signal. ──
const upsCheapComplete = { ...upsCheap, isComplete: true as const };
check('allows a COMPLETE more-expensive re-quote (genuine carrier increase overwrites)',
  isNoDowngradeBlocked(upsCheapComplete, { ...fedexDear, isComplete: true }) === false);
check('still blocks a THIN (isComplete:false) more-expensive re-quote (#1502 flicker)',
  isNoDowngradeBlocked(upsCheapComplete, { ...fedexDear, isComplete: false }) === true);
check('treats ABSENT incoming completeness as not-proven (blocks the higher re-quote, as before)',
  isNoDowngradeBlocked(upsCheapComplete, fedexDear) === true);
check('a COMPLETE cheaper re-quote still overwrites',
  isNoDowngradeBlocked({ ...fedexDear, isComplete: false }, upsCheapComplete) === false);

// ── comparableRateTotal: totalCost wins; falls back to shipment+other; null when uncomputable ──
check('comparableRateTotal prefers totalCost',
  comparableRateTotal({ shipmentCost: 5, otherCost: 5, totalCost: 9.99, requestFingerprint: FP }) === 9.99);
check('comparableRateTotal falls back to shipmentCost + otherCost',
  comparableRateTotal({ shipmentCost: 8, otherCost: 1.5, totalCost: null, requestFingerprint: FP }) === 9.5);
check('comparableRateTotal is null when shipmentCost is absent',
  comparableRateTotal({ shipmentCost: null as unknown as number, otherCost: 1, totalCost: null, requestFingerprint: FP }) === null);
// otherCost folds insurance in; an incoming that is cheaper on shipment but dearer total still blocks.
check('compares the TOTAL (shipment + other), not shipment alone',
  isNoDowngradeBlocked(
    { shipmentCost: 10.14, otherCost: 0, totalCost: 10.14, requestFingerprint: FP },
    { shipmentCost: 9.5, otherCost: 2.0, totalCost: 11.5, requestFingerprint: FP },
  ) === true);

// ── structure: pure core stays DB-free; wrapper delegates; both persist sites route through it ──
const pure = readFileSync('src/services/best-rate-ratchet.ts', 'utf8');
check('the pure ratchet module imports no DB client',
  !/from '\.\.?\/db\/client'/.test(pure) && !/db\.select/.test(pure) && !/db\.insert/.test(pure));

const wrapper = readFileSync('src/services/best-rate-ratchet-db.ts', 'utf8');
check('the DB wrapper delegates to the pure isNoDowngradeBlocked',
  /isNoDowngradeBlocked/.test(wrapper) && /from '\.\/best-rate-ratchet'/.test(wrapper));

const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
// PS-293: the persisted/ratcheted object is the house-tuple-STAMPED best
// (stampedBest = bestWithMetadata + the inert house tuple).
check('the backfill persist routes through the ratchet wrapper',
  /isPersistedBestDowngrade\(row\.id, stampedBest\)/.test(backfill));

const recalc = readFileSync('src/services/rates-recalculate-persist.ts', 'utf8');
check('the strict-recalc persist routes through the ratchet wrapper',
  /isPersistedBestDowngrade\(input\.orderId, canonical\)/.test(recalc));

check('package.json wires test:ps-271-best-rate-ratchet',
  /test:ps-271-best-rate-ratchet/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-271 best-rate ratchet guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-271 best-rate ratchet guard');
