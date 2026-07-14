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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  markupRuleToCanonical,
  resolveCanonicalMarkup,
  applyCanonicalMarkup,
  canonicalMarkupAmount,
} from '../src/services/shipping-workflow/markup-resolver';
import { applyMarkupToAmount, parseMarkupSettingValue, buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { decidePackageCostLine } from '../src/services/billing-box-policy';
import { roundMoney } from '../src/lib/money';

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

// ── PS-371: ONE formula owner — every call site delegates to markup-resolver ──────────────
// canonicalMarkupAmount is the UNROUNDED single formula; roundMoney owns cent conversion.
check('PS-371 canonicalMarkupAmount stays unrounded until a money boundary',
  canonicalMarkupAmount(10.555, null) === 10.555 &&
  canonicalMarkupAmount(10, { pct: 15, flat: 1 }) === 10 * (1 + 15 / 100) + 1);
check('PS-371 applyCanonicalMarkup delegates cent conversion to roundMoney',
  applyCanonicalMarkup(10.555, null) === 10.56 &&
  applyCanonicalMarkup(9.85, { pct: 15, flat: 0 }) === roundMoney(canonicalMarkupAmount(9.85, { pct: 15, flat: 0 })));

// billing-shipping-line: formula parity plus canonical cent conversion.
for (const [billedCost, pct, flat] of [[9.85, 15, 1], [12.34, 0, 0], [7.5, 7.5, 0], [100, 0, 2.25]] as const) {
  const decision = decideShippingLineBilling({
    labelCost: billedCost, cShippingRateAmount: null, billingMode: 'label_cost',
    isBaselineCarrier: true, refUspsRate: 0, refUpsRate: 0,
    shippingMarkupPct: pct, shippingMarkupFlat: flat,
  });
  check(`PS-371 shipping line formula + roundMoney (cost=${billedCost}, pct=${pct}, flat=${flat})`,
    decision.billedAmount === roundMoney(billedCost * (1 + pct / 100) + flat),
    `got=${decision.billedAmount}`);
}

// billing-box-policy: percent-only formula plus canonical cent conversion.
for (const [configuredPrice, markupPct] of [[1.11, 15], [0.75, 0], [2.5, 7.5]] as const) {
  const decision = decidePackageCostLine({
    resolution: { status: 'resolved', source: 'dims', packageId: 7, pkg: { id: 7, name: '12x10x3', packageCode: null, length: 12, width: 10, height: 3 }, overridePrice: null, note: null },
    clientHasBoxPricing: true, configuredPrice, markupPct,
  });
  check(`PS-371 box price percent-only + roundMoney (price=${configuredPrice}, pct=${markupPct})`,
    decision.kind === 'line' && decision.amount === roundMoney(configuredPrice * (1 + markupPct / 100)),
    `got=${JSON.stringify(decision)}`);
}

// applyMarkupToAmount now DELEGATES (byte-identical already proven above in the parity loop).
const rateMoneySrc3 = readFileSync('src/services/shipping-workflow/rate-money.ts', 'utf8');
check('PS-371 rate-money applyMarkupToAmount delegates to the owner (no inline formula)',
  /return applyCanonicalMarkup\(amount, markupRuleToCanonical\(rule\)\)/.test(rateMoneySrc3));
check('PS-371 rate-money canonical row markup is an ALIAS of the owner (no duplicated body)',
  /const applyCanonicalRowMarkup = applyCanonicalMarkup/.test(rateMoneySrc3));
check('PS-371 billing-shipping-line imports the owner',
  /import \{ canonicalMarkupAmount \} from '\.\/shipping-workflow\/markup-resolver'/.test(readFileSync('src/services/billing-shipping-line.ts', 'utf8')));
check('PS-371 billing-box-policy imports the owner',
  /import \{ canonicalMarkupAmount \} from '\.\/shipping-workflow\/markup-resolver'/.test(readFileSync('src/services/billing-box-policy.ts', 'utf8')));

// Single-source sweep: NO file under src/ may re-implement base*(1+pct/100) except the owner.
// (web/src/utils/markups.ts + MarkupsContext.tsx are the documented FE deploy-skew fallbacks,
// scheduled for deletion in the PS-177 Phase 6 cleanup — backend truth is what this guard pins.)
{
  const FORMULA = /\*\s*\(1\s*\+\s*[A-Za-z_.$][\w.$]*\s*\/\s*100\s*\)/;
  const OWNER = join('src', 'services', 'shipping-workflow', 'markup-resolver.ts');
  // CODE only — comments may legitimately describe the math (e.g. rate-money's docstrings).
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (path === OWNER) continue;
      if (FORMULA.test(stripComments(readFileSync(path, 'utf8')))) offenders.push(path);
    }
  };
  walk('src');
  check('PS-371 single-source sweep: no src/ file re-implements the markup formula',
    offenders.length === 0, offenders.join(', '));
}

if (failures > 0) {
  console.error(`\nFAIL markup single-source guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS markup single-source guard');
