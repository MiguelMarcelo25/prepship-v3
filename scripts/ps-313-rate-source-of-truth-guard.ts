/**
 * PS-313 guard - Rate source-of-truth lockdown.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, and no production data mutation. This guard pins
 * the rate owner docs, CI/package wiring, and static boundaries that prevent a
 * frontend, route, or wrapper from becoming an official Best Rate selector.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

type ForbiddenRateAuthorityPattern = {
  id: string;
  description: string;
  pattern: RegExp;
  allowedFiles?: string[];
};

const FORBIDDEN_RATE_AUTHORITY_PATTERNS: ForbiddenRateAuthorityPattern[] = [
  {
    id: 'combined_index_best_rate',
    description: 'A wrapper derives official bestRate from combined[0] instead of backend authority.',
    pattern: /(?:bestRate\s*=\s*)?combined\s*\[\s*0\s*\]|combinedBestRate/,
  },
  {
    id: 'local_rank_rates_helper',
    description: 'A non-owner rankRates helper can become a second Best Rate selector.',
    pattern: /\brankRates\s*\(/,
  },
  {
    id: 'route_or_frontend_pick_best_rate',
    description: 'Frontend/routes must not call pickBestRate directly; they consume backend DTOs.',
    pattern: /\bpickBestRate\s*\(/,
  },
  {
    id: 'rates_sort_zero_cheapest',
    description: 'A non-owner cheapest = rates.sort(...)[0] pattern is a hidden selector.',
    pattern: /\bcheapest\s*=\s*rates\s*\.sort\s*\([\s\S]{0,180}?\)\s*\[\s*0\s*\]/,
  },
  {
    id: 'object_define_best_rate',
    description: 'Object.defineProperty(..., bestRate) can mint wrapper authority unless it passes through a backend bestRate.',
    pattern: /Object\.defineProperty\([\s\S]{0,180}?['"]bestRate['"]/,
    allowedFiles: ['web/src/lib/v2-apiClient.ts'],
  },
  {
    id: 'frontend_proof_minting',
    description: 'Frontend must never mint selected-rate proof or request fingerprints.',
    pattern: /\b(?:buildShippingRateRequestFingerprint|selectedRateAuthorityKey|createHash)\s*\(/,
  },
];

type Violation = { class: string; file: string };

function scanForbiddenRateAuthority(
  files: { path: string; content: string }[],
  patterns: ForbiddenRateAuthorityPattern[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const normalized = file.path.split(sep).join('/');
    const code = stripComments(file.content);
    for (const entry of patterns) {
      if (entry.allowedFiles?.includes(normalized)) continue;
      if (entry.pattern.test(code)) {
        violations.push({ class: entry.id, file: normalized });
      }
    }
  }
  return violations;
}

const packageJson = read('package.json');
const architecture = read('ARCHITECTURE.md');
const agents = read('AGENTS.md');
const claude = read('CLAUDE.md');
const cursorRules = read('.cursorrules');
const prTemplate = read('.github/pull_request_template.md');
const ciWorkflow = read('.github/workflows/ci.yml');

const rateLockdownRules = [
  'Rate Source-of-Truth Lockdown',
  'Best Rate ranking happens only in the backend canonical rate authority',
  'Rate Browser and Awaiting Shipment Best Rate must consume the same backend-selected best rate',
  'Markups, confirmation, insurance, and other carrier amounts are applied before ranking',
  'Frontend sorting is display-only and cannot declare or persist official bestRate',
  'Frontend cannot mint selected-rate proof',
  'Billing and Shipped views display selected/purchased shipment rate truth, not current Best Rate',
  'test:rate-source-of-truth',
];

checkIncludesAll('AGENTS.md documents PS-313 Rate Source-of-Truth Lockdown', agents, rateLockdownRules);
checkIncludesAll('CLAUDE.md mirror documents PS-313 Rate Source-of-Truth Lockdown', claude, rateLockdownRules);
checkIncludesAll('.cursorrules mirror documents PS-313 Rate Source-of-Truth Lockdown', cursorRules, rateLockdownRules);

checkIncludesAll('ARCHITECTURE.md names the backend rate authority cluster and PS-313 guard', architecture, [
  ...rateLockdownRules,
  'src/services/rates-combined.ts#combineCarrierUniverses',
  'src/services/rates.ts#pickBestRate',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/shipping-workflow/rate-fingerprint.ts',
]);

checkIncludesAll('PR template requires rate source-of-truth proof for rate work', prTemplate, [
  'Rate Source-of-Truth proof',
  'test:rate-source-of-truth',
  'backend canonical rate authority',
  'selected/purchased shipment rate truth',
]);

check('package wires test:rate-source-of-truth to the PS-313 guard',
  /"test:rate-source-of-truth"\s*:\s*"tsx scripts\/ps-313-rate-source-of-truth-guard\.ts"/.test(packageJson));
check('CI runs test:rate-source-of-truth before typecheck/build',
  (() => {
    const guardIndex = ciWorkflow.indexOf('npm run test:rate-source-of-truth');
    const typecheckIndex = ciWorkflow.indexOf('npm run typecheck');
    const buildIndex = ciWorkflow.indexOf('npm run build:web');
    return guardIndex >= 0 && typecheckIndex > guardIndex && buildIndex > typecheckIndex;
  })());

const ratesCombined = read('src/services/rates-combined.ts');
checkPatterns('rates-combined owns combined-universe Best Rate selection on customer charge', ratesCombined, [
  /export function combineCarrierUniverses/,
  /export function rateTotal/,
  /customerShippingAmount/,
  /confirmation_amount/,
  /insurance_amount/,
  /other_amount/,
  /\.filter\(isPricedRate\)\.sort\(\(a, b\) => rateTotal\(a\) - rateTotal\(b\)\)/,
  /const cheapest = rankedEligibleRates\[0\] \?\? null/,
]);
check('rates-combined exposes completeness diagnostics with the selected best rate',
  ratesCombined.includes('bestRateComplete: statusesComplete(combinedCarrierStatuses)') &&
  ratesCombined.includes('combinedCarrierDiagnostics'));

const ratesService = read('src/services/rates.ts');
checkPatterns('rates.ts provider-level selector applies markup before pickBestRate', ratesService, [
  /export function pickBestRate/,
  /applyMarkups\(rawRates, markups\)/,
  /bestRate: pickBestRate\(rates\)/,
  /bestRate: pickBestRate\(cachedRates\)/,
]);

const ratesRoute = read('src/routes/rates.ts');
checkPatterns('/rates/browse delegates selection and proof to backend owners', ratesRoute, [
  /const combined = combineCarrierUniverses\(\{/,
  /const \{\s*combinedRates,[\s\S]*?cheapest,[\s\S]*?bestRateComplete,[\s\S]*?\} = combined/,
  /const finalized = await finalizeBestRateWithQuote\(\{/,
  /bestRate: \(bestRateOut as Record<string, unknown> \| null\) \?\? null/,
]);

const ratesBackfill = read('src/services/rates-backfill.ts');
check('rates backfill also delegates combined selection to rates-combined',
  ratesBackfill.includes('const combined = combineCarrierUniverses({'));

const apiClient = read('web/src/lib/v2-apiClient.ts');
check('v2 api client no longer creates a local combined[0] bestRate',
  !stripComments(apiClient).includes('combinedBestRate') && !/combined\s*\[\s*0\s*\]/.test(stripComments(apiClient)));
check('v2 api client does not define a legacy client-side bestRate wrapper',
  /return postRateBrowseTransport\(data\)/.test(apiClient) &&
  !/Object\.defineProperty\([\s\S]{0,180}?['"]bestRate['"]/.test(apiClient) &&
  !/bestRate\s*:.*translateRate/.test(apiClient));

const rateBrowser = read('web/src/components/RateBrowserModal.tsx');
checkIncludesAll('RateBrowserModal consumes backend canonical best and does not fabricate local cheapest', rateBrowser, [
  'findCanonicalBestRate',
  'decideBestRateEmission',
  'backend owns best-rate selection',
  'emit NOTHING',
  'do not fabricate/persist a FE-ranked',
]);

const scanFiles = [
  ...listSourceFiles('web/src'),
  ...listSourceFiles('src/routes'),
].map((path) => ({ path, content: read(path) }));
check('PS-313 scanner read frontend and route source files', scanFiles.length > 50, scanFiles.length);

const negativeControl = scanForbiddenRateAuthority(
  [
    { path: 'web/src/__ps313_combined__.ts', content: 'const combinedBestRate = combined[0];' },
    { path: 'src/routes/__ps313_sort__.ts', content: 'const cheapest = rates.sort((a, b) => a.total - b.total)[0];' },
    { path: 'web/src/__ps313_define__.ts', content: "Object.defineProperty(rows, 'bestRate', { value: rows[0] });" },
  ],
  FORBIDDEN_RATE_AUTHORITY_PATTERNS,
);
check('PS-313 scanner negative control catches local rate authority patterns',
  negativeControl.length >= 3, negativeControl);

const violations = scanForbiddenRateAuthority(scanFiles, FORBIDDEN_RATE_AUTHORITY_PATTERNS);
check('PS-313 no frontend/route wrapper mints official Best Rate or selected-rate proof',
  violations.length === 0, violations);

if (failures > 0) {
  console.error(`\nFAIL PS-313 rate source-of-truth guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-313 rate source-of-truth guard');
