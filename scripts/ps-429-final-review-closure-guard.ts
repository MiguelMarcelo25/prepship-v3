/**
 * PS-429 guard-of-the-guard for exact-SHA Final Review closure packets.
 *
 * Offline/static only. This reads repository files and never imports product
 * runtime, opens a database, calls providers, or mutates any order/label data.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

function includesAll(name: string, text: string, required: readonly string[]): void {
  const missing = required.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const scripts = packageJson.scripts ?? {};
const validator = read('scripts/final-review-closure.mjs');
const fixtures = read('scripts/final-review-closure-fixtures.mjs');
const schema = read('docs/final-review/evidence-packet.schema.json');
const docs = read('docs/final-review/README.md');
const ci = read('.github/workflows/ci.yml');
const prTemplate = read('.github/pull_request_template.md');
const contributing = read('CONTRIBUTING.md');
const architecture = read('ARCHITECTURE.md');
const sotPack = read('scripts/sot-guard-pack.mjs');

check('package wires the canonical closure command',
  scripts['test:final-review-closure'] === 'node scripts/final-review-closure-fixtures.mjs');
check('package wires the PS-429 guard-of-the-guard',
  scripts['test:ps-429-final-review-closure'] === 'tsx scripts/ps-429-final-review-closure-guard.ts');

includesAll('validator owns every evidence classification', validator, [
  "'static'", "'unit'", "'integration'", "'adversarial'", "'failure-injection'", "'e2e'", "'live'",
]);
includesAll('validator owns every risk profile', validator, [
  'auth_scope',
  'rate_label',
  'provider_durable_job',
  'billing_inventory_lifecycle',
  'timing_live',
  'governance',
]);
includesAll('validator enforces exact SHA and score-cap outcomes', validator, [
  'SHA_MISMATCH',
  'TARGET_BRANCH_MISMATCH',
  'SHA_DRIFT_AFTER_REVIEW',
  'UNRESOLVED_SOT_BYPASS',
  'REQUIRED_EVIDENCE_CLASS_MISSING',
  'RISK_ASSERTION_MISSING',
  'FALSE_GREEN_SCORE_CLAIM',
  'scoreCap === 74',
  'scoreCap > 90',
]);
check('static evidence cannot provide behavioral assertions',
  /classification !== 'static'[\s\S]*flatMap\(\(entry\) => entry\.assertions\)/.test(validator));
check('repository validation permits only packet files after the reviewed SHA',
  validator.includes("startsWith('docs/final-review/packets/')"));
check('validator imports no product runtime or network/database client',
  !/(from ['"]\.\.\/src|fetch\(|axios|drizzle|pg-boss|shipstation|easypost|walmart|ebay)/i.test(validator));

includesAll('fixtures cover false-green, stale-SHA, caps, live block, and all profiles', fixtures, [
  'complete-all-risk-profiles',
  'PS-333-static-only-auth-scope',
  'PS-350-static-only-provider-job',
  'PS-351-static-only-provider-job',
  'stale-sha',
  'wrong-target-branch',
  'source-of-truth-bypass',
  'unmet-high-acceptance',
  'complete-score-not-above-90',
  'explicit-live-unverified-block',
]);

includesAll('v1 schema carries required closure fields', schema, [
  'reviewedSha',
  'riskDomains',
  'acceptanceCriteria',
  'canonicalOwners',
  'oldOwners',
  'wrappers',
  'artifactPaths',
  'migrations',
  'rollback',
  'liveVerification',
  'caveats',
]);

includesAll('CI fetches exact history and validates changed packets', ci, [
  'fetch-depth: 0',
  'FINAL_REVIEW_CHANGED_SINCE',
  'FINAL_REVIEW_TARGET_BRANCH',
  'npm run test:final-review-closure',
]);
includesAll('Final Review docs define exact-SHA workflow and score caps', docs, [
  'target.reviewedSha',
  'scoreCap=0',
  'caps the review at 74',
  'caps the review at 88',
  'Hermes green',
]);
includesAll('PR template links packet, exact SHA, and canonical command', prTemplate, [
  'Final Review closure packet',
  'Exact reviewed SHA',
  'npm run test:final-review-closure',
]);
includesAll('contributor docs require exact-SHA closure evidence', contributing, [
  'docs/final-review/README.md',
  'npm run test:final-review-closure',
]);
includesAll('architecture docs name the closure validator as process source of truth', architecture, [
  'scripts/final-review-closure.mjs',
  'exact reviewed SHA',
  'Final Review closure',
]);
check('mandatory SOT pack keeps the PS-429 wiring guard',
  sotPack.includes('test:ps-429-final-review-closure'));

if (failures > 0) {
  console.error(`\nPS-429 Final Review closure guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-429 Final Review closure guard passed.');
