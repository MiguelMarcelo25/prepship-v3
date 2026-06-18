/**
 * PS-261 (slice) guard — a HUGRAB label purchase is GATED on the PS-290 coverage verdict.
 *
 * The PS-290 resolver (insurance-coverage-status.ts) owns the HUGRAB "$100 insurance COVERAGE
 * STATUS" verdict (included | not_included | unknown | unsupported | not_required). This slice
 * adds a SECOND pure resolver that maps that verdict to a purchase decision, so a HUGRAB label
 * can never be bought while the mandatory $100 of coverage is missing, unproven, or unsupported:
 *
 *   included      -> allow (the $100 coverage is proven)
 *   not_required  -> allow (non-HUGRAB row; the mandate does not apply)
 *   not_included  -> BLOCK (the $100 was explicitly NOT applied)
 *   unknown       -> BLOCK (requested but UNPROVEN — never buy on an unproven coverage)
 *   unsupported   -> BLOCK (the rate cannot insure at all)
 *
 * This is a PURE decision: no DB, no network, no live label. It is NOT wired into Create Label /
 * Print Queue / Rate Browser yet — those are follow-on slices. This guard pins ONLY the decision
 * table + the every-status totality (every InsuranceCoverageStatus value maps to a decision).
 *
 *   npx tsx scripts/ps-261-hugrab-label-purchase-gate-guard.ts
 */
import { readFileSync } from 'node:fs';
import type { InsuranceCoverageStatus } from '../src/services/shipping-workflow/insurance-coverage-status';
import { resolveHugrabLabelPurchaseGate } from '../src/services/shipping-workflow/hugrab-label-purchase-gate';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── ALLOW: coverage is proven, or the mandate does not apply ───────────────────
const included = resolveHugrabLabelPurchaseGate('included');
check('included -> allow', included.allow === true);
check('included -> non-empty reason', typeof included.reason === 'string' && included.reason.length > 0);

const notRequired = resolveHugrabLabelPurchaseGate('not_required');
check('not_required (non-HUGRAB) -> allow', notRequired.allow === true);

// ── BLOCK: coverage missing, unproven, or unsupported ──────────────────────────
const notIncluded = resolveHugrabLabelPurchaseGate('not_included');
check('not_included -> BLOCK', notIncluded.allow === false);
check('not_included -> non-empty reason', notIncluded.reason.length > 0);

const unknown = resolveHugrabLabelPurchaseGate('unknown');
check('unknown -> BLOCK (never buy on unproven coverage)', unknown.allow === false);
check('unknown -> non-empty reason', unknown.reason.length > 0);

const unsupported = resolveHugrabLabelPurchaseGate('unsupported');
check('unsupported -> BLOCK', unsupported.allow === false);
check('unsupported -> non-empty reason', unsupported.reason.length > 0);

// ── TOTALITY: every coverage status maps to a decision (no undefined / no throw) ─
const allStatuses: InsuranceCoverageStatus[] = [
  'included', 'not_included', 'unknown', 'unsupported', 'not_required',
];
const allowed: InsuranceCoverageStatus[] = ['included', 'not_required'];
let totalityOk = true;
for (const status of allStatuses) {
  const decision = resolveHugrabLabelPurchaseGate(status);
  if (typeof decision.allow !== 'boolean') totalityOk = false;
  if (typeof decision.reason !== 'string' || decision.reason.length === 0) totalityOk = false;
  if (decision.allow !== allowed.includes(status)) totalityOk = false;
}
check('every InsuranceCoverageStatus maps to a {allow,reason} decision (totality)', totalityOk);

// ── BLOCK-by-default: an unrecognized/garbage status is BLOCKED, never silently allowed ─
// (defense-in-depth — the type is closed, but a bad runtime value must fail safe to BLOCK.)
const garbage = resolveHugrabLabelPurchaseGate('totally-not-a-status' as InsuranceCoverageStatus);
check('unrecognized status -> BLOCK (fail safe, never silently allow)', garbage.allow === false);

// ── the resolver lives in its OWN small file (DJ preference) + is PURE (no IO) ──
const gate = read('src/services/shipping-workflow/hugrab-label-purchase-gate.ts');
check('hugrab-label-purchase-gate is its own file', gate.length > 0);
check('gate exports resolveHugrabLabelPurchaseGate', /export function resolveHugrabLabelPurchaseGate\(/.test(gate));
check('gate IMPORTS the PS-290 InsuranceCoverageStatus type (reuses the owner, no re-declare)',
  /InsuranceCoverageStatus.*from '\.\/insurance-coverage-status'/.test(gate));
check('gate is PURE — no DB / network / fs / label IO',
  !/\b(fetch|axios|db\.|drizzle|readFile|writeFile|require\(|process\.env)\b/.test(gate));
check('gate does NOT call the coverage resolver (it consumes the verdict, does not re-derive it)',
  !/resolveInsuranceCoverageStatus\s*\(/.test(gate));

// ── package.json wires the test:ps-261-hugrab-label-purchase-gate script ───────
const pkg = read('package.json');
check('package.json wires test:ps-261-hugrab-label-purchase-gate',
  /test:ps-261-hugrab-label-purchase-gate/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-261 HUGRAB label-purchase-gate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-261 HUGRAB label-purchase-gate guard');
