/**
 * PS-135(b) — Rate eligibility / block-list source-of-truth guard.
 *
 * Rate eligibility is TWO orthogonal policies:
 *
 *   Policy A — HUGRAB UPS Ground Saver block (client-conditional).
 *     Owner: src/lib/shipping-service-eligibility.ts (evaluateShippingServiceEligibility).
 *     Consumed by BOTH the backend (src/services/rates.ts) AND the FE (RateBrowserModal imports it
 *     directly via ../../../src/lib/...). Single-sourced + shared. ✅
 *
 *   Policy B — USPS-economy / flat-rate block (global).
 *     Owner: src/lib/rate-block-list.ts (PS-135(b)). The constants + the shared service/package/name
 *     predicate (isServiceOrPackageBlocked) used to be DUPLICATED verbatim in src/services/rates.ts
 *     and web/src/utils/markups.ts. They now BOTH import the single owner, so the two can no longer
 *     drift into an FE↔backend mismatch. This guard enforces that structure:
 *       - the canonical owner defines the lists (with their exact, pinned membership), and
 *       - neither rates.ts nor markups.ts re-declares the Sets locally — both import + delegate.
 *     The FE keeps its extra BLOCKED_CARRIER_IDS check + media-mail short-circuit; the backend does
 *     not carrier-id-block. Application scope is unchanged by the consolidation (constants are shared,
 *     enforcement points are not moved).
 *
 * Offline / pure: readFileSync only. No DB, no network, no rate calls.
 */
import { readFileSync } from 'node:fs';

const owner = readFileSync('src/lib/rate-block-list.ts', 'utf8');
const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
const markupsSrc = readFileSync('web/src/utils/markups.ts', 'utf8');
const eligibilitySrc = readFileSync('src/lib/shipping-service-eligibility.ts', 'utf8');
const rateBrowserSrc = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

/** Extract the literal tokens (quoted strings + bare integers) inside `NAME = new Set([...])`. */
function extractSetTokens(src: string, constName: string): string[] | null {
  const re = new RegExp(`${constName}\\s*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = src.match(re);
  if (!m) return null;
  const tokens: string[] = [];
  const tokRe = /'([^']*)'|"([^"]*)"|\b(\d+)\b/g;
  let t: RegExpExecArray | null;
  while ((t = tokRe.exec(m[1])) !== null) tokens.push(t[1] ?? t[2] ?? t[3]);
  return tokens.sort();
}
function sortedEq(a: string[] | null, b: string[]): boolean {
  return a != null && a.length === b.length && JSON.stringify(a) === JSON.stringify([...b].sort());
}

// ── (1) Canonical owner defines Policy B with EXACT pinned membership (no accidental add/drop) ──
check('rate-block-list.ts BLOCKED_SERVICE_CODES = the 5 canonical USPS-economy codes', sortedEq(
  extractSetTokens(owner, 'BLOCKED_SERVICE_CODES'),
  ['usps_media_mail', 'usps_first_class_mail', 'usps_library_mail', 'usps_parcel_select', 'usps_parcel_select_lightweight']));
check('rate-block-list.ts BLOCKED_PACKAGE_TYPES = the 8 canonical flat/regional types', sortedEq(
  extractSetTokens(owner, 'BLOCKED_PACKAGE_TYPES'),
  ['flat_rate_envelope', 'flat_rate_legal_envelope', 'flat_rate_padded_envelope', 'small_flat_rate_box',
    'medium_flat_rate_box', 'large_flat_rate_box', 'regional_rate_box_a', 'regional_rate_box_b']));
check('rate-block-list.ts BLOCKED_CARRIER_IDS = the 3 FE-applied carrier ids', sortedEq(
  extractSetTokens(owner, 'BLOCKED_CARRIER_IDS'), ['442017', '566344', '593739']));
check('rate-block-list.ts MEDIA_MAIL_ALLOWED_STORES = [376759]', sortedEq(
  extractSetTokens(owner, 'MEDIA_MAIL_ALLOWED_STORES'), ['376759']));
check('rate-block-list.ts exports the shared predicate isServiceOrPackageBlocked + BLOCKED_NAME_RE',
  /export function isServiceOrPackageBlocked\(/.test(owner) && /export const BLOCKED_NAME_RE\s*=/.test(owner));

// ── (2) Backend (rates.ts) imports the owner + delegates; does NOT re-declare the Sets locally ──
check('rates.ts imports the canonical owner', /from '\.\.\/lib\/rate-block-list'/.test(ratesSrc));
check('rates.ts does NOT re-declare any Policy-B Set locally (single source of truth)',
  !/(?:export\s+)?const BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(ratesSrc) &&
  !/(?:export\s+)?const BLOCKED_PACKAGE_TYPES\s*=\s*new Set/.test(ratesSrc) &&
  !/(?:export\s+)?const BLOCKED_CARRIER_IDS\s*=\s*new Set/.test(ratesSrc));
check('rates.ts isBlockedRate delegates to the shared predicate',
  /return isServiceOrPackageBlocked\(rate\.service_code, rate\.package_type, rate\.service_type\)/.test(ratesSrc));

// ── (3) FE (markups.ts) imports the owner + delegates; keeps its carrier check; no local Sets ──
check('markups.ts imports the canonical owner', /from '\.\.\/\.\.\/\.\.\/src\/lib\/rate-block-list'/.test(markupsSrc));
check('markups.ts does NOT re-declare any Policy-B Set locally',
  !/(?:export\s+)?const BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(markupsSrc) &&
  !/(?:export\s+)?const BLOCKED_PACKAGE_TYPES\s*=\s*new Set/.test(markupsSrc) &&
  !/(?:export\s+)?const BLOCKED_CARRIER_IDS\s*=\s*new Set/.test(markupsSrc));
check('markups.ts isBlockedRate keeps the FE carrier-id check AND delegates the rest',
  /BLOCKED_CARRIER_IDS\.has\(rate\.shippingProviderId \?\? -1\)\s*\|\|\s*\n?\s*isServiceOrPackageBlocked\(rate\.serviceCode, rate\.packageType, rate\.serviceName\)/.test(markupsSrc));

// ── (4) Policy A stays shared — FE imports the canonical lib, never re-hardcodes the HUGRAB set ──
check('FE RateBrowserModal imports evaluateShippingServiceEligibility from the canonical shared lib',
  /from '\.\.\/\.\.\/\.\.\/src\/lib\/shipping-service-eligibility'/.test(rateBrowserSrc) &&
  /evaluateShippingServiceEligibility/.test(rateBrowserSrc));
check('HUGRAB_BLOCKED_SERVICE_CODES lives ONLY in shipping-service-eligibility.ts (not re-hardcoded)',
  /HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(eligibilitySrc) &&
  !/HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(markupsSrc) &&
  !/HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(rateBrowserSrc));

if (failures > 0) {
  console.error(`\nFAIL PS-135(b) eligibility source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-135(b) eligibility source-of-truth guard (Policy B single-sourced; Policy A shared)');
