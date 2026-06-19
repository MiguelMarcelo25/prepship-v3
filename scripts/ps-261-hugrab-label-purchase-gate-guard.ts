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

// ── PS-261 (this slice): the gate is WIRED into the label-purchase PREFLIGHT as a
//    backend-owned BLOCK. A small preflight resolver (its own file) maps a pre-purchase
//    rate context to the gate decision by reusing the PS-290 coverage resolver + PS-274
//    certainty resolver, and labels.ts calls it BEFORE any postage is bought. ─────────
import {
  resolveHugrabLabelPurchasePreflight,
} from '../src/services/shipping-workflow/hugrab-label-purchase-preflight';

// BEHAVIOR: an UNCERTAIN HUGRAB rate (Shipp-brokered declared value, no direct proof) is
// coverage 'unknown' (PS-290) -> the preflight BLOCKS before postage.
const uncertainHugrab = resolveHugrabLabelPurchasePreflight({
  isHugrab: true,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCost: 0,
  serviceCode: 'shipp_ups_ground',
  provider: 'shipp',
  accountIdentity: 'Shipp',
  isDirectVerifiedAccount: false,
});
check('preflight BLOCKS an uncertain HUGRAB rate (Shipp-brokered, unproven coverage)',
  uncertainHugrab.allow === false);
check('preflight uncertain-HUGRAB verdict is unknown (consumes the PS-290 coverage owner)',
  uncertainHugrab.status === 'unknown');
check('preflight block carries a non-empty operator-facing reason',
  typeof uncertainHugrab.reason === 'string' && uncertainHugrab.reason.length > 0);

// BEHAVIOR: a HUGRAB rate with PROVEN coverage (positive ParcelGuard premium) is
// 'included' -> the preflight is a NO-OP (allow), buying proceeds unchanged.
const includedHugrab = resolveHugrabLabelPurchasePreflight({
  isHugrab: true,
  insuranceProvider: 'parcelguard',
  insuredValue: 100,
  insuranceCost: 0.99,
  insuranceProvenance: 'parcelguard_schedule',
  serviceCode: 'usps_ground_advantage',
  provider: 'stamps_com',
  accountIdentity: 'USPS',
  isDirectVerifiedAccount: false,
});
check('preflight is a NO-OP on a proven-included HUGRAB rate (allow)',
  includedHugrab.allow === true);
check('preflight proven-included verdict is included', includedHugrab.status === 'included');

// BEHAVIOR: a non-HUGRAB rate -> 'not_required' -> the preflight is a NO-OP (allow).
const nonHugrab = resolveHugrabLabelPurchasePreflight({
  isHugrab: false,
  insuranceProvider: 'none',
  insuredValue: 0,
  serviceCode: 'usps_ground_advantage',
});
check('preflight is a NO-OP on a non-HUGRAB rate (mandate does not apply -> allow)',
  nonHugrab.allow === true);
check('preflight non-HUGRAB verdict is not_required', nonHugrab.status === 'not_required');

