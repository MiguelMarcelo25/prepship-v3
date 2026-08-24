import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
  readFrozenCustomerShippingMoney,
} from '../src/services/customer-shipping-money-snapshot';

/**
 * PS-508 — the ordinary-outbound customer-money freeze.
 *
 * ── WHY THIS IMPORTS ONLY THE SNAPSHOT MODULE ───────────────────────────────────────────
 *
 * customer-shipping-money-snapshot.ts depends on nothing but roundMoney, so the whole tuple
 * contract is provable OFFLINE — no database, no env. That matters twice over: the PS-488 lane has
 * no .env and dies at module load on anything that reaches db/client, and a guard that can only
 * run where a database exists is a guard that does not run.
 *
 * Everything that CANNOT be proven by execution is proven against source text below, scoped to a
 * single function body. A file-wide presence check silently transfers its evidence to any newly
 * added identical line elsewhere in the file — that happened five separate times in PS-502.
 */

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Strip comments before matching. My own docblocks name the very things these checks negate, so an
 * un-stripped negative assertion trips on the prose explaining it — four such false positives in
 * PS-502. Decoy matches inside a neighbouring docblock are the same failure wearing a hat.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function functionBody(source: string, name: string): string {
  const start = [`export async function ${name}(`, `export function ${name}(`]
    .map((needle) => source.indexOf(needle))
    .filter((n) => n !== -1)
    .reduce((best, n) => (best === -1 ? n : Math.min(best, n)), -1);
  if (start === -1) {
    throw new Error(`functionBody: ${name} not found — the check would silently pass on empty text`);
  }
  const next = source.indexOf('\nexport ', start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ── 1. TUPLE CONTRACT (behavioural, offline) ──────────────────────────────────────────────

const base = {
  selectedRateCost: 10,
  cShippingRateAmount: 12,
  shippingMarginAmount: 2,
  shippingMarginPct: 16.7,
  rateCostSource: 'label_final_cost',
};

const v1Tuple = {
  ...base,
  customerRateSource: 'realized_customer_shipping_rate',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
};
const v2Tuple = {
  ...base,
  customerRateSource: 'house_next_best_customer_rate',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
  billingDescriptionSuffix: '',
};

check('the two policy versions are DISTINCT values (the constant was added, never edited)',
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION !== CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND
  && CUSTOMER_SHIPPING_MONEY_POLICY_VERSION === 'ps-437-v1',
  `${CUSTOMER_SHIPPING_MONEY_POLICY_VERSION} / ${CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND}`);

check('v1 still reads by DEFAULT (no existing consumer changed behaviour)',
  readFrozenCustomerShippingMoney(v1Tuple)?.cShippingRateAmount === 12);

// THE staging property. If this ever passes, the cutover has happened by accident: every consumer
// of the default reader would begin consuming outbound tuples the moment the first one is frozen.
check('STAGING: an outbound (v2) tuple is INVISIBLE to the default reader',
  readFrozenCustomerShippingMoney(v2Tuple) === null);

check('STAGING: an outbound tuple reads only when a caller explicitly accepts its version',
  readFrozenCustomerShippingMoney(v2Tuple, {
    accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  })?.cShippingRateAmount === 12);

// The line-64 regression: the reader used to return the CONSTANT rather than what it read. With one
// accepted version that was invisible; with two it silently relabels v2 tuples as v1, so no
// consumer can tell which policy produced the number it is about to bill.
{
  const read = readFrozenCustomerShippingMoney(v2Tuple, {
    accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  });
  check('the reader returns the version it READ, never the constant',
    read?.customerShippingMoneyPolicyVersion === CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
    JSON.stringify(read?.customerShippingMoneyPolicyVersion));
}

check('house provenance is a distinct THIRD source, not a flavour of realized',
  readFrozenCustomerShippingMoney(v2Tuple, {
    accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  })?.customerRateSource === 'house_next_best_customer_rate');

check('an unknown provenance is still REJECTED (the union did not become a free-form string)',
  readFrozenCustomerShippingMoney(
    { ...v2Tuple, customerRateSource: 'something_invented' },
    { accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS },
  ) === null);

// The eighth field is OPTIONAL because every already-frozen v1 tuple in production lacks it.
// Making it required would retroactively read correct, frozen money as absent.
check('a v1 tuple WITHOUT billingDescriptionSuffix still reads (no retroactive invalidation)',
  readFrozenCustomerShippingMoney(v1Tuple) != null
  && !('billingDescriptionSuffix' in (readFrozenCustomerShippingMoney(v1Tuple) as object)));

check('billingDescriptionSuffix round-trips when the tuple carries it',
  readFrozenCustomerShippingMoney(
    { ...v2Tuple, billingDescriptionSuffix: ' (20% + $1.00)' },
    { accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS },
  )?.billingDescriptionSuffix === ' (20% + $1.00)');

check('margin reconciliation is still enforced (a tuple whose margin lies is rejected)',
  readFrozenCustomerShippingMoney({ ...v1Tuple, shippingMarginAmount: 5 }) === null);

// ── 2. THE FREEZE (structural, function-scoped) ───────────────────────────────────────────

const labelsSrc = readFileSync('src/services/labels.ts', 'utf8');
const persistBody = stripComments(functionBody(labelsSrc, 'persistCreatedLabel'));

check('the canonical outbound writer freezes customer money in its own body',
  /freezeOutboundCustomerShippingMoney\(/.test(persistBody));

check('the house rate is DERIVED in the same body (order_competitive_rate does not exist yet here)',
  /deriveOutboundHouseCustomerRate\(/.test(persistBody));

// Reachability, not presence. `if (false) { freeze() }` and `undefined && freeze()` both satisfy a
// presence check and an ordering check while never executing — that pattern got past three separate
// PS-502 checks before it was caught.
check('the freeze is REACHABLE (no literal-false or short-circuit kill switch around it)',
  !/if\s*\(\s*(false|0|null|undefined)\s*\)/.test(persistBody)
  && !/(false|undefined|null)\s*&&\s*(await\s+)?(freezeOutbound|deriveOutbound)/.test(persistBody));

check('the freeze runs AFTER the shipment row exists (it needs the returned id)',
  persistBody.indexOf('.returning({ id: shipments.id })') !== -1
  && persistBody.indexOf('freezeOutboundCustomerShippingMoney(')
     > persistBody.indexOf('.returning({ id: shipments.id })'));

// Re-anchored, not loosened: the call gained a return value and now wraps across lines, so the
// argument ends `sp,` with a trailing comma. Same property — the SAVEPOINT handle is what is
// passed, never the bare pool.
check('the freeze joins the CALLER transaction, never the bare pool',
  /freezeOutboundCustomerShippingMoney\([\s\S]{0,200}?\bsp\b,?\s*\)/.test(persistBody));

// BLOCKER 1 (audit, 74%): house money must follow the PURCHASE, not the stamp.
// captureRealizedHouseMargin — sole writer of the sidecar billing reads — is gated on
// directProviderKey === 'shipp'. Deriving from best_rate_json + opt-in alone is a DIFFERENT
// eligibility boundary: a stale SHIPP-winning stamp plus a non-SHIPP purchase froze house money
// where billing applies carrier markup, and the one-shot predicate made it unrepairable.
check('house derivation is gated on the PURCHASED provider being shipp',
  /purchasedProviderKey === 'shipp'/.test(persistBody));
check('a non-SHIPP purchase derives NO house rate (ordinary carrier policy)',
  /housePurchaseEligible\s*\n?\s*\?\s*await deriveOutboundHouseCustomerRate|housePurchaseEligible$/m.test(persistBody)
  && /:\s*null/.test(persistBody));
check('the purchased provider is passed EXPLICITLY, not inferred from source or carrier code',
  /purchasedProviderKey: directProviderKey/.test(labelsSrc)
  && !/purchasedProviderKey:\s*args\.source/.test(labelsSrc));

// BLOCKER 2 (audit, 74%): a failed PostgreSQL statement aborts the WHOLE transaction. Catching the
// JavaScript exception does not restore it — the parent stays poisoned and the ledger's 'consumed'
// flip fails, rolling back a label the carrier already charged for. Only a savepoint makes the
// parent usable again, which is why the replacement purchase already wraps its freeze this way.
check('the staged freeze runs in a SAVEPOINT, not a bare try/catch',
  /exec\.transaction\(async \(sp\) =>/.test(persistBody));
check('the savepoint wraps BOTH the derivation and the freeze',
  persistBody.indexOf('exec.transaction(async (sp)') < persistBody.indexOf('deriveOutboundHouseCustomerRate(')
  && persistBody.indexOf('exec.transaction(async (sp)') < persistBody.indexOf('freezeOutboundCustomerShippingMoney('));
check('the derivation runs on the SAVEPOINT handle, not the parent transaction',
  /exec:\s*sp,/.test(persistBody));

// The cost-basis defect the map surfaced: the sidecar's drp_cost is postage only, but billing floors
// the house amount at resolveBillingSelectedRateCost, which prefers selected_rate_cost = postage +
// insurance. Deriving from bare created.cost misses insurance on every insured shipment.
//
// SCOPED TO THE DERIVE CALL, and that is not fussiness. persistCreatedLabel writes the identical
// expression into the shipments INSERT a few lines above, so a body-wide check is satisfied by the
// INSERT even when the derive call has been changed to bare created.cost — mutation testing caught
// exactly that. A presence check whose evidence can be supplied by a different line is not a check.
{
  const deriveStart = persistBody.indexOf('deriveOutboundHouseCustomerRate(');
  const deriveEnd = persistBody.indexOf('freezeOutboundCustomerShippingMoney(');
  if (deriveStart === -1 || deriveEnd === -1 || deriveEnd < deriveStart) {
    check('the derivation uses the postage+insurance basis, not bare created.cost', false,
      'could not isolate the derive call — the check would pass on unrelated text');
  } else {
    const deriveCall = persistBody.slice(deriveStart, deriveEnd);
    check('the derivation uses the postage+insurance basis, not bare created.cost',
      /selectedRateCost:\s*Number\(\(created\.cost \+ insuranceCost\)\.toFixed\(2\)\)/.test(deriveCall)
      && !/selectedRateCost:\s*created\.cost\b/.test(deriveCall),
      deriveCall.replace(/\s+/g, ' ').slice(0, 160));
  }
}

const moneySrc = readFileSync('src/services/customer-shipping-money.ts', 'utf8');
const freezeBody = stripComments(functionBody(moneySrc, 'freezeOutboundCustomerShippingMoney'));

check('the outbound freeze stamps the OUTBOUND version, not the default',
  /policyVersion:\s*CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND/.test(freezeBody));

// Each exclusion is a real collision, not defensive noise. The one-shot jsonb guards test KEY
// PRESENCE rather than value, so an outbound tuple landing on a replacement row first makes
// freezeReplacementCustomerShippingMoney update zero rows and then throw on its re-select.
check('the outbound freeze yields on replacement rows (the one-shot guards test key presence)',
  /row\.source === 'replacement'/.test(freezeBody));
check('the outbound freeze skips $0 test_offline rows',
  /row\.source === 'test_offline'/.test(freezeBody));
check('the outbound freeze refuses returns and voided rows',
  /row\.isReturn/.test(freezeBody) && /row\.voided/.test(freezeBody));

// It runs inside the committed ship transaction, so throwing rolls back a label already paid for at
// the carrier. Inactive billing config / absent client / $0 cost are ordinary states, not errors —
// pre-checked and skipped, NOT swallowed by a blanket catch that would also hide real defects.
// Re-anchored and STRENGTHENED. The three states were one combined condition; they are now
// separate early returns that each name their reason, so the check pins the skip STATUS too —
// previously it only proved the condition existed, not that it skipped rather than threw.
check('the outbound freeze SKIPS the three ordinary non-billable states rather than throwing',
  /!row\.billingActive\)\s*return \{ status: 'skipped', reason: 'billing_inactive' \}/.test(freezeBody)
  && /row\.clientId == null\)\s*return \{ status: 'skipped', reason: 'no_client' \}/.test(freezeBody)
  && /selectedRateCost == null \|\| selectedRateCost <= 0/.test(freezeBody)
  && /reason: 'no_billable_cost'/.test(freezeBody));

// PS-509 prerequisite: the four meanings of "no billable tuple" must stay distinguishable.
// A malformed tuple silently returning null was indistinguishable from an ordinary skip, so a row
// this build wrote WRONG looked exactly like one it had correctly left alone.
check('the freeze classifies rather than asking only whether a tuple is billable',
  /classifyCustomerShippingMoney\(row\.selectedRateJson\)/.test(freezeBody));
// SCOPED to the malformed branch. The first version asserted `kind === 'malformed_known_version'`
// and `status: 'needs_review'` appeared SOMEWHERE in the body — satisfied by the unknown_version
// branch even after the malformed branch was reverted to a silent skip. The behavioural fixture
// caught that; this check did not. Evidence transferring to an unrelated line is the same decay
// that hit the cost-basis check earlier in this ticket.
// Anchored on `classification.` specifically. Two branches in this function share the shape —
// the primary classification check and the race-recovery path, which uses `raced.kind`. A regex
// matching either was satisfied by the race branch while the primary was reverted to a silent
// skip, so it passed a mutation the behavioural fixture caught. Both are now pinned separately.
check('the PRIMARY malformed branch enters review and is NEVER rewritten in place',
  /classification\.kind === 'malformed_known_version'\)[\s\S]{0,240}?status: 'needs_review'/
    .test(freezeBody));
check('the PRIMARY unknown-version branch likewise returns review',
  /classification\.kind === 'unknown_version'\)[\s\S]{0,240}?status: 'needs_review'/
    .test(freezeBody));
check('the race-recovery path also classifies rather than returning a bare skip',
  /raced\.kind === 'malformed_known_version'\)[\s\S]{0,200}?status: 'needs_review'/
    .test(freezeBody));
