/**
 * PS-203 (stages 1–2) guard — best-rate completeness is relative to the
 * REQUIRED carrier universe.
 *
 * THE BUG (2026-06-11, KF Goods): the saved BEST RATE showed $10.44 (ORI /
 * UPS Ground Saver) while the Rate Browser's combined view showed $9.27
 * (Shipp / SurePost). Every persisting path compared a ShipStation-only
 * universe and self-certified it complete — completeness was computed over
 * the carriers actually queried, not the carriers that SHOULD have been.
 *
 * Stage 1: the side-panel refresh sends includeVisibleDirectCarriers (the
 *   flag Recalculate + passive-live already send) so its persisted winner is
 *   compared against direct carriers too.
 * Stage 2: /rates/cached/bulk completeness is relative to the required
 *   universe — a ShipStation-only cache row for an order whose scope has
 *   visible direct-carrier accounts returns isComplete:false, which stops the
 *   passive fast-path persisting premature winners (the FE gate already
 *   requires isComplete). Stage 3's combined cache rows carry direct
 *   diagnostics (synthetic se-1xxxxxxx ids) and pass the same rule untouched.
 *
 *   npx tsx scripts/ps-203-best-rate-universe-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── stage 1: the panel refresh quotes the COMBINED universe ───────────────────
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
{
  const start = ordersView.indexOf('async function refreshPanelBestRate(');
  const block = start >= 0 ? ordersView.slice(start, start + 4000) : '';
  check('refreshPanelBestRate browse call sends includeVisibleDirectCarriers',
    start >= 0 && /includeVisibleDirectCarriers: true/.test(block));
}

// ── stage 2: cached/bulk completeness vs the required universe ────────────────
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
check('cached/bulk loads the direct-carrier visibility evaluator ONCE per request',
  /const hasVisibleDirectCarriers = await loadDirectCarrierVisibilityEvaluator\(\)/.test(ratesRoute));
check('exact AND rough cache hits evaluate the required universe',
  (ratesRoute.match(/requiredDirectCarriersUncovered:\s*\n?\s*hasVisibleDirectCarriers\(\{ clientId: it\.clientId \?\? null, storeId: it\.storeId \?\? null \}\) &&\s*\n?\s*!rateCacheRowCoversDirectCarriers\(eligibleHit\)/g)?.length ?? 0) === 2);
check('completeness gates on the required universe (uncovered direct carriers ⇒ incomplete)',
  /coversRequiredUniverse = options\.requiredDirectCarriersUncovered !== true/.test(ratesRoute) &&
  /isComplete = fresh && rates\.length > 0 && coversRequiredUniverse/.test(ratesRoute));
check('direct coverage = synthetic se- ids ≥ 10,000,000 in the row diagnostics (stage-3-ready)',
  /rateCacheRowCoversDirectCarriers/.test(ratesRoute) &&
  />= 10_000_000/.test(ratesRoute));
check('uncovered rows are marked for observability (requiredCarrierUniverse)',
  /requiredCarrierUniverse: 'missing-direct'/.test(ratesRoute));

// ── the evaluator lives at the carrier-universe owner ─────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('rates service owns the visibility evaluator (one account load, per-context closure)',
  /export async function loadDirectCarrierVisibilityEvaluator/.test(ratesService) &&
  /directCarrierVisibleForScope\(account, \{/.test(ratesService));
check('evaluator failure degrades to legacy completeness (never breaks the cache read)',
  /direct-carrier visibility load skipped/.test(ratesService));

if (failures > 0) {
  console.error(`\nFAIL PS-203 best-rate universe guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-203 best-rate universe guard');