// the preflight resolver lives in its OWN small file + DELEGATES to the gate (no re-derive).
const preflight = read('src/services/shipping-workflow/hugrab-label-purchase-preflight.ts');
check('hugrab-label-purchase-preflight is its own file', preflight.length > 0);
check('preflight exports resolveHugrabLabelPurchasePreflight',
  /export function resolveHugrabLabelPurchasePreflight\(/.test(preflight));
check('preflight DELEGATES to the PS-261 gate (does not re-implement the decision table)',
  /resolveHugrabLabelPurchaseGate\s*\(/.test(preflight));
check('preflight CONSUMES the PS-290 coverage owner (reuses the verdict resolver)',
  /resolveInsuranceCoverageStatus\s*\(/.test(preflight));
check('preflight is PURE — no DB / network / fs / label IO',
  !/\b(fetch|axios|db\.|drizzle|readFile|writeFile|process\.env)\b/.test(preflight));

// labels.ts WIRES the preflight BLOCK into the real-postage purchase path.
const labels = read('src/services/labels.ts');
check('labels.ts imports the HUGRAB label-purchase preflight',
  /resolveHugrabLabelPurchasePreflight/.test(labels) &&
  /from '\.\/shipping-workflow\/hugrab-label-purchase-preflight'/.test(labels));
check('labels.ts calls the preflight in the buy path (BLOCK before postage)',
  /resolveHugrabLabelPurchasePreflight\s*\(/.test(labels));
// the BLOCK must fire BEFORE either provider purchase call (direct or ShipStation).
const preflightIdx = labels.indexOf('resolveHugrabLabelPurchasePreflight(');
const directBuyIdx = labels.indexOf('createDirectCarrierLabelForOrder({');
// `ssOrderId:` is present ONLY in the real-postage ShipStation buy (the legacy
// createLabelFromShipment helper does not carry it), so it pins the real purchase boundary.
const ssBuyIdx = labels.indexOf('ssOrderId:');
check('preflight runs BEFORE the direct-carrier purchase call',
  preflightIdx > 0 && directBuyIdx > 0 && preflightIdx < directBuyIdx);
check('preflight runs BEFORE the ShipStation purchase call',
  preflightIdx > 0 && ssBuyIdx > 0 && preflightIdx < ssBuyIdx);
// the block surfaces a structured, operator-facing code (the FE branches on code, not message).
check('labels.ts throws a structured HUGRAB coverage block code',
  /HUGRAB_INSURANCE_COVERAGE_UNPROVEN/.test(labels));
// The BLOCK is a money-path change, so it ships behind a DEFAULT-OFF canary (HUGRAB_PURCHASE_GATE):
// OFF (default) is byte-identical to pre-PS-261, DJ flips it on after a live canary (never auto-active).
check('labels.ts gates the BLOCK behind the default-OFF HUGRAB_PURCHASE_GATE canary',
  /HUGRAB_PURCHASE_GATE/.test(labels) &&
  /hugrabPurchaseGateEnabled\(\)\s*&&\s*!hugrabCoveragePreflight\.allow/.test(labels) &&
  /process\.env\.HUGRAB_PURCHASE_GATE === 'on'/.test(labels));

// ── PS-261 (this slice): the PURCHASE-GATE verdict is DISPLAYED, pre-purchase, on the Rate
//    Browser HUGRAB rate row. The operator sees whether the mandatory $100 coverage is PROVEN
//    (purchase allowed) vs BLOCKED (coverage missing / unproven / unsupported) BEFORE buying —
//    the SAME backend gate the purchase preflight uses, rendered VERBATIM by the FE. ───────────
//
// Source of truth: the gate verdict for display is stamped on the rate DTO by DELEGATING to the
// PS-261 gate (resolveHugrabLabelPurchaseGate) over the DTO's already-resolved PS-290 coverage
// status. The FE renders the backend {allow,reason}; it NEVER recomputes a purchase verdict.

// BEHAVIOR: the gate reasons are non-empty + render-safe operator copy (the FE shows reason text).
check('gate ALLOW reason is non-empty render-safe copy (included)',
  resolveHugrabLabelPurchaseGate('included').allow === true &&
  resolveHugrabLabelPurchaseGate('included').reason.length > 0);
check('gate BLOCK reason is non-empty render-safe copy (unknown)',
  resolveHugrabLabelPurchaseGate('unknown').allow === false &&
  resolveHugrabLabelPurchaseGate('unknown').reason.length > 0);

// (A) order-rate-dto STAMPS the backend purchase-gate verdict by DELEGATING to the PS-261 gate
//     over the already-resolved PS-290 coverage status (one owner; no FE/DTO re-derivation).
const dto = read('src/services/order-rate-dto.ts');
check('order-rate-dto imports the PS-261 purchase gate (resolveHugrabLabelPurchaseGate)',
  /resolveHugrabLabelPurchaseGate/.test(dto) &&
  /from '\.\/shipping-workflow\/hugrab-label-purchase-gate'/.test(dto));
check('order-rate-dto declares the backend purchase-gate display fields',
  /hugrabPurchaseAllowed:\s*boolean/.test(dto) &&
  /hugrabPurchaseBlockReason:\s*string/.test(dto));
check('order-rate-dto populates the gate verdict via the gate over the coverage status (delegation)',
  /resolveHugrabLabelPurchaseGate\(/.test(dto));

// (B) orders-row-display exposes a PURE pass-through reader + a renderer for the gate verdict.
const rowDisplay2 = read('web/src/components/Views/orders-row-display.tsx');
check('orders-row-display exposes a pure HUGRAB purchase-gate reader',
  /export function getRowHugrabPurchaseGate\(/.test(rowDisplay2));
check('orders-row-display reads hugrabPurchaseAllowed off the backend DTO (pass-through)',
  /hugrabPurchaseAllowed/.test(rowDisplay2));
check('orders-row-display reads hugrabPurchaseBlockReason off the backend DTO (pass-through)',
  /hugrabPurchaseBlockReason/.test(rowDisplay2));
check('orders-row-display exposes a HUGRAB purchase-gate renderer',
  /export function renderHugrabPurchaseGateBadge\(/.test(rowDisplay2));
check('orders-row-display does NOT call the PS-261 gate (no FE recompute of a purchase verdict)',
  !/resolveHugrabLabelPurchaseGate\s*\(/.test(rowDisplay2));

// (C) RateRowItem RENDERS the gate verdict on the HUGRAB rate row, sourced from the one owner.
const rateRowItem2 = read('web/src/components/RateRowItem.tsx');
check('RateRowItem imports the shared purchase-gate reader (getRowHugrabPurchaseGate)',
  /getRowHugrabPurchaseGate/.test(rateRowItem2));
check('RateRowItem imports the shared purchase-gate renderer (renderHugrabPurchaseGateBadge)',
  /renderHugrabPurchaseGateBadge/.test(rateRowItem2));
check('RateRowItem reads the backend gate verdict off the rate (pure pass-through)',
  /getRowHugrabPurchaseGate\(/.test(rateRowItem2));
check('RateRowItem renders the purchase-gate indicator in the row',
  /renderHugrabPurchaseGateBadge\(/.test(rateRowItem2));
check('RateRowItem does NOT call the PS-261 gate (no FE recompute of a purchase verdict)',
  !/resolveHugrabLabelPurchaseGate\s*\(/.test(rateRowItem2));
check('RateRowItem sources the gate reader/renderer from orders-row-display (one owner, no fork)',
  /from\s+['"]\.\/Views\/orders-row-display['"]/.test(rateRowItem2));

// ── PS-261 GATE SCOPE (2026-06-19, A re-audit + DJ disposition) ────────────────────
// The HUGRAB $100-coverage purchase gate covers FORWARD labels (createLabelV2 + batch +
// print-queue). RETURN labels (createReturnLabelV2 -> ssCreateReturnLabel) are EXEMPT by
// design — the forward-coverage mandate does not apply to inbound return postage (which
// carries no rate/insurance selection). Pin the EXPLICIT exemption + the dead-code
// landmine so a future adversarial audit recognizes them as intentional scope, not a
// missed bypass.
{
  const returnFn = /export async function createReturnLabelV2\([\s\S]*?\r?\n}\r?\n/.exec(labels)?.[0] ?? '';
  check('createReturnLabelV2 body located', returnFn.length > 0);
  check('createReturnLabelV2 DOCUMENTS the PS-261 return-coverage EXEMPTION (forward-only mandate)',
    /PS-261/.test(returnFn) && /EXEMPT/i.test(returnFn) && /HUGRAB/.test(returnFn));
  // the legacy dead-code path stays pinned as an ungated HUGRAB landmine (revival must add the gate).
  const deadCodeNote = /dead-code note:[\s\S]*?export async function createLabelFromShipment/.exec(labels)?.[0] ?? '';
  check('createLabelFromShipment dead-code note warns it is ungated for HUGRAB (PS-261 preflight)',
    deadCodeNote.length > 0 && /PS-261/.test(deadCodeNote) && /preflight/i.test(deadCodeNote));
}

if (failures > 0) {
  console.error(`\nFAIL PS-261 HUGRAB label-purchase-gate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-261 HUGRAB label-purchase-gate guard');