check('an unknown version enters review and is never overwritten',
  /kind === 'unknown_version'/.test(freezeBody)
  && !/update[\s\S]{0,200}unknown_version/.test(freezeBody));
check('a valid tuple still short-circuits as one-shot',
  /kind === 'valid_ps508' \|\| classification\.kind === 'valid_ps437'/.test(freezeBody)
  && /status: 'already_frozen'/.test(freezeBody));
// The caller must record review cases. A `needs_review` that nobody logs is the masquerade again,
// one level up.
check('the label writer records needs_review rather than discarding it',
  /outcome\.status === 'needs_review'/.test(persistBody));

check('the outbound freeze is one-shot (never re-decides an already-versioned tuple)',
  /customerShippingMoneyPolicyVersion/.test(freezeBody) && /not \(coalesce\(/.test(freezeBody));

// ── 3. WRITER INVENTORY ───────────────────────────────────────────────────────────────────

const srcFiles = walk('src');
const inserters: string[] = [];
let rawInserts = 0;
for (const file of srcFiles) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const count = (text.match(/\.insert\(shipments\)/g) ?? []).length;
  for (let i = 0; i < count; i += 1) inserters.push(file.replace(/\\/g, '/'));
  rawInserts += (text.match(/insert\s+into\s+shipments/gi) ?? []).length;
}

// A COUNT, deliberately. The point is not that seven is a magic number — it is that adding an
// eighth outbound shipments writer must not be possible without someone deciding whether it needs
// a freeze. This check failing is not a bug; it is the guard doing its job.
check('the shipments writer inventory is unchanged (7 insert sites in src/)',
  inserters.length === 7,
  `${inserters.length} found:\n     ${inserters.join('\n     ')}\n     If you ADDED a writer: decide whether it produces customer money, wire the freeze (or\n     document why it must not), then update this count.`);

check('no raw-SQL INSERT INTO shipments in src/ (every writer goes through drizzle)',
  rawInserts === 0, `${rawInserts} found`);

// ── 4. THE CUTOVER LANDED — ASSERT THE POST-CUTOVER ARCHITECTURE ─────────────────────────

// PS-508 W5/W6 landed 2026-08-24. This section previously asserted the PRE-cutover state —
// "billing still recomputes" / "billing does NOT yet read outbound tuples" — and stayed green
// straight through the cutover because its regexes matched by accident: the recompute call
// survived inside a thunk, and billing imports the accepted-version UNION so the _OUTBOUND
// constant name never appears in the file. The Hermes re-audit (2026-08-24, correction 3)
// flagged that as a guard asserting a stale architecture narrative while green.
// These are import-graph / structure checks only; the behavioural proof that Billing's real
// generator emits the frozen line is ps-508-billing-generates-frozen-line-pg17.ts.
const billingSrc = readFileSync('src/services/billing.ts', 'utf8');
check('billing imports the frozen-vs-recompute decision owner',
  /from '\.\/customer-shipping-money-billable-decision'/.test(billingSrc));

check('billing consults the per-client activation gate before the decision',
  /isFrozenTupleBillingEnabledForClient\(\{/.test(billingSrc)
  && /PS508_BILLING_FROZEN_TUPLE_CLIENTS/.test(billingSrc));

check('the legacy invoice-time calculation is LAZY — a thunk, not an eager per-shipment call',
  /const computeLegacyShippingDecision = \(\) => resolveCustomerShippingMoney\(\{/.test(billingSrc)
  && !/const shippingDecision = resolveCustomerShippingMoney\(/.test(billingSrc));

check('a held tuple surfaces as a visible review line, never a silent reprice',
  /Customer shipping money needs review/.test(billingSrc));

check('billing accepts the shared version union (which includes ps-508-v1), not a private list',
  /ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS/.test(billingSrc));

if (failures > 0) {
  console.log(`\nFAIL PS-508 outbound freeze guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPS-508 outbound freeze guard passed.');
