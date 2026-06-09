/**
 * PS-135(b) — Rate eligibility / block-list fragmentation guard.
 *
 * Context (verified read-only, 2026-06-09): rate eligibility lives in TWO orthogonal policies.
 *
 *   Policy A — HUGRAB UPS Ground Saver block (client-conditional).
 *     Owner: src/lib/shipping-service-eligibility.ts (evaluateShippingServiceEligibility).
 *     Consumed by BOTH the backend (src/services/rates.ts) AND the FE (RateBrowserModal.tsx
 *     imports it directly via ../../../src/lib/...). ALREADY single-sourced + shared. ✅
 *
 *   Policy B — USPS-economy / flat-rate block (global).
 *     DUPLICATED verbatim across src/services/rates.ts (applied server-side, the authority) and
 *     web/src/utils/markups.ts (FE twin, consumed by rates-parity.ts). The 5 service codes, 8
 *     package types, and the media-mail-allowed store agree TODAY — so no live bug — but two
 *     copies can silently drift into a real FE↔backend mismatch (the FE would hide/show a rate the
 *     backend kept/dropped). PS-135(b) will collapse Policy B into one shared module (mirroring
 *     Policy A). Until that lands, this guard PINS the two copies to stay identical so they CANNOT
 *     drift. It is the interim "source-of-truth" boundary test per ARCHITECTURE.md.
 *
 * This guard does NOT consolidate anything — it freezes the current (correct, identical) state so a
 * future one-sided edit fails CI instead of shipping a divergence. It also asserts Policy A stays
 * shared (the FE must keep importing the canonical lib, never re-hardcode the HUGRAB rules).
 *
 * Offline / pure: readFileSync only. No DB, no network, no rate calls.
 */
import { readFileSync } from 'node:fs';

const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
const markupsSrc = readFileSync('web/src/utils/markups.ts', 'utf8');
const eligibilitySrc = readFileSync('src/lib/shipping-service-eligibility.ts', 'utf8');
const rateBrowserSrc = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

/** Extract the literal tokens (quoted strings + bare integers) inside `const NAME = new Set([...])`. */
function extractSetTokens(src: string, constName: string): string[] | null {
  const re = new RegExp(`${constName}\\s*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = src.match(re);
  if (!m) return null;
  const body = m[1];
  const tokens: string[] = [];
  const tokRe = /'([^']*)'|"([^"]*)"|\b(\d+)\b/g;
  let t: RegExpExecArray | null;
  while ((t = tokRe.exec(body)) !== null) tokens.push(t[1] ?? t[2] ?? t[3]);
  return tokens.sort();
}

function sameSet(a: string[] | null, b: string[] | null): boolean {
  return a != null && b != null && a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

// ── Policy B: the duplicated USPS/flat-rate block list MUST stay identical (backend ↔ FE) ──
const svcBackend = extractSetTokens(ratesSrc, 'BLOCKED_SERVICE_CODES');
const svcFe = extractSetTokens(markupsSrc, 'BLOCKED_SERVICE_CODES');
check('BLOCKED_SERVICE_CODES present in BOTH rates.ts and markups.ts', svcBackend != null && svcFe != null);
check('BLOCKED_SERVICE_CODES identical (backend == FE) — no drift', sameSet(svcBackend, svcFe),
  `backend=${JSON.stringify(svcBackend)} fe=${JSON.stringify(svcFe)}`);

const pkgBackend = extractSetTokens(ratesSrc, 'BLOCKED_PACKAGE_TYPES');
const pkgFe = extractSetTokens(markupsSrc, 'BLOCKED_PACKAGE_TYPES');
check('BLOCKED_PACKAGE_TYPES present in BOTH', pkgBackend != null && pkgFe != null);
check('BLOCKED_PACKAGE_TYPES identical (backend == FE) — no drift', sameSet(pkgBackend, pkgFe),
  `backend=${JSON.stringify(pkgBackend)} fe=${JSON.stringify(pkgFe)}`);

const storeBackend = extractSetTokens(ratesSrc, 'MEDIA_MAIL_ALLOWED_STORES');
const storeFe = extractSetTokens(markupsSrc, 'MEDIA_MAIL_ALLOWED_STORES');
check('MEDIA_MAIL_ALLOWED_STORES present in BOTH', storeBackend != null && storeFe != null);
check('MEDIA_MAIL_ALLOWED_STORES identical (backend == FE) — no drift', sameSet(storeBackend, storeFe),
  `backend=${JSON.stringify(storeBackend)} fe=${JSON.stringify(storeFe)}`);

// The flat-rate/box name regex differs only by a REDUNDANT alternative (rates.ts has an extra
// `|flat rate` already covered by `flat[\s-]?rate`). Pin the meaningful alternatives in both so a
// real change to the matcher on one side is caught.
check('flat-rate/box name regex meaningful alternatives present in BOTH (rates.ts + markups.ts)',
  /flat\[\\s-\]\?rate/.test(ratesSrc) && /\\bbox\\b/.test(ratesSrc) &&
  /flat\[\\s-\]\?rate/.test(markupsSrc) && /\\bbox\\b/.test(markupsSrc));

// ── Documented FE-only divergence: BLOCKED_CARRIER_IDS (Amazon/Sendle) has NO backend twin. ──
// This is a known belt-and-suspenders FE guard (consumed only by rates-parity.ts). Pin its presence
// on the FE so PS-135(b) explicitly decides where it belongs; flag if a backend twin later appears
// out-of-band (then the two must be reconciled, not left as separate copies).
const carrierFe = extractSetTokens(markupsSrc, 'BLOCKED_CARRIER_IDS');
check('BLOCKED_CARRIER_IDS is FE-only today (markups.ts has it; rates.ts has no twin Set)',
  carrierFe != null && !/export const BLOCKED_CARRIER_IDS/.test(ratesSrc));

// ── Policy A: HUGRAB eligibility stays SHARED — FE must import the canonical lib, not re-hardcode ──
check('FE RateBrowserModal imports evaluateShippingServiceEligibility from the canonical shared lib',
  /from '\.\.\/\.\.\/\.\.\/src\/lib\/shipping-service-eligibility'/.test(rateBrowserSrc) &&
  /evaluateShippingServiceEligibility/.test(rateBrowserSrc));
check('HUGRAB_BLOCKED_SERVICE_CODES lives ONLY in the shared lib (not re-hardcoded in the FE)',
  /HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(eligibilitySrc) &&
  !/HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(markupsSrc) &&
  !/HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(rateBrowserSrc));

console.log('\n--- PS-135(b) fragmentation snapshot (informational) ---');
console.log(`Policy B BLOCKED_SERVICE_CODES (shared by drift-pin): ${JSON.stringify(svcBackend)}`);
console.log(`Policy B BLOCKED_PACKAGE_TYPES: ${JSON.stringify(pkgBackend)}`);
console.log(`FE-only BLOCKED_CARRIER_IDS (Amazon/Sendle, no backend twin): ${JSON.stringify(carrierFe)}`);
console.log('TODO PS-135(b): extract Policy B into one shared module (like Policy A) + decide BLOCKED_CARRIER_IDS home.');

if (failures > 0) {
  console.error(`\nFAIL PS-135(b) eligibility-fragmentation guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-135(b) eligibility-fragmentation guard');
