/**
 * #798 slice 2c — per-ACCOUNT markup on the INVOICE (the deferred half of the single-source-of-truth
 * reconciliation).
 *
 * The rate DISPLAY has always honored a per-account markup (settings markup.<account>, keyed by carrier
 * account). BILLING could not: the billing line-item path carried carrierCode + clientId but NOT the
 * carrier ACCOUNT, so a per-account markup SHOWED on the quote and never billed — the live KF Goods 15%
 * on accounts 595995/596001 quoted $14.38 but invoiced the raw $12.50.
 *
 * Why a per-CLIENT "mirror" is the WRONG fix: carrier_account_clients is MANY-TO-MANY (one UPS account is
 * reused across several DRP sub-stores — see src/db/schema/carrier-accounts.ts). A per-client markup would
 * under-bill the OTHER clients on that account and over-bill the owning client's shipments through OTHER
 * accounts. The markup lives on the ACCOUNT, so billing must key on the shipment's actual account.
 *
 * This slice adds the shipment's FROZEN carrierAccountId to the billing read (a READ of shipped data —
 * allowed) and feeds settings markup.<account> into the SAME canonical resolver as the per-account
 * OVERRIDE, behind a default-OFF flag (BILLING_PER_ACCOUNT_MARKUP). OFF => null per-account map =>
 * per-client-only behavior, byte-identical to slice 2a. ON => quote == invoice for per-account markups.
 *
 * ACTIVATION CAVEAT (reported to DJ, not enforced here): the regenerate path deletes billing_line_items
 * by date window WITHOUT honoring the `invoiced` flag, so flipping the flag ON and then regenerating an
 * already-invoiced PAST period would retroactively add the markup. Operator rule: flip ON, then only
 * generate/regenerate go-forward periods.
 *
 *   npx tsx scripts/ps-798-per-account-billing-guard.ts
 */
import { readFileSync } from 'node:fs';
import { resolveCanonicalMarkup, applyCanonicalMarkup } from '../src/services/shipping-workflow/markup-resolver';
import { resolvePerAccountMarkupRule } from '../src/services/shipping-workflow/per-account-markup-key';
import type { MarkupRule } from '../src/services/shipping-workflow/rate-money';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ── static: billing reads the shipment account + delegates to the ONE markup owner ───────────────
const billingSrc = readFileSync('src/services/billing.ts', 'utf8');
check('billing imports loadCarrierMarkups from the rates SOT (the SAME map the quote reads)',
  /import \{[^}]*\bloadCarrierMarkups\b[^}]*\} from '\.\/rates'/.test(billingSrc));
check('billing query selects the shipment providerAccountId (the reliably-written account id, not the NULL-on-sync carrierAccountId)',
  /providerAccountId: shipments\.providerAccountId/.test(billingSrc));
check('REGRESSION: billing no longer keys the per-account markup on carrierAccountId (NULL on synced rows)',
  !/\.get\(s\.carrierAccountId\)/.test(billingSrc));
check('BillableRow carries providerAccountId (number)',
  /providerAccountId: number \| null/.test(billingSrc));
check('per-account markup is gated DEFAULT-OFF behind BILLING_PER_ACCOUNT_MARKUP === "on"',
  /process\.env\.BILLING_PER_ACCOUNT_MARKUP === 'on'/.test(billingSrc));
check('OFF path loads NO per-account map (null) — only loadCarrierMarkups() when the flag is on',
  /\?\s*await loadCarrierMarkups\(\)\s*:\s*null/.test(billingSrc));
check('billing resolves the per-account override via resolvePerAccountMarkupRule(perAccountMarkups, s.providerAccountId)',
  /carrierAccountMarkup:\s*perAccountMarkups[\s\S]*?resolvePerAccountMarkupRule\(perAccountMarkups, s\.providerAccountId\)/.test(billingSrc));

// ── the FIX: key NAMESPACE alignment. Billing keys on providerAccountId, matching the SAME settings
//    key the rate DISPLAY uses (applyMarkups: markups.get(carrier_id) ?? markups.get(bare "se-<n>")).
//    The earlier slice keyed on carrierAccountId (NULL on synced rows + wrong namespace) => never billed.
{
  const rule15: MarkupRule = { type: 'percent', value: 15 };
  const bareMap = new Map<string, MarkupRule>([['595995', rule15]]);   // settings markup.595995
  const seMap = new Map<string, MarkupRule>([['se-595995', rule15]]);  // settings markup.se-595995
  check('account key: providerAccountId 595995 matches a BARE markup.595995 key (applyMarkups bare fallback)',
    JSON.stringify(resolvePerAccountMarkupRule(bareMap, 595995)) === JSON.stringify(rule15));
  check('account key: providerAccountId 595995 matches an markup.se-595995 key (applyMarkups carrier_id form)',
    JSON.stringify(resolvePerAccountMarkupRule(seMap, 595995)) === JSON.stringify(rule15));
  check('account key: a DIFFERENT account (596001) does NOT match markup.595995',
    resolvePerAccountMarkupRule(bareMap, 596001) === null);
  check('account key: null/NaN providerAccountId => null (no markup, no crash — what synced NULL rows hit before)',
    resolvePerAccountMarkupRule(bareMap, null) === null && resolvePerAccountMarkupRule(bareMap, Number.NaN) === null);
}

