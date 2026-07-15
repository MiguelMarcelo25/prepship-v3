/**
 * PS-135(b)/PS-433 rate eligibility source-of-truth guard.
 *
 * Offline source inspection only. Policy A is the backend-shared service
 * eligibility evaluator. Policy B is the backend rate block list. React reads
 * backend DTO verdicts and owns no independent block-list module.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isProviderAccountBlocked } from '../src/lib/rate-block-list.js';

const owner = readFileSync('src/lib/rate-block-list.ts', 'utf8');
const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
const eligibilitySrc = readFileSync('src/lib/shipping-service-eligibility.ts', 'utf8');
const rateBrowserSrc = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function extractSetTokens(src: string, constName: string): string[] | null {
  const match = src.match(new RegExp(`${constName}\\s*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!match) return null;
  const tokens: string[] = [];
  const tokenPattern = /'([^']*)'|"([^"]*)"|\b(\d+)\b/g;
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(match[1]!)) !== null) tokens.push(token[1] ?? token[2] ?? token[3]!);
  return tokens.sort();
}

function sortedEq(actual: string[] | null, expected: string[]): boolean {
  return actual != null && JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

check('Policy B service codes are pinned', sortedEq(
  extractSetTokens(owner, 'BLOCKED_SERVICE_CODES'),
  ['usps_media_mail', 'usps_first_class_mail', 'usps_library_mail', 'usps_parcel_select', 'usps_parcel_select_lightweight'],
));
check('Policy B package types are pinned', sortedEq(
  extractSetTokens(owner, 'BLOCKED_PACKAGE_TYPES'),
  ['flat_rate_envelope', 'flat_rate_legal_envelope', 'flat_rate_padded_envelope', 'small_flat_rate_box',
    'medium_flat_rate_box', 'large_flat_rate_box', 'regional_rate_box_a', 'regional_rate_box_b'],
));
check('Policy B provider ids are pinned', sortedEq(
  extractSetTokens(owner, 'BLOCKED_CARRIER_IDS'),
  ['442017', '566344', '593739'],
));
check('Media Mail store exception is pinned', sortedEq(
  extractSetTokens(owner, 'MEDIA_MAIL_ALLOWED_STORES'),
  ['376759'],
));
check('backend imports the canonical Policy B owner', /from '\.\.\/lib\/rate-block-list'/.test(ratesSrc));
check('backend applies provider-account and service/package Policy B rules',
  /isProviderAccountBlocked\(rate\.carrier_id\)/.test(ratesSrc) &&
  /isServiceOrPackageBlocked\(rate\.service_code, rate\.package_type, rate\.service_type\)/.test(ratesSrc));
check('provider-account owner blocks configured ShipStation ids only',
  isProviderAccountBlocked('se-442017') &&
  isProviderAccountBlocked('SE-593739') &&
  !isProviderAccountBlocked('se-100') &&
  !isProviderAccountBlocked('direct-442017'));
check('backend does not redeclare Policy B sets',
  !/(?:export\s+)?const BLOCKED_(?:SERVICE_CODES|PACKAGE_TYPES|CARRIER_IDS)\s*=\s*new Set/.test(ratesSrc));
check('obsolete frontend markup/eligibility authority is deleted', !existsSync('web/src/utils/markups.ts'));
check('Rate Browser reads backend eligibility stamps without importing the evaluator',
  /eligibilityBlocked/.test(rateBrowserSrc) &&
  /eligibilityBlockReason/.test(rateBrowserSrc) &&
  !/evaluateShippingServiceEligibility\(/.test(rateBrowserSrc));
check('HUGRAB Policy A remains single-owned',
  /HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(eligibilitySrc) &&
  !/HUGRAB_BLOCKED_SERVICE_CODES\s*=\s*new Set/.test(rateBrowserSrc));

if (failures > 0) {
  console.error(`\nFAIL PS-135(b) eligibility source-of-truth guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-135(b) eligibility source-of-truth guard');
