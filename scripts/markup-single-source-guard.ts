/**
 * #798 — Markup single source of truth (slice 1: the canonical resolver + math owner).
 *
 * Two disconnected markup systems today: rate DISPLAY reads settings markup.<carrierAccount> (keyed by
 * ACCOUNT), BILLING reads billing_config shipping_markup_pct/flat (keyed by CLIENT). They never
 * reconcile, so a configured markup would quote at one number and invoice at another (latent — both 0
 * today). This slice pins the CANONICAL resolver (per-client default + per-account override) + the
 * shared additive {pct,flat} math, PROVEN byte-identical to the current display formula so wiring it in
 * (slice 2) changes nothing until a markup is configured.
 *
 *   npx tsx scripts/markup-single-source-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  markupRuleToCanonical,
  resolveCanonicalMarkup,
  applyCanonicalMarkup,
} from '../src/services/shipping-workflow/markup-resolver';
import { applyMarkupToAmount, parseMarkupSettingValue, buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── per-account {type,value} -> canonical {pct,flat} ──────────────────────────
check('markupRuleToCanonical: percent rule => {pct,flat:0}',
  JSON.stringify(markupRuleToCanonical({ type: 'percent', value: 15 })) === JSON.stringify({ pct: 15, flat: 0 }));
check('markupRuleToCanonical: amount rule => {pct:0,flat}',
  JSON.stringify(markupRuleToCanonical({ type: 'amount', value: 1.5 })) === JSON.stringify({ pct: 0, flat: 1.5 }));
check('markupRuleToCanonical: zero/null => null',
  markupRuleToCanonical({ type: 'percent', value: 0 }) === null && markupRuleToCanonical(null) === null);

// ── resolver precedence: account override WINS, else client default, else null ─
check('resolve: per-account override wins over the per-client default',
  JSON.stringify(resolveCanonicalMarkup({
    carrierAccountMarkup: { type: 'percent', value: 20 },
    clientShippingMarkupPct: 15, clientShippingMarkupFlat: 1,
  })) === JSON.stringify({ pct: 20, flat: 0 }));
check('resolve: per-client default applies when no account override',
  JSON.stringify(resolveCanonicalMarkup({
    carrierAccountMarkup: null, clientShippingMarkupPct: 15, clientShippingMarkupFlat: 1,
  })) === JSON.stringify({ pct: 15, flat: 1 }));
check('resolve: nothing configured => null (DEFAULT-OFF)',
  resolveCanonicalMarkup({ carrierAccountMarkup: null, clientShippingMarkupPct: 0, clientShippingMarkupFlat: 0 }) === null);
check('resolve: undefined inputs => null (DEFAULT-OFF)', resolveCanonicalMarkup({}) === null);

// ── additive math + default-off no-op ─────────────────────────────────────────
check('apply: additive base*(1+pct/100)+flat', approx(applyCanonicalMarkup(10, { pct: 15, flat: 1 }), 12.5));
check('apply: null markup => base unchanged (2dp)', applyCanonicalMarkup(10.555, null) === 10.56);
check('apply: zero markup object => base unchanged', applyCanonicalMarkup(10, { pct: 0, flat: 0 }) === 10);

// ── BYTE-IDENTICAL to the current display formula (no drift on wiring) ─────────
for (const base of [9.27, 10.54, 11.21, 100, 0.01]) {
  for (const raw of ['{"type":"percent","value":15}', '{"type":"amount","value":1.5}', '{"type":"pct","value":7.5}']) {
    const rule = parseMarkupSettingValue(raw)!;
    const viaOld = applyMarkupToAmount(base, rule);
    const viaNew = applyCanonicalMarkup(base, markupRuleToCanonical(rule));
    check(`byte-identical to applyMarkupToAmount (base=${base}, ${raw})`, viaOld === viaNew, `old=${viaOld} new=${viaNew}`);
  }
}

// ── display <-> billing PARITY: same context => same effective amount ─────────
// HKP-class: 15% on a $9.85 shipping line is identical whether resolved as a per-account override
// (settings markup.<account> = 15%) or the per-client default (billing_config pct=15).
{
  const base = 9.85;
  const viaAccount = applyCanonicalMarkup(base, resolveCanonicalMarkup({ carrierAccountMarkup: { type: 'percent', value: 15 } }));
  const viaClient = applyCanonicalMarkup(base, resolveCanonicalMarkup({ clientShippingMarkupPct: 15, clientShippingMarkupFlat: 0 }));
  check('parity: 15% via account-override == 15% via client-default (display == billing)',
    viaAccount === viaClient && approx(viaAccount, 11.33));
}

// ── slice 2 wiring: BILLING resolves its shipping markup through the canonical owner ──
const billingSrc = readFileSync('src/services/billing.ts', 'utf8');
check('billing.ts imports the canonical markup owner (resolveCanonicalMarkup)',
  /import \{ resolveCanonicalMarkup \} from '\.\/shipping-workflow\/markup-resolver'/.test(billingSrc));
check('billing.ts resolves the shipping-line markup via resolveCanonicalMarkup (single owner)',
  /resolveCanonicalMarkup\(\{[\s\S]*?clientShippingMarkupPct: toNum\(cfg\.shippingMarkupPct\)/.test(billingSrc));
check('billing.ts feeds the RESOLVED markup into decideShippingLineBilling (not cfg directly)',
  /shippingMarkupPct: resolvedShippingMarkup\?\.pct \?\? 0/.test(billingSrc) &&
  /shippingMarkupFlat: resolvedShippingMarkup\?\.flat \?\? 0/.test(billingSrc));

// ── slice 2b: the order-row Best Rate column applies the SAME canonical markup (display == billing) ──
const rowFacts = (over: Record<string, unknown>) => ({
  isAwaiting: true, bestRateBaseAmount: null, selectedRateBaseAmount: null, labelFinalCost: null,
  markupRule: null, insuranceAddOn: null, ...over,
}) as Parameters<typeof buildOrderRowMoneyDisplay>[0];

// (1) rate-money's inlined canonical row markup == the resolver's applyCanonicalMarkup (no drift between
// the two impls — rate-money stays zero-import pure, so the math is duplicated and MUST stay in parity).
{
  const base = 10, m = { pct: 15, flat: 1 };
  const row = buildOrderRowMoneyDisplay(rowFacts({ bestRateBaseAmount: base, markupRuleCanonical: m }));
  check('row Best Rate canonical markup == resolver applyCanonicalMarkup (no drift)',
    row?.markedAmount === applyCanonicalMarkup(base, m) && row?.markedAmount === 12.5);
}
// (2) byte-identical: a per-account 15% resolved canonically == the legacy per-account markupRule path.
{
  const base = 12.5;
  const viaCanonical = buildOrderRowMoneyDisplay(rowFacts({ bestRateBaseAmount: base, markupRuleCanonical: { pct: 15, flat: 0 } }));
  const viaLegacy = buildOrderRowMoneyDisplay(rowFacts({ bestRateBaseAmount: base, markupRule: { type: 'percent', value: 15 } }));
  check('row display byte-identical: canonical {pct:15} == legacy per-account percent 15',
    viaCanonical?.markedAmount === viaLegacy?.markedAmount &&
    viaCanonical?.markedAmount === applyCanonicalMarkup(base, { pct: 15, flat: 0 }) &&
    viaCanonical?.markupSource === 'carrier_markup');
}
// (3) default-OFF: no canonical markup => base unchanged (a per-client 0/0 client is byte-identical).
{
  const row = buildOrderRowMoneyDisplay(rowFacts({ bestRateBaseAmount: 9.27, markupRuleCanonical: null }));
  check('row display default-off: canonical null => base unchanged', row?.markedAmount === 9.27);
}

// ── slice 2b wiring: orders route resolves canonically + threads it; rate-money prefers it ──
const ordersSrc = readFileSync('src/routes/orders.ts', 'utf8');
check('orders.ts bulk-loads the per-client billing markup (gated to financial viewers)',
  /clientShippingMarkupByClientId/.test(ordersSrc) && /billingConfig\.shippingMarkupPct/.test(ordersSrc));
check('orders.ts resolves the row markup via the canonical resolver (account override -> client default) and threads it',
  /resolveCanonicalMarkup\(\{[\s\S]*?carrierAccountMarkup: rowMarkupRule/.test(ordersSrc) &&
  /markupRuleCanonical: rowCanonicalMarkup/.test(ordersSrc));
const workflowDto = readFileSync('src/services/shipping-workflow/best-rate-workflow-dto.ts', 'utf8');
check('best-rate-workflow-dto threads markupRuleCanonical into buildOrderRowMoneyDisplay (no whitelist drop)',
  /markupRuleCanonical: facts\.money\.markupRuleCanonical/.test(workflowDto));
const rateMoneySrc2 = readFileSync('src/services/shipping-workflow/rate-money.ts', 'utf8');
check('rate-money PREFERS the canonical markup in the carrier branch (falls back to legacy per-account)',
  /facts\.markupRuleCanonical !== undefined[\s\S]*?applyCanonicalRowMarkup/.test(rateMoneySrc2));

if (failures > 0) {
  console.error(`\nFAIL markup single-source guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS markup single-source guard');