// ── END-TO-END chain (drives the REAL key resolver, not a hand-built rule — the audit's "vacuous
//    guard" fix): a synced shipment with providerAccountId 595995 + settings markup.595995=15% on a
//    flag-ON generate bills $14.37 — the SAME number the rate quote shows. ──
{
  const perAccountMarkups = new Map<string, MarkupRule>([['595995', { type: 'percent', value: 15 }]]);
  const providerAccountId = 595995; // what shipment-sync writes for a "se-595995" ShipStation account
  const carrierAccountMarkup = resolvePerAccountMarkupRule(perAccountMarkups, providerAccountId);
  const resolved = resolveCanonicalMarkup({ carrierAccountMarkup, clientShippingMarkupPct: 0, clientShippingMarkupFlat: 0 });
  const d = decideShippingLineBilling({
    labelCost: 12.5, cShippingRateAmount: null, billingMode: 'per_shipment', isBaselineCarrier: false,
    refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: resolved?.pct ?? 0, shippingMarkupFlat: resolved?.flat ?? 0,
  });
  check('e2e: providerAccountId 595995 + markup.595995=15% => billed $14.37 (quote == invoice, keyed correctly)',
    d.billedAmount.toFixed(2) === '14.37' && d.markupApplied === true, `billed=${d.billedAmount}`);
  check('e2e: display == invoice for the same account markup (single source of truth)',
    applyCanonicalMarkup(12.5, resolved).toFixed(2) === d.billedAmount.toFixed(2));
}

// ── functional: DEFAULT-OFF byte-identical (null per-account map + per-client 0/0) ───────────────
{
  const resolved = resolveCanonicalMarkup({ carrierAccountMarkup: null, clientShippingMarkupPct: 0, clientShippingMarkupFlat: 0 });
  check('default-OFF: resolver returns null (=> 0pct/0flat)', resolved === null);
  const d = decideShippingLineBilling({
    labelCost: 12.5, cShippingRateAmount: null, billingMode: 'per_shipment', isBaselineCarrier: false,
    refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: resolved?.pct ?? 0, shippingMarkupFlat: resolved?.flat ?? 0,
  });
  check('default-OFF: a $12.50 shipping line bills $12.50 (byte-identical to slice 2a)',
    approx(d.billedAmount, 12.5) && d.markupApplied === false);
}

// ── functional: flag-ON per-account markup bills (the live KF Goods 15% on account 595995) ───────
{
  const accountRule = { type: 'percent', value: 15 } as const; // settings markup.595995
  const resolved = resolveCanonicalMarkup({ carrierAccountMarkup: accountRule, clientShippingMarkupPct: 0, clientShippingMarkupFlat: 0 });
  check('flag-ON: per-account 15% => resolver {pct:15,flat:0}',
    JSON.stringify(resolved) === JSON.stringify({ pct: 15, flat: 0 }));
  const d = decideShippingLineBilling({
    labelCost: 12.5, cShippingRateAmount: null, billingMode: 'per_shipment', isBaselineCarrier: false,
    refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: resolved?.pct ?? 0, shippingMarkupFlat: resolved?.flat ?? 0,
  });
  // billing formats with .toFixed(2) (billing.ts unitCost/totalCost); 12.50*1.15 = 14.375 -> 14.37 in
  // float — the SAME value the documented KF Goods quote shows.
  check('flag-ON: $12.50 account-595995 line now bills $14.37 (matches the live KF Goods quote)',
    d.billedAmount.toFixed(2) === '14.37' && d.markupApplied === true, `billed=${d.billedAmount}`);
  // quote == invoice PROVEN: the rate DISPLAY (applyCanonicalMarkup) and the INVOICE (decideShipping
  // -LineBilling) produce the identical formatted amount for the same per-account markup.
  check('flag-ON: display amount == invoice amount (single source of truth)',
    applyCanonicalMarkup(12.5, resolved).toFixed(2) === d.billedAmount.toFixed(2));
}

// ── functional: per-account OVERRIDE beats the per-client default in the billing context ─────────
{
  const resolved = resolveCanonicalMarkup({
    carrierAccountMarkup: { type: 'percent', value: 20 }, clientShippingMarkupPct: 15, clientShippingMarkupFlat: 1,
  });
  check('billing precedence: account override (20%) wins over per-client default (15% + $1)',
    JSON.stringify(resolved) === JSON.stringify({ pct: 20, flat: 0 }));
}

// ── functional: an account with NO markup falls back to the per-client default (not 0) ───────────
{
  const resolved = resolveCanonicalMarkup({ carrierAccountMarkup: null, clientShippingMarkupPct: 10, clientShippingMarkupFlat: 0 });
  check('billing fallback: account with no markup => per-client 10% default still applies',
    JSON.stringify(resolved) === JSON.stringify({ pct: 10, flat: 0 }));
}

// ── functional: HOUSE customer_rate suppresses ALL markup, per-account included (PS-220 invariant) ─
{
  const resolved = resolveCanonicalMarkup({ carrierAccountMarkup: { type: 'percent', value: 15 } });
  const d = decideShippingLineBilling({
    labelCost: 9.0, cShippingRateAmount: 12.0, billingMode: 'per_shipment', isBaselineCarrier: false,
    refUspsRate: 0, refUpsRate: 0, shippingMarkupPct: resolved?.pct ?? 0, shippingMarkupFlat: resolved?.flat ?? 0,
  });
  check('house rate: per-account markup does NOT apply (customer_rate billed verbatim)',
    approx(d.billedAmount, 12.0) && d.source === 'c_shipping_rate' && d.markupApplied === false);
}

if (failures > 0) {
  console.error(`\nFAIL #798 per-account billing guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS #798 per-account billing guard');
