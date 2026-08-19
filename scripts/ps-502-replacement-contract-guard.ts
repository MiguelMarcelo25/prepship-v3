/**
 * PS-502 — replacement schema + lifecycle + financial-action contract.
 *
 * SCOPE. DJ supplied `unlock shipped data` for PS-502 on 2026-08-19. This guard pins the
 * resulting shipped/replacement safety boundaries without exercising them: it is offline,
 * inserts no fixtures, calls no provider, and mutates no database or production data.
 *
 * BEHAVIOURAL where it can be. The lifecycle is executed, not grepped: a guard that only
 * matched source text would pass against a state machine that allowed
 * `label_failed -> shipped`, which is the transition that would ship without a label.
 *
 * Offline and pure — no database, no network, no mutation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  assertReplacementTransition,
  canTransitionReplacement,
  evaluateReplacementSourceLineDrift,
  isReplacementPostShip,
  isReplacementTerminal,
  REPLACEMENT_ERROR_CODES,
  REPLACEMENT_STATUSES,
  ReplacementStateError,
  replacementTransitionsFrom,
  type ReplacementStatus,
} from '../src/services/replacement-state-machine';
import {
  buildReplacementSourceLineFingerprint,
  currentSourceLineFingerprint,
  findFrozenSkuElsewhere,
  REPLACEMENT_FINGERPRINT_VERSION,
} from '../src/services/replacement-source-line-fingerprint';
import {
  formatReplacementReference,
  nextReplacementReference,
  parseReplacementReference,
} from '../src/services/replacement-reference';
import {
  calculateReplacementAllowance,
  evaluateReplacementAllowance,
  type AllowanceRow,
} from '../src/services/replacement-allowance';
import { evaluateBillabilityChange } from '../src/services/replacement-billability';
import {
  FROZEN_DECISIONS,
  fingerprintPurchaseRequest,
  resolveReplacementPurchaseRequest,
  ReplacementPurchaseRequestError,
} from '../src/services/replacement-purchase-request';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

/**
 * "`a` appears, `b` appears, and `a` comes first."
 *
 * indexOf returns -1 when text is absent and -1 < anything is TRUE, so a bare
 * `at(a) < at(b)` PASSES when `a` has been deleted — which is exactly the mutation such a
 * check exists to catch. This has slipped through three times in this guard; ordering
 * assertions go through here now.
 */
/**
 * The text of ONE function, declaration to the next top-level export.
 *
 * A presence check reads the whole file, so the moment a SECOND function contains the same
 * line, deleting the first one's copy stops making the check red — the neighbour answers
 * for it. M73 had defended regeneration's `invoiced = false` term for nine commits and
 * silently stopped the day cancellation was added with a line of identical text. Nothing in
 * a green run showed it; only the matrix did.
 *
 * So a check that owns a predicate inside a specific function must read that function.
 */
/** Like functionBody, for a module-PRIVATE function. */
function functionBodyOf(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start === -1) {
    throw new Error(`functionBodyOf: ${name} not found — the check would pass on empty text`);
  }
  const next = source.indexOf('\nasync function ', start + 1);
  const alt = source.indexOf('\nexport ', start + 1);
  const ends = [next, alt].filter((n) => n !== -1);
  return ends.length ? source.slice(start, Math.min(...ends)) : source.slice(start);
}

function functionBody(source: string, name: string): string {
  // Both forms: a pure fence is synchronous, and a checker that silently could not find it
  // would pass on empty text — the failure this helper exists to prevent.
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

function occursBefore(haystack: string, a: string, b: string): boolean {
  const ia = haystack.indexOf(a);
  const ib = haystack.indexOf(b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

const read = (path: string) => {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
};

const replacementsSql = read('drizzle/0096_ps502_replacements.sql');
const billingSql = read('drizzle/0097_ps502_replacement_billing.sql');
// Hermes ruling C: replacement financial attribution became RESTRICT in a forward migration.
const restrictSql = read('drizzle/0098_ps502_replacement_financial_restrict.sql');
// Hermes re-audit correction 1: idempotency binds to the whole request, stored by 0099.
const signatureSql = read('drizzle/0099_ps502_replacement_request_signature.sql');
const financialActionsSql = read('drizzle/0103_ps502_replacement_financial_actions.sql');

// ── AC-2 — transitions enforced, illegal ones coded 409 ──────────────────────
console.log('\nlifecycle (executed, not grepped)');

check('the happy path is legal end to end', (
  ['requested', 'approved', 'label_created', 'shipped'] as ReplacementStatus[]
).every((from, i, arr) => i === arr.length - 1 || canTransitionReplacement(from, arr[i + 1]!))
  && canTransitionReplacement('shipped', 'completed'));

{
  // The transition that would ship goods with no label. Its absence is the point.
  check('label_failed -> shipped is ILLEGAL', !canTransitionReplacement('label_failed', 'shipped'));
  check('approved -> shipped is ILLEGAL (a label must exist first)',
    !canTransitionReplacement('approved', 'shipped'));
  check('review -> shipped is ILLEGAL (review blocks shipping)',
    !canTransitionReplacement('review', 'shipped'));
}

{
  // "cancelled/rejected terminal pre-ship" — so neither is reachable once shipped.
  for (const from of ['shipped', 'completed'] as ReplacementStatus[]) {
    check(`${from} cannot be cancelled`, !canTransitionReplacement(from, 'cancelled'));
    check(`${from} cannot be rejected`, !canTransitionReplacement(from, 'rejected'));
  }
  check('shipped only moves to completed',
    replacementTransitionsFrom('shipped').join(',') === 'completed');
}

{
  for (const terminal of ['completed', 'rejected', 'cancelled'] as ReplacementStatus[]) {
    check(`${terminal} is terminal (no outbound transitions)`,
      replacementTransitionsFrom(terminal).length === 0 && isReplacementTerminal(terminal));
  }
  check('shipped and completed are post-ship',
    isReplacementPostShip('shipped') && isReplacementPostShip('completed'));
  check('label_created is NOT post-ship (a label is not a shipment)',
    !isReplacementPostShip('label_created'));
}

{
  // An illegal move must raise the coded 409, not return false quietly.
  let err: unknown = null;
  try { assertReplacementTransition('label_failed', 'shipped'); } catch (e) { err = e; }
  check('an illegal transition throws a coded 409',
    err instanceof ReplacementStateError
    && (err as ReplacementStateError).code === REPLACEMENT_ERROR_CODES.STATE_CONFLICT
    && (err as ReplacementStateError).httpStatus === 409,
    err === null ? 'it returned instead of throwing' : String((err as Error).message));

  // A no-op that looks like progress is a bug, not a success.
  let selfErr: unknown = null;
  try { assertReplacementTransition('approved', 'approved'); } catch (e) { selfErr = e; }
  check('a self-transition is rejected rather than treated as a no-op',
    selfErr instanceof ReplacementStateError);
}

{
  const unreachable = REPLACEMENT_STATUSES.filter((to) =>
    to !== 'requested' && !REPLACEMENT_STATUSES.some((from) => canTransitionReplacement(from, to)));
  check('every non-initial status is reachable (no dead vocabulary)',
    unreachable.length === 0, `unreachable: ${unreachable.join(', ')}`);
}

// ── Section A — drift is detected, never silently retargeted ─────────────────
console.log('\nsource-line drift');

check('a matching fingerprint passes',
  evaluateReplacementSourceLineDrift({ frozenFingerprint: 'f1', currentFingerprint: 'f1' }).matches === true);

{
  const changed = evaluateReplacementSourceLineDrift({ frozenFingerprint: 'f1', currentFingerprint: 'f2' });
  check('a changed fingerprint is drift with the coded 409 and the review reason',
    changed.matches === false
    && changed.code === REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED
    && changed.reviewReason === 'original_order_line_drift');
}

{
  // The referenced line being GONE is one of the four drift cases. Absence must not read
  // as "unchanged" — that is the silent-retarget path.
  for (const [label, value] of [['null', null], ['undefined', undefined], ['empty', '']] as const) {
    const gone = evaluateReplacementSourceLineDrift({ frozenFingerprint: 'f1', currentFingerprint: value });
    check(`a ${label} current fingerprint is DRIFT, not a pass`, gone.matches === false);
  }
}

// ── Schema — the identity decisions the card froze ───────────────────────────
console.log('\nschema (0096 / 0097)');

check('0096 creates the three replacement tables',
  /create table if not exists replacements\b/.test(replacementsSql)
  && /create table if not exists replacement_items\b/.test(replacementsSql)
  && /create table if not exists replacement_activity_events\b/.test(replacementsSql));

check('replacement_items has NO foreign key to order_items',
  !/references\s+order_items/i.test(replacementsSql));

check('the volatile source coordinate is paired with a frozen fingerprint',
  /order_line_index integer not null/.test(replacementsSql)
  && /source_line_fingerprint text not null/.test(replacementsSql));

check('one shipment cannot belong to two replacements',
  /create unique index if not exists replacements_shipment_unq[\s\S]{0,160}where replacement_shipment_id is not null/.test(replacementsSql));

check('there is NO "one active replacement per order" unique index',
  !/unique index[^\n]*replacements\(order_id\)/.test(replacementsSql));

check('parent_replacement_id is frozen out', !/parent_replacement_id/.test(replacementsSql.replace(/--[^\n]*/g, '')));

check('an override must name who and why',
  /admin_override = false[\s\S]{0,120}admin_override_by is not null[\s\S]{0,60}admin_override_reason is not null/.test(replacementsSql));

check('activity events are append-only (RESTRICT, not CASCADE)',
  /replacement_activity_events[\s\S]*?replacement_id integer not null references replacements\(id\) on delete restrict/.test(replacementsSql));

check('quantity is a positive integer, matching the ledger',
  /quantity integer not null/.test(replacementsSql) && /quantity > 0/.test(replacementsSql));

check('0097 adds relational replacement identity to billing lines',
  /alter table billing_line_items[\s\S]{0,160}add column if not exists replacement_id integer references replacements\(id\)/.test(billingSql));

check('a description reword cannot mint a second replacement charge',
  /create unique index if not exists billing_li_replacement_line_unq[\s\S]{0,220}replace_postage[\s\S]{0,40}replace_pick_pack/.test(billingSql));

check('a replacement line without shipment_id AND replacement_id is rejected',
  /billing_li_replacement_identity_check[\s\S]{0,320}shipment_id is not null and replacement_id is not null/.test(billingSql));

check('credit notes carry replacement attribution (not parsed out of a reason string)',
  /alter table billing_credit_notes[\s\S]{0,160}add column if not exists replacement_id/.test(billingSql)
  && /billing_credit_notes_replacement_idx/.test(billingSql));

check('both migrations are additive and re-runnable',
  !/\bdrop\s+(table|column|constraint)\b/i.test(replacementsSql + billingSql)
  && !/\balter\s+column\b/i.test(replacementsSql + billingSql));

{
  // The card's numbers are 0092/0093, which were taken by PS-488, RLS, search_path and
  // PS-501 after REV 4 was written. Pin the renumber so nobody "restores" a collision.
  check('the migrations do not collide with existing numbers',
    read('drizzle/0092_ps488_return_identity_reconciliation.sql').length > 0
    && replacementsSql.length > 0 && billingSql.length > 0);
}

// ── Lockdown — this slice writes no shipped data ─────────────────────────────
console.log('\nlockdown scope');

{
  const stateMachine = read('src/services/replacement-state-machine.ts');
  check('the state machine is pure (no db, no fetch, no service imports)',
    !/from '\.\.\/db|drizzle-orm|node-fetch|axios/.test(stateMachine)
    && !/\bimport\b[^\n]*\bdb\b/.test(stateMachine));
  // The card's lockdown permits an FK that REFERENCES shipments ("referencing shipments.id
  // mutates nothing") but not writing shipment rows. Asserted against the MIGRATIONS rather
  // than against this file: a guard that greps its own source for a pattern necessarily
  // contains that pattern, so it can only ever fail itself — which is exactly what the
  // first version of this check did.
  const migrations = replacementsSql + billingSql;
  check('the migrations never write shipment rows (referencing shipments.id is allowed)',
    !/\b(insert\s+into|update|delete\s+from)\s+shipments\b/i.test(migrations));
  check('the migrations never write order or billing ROWS either (schema only)',
    !/\b(insert\s+into|update|delete\s+from)\s+(orders|billing_line_items|billing_credit_notes)\b/i.test(migrations));
}

// ── AC-15 — the line-drift matrix, executed ──────────────────────────────────
//
// Every case runs through the REAL builder and the REAL comparator. The card enumerates
// five, and requires each to "either resolve correctly or move to review with
// REPLACEMENT_SOURCE_LINE_CHANGED, and never silently retarget".
//
// Lines are modelled as order_items rows AFTER the sync trigger, which is what makes case 3
// meaningful: the trigger recomputes `line_index` as (ordinality - 1) over the raw array, so
// removing an EARLIER element renumbers everything after it.
console.log('\nline-drift matrix (AC-15)');

type Line = { orderId: number; lineIndex: number; sku: string; name?: string | null; quantity: number | string };
const ORDER = 4321;
const original: Line[] = [
  { orderId: ORDER, lineIndex: 0, sku: 'SKU-A', name: 'Widget A', quantity: 1 },
  { orderId: ORDER, lineIndex: 1, sku: 'SKU-B', name: 'Widget B', quantity: 2 },
  { orderId: ORDER, lineIndex: 2, sku: 'SKU-C', name: 'Widget C', quantity: 3 },
];
// Frozen at creation against the middle line.
const frozenCoord = { orderId: ORDER, orderLineIndex: 1 };
const frozen = buildReplacementSourceLineFingerprint({
  orderId: ORDER, orderLineIndex: 1, sku: 'SKU-B', name: 'Widget B', originalOrderedQuantity: 2,
});

const drifted = (lines: Line[]) =>
  evaluateReplacementSourceLineDrift({
    frozenFingerprint: frozen,
    currentFingerprint: currentSourceLineFingerprint(lines, frozenCoord),
  });

check('unchanged order resolves', drifted(original).matches === true);

check('a LATER line removed still resolves (the card calls this safe)',
  drifted(original.slice(0, 2)).matches === true);

{
  // The trigger renumbers, so dropping index 0 moves SKU-B to 0 and SKU-C to 1.
  const earlierRemoved: Line[] = [
    { orderId: ORDER, lineIndex: 0, sku: 'SKU-B', name: 'Widget B', quantity: 2 },
    { orderId: ORDER, lineIndex: 1, sku: 'SKU-C', name: 'Widget C', quantity: 3 },
  ];
  const verdict = drifted(earlierRemoved);
  check('an EARLIER line removed is DRIFT, not a silent retarget onto SKU-C',
    verdict.matches === false && verdict.code === REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED);
}

{
  const referencedRemoved: Line[] = [
    { orderId: ORDER, lineIndex: 0, sku: 'SKU-A', name: 'Widget A', quantity: 1 },
    { orderId: ORDER, lineIndex: 1, sku: 'SKU-C', name: 'Widget C', quantity: 3 },
  ];
  check('the REFERENCED line removed is DRIFT', drifted(referencedRemoved).matches === false);
}

{
  const reordered: Line[] = [
    { orderId: ORDER, lineIndex: 0, sku: 'SKU-C', name: 'Widget C', quantity: 3 },
    { orderId: ORDER, lineIndex: 1, sku: 'SKU-A', name: 'Widget A', quantity: 1 },
    { orderId: ORDER, lineIndex: 2, sku: 'SKU-B', name: 'Widget B', quantity: 2 },
  ];
  check('a REORDER is DRIFT', drifted(reordered).matches === false);
}

{
  // 🔴 The card's worst case: duplicate-SKU lines reordered, where "a SKU check falsely
  // passes on the wrong line". Same SKU, same name, DIFFERENT quantities, positions swapped.
  const dupFrozen = buildReplacementSourceLineFingerprint({
    orderId: ORDER, orderLineIndex: 1, sku: 'SKU-A', name: 'Widget A', originalOrderedQuantity: 5,
  });
  const swapped: Line[] = [
    { orderId: ORDER, lineIndex: 0, sku: 'SKU-A', name: 'Widget A', quantity: 5 },
    { orderId: ORDER, lineIndex: 1, sku: 'SKU-A', name: 'Widget A', quantity: 1 },
  ];
  const current = currentSourceLineFingerprint(swapped, frozenCoord);
  check('DUPLICATE-SKU REORDER is caught (the card\'s worst case)',
    evaluateReplacementSourceLineDrift({ frozenFingerprint: dupFrozen, currentFingerprint: current }).matches === false);
  // And the reason it is caught: a SKU-only comparison would have passed here.
  check('a SKU-only check WOULD have passed — which is why quantity is in the tuple',
    swapped[1]!.sku === 'SKU-A');
}

check('a shipped replacement\'s frozen fingerprint is a pure function of frozen facts',
  buildReplacementSourceLineFingerprint({
    orderId: ORDER, orderLineIndex: 1, sku: 'SKU-B', name: 'Widget B', originalOrderedQuantity: 2,
  }) === frozen);

// ── Fingerprint properties ───────────────────────────────────────────────────
console.log('\nfingerprint');

{
  const base = { orderId: 1, orderLineIndex: 0, name: 'n', originalOrderedQuantity: 1 };
  check('SKU case and surrounding space are not drift',
    buildReplacementSourceLineFingerprint({ ...base, sku: ' sku-a ' })
    === buildReplacementSourceLineFingerprint({ ...base, sku: 'SKU-A' }));

  check('numeric quantity representations are one value ("2" = 2 = "2.000")',
    buildReplacementSourceLineFingerprint({ ...base, sku: 's', originalOrderedQuantity: '2.000' })
    === buildReplacementSourceLineFingerprint({ ...base, sku: 's', originalOrderedQuantity: 2 })
    && buildReplacementSourceLineFingerprint({ ...base, sku: 's', originalOrderedQuantity: '2.0' })
    === buildReplacementSourceLineFingerprint({ ...base, sku: 's', originalOrderedQuantity: 2 }));

  check('a renamed line IS drift (names are editable; review is the intended cost)',
    buildReplacementSourceLineFingerprint({ ...base, sku: 's', name: 'before' })
    !== buildReplacementSourceLineFingerprint({ ...base, sku: 's', name: 'after' }));

  // Two genuinely different lines that a delimiter-joined format would render identically:
  // ['a','b|c','d'] and ['a','b','c|d'] both join to "a|b|c|d". A collision in a drift check
  // reads as "unchanged", which is the silent-retarget outcome. JSON escaping separates them.
  check('a separator inside a field cannot forge another line\'s fingerprint',
    buildReplacementSourceLineFingerprint({ ...base, sku: 'a', sourceItemId: 'b|c', name: 'd' })
    !== buildReplacementSourceLineFingerprint({ ...base, sku: 'a', sourceItemId: 'b', name: 'c|d' }));

  check('a durable source item id participates when present',
    buildReplacementSourceLineFingerprint({ ...base, sku: 's', sourceItemId: 'li_1' })
    !== buildReplacementSourceLineFingerprint({ ...base, sku: 's', sourceItemId: 'li_2' }));

  check('the format is versioned, so a layout change is deliberate not silent',
    buildReplacementSourceLineFingerprint({ ...base, sku: 's' }).includes(REPLACEMENT_FINGERPRINT_VERSION));
}

{
  // The card requires review to show "whether the frozen SKU appears elsewhere".
  const lines = [
    { lineIndex: 0, sku: 'SKU-A' }, { lineIndex: 1, sku: 'SKU-B' }, { lineIndex: 2, sku: 'sku-a' },
  ];
  check('review can tell "this line moved" from "this product is gone"',
    findFrozenSkuElsewhere(lines, { orderLineIndex: 1, sku: 'SKU-A' }).join(',') === '0,2');
  check('a frozen SKU with no other home reports nothing',
    findFrozenSkuElsewhere(lines, { orderLineIndex: 1, sku: 'SKU-Z' }).length === 0);
}

// ── AC-12 — reference allocation ─────────────────────────────────────────────
console.log('\nreference allocation (AC-12)');

check('the first replacement is the BARE form, never -1',
  formatReplacementReference('1321', 1) === '1321-REPLACE');
check('the second is -2', formatReplacementReference('1321', 2) === '1321-REPLACE-2');

check('references round-trip', (() => {
  const parsed = parseReplacementReference('1321-REPLACE-2');
  return parsed?.orderNumber === '1321' && parsed.sequence === 2;
})());

check('the bare form parses as sequence 1',
  parseReplacementReference('1321-REPLACE')?.sequence === 1);

check('order numbers containing hyphens survive the round trip', (() => {
  const parsed = parseReplacementReference('1321-A-REPLACE-3');
  return parsed?.orderNumber === '1321-A' && parsed.sequence === 3;
})());

{
  // Non-canonical spellings this module would never emit. Accepting one lets two rows claim
  // the same sequence while the UNIQUE index sees two distinct strings.
  for (const bad of ['1321-REPLACE-1', '1321-REPLACE-0', '1321-REPLACE-02', '-REPLACE', '1321', '1321-RETURN']) {
    check(`"${bad}" is rejected as a reference`, parseReplacementReference(bad) === null);
  }
}

check('allocation starts at the bare form', nextReplacementReference('1321', []) === '1321-REPLACE');
check('allocation increments', nextReplacementReference('1321', ['1321-REPLACE']) === '1321-REPLACE-2');
check('allocation increments past -2',
  nextReplacementReference('1321', ['1321-REPLACE', '1321-REPLACE-2']) === '1321-REPLACE-3');

check('a GAP is never reused (a cancelled replacement keeps its reference)',
  nextReplacementReference('1321', ['1321-REPLACE', '1321-REPLACE-3']) === '1321-REPLACE-4');

check('another order\'s references do not advance this order',
  nextReplacementReference('1321', ['9999-REPLACE', '9999-REPLACE-7']) === '1321-REPLACE');

{
  let threw = false;
  try { formatReplacementReference('1321', 0); } catch { threw = true; }
  check('a non-positive sequence is refused rather than emitted', threw);
  let blankThrew = false;
  try { nextReplacementReference('   ', []); } catch { blankThrew = true; }
  check('a blank order number is refused', blankThrew);
}

// ── Decision 5 — the cumulative cap counts SHIPPED UNITS only ────────────────
//
// Frozen by DJ's pinned comment, which supersedes the card description. The rule that
// matters: a cancelled or never-shipped replacement must not permanently reduce what a
// customer can be re-sent, because nothing left the warehouse.
console.log('\ncumulative cap (decision 5)');

const FP = 'frozen-line-1';
const row = (status: AllowanceRow['status'], quantity: number, shippedAt: Date | null = null): AllowanceRow =>
  ({ sourceLineFingerprint: FP, quantity, status, shippedAt });
const remainingOf = (rows: AllowanceRow[], original = 3) =>
  calculateReplacementAllowance({ originalOrderedQuantity: original, sourceLineFingerprint: FP, rows }).remaining;

check('DJ\'s new AC: ship 1 of 3, then 2 remain', remainingOf([row('shipped', 1)]) === 2);
check('completed consumes too', remainingOf([row('completed', 1)]) === 2);

{
  // Every status the decision explicitly excludes.
  for (const status of ['requested', 'approved', 'label_created', 'label_failed', 'cancelled', 'rejected'] as const) {
    check(`${status} does NOT consume allowance`, remainingOf([row(status, 3)]) === 3);
  }
}

check('DJ\'s new AC: cancelling a replacement leaves the allowance unchanged',
  remainingOf([row('shipped', 1), row('cancelled', 2)]) === 2);

check('a PRE-ship review consumes nothing', remainingOf([row('review', 3)]) === 3);
check('a POST-ship review DOES consume (it shipped, then drifted)',
  remainingOf([row('review', 1, new Date())]) === 2);

check('the cap aggregates on the FROZEN coordinate, not on whatever sits there now',
  calculateReplacementAllowance({
    originalOrderedQuantity: 3,
    sourceLineFingerprint: FP,
    rows: [row('shipped', 1), { sourceLineFingerprint: 'a-different-line', quantity: 3, status: 'shipped', shippedAt: new Date() }],
  }).remaining === 2);

check('allowance never goes negative (an override that already over-shipped leaves 0)',
  remainingOf([row('shipped', 9)]) === 0);

{
  const verdict = evaluateReplacementAllowance({
    originalOrderedQuantity: 3, sourceLineFingerprint: FP, rows: [row('shipped', 3)], requestedQuantity: 1,
  });
  check('exceeding the cap is refused with a code',
    verdict.allowed === false && verdict.code === 'REPLACEMENT_ALLOWANCE_EXCEEDED');
}

{
  const base = { originalOrderedQuantity: 3, sourceLineFingerprint: FP, rows: [row('shipped', 3)], requestedQuantity: 1 };
  check('an override requires a reason, not just the permission',
    evaluateReplacementAllowance({ ...base, override: { hasOverridePermission: true, reason: '  ' } }).allowed === false);
  check('an override requires the permission, not just a reason',
    evaluateReplacementAllowance({ ...base, override: { hasOverridePermission: false, reason: 'lost in transit' } }).allowed === false);
  const ok = evaluateReplacementAllowance({ ...base, override: { hasOverridePermission: true, reason: 'replacement_of_failed_replacement' } });
  check('permission AND reason together allow the override, flagged as one',
    ok.allowed === true && ok.viaOverride === true);
}

// ── Decision 7 — billability authority ───────────────────────────────────────
console.log('\nbillability authority (decision 7)');

const FINANCE = { permissions: ['replacements:billing', 'financials:write'] };
const OPERATOR = { permissions: ['replacements:create'] };

{
  const v = evaluateBillabilityChange({
    liabilityOwner: 'operator', status: 'approved', requestedBillable: true, actor: FINANCE, reason: 'client asked',
  });
  check('operator liability FORCES non-billable, even for finance',
    v.allowed === false && v.code === 'REPLACEMENT_BILLABLE_FORBIDDEN_FOR_OPERATOR_LIABILITY');
}

check('operator liability + billable=false is a no-op, not a privileged action',
  evaluateBillabilityChange({
    liabilityOwner: 'operator', status: 'approved', requestedBillable: false, actor: OPERATOR,
  }).allowed === true);

{
  const v = evaluateBillabilityChange({
    liabilityOwner: 'client', status: 'approved', requestedBillable: true, actor: FINANCE, reason: 'client damaged it',
  });
  check('client liability + both permissions + a reason is allowed',
    v.allowed === true && v.allowed === true && v.billable === true);
}

check('an operator cannot make a replacement billable',
  evaluateBillabilityChange({
    liabilityOwner: 'client', status: 'approved', requestedBillable: true, actor: OPERATOR, reason: 'because',
  }).allowed === false);

check('replacements:billing alone is not enough — financials:write is also required',
  evaluateBillabilityChange({
    liabilityOwner: 'client', status: 'approved', requestedBillable: true,
    actor: { permissions: ['replacements:billing'] }, reason: 'because',
  }).allowed === false);

{
  const v = evaluateBillabilityChange({
    liabilityOwner: 'client', status: 'approved', requestedBillable: true, actor: FINANCE, reason: '   ',
  });
  check('a written reason is required',
    v.allowed === false && v.code === 'REPLACEMENT_BILLABLE_REASON_REQUIRED');
}

{
  // Postage is committed at label_created, so the charge basis cannot move after it.
  const v = evaluateBillabilityChange({
    liabilityOwner: 'client', status: 'label_created', requestedBillable: true, actor: FINANCE, reason: 'late change',
  });
  check('billability is FROZEN from label_created onward',
    v.allowed === false && v.code === 'REPLACEMENT_BILLABLE_FROZEN');
  check('it is still editable at requested and review',
    evaluateBillabilityChange({ liabilityOwner: 'client', status: 'requested', requestedBillable: true, actor: FINANCE, reason: 'r' }).allowed === true
    && evaluateBillabilityChange({ liabilityOwner: 'client', status: 'review', requestedBillable: true, actor: FINANCE, reason: 'r' }).allowed === true);
}

{
  const v = evaluateBillabilityChange({
    liabilityOwner: 'client', status: 'approved', requestedBillable: true, actor: FINANCE, reason: 'r', finalized: true,
  });
  check('after finalization it is never rewritten — it becomes an adjustment',
    v.allowed === false && v.code === 'REPLACEMENT_BILLABLE_FINALIZED');
}

// ── The Drizzle schema must MIRROR the migration, in both directions ─────────
//
// returns.ts records the failure this prevents: "a Drizzle column that does not exist in the
// database makes even a bare select() emit it and 500 the route". The reverse gap is quieter
// and worse — a column the migration created but the schema omits is simply invisible to
// every typed query, so `source_line_fingerprint` could sit populated in the database while
// the drift check reads undefined.
console.log('\ndrizzle schema mirrors the migration');

{
  const schemaSource = read('src/db/schema/replacements.ts');

  const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  /** Column names declared in one pgTable body, whether named explicitly or inferred. */
  const schemaColumns = (table: string): Set<string> => {
    const start = schemaSource.indexOf(`pgTable(\n  '${table}'`);
    if (start === -1) return new Set();
    const body = schemaSource.slice(start, schemaSource.indexOf('\n  (t) => [', start));
    const found = new Set<string>();
    for (const m of body.matchAll(/^\s{4}(\w+):\s*(?:serial|bigint|integer|numeric|text|boolean|timestamp)\(\s*(?:'([^']+)')?/gm)) {
      found.add(m[2] ?? snake(m[1]!));
    }
    return found;
  };

  /**
   * Column names for one table across EVERY migration that touches it — the `create table`
   * body plus any later `add column`. Reading only the create would report a column added by
   * a follow-up migration as "declared in Drizzle but absent from the database", which is the
   * exact false alarm that teaches people to weaken this check.
   */
  const migrationColumns = (table: string): Set<string> => {
    const found = new Set<string>();
    const migrationSources = [replacementsSql, billingSql, restrictSql, signatureSql,
      financialActionsSql];
    const createSource = migrationSources.find((source) =>
      source.includes(`create table if not exists ${table} (`)) ?? '';
    const start = createSource.indexOf(`create table if not exists ${table} (`);
    if (start !== -1) {
      const body = createSource.slice(start, createSource.indexOf('\n);', start));
      for (const m of body.matchAll(/^\s{2}(\w+)\s+(?:serial|bigint|integer|numeric|text|boolean|timestamptz)\b/gm)) {
        if (m[1] !== 'constraint') found.add(m[1]!);
      }
    }
    for (const sql of migrationSources) {
      const pattern = new RegExp(
        `alter table ${table}\\s+add column(?: if not exists)? (\\w+)`,
        'gi',
      );
      for (const m of sql.matchAll(pattern)) found.add(m[1]!);
    }
    return found;
  };

  for (const table of [
    'replacements',
    'replacement_items',
    'replacement_activity_events',
    'replacement_financial_actions',
  ]) {
    const inSchema = schemaColumns(table);
    const inMigration = migrationColumns(table);
    check(`${table}: the migration has columns to compare`, inMigration.size > 0);

    const missingFromSchema = [...inMigration].filter((c) => !inSchema.has(c));
    check(`${table}: every migration column is declared in Drizzle`,
      missingFromSchema.length === 0,
      `invisible to every typed query: ${missingFromSchema.join(', ')}`);

    const missingFromMigration = [...inSchema].filter((c) => !inMigration.has(c));
    check(`${table}: Drizzle declares NO column the migration lacks`,
      missingFromMigration.length === 0,
      `these would 500 a bare select(): ${missingFromMigration.join(', ')}`);
  }

  check('the schema declares no CHECK constraint (those are migration-owned)',
    !/\bcheck\(/.test(schemaSource),
    'a constraint declared in two places is one that can disagree with itself');

  // 0097's columns land on billing tables, so they are asserted against billing.ts.
  const billingSchema = read('src/db/schema/billing.ts');
  check('billing_line_items.replacement_id is mapped',
    /replacementId: integer\('replacement_id'\)/.test(billingSchema));
  check('billing_credit_notes.replacement_id is mapped',
    (billingSchema.match(/replacementId: integer\('replacement_id'\)/g) || []).length === 2,
    'correction C needs it on credit notes too, not only on line items');
  // Hermes ruling C. A billing line and a credit note are financial history: deleting the
  // subject must not silently null its attribution, because SET NULL turns durable evidence
  // into "not yet attributed" — factually wrong, since the row WAS attributed.
  check('both replacement financial FKs are ON DELETE RESTRICT',
    (billingSchema.match(/replacementId: integer\('replacement_id'\)\.references\(\(\) => replacements\.id, \{\s*onDelete: 'restrict',\s*\}\)/g) || []).length === 2,
    'ruling C reversed 0097; the schema must match 0098');

  check('0098 makes both FKs RESTRICT in the database, not just in Drizzle',
    /billing_line_items[\s\S]{0,200}references replacements\(id\) on delete restrict/.test(restrictSql)
    && /billing_credit_notes[\s\S]{0,200}references replacements\(id\) on delete restrict/.test(restrictSql),
    'editing Drizzle ahead of the database is the failure 0097 already caused once');

  check('0099 stores the whole-request signature a retry compares against',
    /alter table replacements\s+add column if not exists request_signature text/i.test(signatureSql),
    'reconstructing it from the row would reassemble the request from its effects');

  check('0098 gives activity events somewhere to keep a written reason',
    /alter table replacement_activity_events\s+add column if not exists detail text/i.test(restrictSql),
    'decision 7 requires a reason; validating one and discarding it is worse than not asking');

  check('0103 is an append-only retry authority with strict identity and completion shape',
    /create table if not exists replacement_financial_actions/.test(financialActionsSql)
    && /replacement_id integer not null references replacements\(id\) on delete restrict/.test(financialActionsSql)
    && /client_id integer not null references clients\(id\) on delete restrict/.test(financialActionsSql)
    && /unique index if not exists replacement_financial_actions_idempotency_unq/.test(financialActionsSql)
    && /status in \('pending', 'processing', 'retry', 'completed', 'review_required'\)/.test(financialActionsSql)
    && /\(status = 'completed'\) = \(completed_at is not null\)/.test(financialActionsSql),
    'a process-death obligation needs durable identity, retry states, and an unambiguous completed fact');

  check('0103 exposes no public Data-API write surface',
    /alter table replacement_financial_actions enable row level security/.test(financialActionsSql)
    && !/create policy/i.test(financialActionsSql),
    'the server owns financial-action writes; the public schema must not grant a parallel writer');
}

// ── "do not charge for this replacement" ─────────────────────────────────────
console.log('\ncancelling a replacement charge');

{
  const owner = read('src/services/replacement-charge-cancellation.ts');
  const routes = read('src/routes/replacements.ts');
  const routeCode2 = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const holdSrc = read('src/services/replacement-original-order-hold.ts');
  const lifecycle = read('src/services/replacement-lifecycle-command.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const financial = read('src/services/replacement-financial-action.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const directCancel = functionBody(lifecycle, 'cancelReplacement');
  const reviewResolution = functionBody(lifecycle, 'resolveReplacementReview');
  const cleanup = functionBody(financial, 'completePreShipCancellationCleanupInTransaction');

  check('the charge-cancellation owner is OUTSIDE the billing writer',
    /export async function cancelReplacementCharges/.test(owner),
    'the writer is transaction-parasitic so the shipped command can roll a billing failure back with the stock; an owner that opens its own transaction cannot live there');

  check('the compatibility owner removes editable lines, then settles invoiced ones AFTER the commit',
    /conn\.transaction\([\s\S]{0,160}cancelReplacementBillingInTransaction/.test(owner)
    && /settleReplacementCancellationCredits\(/.test(owner)
    // The early return must be the NOTHING-INVOICED case only. Widening it to `>= 0` left
    // the settle call in place and unreachable.
    && /if \(removal\.invoicedRetained === 0\) \{/.test(owner)
    && occursBefore(owner, 'cancelReplacementBillingInTransaction',
      'settleReplacementCancellationCredits')
    && /settleReplacementCancellationCredits\([\s\S]*?\n\s*conn,\s*\n\s*\)/.test(owner),
    'the reconciler takes the CLIENT lock while replacement commands hold the ORDER one');

  check('pre-ship cancellation cleans its charge BEFORE the lifecycle move in ONE transaction',
    /conn\.transaction\(async \(tx\)/.test(directCancel)
    && /^ {4}await completePreShipCancellationCleanupInTransaction\(tx, \{$/m.test(directCancel)
    && occursBefore(directCancel, 'completePreShipCancellationCleanupInTransaction(tx, {',
      'await applyTransition(tx, before, {')
    && !/cancelReplacementCharges/.test(routeCode2),
    'a process death must roll back both the cleanup fact and cancelled status, never strand one behind the other');

  check('resolving a review INTO cancelled uses the SAME atomic cleanup boundary',
    /if \(input\.to === 'cancelled'\) \{[\s\S]{0,260}await completePreShipCancellationCleanupInTransaction\(tx, \{/.test(reviewResolution)
    && /^ {6}await completePreShipCancellationCleanupInTransaction\(tx, \{$/m.test(reviewResolution)
    && occursBefore(reviewResolution, 'completePreShipCancellationCleanupInTransaction(tx, {',
      'await applyTransition(tx, before, {'),
    'reaching cancelled by a different door does not make it a different money decision');

  check('pre-ship cleanup is replacement-scoped, refuses finalized money, and records completion atomically',
    /cancelReplacementBillingInTransaction\(tx, \{[\s\S]{0,80}replacementId: input\.replacement\.id/.test(cleanup)
    && /if \(removal\.invoicedRetained > 0\)/.test(cleanup)
    && /actionType: 'pre_ship_cancellation_cleanup'/.test(cleanup)
    && /status: 'completed'/.test(cleanup)
    && /completedAt: new Date\(\)/.test(cleanup),
    'pre-ship cancellation is not the shipped financial-reversal path and cannot erase invoice history');

  check('the sweep does not pretend it can owe a credit',
    /finalizedCreditOwed: false,/.test(holdSrc)
    && !/finalizedCreditOwed: billing\.invoicedRetained > 0/.test(holdSrc),
    'the branch above sends anything carrying invoiced money to review, so deriving this from invoicedRetained read as careful and could never be true');
}

// ── the customer-money freeze site ───────────────────────────────────────────
console.log('\nAC-10 freeze site');

{
  const money = read('src/services/customer-shipping-money.ts');
  const freeze = functionBody(money, 'freezeReplacementCustomerShippingMoney');
  const buy = read('src/services/replacement-label-purchase-command.ts');
  const buyCode = buy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('a replacement has its OWN freeze, not the return one relaxed',
    /export async function freezeReplacementCustomerShippingMoney/.test(money)
    && /eq\(shipments\.isReturn, false\)/.test(freeze),
    'the return freeze is double-gated on isReturn; admitting an outbound shipment to it would make every reader asking \'is this a return?\' start answering wrongly');

  check('it does NOT demand return-only policy',
    !/requireExplicitReturnPolicy/.test(freeze),
    'a replacement is an outbound shipment and the client\'s ordinary markup is the right policy; demanding a separate return rate would leave every replacement unbillable');

  check('the money is frozen ONCE and never re-decided',
    /not \(coalesce\(\$\{shipments\.selectedRateJson\}, '\{\}'::jsonb\) \? 'customerShippingMoneyPolicyVersion'\)/.test(freeze)
    && (freeze.match(/readFrozenReplacementCustomerShippingMoney\(/g) ?? []).length >= 3,
    'a markup edited next week must not change what a shipped label cost the client');

  check('the replacement freeze records exact pricing authority from the receipt transaction',
    /decideCustomerShippingMoneyForRow\(row, \{ exec \}\)/.test(freeze)
    && /customerShippingPricingAuthority: decision\.customerShippingPricingAuthority/.test(freeze),
    'a global cached markup or a missing billing_config row cannot authorize replacement money');

  check('the purchase freezes customer money in the same commit as the label',
    /freezeReplacementCustomerShippingMoney\(input\.shipmentId, sp\)/.test(buyCode)
    && occursBefore(buyCode, 'update(shipments)',
      'freezeReplacementCustomerShippingMoney(input.shipmentId, sp)'),
    'the carrier receipt and what the client pays must become true together');

  check('it is attempted in a SAVEPOINT, and a failure keeps the label',
    /tx\.transaction\(async \(sp: never\) =>/.test(buyCode)
    && /reviewReason: 'replacement_customer_money_unavailable'/.test(buyCode),
    'a failed statement aborts the whole PostgreSQL transaction, so a plain catch left every later write failing; and the label is real and already paid for');
}

// ── a purchased label becomes recorded state ─────────────────────────────────
console.log('\npaid-label recovery');

{
  const purchase = read('src/services/replacement-label-purchase-command.ts');
  const purchaseCode = purchase.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const voidCmd = read('src/services/replacement-label-void-command.ts');
  const voidCode = voidCmd.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const recorder = functionBody(purchaseCode, 'recordPurchasedReplacementLabelInTransaction');
  const contextLoader = functionBodyOf(purchaseCode, 'loadReplacementLabelContextInTransaction');
  const recovery = functionBody(voidCode, 'reconcileReplacementPurchaseIntent');
  const replayPrefix = recorder.slice(0,
    recorder.indexOf("if (before.intent.state !== 'provider_pending'"));
  const foundStart = recovery.indexOf('if (found) {');
  const foundBranch = recovery.slice(foundStart,
    recovery.indexOf('\n    const before = await readReplacementLabelIntentInTransaction', foundStart));

  check('ONE owner records that a label happened',
    /export async function recordPurchasedReplacementLabelInTransaction/.test(purchase),
    'recovery reimplemented a subset of it and drifted — the intent resolved while the shipment and the status did not');

  check('it does every part of what the label MEANS',
    /replacementLabelPurchaseIntents/.test(recorder)
    && /update\(shipments\)/.test(recorder)
    && /findFrozenLineDrift/.test(recorder)
    && /status: 'label_created'/.test(recorder)
    && /eventType: 'replacement_label_created'/.test(recorder),
    'intent receipt, shipment receipt, in-flight drift, guarded transition, one event');

  check('intent-derived order locking precedes the intent row lock and every receipt mutation',
    /join replacements r on r\.id = i\.replacement_id/.test(contextLoader)
    && occursBefore(contextLoader, 'pg_advisory_xact_lock', ".for('update')")
    && occursBefore(recorder, 'loadReplacementLabelContextInTransaction(tx, input)',
      'tx.update(replacementLabelPurchaseIntents)'),
    'a caller id must never select one order lock while the intent mutates another replacement');

  check('the intent, replacement and shipment must form one replacement-owned chain',
    /replacement\.replacementShipmentId === intent\.replacementShipmentId/.test(contextLoader)
    && /shipment\.orderId === null/.test(contextLoader)
    && /shipment\.clientId === replacement\.clientId/.test(contextLoader)
    && /shipment\.orderNumber === replacement\.reference/.test(contextLoader)
    && /shipment\.source === 'replacement'/.test(contextLoader),
    'a matching numeric shipment id alone is not ownership');

  check('BOTH callers use it — the purchase and the recovery',
    /await recordPurchasedReplacementLabelInTransaction\(tx, \{/.test(purchaseCode)
    && /await recordPurchasedReplacementLabelInTransaction\(tx, \{/.test(voidCode),
    'a provider-confirmed interrupted purchase owes exactly what an ordinary one owes');

  check('a purchased replay returns the complete durable receipt without another write or event',
    /if \(before\.intent\.state === 'purchased'\) \{[\s\S]{0,100}recordedResultFromContext\(before, false\)/.test(replayPrefix)
    && !/\.update\(|\.insert\(/.test(replayPrefix)
    && /receipt: durableReceiptFromContext\(context\)/.test(purchaseCode),
    'a replay must not call the provider, append another event, or return a receipt reconstructed from request input');

  check('the recorder claims only unresolved intents and a stale loser returns the purchased winner',
    /state\} in \('provider_pending', 'reconcile_required'\)/.test(recorder)
    && /if \(!claimed\) \{[\s\S]{0,180}loadReplacementLabelContextInTransaction\(tx, input\)/.test(recorder)
    && /winner\.intent\.state === 'purchased'[\s\S]{0,80}recordedResultFromContext\(winner, false\)/.test(recorder),
    'a late failure or recovery must never downgrade a receipt another transaction already recorded');

  check('provider-confirmed recovery delegates directly to the recorder in ONE transaction',
    foundStart !== -1
    && /recordPurchasedReplacementLabelInTransaction\(tx, \{/.test(foundBranch)
    && /reconciliation: \{ reason \}/.test(foundBranch)
    && !/\.update\(replacementLabelPurchaseIntents\)/.test(foundBranch),
    'pre-mutating the intent and then failing to record the shipment recreates the split this closes');

  check('the label event key is SHARED between both callers',
    /idempotencyKey: `replacement:\$\{before\.replacement\.id\}:label:\$\{input\.intentId\}`/.test(recorder),
    'they record the same fact about the same intent, so whichever arrives first wins');
}

// ── who decides how much stock moves ─────────────────────────────────────────
console.log('\ninventory quantity authority');

{
  const shipped = read('src/services/replacement-shipped-command.ts');
  const shippedCode = shipped.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lineType = shippedCode.slice(
    shippedCode.indexOf('export type ReplacementInventoryLine'),
    shippedCode.indexOf('};', shippedCode.indexOf('export type ReplacementInventoryLine')),
  );

  check('the caller has NOWHERE to put a quantity',
    !/\bqty\b/.test(lineType),
    'a validated number is still the caller\'s number; the next caller would have to be trusted again');

  // Pinned by the deduction loop's SHAPE, not by a bare `for (const item of items) {` header.
  // That header also opens the inventory-authority loop above it, so the bare form stayed green
  // while the deduction itself was rewritten to walk the caller's array — the mutation survived
  // against a check written to stop exactly that. The proximity bound is a bound on the deduction
  // body, which now carries a corruption assertion and is ~700 characters long.
  check('the deduction iterates the FROZEN items, not the caller\'s lines',
    /for \(const item of items\) \{\s*\n\s*const stock = validatedInventoryByItem\.get\(item\.id\)!;/.test(shippedCode)
    && !/for \(const line\w* of input\.inventoryLines\) \{[\s\S]{0,900}applyInventoryMovementInTransaction/.test(shippedCode),
    'iterating the caller\'s array is what let an extra line move stock nobody froze');

  check('the quantity comes from the frozen row',
    /qty: -item\.quantity,/.test(shippedCode)
    && !/Math\.abs\(Math\.trunc\(line\.qty\)\)/.test(shippedCode),
    'a replacement frozen at one unit deducted seven when the caller said seven');

  check('one mapping per frozen item, and only this replacement\'s items',
    /REPLACEMENT_INVENTORY_DUPLICATE_MAPPING/.test(shippedCode)
    && /REPLACEMENT_INVENTORY_UNKNOWN_ITEM/.test(shippedCode)
    && /mappingByItem\.has\(line\.replacementItemId\)/.test(shippedCode)
    && /frozenIds\.has\(line\.replacementItemId\)/.test(shippedCode),
    'the idempotency key includes the inventory id, so two mappings with different inventory records deduct twice and the ledger has no reason to refuse');
}

// ── code can reach production before its schema ──────────────────────────────
console.log('\nschema-absent safety');

{
  const probe = read('src/services/replacement-schema-readiness.ts');
  // Comment-stripped for the negative assertion below: the docblock NAMES the flag while
  // explaining why it is not used, and a guard that trips on its own reasoning forces the
  // next engineer to delete the reasoning to get green.
  const probeCode = probe.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const upstreamSrc = read('src/services/fulfillment/upstream-reconcile.ts');
  const foldSrc = read('src/services/billing-replacement-finalized-fold.ts');
  const lifecycleSrc = read('src/services/order-lifecycle-command.ts');
  const financialSrc = read('src/services/replacement-financial-action.ts');

  check('every PRE-EXISTING path probes only the replacement dependency it reads',
    /replacementSchemaPresent\(/.test(lifecycleSrc)
    && /replacementSchemaPresent\(/.test(upstreamSrc)
    && /billingLineItemsHasReplacementIdColumn\(conn\)/.test(foldSrc)
    && !/replacementSchemaPresent\(/.test(foldSrc),
    'AC-16 needs the 0096-0101 hold set; finalized billing needs only 0097 and must not be disabled by an unrelated missing hold table');

  check('the probe answers SCHEMA presence, never the feature flag',
    !/REPLACEMENTS_ENABLED/.test(probeCode),
    'a migrated database with the surface switched off must still raise holds, and an unmigrated one must skip regardless of the flag');

  check('an explicit connection is never served from the memo',
    /if \(conn\) return probe\(conn\);/.test(probe),
    'the singleton points at production while the harness runs embedded; one shared memo lets a test answer for the real database');

  check('a NEGATIVE answer is never remembered',
    /if \(!found\) present = null;/.test(probeCode),
    'a process that booted before the migration lane cached false and kept returning it afterwards, so a migrated database looked unmigrated until restart');

  check('the probe is schema-qualified and covers what its callers touch',
    /to_regclass\('replacements'\)/.test(probeCode)
    && /to_regclass\('replacement_activity_events'\)/.test(probeCode)
    && /to_regclass\('replacement_label_purchase_intents'\)/.test(probeCode)
    && /to_regclass\('replacement_original_order_holds'\)/.test(probeCode)
    && /column_name = 'request_signature'/.test(probeCode)
    && /column_name = 'detail'/.test(probeCode)
    && /column_name = 'replacement_id'/.test(probeCode)
    && /table_schema = current_schema\(\)/.test(probeCode),
    'a bare table_name lookup finds a same-named table in another schema, and `replacements` alone does not prove 0097\'s column or 0101\'s holds table');

  check('the canonical invoice totals probe on the CALLER\'s connection',
    /billingLineItemsHasReplacementIdColumn\(conn\)/.test(
      read('src/services/billing-invoice-totals.ts')),
    'this owner runs for every client on every database; an unguarded replacement_id crashed the canonical totals with the feature switched off');

  check('a failed probe is not cached as absent',
    /present = null; throw error;/.test(probe),
    'one transient error would otherwise disable every replacement path until restart');

  check('0103 readiness is positive-only and explicit connections are never memoized',
    /if \(conn !== db\) return probeFinancialActionSchema\(conn\)/.test(financialSrc)
    && /if \(!present\) defaultSchemaPresence = null/.test(financialSrc)
    && /defaultSchemaPresence = null;[\s\S]{0,40}throw error/.test(financialSrc)
    && /REPLACEMENT_FINANCIAL_SCHEMA_NOT_READY/.test(financialSrc),
    'flags-off old-schema boot stays safe, while a migration or injected harness becomes visible without restart');
}

// ── item 14: what an operator can see ────────────────────────────────────────
console.log('\nitem 14 — operator diagnostics');

{
  const diag = read('src/services/replacement-diagnostics.ts');
  const diagCode = diag.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('diagnostics is READ ONLY',
    !/\.insert\(|\.update\(|\.delete\(|\binsert into\b|\bupdate \b|\bdelete from\b/i.test(diagCode),
    'a tool that could also fix things would be a second way to change state, without the locks, guards and events the commands carry');

  check('it reports, and never resolves',
    !/replacement-lifecycle-command|replacement-label|replacement-shipped|original-order-hold/.test(diagCode),
    'an operator acts through the ordinary commands so the audit trail stays true');

  check('the money-losing states are all covered',
    ['shipped_without_billing', 'unresolved_label_purchase_intent', 'void_reconcile_required']
      .every((kind) => diagCode.includes(kind)),
    'these are the three ways real money moves with nothing downstream noticing');

  check('the unbilled-shipment query is scoped to BILLABLE replacements',
    /r\.billable = true[\s\S]{0,200}not exists \([\s\S]{0,120}billing_line_items/.test(diagCode),
    'a non-billable replacement writing no line is correct behaviour, not an anomaly — reporting it would train operators to ignore the list');

  // Counted inside the CATALOGUE only: meaning/action also appear where each entry is
  // copied onto the result, which made the totals differ by one for a correct file.
  const catalogue = diagCode.slice(diagCode.indexOf('const CATALOGUE'),
    diagCode.indexOf('export async function collectReplacementDiagnostics'));
  check('every anomaly carries what it means and what to do',
    (catalogue.match(/meaning:/g) ?? []).length === (catalogue.match(/action:/g) ?? []).length
    && (catalogue.match(/kind: '/g) ?? []).length === (catalogue.match(/severity: '/g) ?? []).length
    && (catalogue.match(/kind: '/g) ?? []).length >= 6
    && (catalogue.match(/meaning:/g) ?? []).length
       === (catalogue.match(/kind: '/g) ?? []).length + 1
    // Counting the FIELDS is not enough: an empty string is still a field, and M98 emptied
    // one while every count stayed correct. Substance, not presence.
    && !/(meaning|action):\s*'',/.test(catalogue)
    && !/(meaning|action):\s*\n?\s*''/.test(catalogue),
    'a count named void_reconcile_required tells the person reading it at 2am nothing');

  check('classes with nothing wrong are OMITTED, and healthy is explicit',
    /if \(count === 0\) continue;/.test(diagCode)
    && /healthy: anomalies\.length === 0/.test(diagCode),
    'a list of zeroes stops being read, and an empty list must not be mistakable for a run that failed');

  check('the sample is a signal, not an export',
    /\[1:10\]/.test(diagCode),
    'enough ids to go and look, never the whole set');
}

// ── item 13: the HTTP surface ────────────────────────────────────────────────
console.log('\nthe HTTP surface');

{
  const route = read('src/routes/replacements.ts');
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const main = read('src/main.ts');
  const auth = read('src/middleware/auth.ts');
  const envSource = read('src/lib/env.ts');
  const financial = read('src/services/replacement-financial-action.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const requestReversal = functionBody(financial, 'requestReplacementFinancialReversal');
  const purchaseAt = routeCode.indexOf("'/:id{[0-9]+}/label/purchase'");
  const retryAt = routeCode.indexOf("'/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/retry'");
  const purchaseReconcileAt = routeCode.indexOf("'/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/reconcile'");
  const pricingReconcileAt = routeCode.indexOf("'/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/pricing-reconcile'");
  const voidReconcileAt = routeCode.indexOf("'/:id{[0-9]+}/label/purchase-intents/:intentId{[0-9]+}/void/reconcile'");
  const voidAt = routeCode.indexOf("'/:id{[0-9]+}/label/void'");
  const shipAt = routeCode.indexOf("'/:id{[0-9]+}/ship'");
  const reversalAt = routeCode.indexOf("'/:id{[0-9]+}/financial-reversal'");
  const purchaseRoute = purchaseAt === -1 || retryAt === -1 ? '' : routeCode.slice(purchaseAt, retryAt);
  const retryRoute = retryAt === -1 || purchaseReconcileAt === -1
    ? '' : routeCode.slice(retryAt, purchaseReconcileAt);
  const purchaseReconcileRoute = purchaseReconcileAt === -1 || pricingReconcileAt === -1
    ? '' : routeCode.slice(purchaseReconcileAt, pricingReconcileAt);
  const pricingReconcileRoute = pricingReconcileAt === -1 || voidReconcileAt === -1
    ? '' : routeCode.slice(pricingReconcileAt, voidReconcileAt);
  const voidReconcileRoute = voidReconcileAt === -1 || voidAt === -1
    ? '' : routeCode.slice(voidReconcileAt, voidAt);
  const voidRoute = voidAt === -1 || shipAt === -1 ? '' : routeCode.slice(voidAt, shipAt);
  const shipRoute = shipAt === -1 || reversalAt === -1 ? '' : routeCode.slice(shipAt, reversalAt);
  const reversalRoute = reversalAt === -1 ? '' : routeCode.slice(reversalAt);
  const labelRoutes = [
    [purchaseRoute, 'purchaseLabelBody'],
    [retryRoute, 'retryLabelBody'],
    [purchaseReconcileRoute, 'reconcileLabelBody'],
    [pricingReconcileRoute, 'reconcileLabelBody'],
    [voidReconcileRoute, 'reconcileLabelBody'],
    [voidRoute, 'voidLabelBody'],
  ] as const;
  const reversalPreHandler = reversalRoute.slice(0, reversalRoute.indexOf('async (c) =>'));
  const reversalRequestAt = reversalRoute.indexOf('await deps.requestFinancialReversal({');
  const reversalBeforeRequest = reversalRequestAt === -1 ? '' : reversalRoute.slice(0, reversalRequestAt);
  const shipBodyAt = routeCode.indexOf('const shipBody = z.object({');
  const financialBodyAt = routeCode.indexOf('const financialReversalBody', shipBodyAt);
  const shipBody = shipBodyAt === -1 || financialBodyAt === -1
    ? ''
    : routeCode.slice(shipBodyAt, financialBodyAt);

  check('a PS-502 error keeps its status when it reaches the global handler',
    /coded\.httpStatus \?\? coded\.status \?\? 500/.test(main),
    'every PS-502 class names the field httpStatus; reading only `status` turned a deliberate 403 into a 500 that logged as unhandled');

  check('the router is in protectedPrefixes, not merely mounted',
    /^\s*'\/replacements',$/m.test(main.slice(main.indexOf('const protectedPrefixes'),
      main.indexOf(']', main.indexOf('const protectedPrefixes'))))
    && /app\.route\('\/replacements', replacementsRoute\)/.test(main),
    'app.route does NOT attach requireAuth; two features have shipped unauthenticated by missing the allowlist entry');

  check('the WHOLE router is gated, with a code distinct from not-found',
    /app\.use\('\*', async \(c, next\) => \{[\s\S]{0,300}REPLACEMENTS_ENABLED/.test(routeCode)
    && /REPLACEMENTS_DISABLED[\s\S]{0,40}403/.test(routeCode),
    'a per-handler gate is one revert away from protecting five routes of six; and a bare 404 could not be told apart from a missing replacement');

  check('both replacement feature flags remain DEFAULT OFF',
    /REPLACEMENTS_ENABLED: booleanFlag\(false\)/.test(envSource)
    && /REPLACEMENTS_LABEL_ENABLED: booleanFlag\(false\)/.test(envSource),
    'shipping code may be mounted without enabling operator access or postage purchase');

  check('every route denies portal roles outright',
    /requireInternalPermission\(/.test(routeCode)
    && !/[^l]requirePermission\(/.test(routeCode),
    'replacements are an operator surface; requirePermission alone would admit a client portal session');

  check('every replacement permission is DECLARED in the vocabulary',
    ['replacements:read', 'replacements:write', 'replacements:hold',
     'replacements:label', 'replacements:override', 'replacements:billing', 'financials:write']
      .every((perm) => auth.includes(`'${perm}'`)),
    'a permission a service demands but the vocabulary never names is one nobody can be granted deliberately');

  check('scope is DELEGATED to the order-scope owner',
    /from '\.\.\/lib\/order-scope'/.test(route)
    && /isOrderRowInScope\(/.test(routeCode)
    && /orderScopePredicate\(/.test(routeCode),
    'that owner exists because /rates/browse could read any tenant\'s order; a second copy is a second thing to get wrong');

  // Scoped to the LOAD path: the feature gate legitimately answers 403 now, so a file-wide
  // "no 403 anywhere" assertion would be asserting the wrong thing.
  check('an out-of-scope replacement 404s rather than 403s',
    (routeCode.match(/return c\.json\(\{ error: 'Not found' \}, 404\)/g) ?? []).length >= 4
    && !/isOrderRowInScope[\s\S]{0,200}403/.test(routeCode),
    'a 403 on a scope miss confirms the row exists, which is the fact being withheld');

  check('the route never decides the status code',
    /if \(typeof e\?\.httpStatus !== 'number' \|\| typeof e\?\.code !== 'string'\) throw error;/.test(routeCode)
    && /const status = e\.httpStatus;/.test(routeCode),
    'an unrecognised failure dressed as a coded refusal looks handled in the logs forever');

  check('request bodies reject unknown keys',
    (routeCode.match(/\}\)\.strict\(\)/g) ?? []).length >= 4,
    'a silently ignored field is a caller believing something happened');

  check('AC-13 is a strict, scoped financial-reversal route — never lifecycle cancellation',
    reversalAt !== -1
    && (reversalPreHandler.match(/requireInternalPermission\('[^']+'\)/g) ?? []).join('')
      === "requireInternalPermission('replacements:billing')"
    && /reason: z\.string\(\)\.trim\(\)\.min\(1\)/.test(routeCode)
    && /idempotencyKey: z\.string\(\)\.trim\(\)\.min\(1\)/.test(routeCode)
    && occursBefore(reversalRoute, 'deps.loadScopedReplacement(c,',
      'deps.requestFinancialReversal({')
    && !/cancelReplacement\(/.test(reversalRoute),
    'a shipped replacement keeps its lifecycle; the route records only an attributed money decision');

  check('financial reversal requires BOTH permissions before schema or database access',
    /\[REPLACEMENT_BILLING_PERMISSION, FINANCIALS_WRITE_PERMISSION\]/.test(financial)
    && occursBefore(requestReversal, 'requireFinancialPermissions(input.actor)',
      'await assertFinancialActionSchema(conn)'),
    'the route exposes only replacements:billing; the command still requires billing + financials:write before touching its database');

  check('the route commits the durable obligation before best-effort processing',
    reversalRequestAt !== -1
    && !/deps\.(processFinancialAction|readFinancialAction)\(/.test(reversalBeforeRequest)
    && occursBefore(reversalRoute, 'await deps.requestFinancialReversal({',
      'await deps.processFinancialAction(Number(action.id))')
    && /catch \{[\s\S]{0,120}deps\.readFinancialAction/.test(reversalRoute),
    'a disconnect or process death after the request must leave work for the worker');

  check('every label purchase/retry/recovery/void route stays behind label RBAC and the DEFAULT-OFF label flag',
    labelRoutes.every(([segment]) =>
      occursBefore(segment, "requireInternalPermission('replacements:label')", 'requireLabelFeature')),
    'the router flag does not authorize postage; every label or recovery path keeps the narrower kill switch and capability');

  check('ship requires replacement + inventory capabilities and the label feature gate',
    /'\/:id\{\[0-9\]\+\}\/ship',[\s\S]{0,160}requireInternalPermission\('replacements:write'\),[\s\S]{0,100}requireInternalPermission\('inventory:write'\),[\s\S]{0,80}requireLabelFeature/.test(routeCode),
    'shipping moves stock, package and billing atomically; one broad replacement permission is insufficient');

  check('all pre-handler refusals run before scope loading, provider selection or commands',
    occursBefore(routeCode, "app.use('*',", "app.route('/', createReplacementSideEffectRouter())")
    && labelRoutes.every(([segment, body]) =>
      occursBefore(segment, "requireInternalPermission('replacements:label')", `zValidator('json', ${body})`)
      && occursBefore(segment, 'requireLabelFeature', `zValidator('json', ${body})`)
      && occursBefore(segment, `zValidator('json', ${body})`, 'deps.loadScopedReplacement(c,'))
    && occursBefore(shipRoute, "requireInternalPermission('replacements:write')", "zValidator('json', shipBody)")
    && occursBefore(shipRoute, "requireInternalPermission('inventory:write')", "zValidator('json', shipBody)")
    && occursBefore(shipRoute, 'requireLabelFeature', "zValidator('json', shipBody)")
    && occursBefore(shipRoute, "zValidator('json', shipBody)", 'deps.loadScopedReplacement(c,')
    && occursBefore(reversalRoute, "requireInternalPermission('replacements:billing')", "zValidator('json', financialReversalBody)")
    && occursBefore(reversalRoute, "zValidator('json', financialReversalBody)", 'deps.loadScopedReplacement(c,'),
    'feature flags, RBAC and strict-body refusal are request-boundary work; none may be deferred until a scoped lookup or side effect');

  check('every side-effect route resolves tenant scope before its command or provider factory',
    (routeCode.match(/const replacement = await deps\.loadScopedReplacement\(c,/g) ?? []).length === 8
    && occursBefore(purchaseRoute, 'deps.loadScopedReplacement(c,', 'deps.insertShipment({')
    && occursBefore(purchaseRoute, 'deps.loadScopedReplacement(c,', 'deps.providerFor(')
    && occursBefore(retryRoute, 'deps.loadScopedReplacement(c,', 'deps.retryLabel({')
    && occursBefore(retryRoute, 'deps.loadScopedReplacement(c,', 'deps.providerFor(')
    && occursBefore(purchaseReconcileRoute, 'deps.loadScopedReplacement(c,', 'deps.reconcilePurchaseIntent({')
    && occursBefore(purchaseReconcileRoute, 'deps.loadScopedReplacement(c,', 'deps.providerFor(')
    && occursBefore(pricingReconcileRoute, 'deps.loadScopedReplacement(c,', 'deps.reconcileLabelPricing({')
    && !/deps\.providerFor\(/.test(pricingReconcileRoute)
    && occursBefore(voidReconcileRoute, 'deps.loadScopedReplacement(c,', 'deps.reconcileVoidOutcome({')
    && occursBefore(voidReconcileRoute, 'deps.loadScopedReplacement(c,', 'deps.providerFor(')
    && occursBefore(voidRoute, 'deps.loadScopedReplacement(c,', 'deps.providerFor(')
    && occursBefore(voidRoute, 'deps.loadScopedReplacement(c,', 'deps.voidLabel({')
    && occursBefore(shipRoute, 'deps.loadScopedReplacement(c,', 'deps.ship({')
    && occursBefore(reversalRoute, 'deps.loadScopedReplacement(c,',
      'deps.requestFinancialReversal({'),
    'an id must 404 out of scope before provider selection or a mutation command sees it');

  check('purchase input is strict operator intent, never caller-supplied customer money',
    /const purchaseLabelBody = z\.object\(\{[\s\S]{0,900}\}\)\.strict\(\)/.test(routeCode)
    && !/shipmentCost|otherCost|selectedRateCost|cShippingRateAmount/.test(
      routeCode.slice(routeCode.indexOf('const purchaseLabelBody'),
        routeCode.indexOf('const voidLabelBody')))
    && occursBefore(routeCode, 'await deps.insertShipment({', 'await deps.purchaseLabel({'),
    'the route may capture attributed address/carrier/package intent; money remains command-owned');

  check('ship accepts inventory candidates only, never caller display or quantity data',
    /replacementItemId: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/.test(shipBody)
    && /inventoryId: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/.test(shipBody)
    && !/\b(?:name|sku|quantity|qty)\s*:/.test(shipBody),
    'name, SKU and quantity are frozen/database facts; the HTTP body may identify only the candidate stock row');
}

// ── The production label-provider boundary ──────────────────────────────────
console.log('\nreplacement label provider adapter');

{
  const provider = read('src/services/replacement-label-provider.ts');
  const providerCode = provider.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const directLabels = read('src/services/labels-direct.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const factory = functionBody(providerCode, 'replacementLabelProviderFor');
  const factoryReturnAt = factory.indexOf('return {');
  const factoryConstruction = factoryReturnAt === -1 ? factory : factory.slice(0, factoryReturnAt);
  const lookupMethodAt = factory.indexOf('lookupPurchase: async');
  const purchaseMethod = lookupMethodAt === -1 ? '' : factory.slice(0, lookupMethodAt);
  const context = functionBodyOf(providerCode, 'loadReplacementProviderContext');
  const accountAuthority = functionBodyOf(providerCode, 'resolveShipStationAccountAuthority');
  const purchaseAuthority = functionBodyOf(providerCode, 'resolveShipStationPurchaseAuthority');
  const contextSafety = functionBodyOf(providerCode, 'assertReplacementContextSafety');
  const serviceSafety = functionBodyOf(providerCode, 'assertReplacementServiceSafety');
  const purchase = functionBodyOf(providerCode, 'purchaseShipStationLabel');
  const intentRequest = functionBodyOf(providerCode, 'loadIntentRequest');
  const lookupIntent = functionBodyOf(providerCode, 'findIntentForLookup');
  const voidIntent = functionBodyOf(providerCode, 'findIntentForVoid');
  const lookup = functionBodyOf(providerCode, 'lookupShipStationPurchase');
  const voidLabel = functionBodyOf(providerCode, 'voidShipStationReplacementLabel');
  const directRef = functionBody(directLabels, 'directLabelAccountRefFromProviderId');

  check('constructing the replacement provider is lazy and performs no I/O',
    factoryReturnAt !== -1
    && ['purchase: async', 'lookupPurchase: async', 'voidLabel: async']
      .every((method) => factory.includes(method))
    && !/\bawait\b|\bdb\.|loadReplacementProviderContext\(|purchaseShipStationLabel\(|lookupShipStationPurchase\(|voidShipStationReplacementLabel\(|ssCreateLabel\(/.test(factoryConstruction),
    'route construction must not select credentials, open a provider request or buy postage');

  check('the provider request is bound to the replacement, its shipment and its frozen fingerprint',
    /innerJoin\(orders, eq\(orders\.id, replacements\.orderId\)\)/.test(context)
    && /row\.replacementShipmentId == null/.test(context)
    && /row\.replacementClientId !== row\.orderClientId/.test(context)
    && /request\.replacementId === context\.replacementId/.test(providerCode)
    && /request\.replacementShipmentId === context\.replacementShipmentId/.test(providerCode)
    && /request\.replacementReference === context\.replacementReference/.test(providerCode)
    && /request\.fingerprint !== expectedFingerprint/.test(providerCode)
    && /intent\.replacementId !== replacementId/.test(intentRequest)
    && /intent\.requestFingerprint !== request\.fingerprint/.test(intentRequest),
    'the original order supplies safety context, never the purchase identity');

  check('direct, store-scoped and ambiguous account paths fail closed before postage',
    /DIRECT_STORE_PROVIDER_ID_OFFSET/.test(directRef)
    && /sourceTable: 'store_accounts'/.test(directRef)
    && /DIRECT_CARRIER_PROVIDER_ID_OFFSET/.test(directRef)
    && /sourceTable: 'carrier_accounts'/.test(directRef)
    && occursBefore(purchaseMethod,
      'if (directLabelAccountRefFromProviderId(request.carrier.providerAccountId)) {',
      'return purchaseShipStationLabel(context, request, idempotencyKey)')
    && /loadClientCredentials\(context\.clientId\)/.test(accountAuthority)
    && /matchingCarriers\.length !== 1/.test(accountAuthority)
    && /candidate\.carrier_id === carrierId/.test(accountAuthority)
    && /services\.length !== 1/.test(purchaseAuthority)
    && /services\[0\]!\.domestic !== true/.test(purchaseAuthority)
    && /services\[0\]!\.international === true/.test(purchaseAuthority),
    'only one exact domestic ShipStation account/service under the current credential is supported');

  check('all safety preflight and canonical ship-from resolution precede ShipStation purchase',
    /assertInternationalOriginationSupported/.test(contextSafety)
    && /isHugrabShippingContext/.test(contextSafety)
    && /getOrderHazmatForShipping/.test(contextSafety)
    && /loadShippingAutomationControls/.test(serviceSafety)
    && /isPoBoxAddress/.test(serviceSafety)
    && occursBefore(purchase, 'resolveShipStationPurchaseAuthority(context, request)', 'ssCreateLabel({')
    && occursBefore(purchase, 'assertCarrierFamilyEligibleForPurchase({', 'ssCreateLabel({')
    && occursBefore(purchase, 'assertReplacementContextSafety(context, request)', 'ssCreateLabel({')
    && occursBefore(purchase, 'assertReplacementServiceSafety(', 'ssCreateLabel({')
    && occursBefore(purchase, 'getDefaultShipFrom()', 'ssCreateLabel({')
    && occursBefore(purchase, 'replacementExternalShipmentId(request, idempotencyKey)', 'ssCreateLabel({'),
    'a provider call is the last step after identity, eligibility, safety and deterministic recovery facts');

  check('purchase recovery reloads one scoped frozen intent and the current exact credential',
    /eq\(replacementLabelPurchaseIntents\.replacementId, replacementId\)/.test(lookupIntent)
    && /eq\(replacementLabelPurchaseIntents\.providerIdempotencyKey, idempotencyKey\)/.test(lookupIntent)
    && /\.limit\(2\)/.test(lookupIntent)
    && /rows\.length !== 1/.test(lookupIntent)
    && occursBefore(lookup, 'loadReplacementProviderContext(replacementId)',
      'findIntentForLookup(replacementId, idempotencyKey)')
    && occursBefore(lookup, 'findIntentForLookup(replacementId, idempotencyKey)',
      'loadIntentRequest(replacementId, intent, context)')
    && occursBefore(lookup, 'resolveShipStationAccountAuthority(context, request)',
      'ssGetLabelByExternalShipmentId(')
    && /replacementExternalShipmentId\(request, idempotencyKey\)/.test(lookup),
    'recovery asks ShipStation by the deterministic purchase identity; it never guesses from an order');

  check('a bare ShipStation lookup miss stays indeterminate without durable no-effect proof',
    /if \(!found\) \{/.test(lookup)
    && /external_shipment_not_found_without_no_effect_proof/.test(lookup)
    && /throw lookupUnavailable\(/.test(lookup)
    && !/if \(!found\)\s*(?:\{\s*)?return null/.test(lookup)
    && occursBefore(lookup, 'if (!found) {', "return completeReceipt(found.label, request, 'ShipStation')"),
    'an eventually-consistent 404 cannot authorize failed_pre_purchase and a second postage buy');

  check('void reloads one purchased intent, its frozen request and its exact owning credential',
    /eq\(replacementLabelPurchaseIntents\.replacementId, replacementId\)/.test(voidIntent)
    && /eq\(replacementLabelPurchaseIntents\.state, 'purchased'\)/.test(voidIntent)
    && /eq\(replacementLabelPurchaseIntents\.providerTransactionId, providerTransactionId\)/.test(voidIntent)
    && /\.limit\(2\)/.test(voidIntent)
    && /rows\.length !== 1/.test(voidIntent)
    && occursBefore(voidLabel, 'loadReplacementProviderContext(replacementId)',
      'findIntentForVoid(replacementId, providerTransactionId)')
    && occursBefore(voidLabel, 'loadIntentRequest(replacementId, intent, context)',
      'intent.providerLabelId !== providerTransactionId')
    && occursBefore(voidLabel, 'input.idempotencyKey !== replacementVoidIdempotencyKey(intent)',
      'resolveShipStationAccountAuthority(context, request)')
    && occursBefore(voidLabel, 'resolveShipStationAccountAuthority(context, request)',
      'ssVoidLabel(providerTransactionId, authority.apiKeyV2)'),
    'a caller-supplied label or stale credential cannot choose what gets voided');

  check('the adapter writes no local lifecycle and carries no original-order marketplace identity',
    /ssOrderId: null/.test(purchase)
    && !/\.update\(orders\)|\.update\(replacements\)|\.insert\(orders\)|\.delete\(orders\)/.test(providerCode)
    && !/notifyCustomer|marketplaceFulfillment|markAsShipped|shopify|walmart|ebay/i.test(providerCode),
    'this boundary may call ShipStation only; commands own lifecycle and marketplace effects');
}

// ── AC-10/AC-18: customer money, and money that has a bucket ─────────────────
console.log('\nAC-10/AC-18 — where replacement money comes from and where it shows up');

{
  const fence = read('src/services/replacement-customer-money.ts');
  const planner = read('src/services/replacement-billing-planner.ts');
  const live = read('src/services/billing.ts');
  const cached = read('src/services/reporting-metrics.ts');
  const invoice = read('src/services/billing-invoice-totals.ts');
  const contract = read('src/services/billing-row-total-contract.ts');
  const snapshots = read('src/services/customer-shipping-money-snapshot.ts');
  const fenceFn = functionBody(fence, 'resolveReplacementCustomerPostage');
  const strictReader = functionBody(snapshots, 'readFrozenReplacementCustomerShippingMoney');
  const plannerCode = planner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The signature only — sliced, not regexed, because a regex literal carrying braces and a
  // semicolon is a parser hazard and the thing under test is simply "how many fields".
  const fenceObjStart = fence.indexOf('resolveReplacementCustomerPostage(input: {');
  const fenceSignature = fence.slice(
    fenceObjStart + 'resolveReplacementCustomerPostage(input: {'.length,
    fence.indexOf('}): ReplacementCustomerPostage | null', fenceObjStart),
  );
  check('the fence accepts the frozen tuple and NOTHING else',
    fenceSignature.includes('frozenCustomerShippingMoney: unknown;')
    && (fenceSignature.match(/\w+: /g) ?? []).length === 1,
    'a caller holding only carrier cost must have nowhere to put it — that is the protection, not a list that refuses strings');

  check('the fence returns the CUSTOMER amount, never the carrier cost',
    /amount: frozen\.cShippingRateAmount/.test(fenceFn)
    && !/amount: frozen\.selectedRateCost/.test(fenceFn),
    'selectedRateCost is what the carrier charged us; billing it as customer money is the defect this fence exists to close');

  // REPLACED, not deleted. The property that matters was never "the amounts differ" — a
  // zero-markup client legitimately has equal amounts — it is that the tuple came from the
  // policy owner. Asserting equality blocked those clients from shipping at all.
  check('the fence accepts only a tuple with customer-money PROVENANCE',
    /readFrozenReplacementCustomerShippingMoney\(input\.frozenCustomerShippingMoney\)/.test(fenceFn)
    && /if \(!frozen\) return null;/.test(fenceFn)
    && !/frozen\.cShippingRateAmount === frozen\.selectedRateCost/.test(fenceFn),
    'customerRateSource, rateCostSource and the policy version are what a number copied out of shipments.cost cannot forge, at any markup');

  check('the replacement-specific reader requires exact active pricing authority',
    /readFrozenCustomerShippingMoney\(value\)/.test(strictReader)
    && /frozen\.customerShippingMoneyPolicyVersion !== CUSTOMER_SHIPPING_MONEY_POLICY_VERSION/.test(strictReader)
    && /!frozen\.customerShippingPricingAuthority/.test(strictReader),
    'the generic historical reader stays compatible, but replacement billing must fail closed on a missing or malformed authority receipt');

  // Reads planCode, not planner: the docblock explaining WHY the carrier fields were removed
  // names them, and a negative assertion over prose forces the next engineer to delete the
  // reasoning to get green. Same trap the postage check below already documents.
  check('the planner can no longer HOLD a carrier amount',
    !/shipmentCost/.test(plannerCode) && !/otherCost/.test(plannerCode),
    'the old docblock already claimed money came from the frozen tuple; only the type disagreed, and the type is what callers obey');

  check('postage is the fenced amount',
    /const postage = customerPostage\.amount;/.test(planner),
    'never a sum of carrier fields');

  // The SQL ARM specifically. A bare `includes` was satisfied by the row type, the local and
  // the returned field, so deleting the arm that actually sums the money left the check
  // green — the same presence-versus-substance trap this file has hit before.
  const hasBucketArm = (src: string, lineType: string) =>
    new RegExp(`line_type = '${lineType}'`).test(src);
  check('both replacement line types have a bucket in EVERY summary owner',
    ['replace_postage', 'replace_pick_pack'].every((t) =>
      hasBucketArm(live, t) && hasBucketArm(cached, t) && hasBucketArm(invoice, t)),
    'three owners each compute grand_total as an unfiltered sum, so a type missing from any one of them is money on screen that belongs to nothing');

  check('the category reconciler knows both buckets',
    /'replacePostageTotal', 'replacePickPackTotal',/.test(contract),
    'this is the AC written down — it is what reports the delta when money has no bucket');

  check('no residual bucket silences that reconciler',
    !/otherTotal/.test(invoice) && !/otherTotal/.test(live),
    'an \'other\' category would make the identity hold by absorbing whatever is unaccounted for, which is the alarm itself');

  check('replacementCount counts REPLACEMENTS, not orders',
    /count\(distinct b\.replacement_id\)/.test(live)
    && /count\(distinct b\.replacement_id\)/.test(cached),
    'a replacement line carries the ORIGINAL order id, so order_count structurally cannot see it');

  check('the live summary guards on replacement_id column PRESENCE',
    /billingLineItemsHasReplacementIdColumn/.test(live),
    'migrations are not applied by deploy here, and an unguarded reference would 500 the billing summary for every client over money that cannot exist yet');
}

// ── AC-16: the original order went away ──────────────────────────────────────
console.log('\nAC-16 — the original order went away');

{
  const hold = read('src/services/replacement-original-order-hold.ts');
  const holdCode = hold.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lifecycleOwner = read('src/services/order-lifecycle-command.ts');
  const upstream = read('src/services/fulfillment/upstream-reconcile.ts');
  const classify = functionBodyOf(holdCode, 'classifyAndAct');

  check('the sweep takes the SAME order lock every replacement command takes',
    /pg_advisory_xact_lock\(36423, \$\{input\.orderId\}\)/.test(holdCode),
    'that lock is what makes it safe against an in-flight shipReplacement');

  check('shipped_at is authoritative even when lifecycle text disagrees',
    occursBefore(classify, 'if (before.shippedAt != null) {',
      "if (before.status === 'shipped' || before.status === 'completed') {")
    && /dispatch_evidence_disagrees_with_lifecycle_and_financials_need_review/.test(classify),
    'status text cannot erase physical dispatch evidence or authorize a pre-dispatch cancel');

  check('a POST-DISPATCH replacement is annotated, never transitioned',
    /annotateReplacementOriginalOrderInTransaction/.test(classify)
    && !/cancelReplacementForOriginalOrderInTransaction[\s\S]{0,400}status === 'shipped'/.test(classify),
    'shipped -> [completed] is the whole of a dispatched replacement\'s future');

  check('a live label is parked, never auto-voided',
    !/voidReplacementLabel/.test(hold),
    'a void is a one-way door and a provider action; a local cancellation cannot take it');

  check('a purchased but CONFIRMED-VOID intent is no longer a live label',
    /sql`\$\{replacementLabelPurchaseIntents\.state\} in \$\{INTENT_AT_RISK_STATES\}`/.test(classify)
    && /replacementLabelPurchaseIntents\.voidState\} is null or \$\{replacementLabelPurchaseIntents\.voidState\} <> 'voided'/.test(classify)
    && /if \(atRiskIntent\?\.state === 'purchased'\) \{/.test(classify)
    && !/if \(before\.status === 'label_created'\)/.test(classify)
    && occursBefore(classify,
      "replacementLabelPurchaseIntents.voidState} <> 'voided'",
      "if (atRiskIntent?.state === 'purchased') {")
    && occursBefore(classify, "if (atRiskIntent?.state === 'purchased') {",
      'await cancelReplacementForOriginalOrderInTransaction(tx, before, {'),
    'label_created is display state; the purchased intent ledger decides whether postage is still live');

  check('the money question on a delivered replacement is RECORDED, not answered',
    /does_the_client_still_pay_for_a_delivered_replacement/.test(holdCode),
    'guessing it would either bill for nothing owed or silently forgive real money');

  check('lifecycle dispatch text without shipped_at enters its dedicated review',
    /before\.status === 'shipped' \|\| before\.status === 'completed'/.test(classify)
    && /reviewReason: 'original_order_cancelled_dispatch_inconsistent'/.test(classify)
    && /openQuestion: 'resolve_lifecycle_dispatch_inconsistency'/.test(classify),
    'the opposite status/reality mismatch is anomalous too; it must not be treated as delivered or clean');

  check('AC-16 keeps its OWN review reasons, never the drift code',
    /original_order_cancelled_label_live/.test(holdCode)
    && /original_order_cancelled_label_unresolved/.test(holdCode)
    && /original_order_cancelled_dispatch_inconsistent/.test(holdCode)
    && /original_order_cancelled_unexpected_billing/.test(holdCode)
    && !/original_order_line_drift/.test(holdCode),
    'the card is explicit that a cancelled original keeps its own review path');

  check('a hold points at a RECEIPT, and reason is never parsed',
    /orderLifecycleEventId/.test(holdCode)
    && /webhookEventId/.test(holdCode)
    && !/\breason\b[^\n]{0,60}\.(match|split|indexOf|includes)\(/.test(holdCode),
    'inferring a cancellation from prose is the mistake PS-488 rejected');

  check('an open hold blocks re-classification, as the partial index requires',
    /resolvedAt\} is null/.test(holdCode),
    'matching only the idempotency key aborts the sweep on the second signal');

  check('ANY replacement billing row blocks automatic cancellation',
    /\.where\(eq\(billingLineItems\.replacementId, before\.id\)\)/.test(classify)
    && !/eq\(billingLineItems\.invoiced, (?:true|false)\)/.test(classify)
    && /invoiced_money_on_an_undispatched_replacement/.test(classify)
    && /editable_money_on_an_undispatched_replacement/.test(classify)
    && occursBefore(classify, '.from(billingLineItems)',
      'cancelReplacementForOriginalOrderInTransaction(tx, before, {'),
    'editable money is no less anomalous than finalized money on an undispatched replacement');

  check('terminal lifecycle text with live intent or money creates a hold without illegal review transition',
    /replacement_terminal_original_order_live_label/.test(classify)
    && /replacement_terminal_original_order_unresolved_label/.test(classify)
    && /replacement_terminal_original_order_unexpected_billing/.test(classify)
    && /terminal_replacement_has_live_label/.test(classify)
    && /if \(before\.status === 'cancelled' \|\| before\.status === 'rejected'\) \{[\s\S]{0,900}replacement_terminal_original_order_live_label[\s\S]{0,900}return \{[\s\S]{0,400}terminal_replacement_has_live_label/.test(classify)
    && /if \(before\.status === 'cancelled' \|\| before\.status === 'rejected'\) \{[\s\S]{0,900}replacement_terminal_original_order_unresolved_label[\s\S]{0,900}return \{[\s\S]{0,400}terminal_replacement_has_unresolved_label_intent/.test(classify)
    && /if \(before\.status === 'cancelled' \|\| before\.status === 'rejected'\) \{[\s\S]{0,900}replacement_terminal_original_order_unexpected_billing[\s\S]{0,900}return \{/.test(classify),
    'cancelled/rejected -> review is illegal, but terminal text cannot erase live postage or money evidence');

  check('a clean pre-dispatch cancel closes its hold in the same transaction',
    /outcome\.disposition === 'no_action' \|\| outcome\.disposition === 'cancelled'/.test(holdCode)
    && /resolution: outcome\.disposition === 'cancelled'[\s\S]{0,120}'clean_pre_dispatch_replacement_cancelled'/.test(holdCode)
    && /await cancelReplacementForOriginalOrderInTransaction\(tx, before, \{/.test(classify)
    && /await cancelReplacementBillingInTransaction\(tx, \{ replacementId: before\.id \}\)/.test(classify),
    'no label, unresolved intent, dispatch evidence or billing row means there is no human question to leave open');

  // The call must be a BARE STATEMENT, not merely present. M84 survived an earlier version of
  // this check by wrapping it in `if (false)` — the text was still there, still in the right
  // order, and still doing nothing. Presence and position are both satisfied by dead code.
  check('the local cancel branch fans out IN THE SAME TRANSACTION',
    /^ {4}if \(await replacementSchemaPresent\(tx\)\) \{$/m.test(lifecycleOwner)
    && /^ {6}await raiseReplacementOriginalOrderHoldsInTransaction\(tx, \{$/m.test(lifecycleOwner)
    && !/REPLACEMENTS_ENABLED/.test(lifecycleOwner)
    && occursBefore(lifecycleOwner, "orderStatus: 'cancelled',",
      'raiseReplacementOriginalOrderHoldsInTransaction(tx, {'),
    'a cancellation that left its replacements untouched would be undetectable');

  check('the upstream producer raises holds WITHOUT moving the order',
    /candidate\.orderStatus === 'shipped'/.test(upstream)
    && /raiseReplacementOriginalOrderHoldsInTransaction\(tx, \{/.test(upstream)
    && occursBefore(upstream, "candidate.orderStatus === 'shipped'",
      "candidate.orderStatus !== 'awaiting_shipment'")
    && !/candidate\.orderStatus === 'shipped'[\s\S]{0,1200}applyOrderLifecycleCommand/.test(upstream),
    'writing canonical_status would zero the original\'s billing through cancelled-no-charge');

  const create = read('src/services/replacement-create-command.ts');
  check('a create after durable cancellation/refund evidence is refused under the order lock',
    /replacementOriginalOrderHolds/.test(create)
    && /priorWebhookCancellation/.test(create)
    && /REPLACEMENT_ORIGINAL_ORDER_HELD/.test(create)
    && /REPLACEMENT_ORIGINAL_ORDER_EVIDENCE_AMBIGUOUS/.test(create)
    && /unboundAccountless/.test(create)
    && /competingAccount/.test(create)
    && occursBefore(create, 'pg_advisory_xact_lock', 'priorWebhookCancellation')
    && occursBefore(create, 'priorWebhookCancellation', '.insert(replacements)'),
    'a sweep or unbound pre-import receipt must remain authoritative, including after account identity becomes ambiguous');

  const lifecycle = read('src/services/replacement-lifecycle-command.ts');
  const resolveReview = functionBody(lifecycle, 'resolveReplacementReview');
  check('every direct pre-ship terminal command fences label intent and retires only its vessel',
    /prepareReplacementTerminalTransitionInTransaction/.test(lifecycle)
    && /provider_pending/.test(lifecycle)
    && /reconcile_required/.test(lifecycle)
    && /terminal_transition_label_live/.test(lifecycle)
    && /isEmptyReplacementShipment/.test(lifecycle)
    && /isNull\(shipments\.orderId\)/.test(lifecycle)
    && /eq\(shipments\.source, 'replacement'\)/.test(lifecycle)
    && /replacement_empty_shipment_retired/.test(lifecycle),
    'cancel/reject may race provider Phase 3; terminal state cannot hide an in-flight label');

  check('generic review resolution cannot bypass AC-16 or paid-label pricing evidence',
    /assertReviewResolutionPrerequisites/.test(lifecycle)
    && /AC16_REVIEW_QUESTIONS_BY_REASON/.test(lifecycle)
    && /replacementOriginalOrderHolds/.test(lifecycle)
    && /if \(!decision\?\.resolvedAt\)/.test(lifecycle)
    && /replacement_customer_money_unavailable/.test(lifecycle)
    && /to !== 'label_created'/.test(lifecycle)
    && /replacement_customer_money_reconciled/.test(lifecycle)
    && /readFrozenReplacementCustomerShippingMoney/.test(lifecycle)
    && occursBefore(resolveReview, 'await assertReviewResolutionPrerequisites(tx, before, input.to)',
      'const replacement = await applyTransition(tx, before, {'),
    'review_reason is not authority to erase its own unanswered hold or missing customer-money receipt');

  check('open holds have an audited state-versioned resolution writer',
    /resolveReplacementOriginalOrderHold/.test(hold)
    && /expectedStateVersion/.test(hold)
    && /assertHoldResolutionPrerequisite/.test(hold)
    && /assertResolutionMatchesOpenQuestion\(hold\.openQuestion, input\.resolution\)/.test(hold)
    && /REPLACEMENT_HOLD_RESOLUTION_INCOMPATIBLE/.test(hold)
    && /void_or_retain_purchased_label: \['label_voided', 'label_retained'\]/.test(hold)
    && /invoiced_money_on_an_undispatched_replacement: \['financial_reversal_completed'\]/.test(hold)
    && /if \(intent\.voidState !== null\)/.test(hold)
    && /activeShipment\.orderId !== null/.test(hold)
    && /replacement_original_order_hold_resolved/.test(hold)
    && /isNull\(replacementOriginalOrderHolds\.resolvedAt\)/.test(hold),
    'the close command must answer this exact question and prove its provider/lifecycle/financial prerequisite');

  check('shipped -> cancelled is STILL refused',
    /transition === 'cancelled' && order\.orderStatus === 'shipped'/.test(lifecycleOwner)
    && /cannot transition to cancelled/.test(lifecycleOwner),
    'the tempting shortcut is to relax this so the local hook fires; AC-16 must not');

  // The second regex was passed as `detail`, not ANDed into the condition — `check` takes
  // (name, boolean, detail?) — so "AC-16 uses it" was never asserted and only the export's
  // existence was. scripts/ is outside tsconfig's include, so no compiler ever typed it. This
  // is the same vacuous-block failure the purchase-input section records above.
  check('there is ONE shared review writer, and AC-16 uses it',
    /export async function enterReplacementReview/.test(
      read('src/services/replacement-lifecycle-command.ts'))
    && /enterReplacementReview\(tx, before, \{/.test(holdCode),
    'a second copy of the review write is how the label-purchase path lost its predicate');
}

// ── Three ways replacement money silently disappears ─────────────────────────
console.log('\nmoney that silently disappears');

{
  const policy = read('src/services/billing-finalization-policy.ts');
  const fold = read('src/services/billing-replacement-finalized-fold.ts');
  const generator = read('src/services/billing.ts');
  const noCharge = read('src/services/billing-cancelled-no-charge.ts');
  const discovery = functionBody(policy, 'findFrozenReplacementLineTotals');

  check('a finalized replacement line is found by JOINING the closed period',
    /join billing_finalizations closed/.test(discovery)
    && /coalesce\(line\.billing_effective_date, line\.ship_date\) >= closed\.period_start/.test(discovery)
    && /line\.invoiced = true/.test(discovery),
    'that join is what this repo means by frozen');

  check('discovery never asks for source_finalization_id',
    !/source_finalization_id/.test(discovery)
    && !/sourceFinalizationId/.test(discovery),
    'constraint 0074 forbids that column on a replace_* line, so the predicate matched nothing and the reconciler credited nothing — indistinguishable from a correct empty run');

  check('the reconciler delegates discovery to that one owner',
    /const frozenRows = await findFrozenReplacementLineTotals\(tx, \{/.test(policy),
    'a second copy of the predicate is a second chance to get it wrong');

  // Re-anchored when the fold moved to raw SQL and gained a period. "Invoiced" alone was
  // never the rule: the frozen side counts a line only when its effective date falls inside
  // a CLOSED period overlapping the window, and a fold that ignored that added money frozen
  // on a different invoice — a debit charging the client twice.
  check('the finalized fold counts ONLY money frozen in THIS window',
    /line\.replacement_id is not null/.test(fold)
    && /line\.invoiced = true/.test(fold)
    && /join billing_finalizations closed/.test(fold)
    && /closed\.period_start < \$\{period\.dateTo\}/.test(fold)
    && /closed\.period_end > \$\{period\.dateFrom\}/.test(fold),
    'it must add back exactly what the frozen total counted, so the delta is zero');

  check('one line is counted once even if two closed periods overlap',
    /select distinct/.test(fold),
    'migration 0065 discourages overlapping finalizations; a fold that doubles a charge when they exist anyway is not worth defending');

  check('the generator hands the fold the RECONCILER\'s window',
    /\{ dateFrom: fromIso, dateTo: toIso \},/.test(generator),
    'two different windows would be two different opinions about what is frozen');

  check('the generator folds replacement money BEFORE reconciling',
    occursBefore(generator, 'foldFinalizedReplacementTotalsIntoCandidates(',
      'reconcileFinalizedBillingOrderAdjustments({'),
    'folding after the comparison would be the same bug with extra steps');

  check('a cancelled original does not zero replacement money — both twins',
    /REPLACEMENT_LINE_TYPES\.has\(normalized\)/.test(noCharge)
    && /'replace_postage', 'replace_pick_pack'/.test(noCharge),
    'the TypeScript set and the SQL predicate are read by different callers; one without the other is a disagreement, not a fix');
}

// ── AC-13: cancelling ONE replacement, credited relationally ─────────────────
console.log('\ncancellation and finalized credits (AC-13)');

{
  const policy = read('src/services/billing-finalization-policy.ts');
  const writer = read('src/services/replacement-billing-writer.ts');
  const writeCode = writer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const financial = read('src/services/replacement-financial-action.ts');
  const financialCode = financial.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const policyCode = policy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const scheduler = read('src/services/sync-scheduler.ts');
  const fulfillmentTick = functionBody(scheduler, 'runFulfillmentOutboxTick');
  const requestAction = functionBody(financialCode, 'requestReplacementFinancialReversal');
  const claimAction = functionBodyOf(financialCode, 'claimOneAction');
  const processAction = functionBodyOf(financialCode, 'processClaimedAction');
  const completeAction = functionBodyOf(financialCode, 'completeClaimedAction');
  const repairScanner = functionBody(financialCode,
    'enqueueStrandedReplacementCancellationCleanup');
  const replacementAdjustment = functionBody(policyCode,
    'reconcileFinalizedBillingReplacementAdjustment');

  check('the reconciler is a SIBLING, not a parameter on the order reconciler',
    /export async function reconcileFinalizedBillingReplacementAdjustment/.test(policy)
    && /export async function reconcileFinalizedBillingOrderAdjustments/.test(policy),
    'the two answer different questions; one function with two grains has two meanings');

  check('the ORDER reconciler stays order-grained',
    /adjustmentSource: 'regeneration',[\s\S]{0,400}replacementId: null,/.test(policy),
    'a replacement-attributed adjustment comes from the sibling, never from there');

  // Re-anchored when discovery moved into findFrozenReplacementLineTotals: the predicate is
  // now raw SQL against the joined line alias rather than a Drizzle column template. Same
  // intent — identity is a column, never a string parsed out of `reason`.
  check('invoiced lines are found RELATIONALLY by replacement_id',
    /line\.replacement_id = \$\{input\.replacementId\}/.test(policy)
    && !/\breason\b[^\n]{0,60}\.(match|split|indexOf|includes)\(/.test(policy),
    'parsing identity out of a reason string is the mistake PS-488 rejected');

  check('prior adjustments are matched by replacement_id too',
    /billingCreditNotes\.replacementId\} = \$\{input\.replacementId\}/.test(policy));

  // Scoped to the reconciler body: `replacementId: input.replacementId,` also appears in the
  // call to findFrozenReplacementLineTotals, and a file-wide check let that copy answer for
  // this one the moment discovery was extracted. Third time on this ticket that a green
  // check quietly stopped defending anything because NEW code elsewhere satisfied it.
  const replacementReconciler = functionBody(policy, 'reconcileFinalizedBillingReplacementAdjustment');
  // Re-anchored: the column and value are now CONDITIONAL. appendBillingAdjustmentProjection
  // is the canonical credit-note writer used by the ORDER reconciler for ordinary billing, and
  // 0097 is gated behind the operator lane — referencing replacement_id unconditionally broke
  // every credit note on a production database. The intent is unchanged: when the column
  // exists, the credit carries it.
  check('the credit CARRIES replacement_id through the projection',
    /const withReplacementId = await billingCreditNotesHasReplacementIdColumn\(conn\);/.test(policy)
    && /replacementIdColumn = withReplacementId \? sql`replacement_id,`/.test(policy)
    && /replacementIdValue = withReplacementId \? sql`\$\{input\.replacementId\},`/.test(policy)
    && /adjustmentKind: 'credit',[\s\S]{0,120}replacementId: input\.replacementId,/.test(replacementReconciler),
    'a deterministic key is not a substitute for a queryable column');

  check('it credits the DELTA, not the frozen total',
    /const outstandingCents = frozenCents \+ priorCents;/.test(policy)
    && /if \(outstandingCents <= 0n\) continue;/.test(policy),
    're-crediting the whole total on a retry is how a cancellation refunds twice');

  check('the idempotency key includes the finalization',
    /const actionCreditKey = `\$\{input\.idempotencyKey\}:finalization:\$\{frozen\.finalizationId\}`/.test(policy)
    && /idempotencyKey: actionCreditKey/.test(policy),
    'one cancellation spanning two finalizations is two adjustments, not one');

  const cancelBody = functionBody(writeCode, 'cancelReplacementBillingInTransaction');

  check('cancellation removes ONLY editable replacement-scoped lines',
    /eq\(billingLineItems\.replacementId, input\.replacementId\)/.test(cancelBody)
    && /eq\(billingLineItems\.invoiced, false\)/.test(cancelBody)
    && /sourceFinalizationId\} is null/.test(cancelBody),
    'cancelling A must leave B exactly as it was');

  check('cancellation never deletes an invoiced line',
    !/\.delete\(billingLineItems\)[\s\S]{0,400}invoiced, true/.test(cancelBody),
    'a finalized charge is history; the difference becomes an append-only credit');

  check('the post-ship decision requires written reason + stable key and replays by full signature',
    /REPLACEMENT_FINANCIAL_REASON_REQUIRED/.test(requestAction)
    && /REPLACEMENT_FINANCIAL_IDEMPOTENCY_REQUIRED/.test(requestAction)
    && /onConflictDoNothing\(\{ target: replacementFinancialActions\.idempotencyKey \}\)/.test(requestAction)
    && /assertReplayMatches\(existing as ReplacementFinancialActionRow, expected\)/.test(requestAction),
    'an idempotency key reused for different replacement, action or reason is a conflict, not a replay');

  check('financial reversal accepts dispatch evidence or a finalized historical anomaly',
    /eq\(billingLineItems\.replacementId, replacement\.id\)/.test(requestAction)
    && /eq\(billingLineItems\.invoiced, true\)/.test(requestAction)
    && /if \(replacement\.shippedAt == null && !finalizedLine\)/.test(requestAction),
    'a clean pre-ship replacement belongs to lifecycle cancellation; shipped_at remains authoritative');

  check('financial reversal preserves lifecycle and touches no provider, stock, package or marketplace',
    !/\.update\(replacements\)/.test(financialCode)
    && !/createLabel|voidLabel|provider\.|inventory|consumePackage|marketplace/i.test(financialCode),
    'AC-13 is a money decision about one delivered replacement, never a disguised shipped cancellation');

  check('the durable worker claims with a lease and SKIP LOCKED',
    /for update skip locked/.test(claimAction)
    && /status = 'processing'/.test(claimAction)
    && /attempts = action\.attempts \+ 1/.test(claimAction)
    && /lease_expires_at/.test(claimAction)
    && /status in \('pending', 'retry'\)/.test(claimAction),
    'a crash must leave a reclaimable obligation, while concurrent workers process it once');

  check('the worker removes and credits ONLY the action replacement on the supplied database',
    (processAction.match(/^ {8}replacementId: action\.replacement_id,$/gm) ?? []).length === 2
    && /cancelReplacementBillingInTransaction\(tx, \{[\s\S]{0,80}replacementId: action\.replacement_id,/.test(processAction)
    && /reconcileFinalizedBillingReplacementAdjustment\(\{[\s\S]{0,180}replacementId: action\.replacement_id,/.test(processAction)
    && /idempotencyKey: `replacement-financial-action:\$\{action\.id\}`/.test(processAction)
    && /\}, conn, async \(\) => undefined\)/.test(processAction),
    'reversing A must leave sibling B unchanged and must not escape an injected database');

  check('a retry recovers its already-committed credit into the durable action result',
    /where \$\{billingCreditNotes\.idempotencyKey\} = \$\{actionCreditKey\}/.test(replacementAdjustment)
    && /if \(existingActionCredit\) \{/.test(replacementAdjustment)
    && /existingActionCredit\.finalizationId !== frozen\.finalizationId/.test(replacementAdjustment)
    && /Number\(existingActionCredit\.replacementId\) !== input\.replacementId/.test(replacementAdjustment)
    && /existingActionCredit\.reason !== input\.reason\.trim\(\)/.test(replacementAdjustment)
    && /adjustedCount \+= 1;\s*creditedCents \+= moneyCents\(existingActionCredit\.amount\);\s*continue;/.test(replacementAdjustment)
    && occursBefore(replacementAdjustment, 'if (existingActionCredit) {',
      'const prior = resultRows<{ signedTotal: string }>'),
    'a crash after credit commit must not let the action retry complete with false zero results');

  check('completion is append-only and replay-safe',
    /eq\(replacementFinancialActions\.status, 'processing'\)/.test(completeAction)
    && /eq\(replacementFinancialActions\.attempts, action\.attempts\)/.test(completeAction)
    && /if \(existing\) return existing;/.test(completeAction)
    && /replacement_financial_reversal_completed/.test(completeAction)
    && /onConflictDoNothing\(\{ target: replacementActivityEvents\.idempotencyKey \}\)/.test(completeAction),
    'a repeated worker may reread completion but may not append another financial fact');

  check('the repair scanner targets only stranded pre-ship cancelled replacement money',
    /replacement\.status = 'cancelled'/.test(repairScanner)
    && /replacement\.shipped_at is null/.test(repairScanner)
    && /line\.replacement_id = replacement\.id/.test(repairScanner)
    && /on conflict \(idempotency_key\) do nothing/.test(repairScanner),
    'historical repair must not invent a broad order-level cleanup or touch dispatched history');

  check('the DEFAULT-OFF replacement flag blocks historical replacement discovery',
    /const replacementCleanupRecovered = env\.REPLACEMENTS_ENABLED\s*\? await enqueueStrandedReplacementCancellationCleanup/.test(fulfillmentTick)
    && (fulfillmentTick.match(/enqueueStrandedReplacementCancellationCleanup\(/g) ?? []).length === 1
    && /: \{ schemaReady: false, enqueued: 0 \};/.test(fulfillmentTick),
    'a flags-off deploy must not discover and enqueue mutations for historical replacements');

  check('already-authorized durable financial obligations drain even while flags are off',
    /replacementFinancials = await processReplacementFinancialActionsOnce\(\{ limit: 5 \}\);/.test(fulfillmentTick)
    && !/processReplacementFinancialActionsOnce[\s\S]{0,120}REPLACEMENTS_ENABLED/.test(fulfillmentTick)
    && (fulfillmentTick.match(/processReplacementFinancialActionsOnce\(/g) ?? []).length === 1
    && occursBefore(fulfillmentTick,
      'replacementFinancials = await processReplacementFinancialActionsOnce({ limit: 5 });',
      'return {'),
    'a committed financial action is an explicit obligation; rollback must not strand it halfway through');
}

// ── AC-6: one regeneration owner, and the sweep cannot erase replacement money ─
const regenBody = functionBody(
  read('src/services/replacement-billing-writer.ts').replace(/\/\*[\s\S]*?\*\//g, ''),
  'regenerateReplacementBillingInTransaction',
);
console.log('\nregeneration ownership (AC-6)');

{
  const sweep = read('src/services/billing-outbound-sweep.ts');
  const writer = read('src/services/replacement-billing-writer.ts');
  const writeCode = writer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('the outbound sweep PRESERVES replacement line types',
    /OUTBOUND_SWEEP_PRESERVED_LINE_TYPES = \[[\s\S]{0,200}REPLACEMENT_LINE_TYPES/.test(sweep),
    'replacement lines carry order_id = originalOrder.id, so an ordinary rebuild of that ' +
    'order would delete charges for a re-ship that already consumed stock');

  check('the return and replacement vocabularies stay SEPARATE',
    /\.\.\.ALL_GOVERNED_RETURN_LINE_TYPES/.test(sweep)
    && /\.\.\.REPLACEMENT_LINE_TYPES/.test(sweep)
    && !/replace_postage/.test(read('src/services/billing-return-event-contract.ts')),
    'a replacement is outbound; folding it into the return contract would make every reader ' +
    'that asks "is this a return?" answer yes');

  {
    // ONE owner. No other PS-502 module may delete billing lines.
    const others = [
      'src/services/replacement-shipped-command.ts',
      'src/services/replacement-lifecycle-command.ts',
      'src/services/replacement-label-purchase-command.ts',
      'src/services/replacement-label-void-command.ts',
    ];
    const deleters = others.filter((file) => /\.delete\(billingLineItems\)/.test(read(file)));
    check('no other replacement command deletes billing lines',
      deleters.length === 0, `also deletes: ${deleters.join(", ")}`);
  }

  check('the regeneration delete carries ALL FOUR scoping terms',
    /eq\(billingLineItems\.replacementId, facts\.replacementId\)/.test(writeCode)
    && /inArray\(billingLineItems\.lineType/.test(writeCode)
    && /eq\(billingLineItems\.invoiced, false\)/.test(regenBody)
    && /sourceFinalizationId\} is null/.test(writeCode)
    && /billingAdjustmentId\} is null/.test(writeCode),
    'dropping any one term turns a regeneration into a deletion of something it does not own');

  check('delete and rebuild share ONE transaction',
    /export async function regenerateReplacementBillingInTransaction/.test(writer)
    && !/conn\.transaction|db\.transaction/.test(writeCode),
    'a failed insert must roll the delete back, never leave charges removed with nothing back');

  check('finalized rows are never deleted',
    /eq\(billingLineItems\.invoiced, false\)/.test(regenBody),
    'an invoiced line is history; a difference becomes an append-only adjustment');
}

// ── Replacement billing: zero or complete, never partial ─────────────────────
console.log('\nreplacement billing');

{
  const planner = read('src/services/replacement-billing-planner.ts');
  const writer = read('src/services/replacement-billing-writer.ts');
  const planCode = planner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const writeCode = writer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('the planner is PURE — no database, no clock, no policy lookup',
    !/from '\.\.\/db|drizzle-orm|Date\.now\(\)|new Date\(\)/.test(planCode),
    'a planner that reads its own clock cannot be replayed');

  check('billable=false produces NO line, not a zero line',
    /if \(!facts\.billable\) return \[\];/.test(planCode),
    'absence and $0.00 are different claims about whether the work was charged');

  // Re-anchored for AC-10: the two carrier fields are gone and the refusal now hangs off the
  // fenced amount. Same intent — absence must refuse, not bill zero.
  check('a missing frozen money tuple FAILS CLOSED',
    /REPLACEMENT_BILLING_MONEY_UNAVAILABLE/.test(planCode)
    && /!customerPostage \|\| !Number\.isFinite\(customerPostage\.amount\)/.test(planCode),
    'a live quote is not a substitute for what was actually paid');

  check('a missing pick/pack authority FAILS CLOSED',
    /REPLACEMENT_BILLING_PICK_PACK_UNAVAILABLE/.test(planCode),
    'route input and portal arithmetic are not authorities');

  check('postage is the frozen tuple, never a re-read rate',
    // The first negative here was over-broad and matched this module's OWN error message,
    // which says a live quote is not a substitute. A guard that trips on its own explanation
    // forces the next engineer to delete the reasoning to get green. Narrowed to imports.
    //
    // Re-anchored for AC-10: postage was the SUM of two carrier fields, which is what made
    // "the frozen tuple" a claim rather than a fact. It is now the single fenced amount.
    /const postage = customerPostage\.amount;/.test(planCode)
    && !/from '\.\/rate|rate-browser|shipping-rate|normalizeShippingRateMoney/.test(planner),
    'a charge that changes after the goods shipped is not a record of what happened');

  check('lines carry the ORIGINAL order and the ALLOCATED reference',
    /orderId: facts\.orderId/.test(planCode)
    && /orderNumber: facts\.reference/.test(planCode)
    && !/-REPLACE/.test(planCode),
    'never string-build the reference at a use site');

  check('cross-table invariants are asserted in the service',
    /export function assertReplacementLineInvariants/.test(planner)
    && /line\.shipmentId !== replacement\.replacementShipmentId/.test(planCode)
    && /assertReplacementLineInvariants\(/.test(writeCode),
    'no CHECK can require that the shipment is THIS replacement\'s');

  check('the writer inserts with RETURNING and counts the RETURNED rows',
    /\.returning\(\{ id: billingLineItems\.id/.test(writeCode)
    && /inserted\.length !== planned\.length/.test(writeCode),
    'plan length and persisted length are the same number only when the insert did what was asked');

  check('there is NO onConflictDoNothing on a money path',
    !/onConflictDoNothing/.test(writeCode),
    'a conflict means a line exists this plan did not know about; swallowing it reports success');

  check('billing commits inside the caller\'s transaction, not beside it',
    /export async function writeReplacementBillingInTransaction/.test(writer)
    && !/conn\.transaction|db\.transaction/.test(writeCode),
    'a billing failure must roll back the stock movement that would otherwise go unbilled');
}

// ── `shipped` is atomic, and exactly one function writes it ──────────────────
console.log('\nthe atomic shipped command');

{
  const shipCmd = read('src/services/replacement-shipped-command.ts');
  const code = shipCmd.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const shipTransaction = functionBody(code, 'shipReplacement');
  const at = (needle: string) => code.indexOf(needle);

  check('the shipped command exists and is a single transaction',
    shipCmd.length > 0
    && (code.match(/conn\.transaction\(/g) || []).length === 1,
    'stock leaving with no billing row behind it is what a split transaction produces');

  {
    // EXACTLY ONE writer. Every other PS-502 module, and the routes, must not write it.
    const others = [
      'src/services/replacement-lifecycle-command.ts',
      'src/services/replacement-label-purchase-command.ts',
      'src/services/replacement-label-void-command.ts',
      'src/services/replacement-shipment-command.ts',
      'src/services/replacement-create-command.ts',
    ];
    const writers = others.filter((file) => /status: 'shipped'/.test(read(file)));
    check('no other replacement command writes status shipped',
      writers.length === 0, `also writes it: ${writers.join(", ")}`);
    check('the shipped command does write it',
      /status: 'shipped'/.test(code));
  }

  check('the inventory kill switch is checked BEFORE any write',
    /env\.INVENTORY_AUTO_DEDUCT !== true/.test(code)
    && at('INVENTORY_AUTO_DEDUCT') < at('await applyInventoryMovementInTransaction('),
    'shipping while auto-deduct is off moves goods with no ledger entry');

  check('inventory identity is replacement- and ITEM-scoped',
    /replacement:\$\{input\.replacementId\}:shipment:\$\{input\.shipmentId\}/.test(shipCmd)
    && /item:\$\{input\.replacementItemId\}/.test(shipCmd),
    'keying on SKU would collapse duplicate-SKU lines into one deduction');

  check('it never uses the ordinary order-scoped ledger key',
    !/inventory:ship:order:/.test(code),
    'the original order already shipped under that key, so the ledger would skip the deduction');

  check('an unmapped replacement item blocks shipping',
    /REPLACEMENT_INVENTORY_UNRESOLVED/.test(code)
    && at('REPLACEMENT_INVENTORY_UNRESOLVED') < at('await applyInventoryMovementInTransaction('),
    'a missing mapping would move goods with no ledger row and nothing would say so');

  check('an unresolved package blocks shipping rather than being skipped',
    /REPLACEMENT_PACKAGE_UNRESOLVED/.test(code)
    && /if \(!input\.consumePackage\)/.test(code),
    'decision 3 is unfrozen; silently skipping consumption ships a box nothing accounted for');

  check('a billable replacement CANNOT ship without billing lines',
    occursBefore(code, 'if (replacement.billable) {', "status: 'shipped'")
    && /REPLACEMENT_BILLING_UNRESOLVED/.test(code),
    'shipping first and billing later loses the record of what was owed');

  check('ONLY an explicit active/null void state can ship',
    /eq\(replacementLabelPurchaseIntents\.state, 'purchased'\)/.test(shipTransaction)
    && /intent\.voidState === null/.test(shipTransaction)
    && /REPLACEMENT_LABEL_NOT_ACTIVE/.test(shipTransaction)
    && occursBefore(shipTransaction,
      'intent.voidState === null',
      'findFrozenLineDrift('),
    'pending, reconcile-required, voided and future unknown states all mean the label is not proven active');

  check('inventory ids stay candidates until remapped SKU, client and active authority all agree',
    /orderBy\(desc\(replacementItemRemaps\.remapVersion\)\)/.test(shipTransaction)
    && /const effectiveLineIndex = latestRemap\?\.resolvedOrderLineIndex \?\? item\.orderLineIndex;/.test(shipTransaction)
    && /eq\(orderItems\.lineIndex, effectiveLineIndex\)/.test(shipTransaction)
    && /eq\(inventory\.clientId, Number\(replacement\.clientId\)\)/.test(shipTransaction)
    && /eq\(inventory\.active, true\)/.test(shipTransaction)
    && /lower\(btrim\(\$\{inventory\.sku\}\)\) = lower\(btrim\(\$\{expectedSku\}\)\)/.test(shipTransaction)
    && /allowedStock\.length !== 1/.test(shipTransaction)
    && /allowedStock\[0\]!\.id !== candidate\.inventoryId/.test(shipTransaction)
    && /validatedInventoryByItem\.set\(item\.id, \{ id: allowedStock\[0\]!\.id \}\)/.test(shipTransaction)
    && occursBefore(shipTransaction,
      'validatedInventoryByItem.set(item.id, { id: allowedStock[0]!.id });',
      'await applyInventoryMovementInTransaction(')
    && /inventoryId: stock\.id/.test(shipTransaction),
    'inventory:write does not authorize cross-client, inactive or wrong-effective-SKU stock');

  check('duplicate-SKU items keep distinct ledger source identities',
    /sourceEntity: 'replacement_shipment_item'/.test(shipTransaction)
    && /sourceId: `\$\{replacement\.replacementShipmentId\}:\$\{item\.id\}`/.test(shipTransaction)
    && /replacementItemId: item\.id/.test(shipTransaction),
    'the ledger has a second source-identity unique key, so shipment-only identity collapses two items mapped to one SKU');

  check('drift is re-resolved before anything is deducted',
    at('findFrozenLineDrift(') !== -1
    && at('findFrozenLineDrift(') < at('await applyInventoryMovementInTransaction('));

  check('a retry is a no-op rather than a second deduction',
    /replacement\.status === 'shipped' \|\| replacement\.status === 'completed'/.test(code)
    && at("replacement.status === 'shipped'") < at('await applyInventoryMovementInTransaction('));

  check('the transition is guarded on expected status AND version',
    /eq\(replacements\.status, replacement\.status\)/.test(code)
    && /eq\(replacements\.stateVersion, replacement\.stateVersion\)/.test(code)
    && /if \(moved\.length === 0\)/.test(code));

  check('it notifies no marketplace and never touches the original order',
    !/marketplace|notifyCustomer|shopify|walmart|ebay/i.test(code)
    && !/\.update\(orders\)|orderStatus:/.test(code));
}

// ── Void is DESTRUCTIVE, so nothing is inferred ──────────────────────────────
console.log('\nlabel void and reconciliation (locked path)');

{
  const v = read('src/services/replacement-label-void-command.ts');
  const code = v.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const voidCommand = functionBody(code, 'voidReplacementLabel');
  const at = (needle: string) => code.indexOf(needle);

  check('the void command exists and is gated by the feature flag',
    v.length > 0 && /assertReplacementLabelEnabled\(\)/.test(code)
    && at('assertReplacementLabelEnabled()') < at('conn.transaction'));

  check('ALL THREE provider-reaching void/reconcile commands require the label capability and a reason',
    // Counted, not merely present: void, purchase recovery and void recovery each reach a provider, and replacing
    // one check left the other while a `.test()` stayed green — the same multi-occurrence
    // weakness M47 exposed on the lifecycle command.
    (code.match(/includes\(REPLACEMENT_LABEL_PERMISSION\)/g) || []).length === 3
    && (code.match(/requireReason\(input\.reason\)/g) || []).length === 3,
    'reconciling an intent can resolve money as surely as voiding a label');

  check('the destructive call is OUTSIDE every transaction',
    (() => {
      const call = at('await provider.voidLabel({');
      const claimEnds = at('const claim = await conn.transaction');
      const persistBegins = code.lastIndexOf('return conn.transaction(async (tx) => {');
      return call !== -1 && call > claimEnds && call < persistBegins;
    })());

  check('an UNCONFIRMED void is never recorded as voided',
    code.includes('if (!result.voided) {')
    && /if \(!result\.voided\) \{[\s\S]{0,500}voidState: 'void_reconcile_required'/.test(voidCommand)
    && !/if \(!result\.voided\) \{[\s\S]{0,500}voidState: 'voided'/.test(voidCommand),
    'a local voided row with a live label is worse than no row at all');

  check('an already-voided label sends no second destructive call',
    code.includes("intent.voidState === 'voided'")
    && at("intent.voidState === 'voided'") < at('await provider.voidLabel({'),
    'a repeated destructive call can cancel a label a later attempt bought');

  check('an unresolved void attempt is a hard stop before a second destructive call',
    /if \(intent\.voidState != null\) \{/.test(voidCommand)
    && occursBefore(voidCommand,
      'if (intent.voidState != null) {',
      ".set({ voidState: 'void_pending', updatedAt: new Date() })")
    && occursBefore(voidCommand,
      'if (intent.voidState != null) {',
      "return { alreadyVoided: false as const")
    && occursBefore(voidCommand,
      'if (intent.voidState != null) {',
      'await provider.voidLabel({')
    && /REPLACEMENT_VOID_RECONCILE_REQUIRED[\s\S]{0,260}a second destructive call is not a retry/.test(voidCommand),
    'void_pending is evidence of an in-flight call, not permission to send it again');

  check('the intent must belong to THIS replacement',
    /eq\(replacementLabelPurchaseIntents\.replacementId, replacement\.id\)/.test(code),
    'a caller must not void another replacement\'s label by naming its own');

  check('reconciliation asks the provider and never guesses',
    /provider\.lookupPurchase/.test(code)
    && /still_unknown/.test(code),
    'a provider that cannot tell must leave the intent unresolved');

  check('a void alters no order status, stock, billing or marketplace',
    !/\.update\(orders\)|orderStatus:|\.insert\(inventory|\.delete\(billingLineItems\)/.test(code)
    && !/marketplace|notifyCustomer|shopify|walmart|ebay/i.test(code),
    'a voided label moved nothing and a credit is the billing owner\'s job');
}

// ── Label purchase: the only command that can spend real money ───────────────
console.log('\nlabel purchase (locked path)');

{
  const buy = read('src/services/replacement-label-purchase-command.ts');
  const code = buy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const envSource = read('src/lib/env.ts');
  const at = (needle: string) => code.indexOf(needle);
  const purchaseCommand = functionBody(code, 'purchaseReplacementLabel');
  const retryCommand = functionBody(code, 'retryFailedReplacementLabel');
  const dispatch = functionBodyOf(code, 'dispatchClaimedReplacementPurchase');

  check('the feature flag is server-authoritative and DEFAULT OFF',
    /REPLACEMENTS_LABEL_ENABLED: booleanFlag\(false\)/.test(envSource),
    'dark deployment means the code ships and does nothing');

  check('the gate runs BEFORE any transaction or provider access',
    [purchaseCommand, retryCommand].every((command) =>
      occursBefore(command, 'assertReplacementLabelEnabled();',
        command === purchaseCommand ? 'claimPurchase(input, conn)' : 'conn.transaction(async (tx) =>')
      && occursBefore(command, 'input.actor.permissions?.includes(REPLACEMENT_LABEL_PERMISSION)',
        command === purchaseCommand ? 'claimPurchase(input, conn)' : 'conn.transaction(async (tx) =>'))
    && !/provider\.purchase\(/.test(purchaseCommand)
    && !/provider\.purchase\(/.test(retryCommand),
    'a disabled or unauthorized feature must not write a durable intent or contact a provider');

  check('the durable intent is committed BEFORE dispatch',
    // Presence FIRST: indexOf returns -1 when the text is gone, and -1 < anything is true, so
    // deleting the very thing under test made the bare position check pass.
    at('.insert(replacementLabelPurchaseIntents)') !== -1
    && at('.insert(replacementLabelPurchaseIntents)') < at('provider.purchase('),
    'a crash between dispatch and persistence must leave proof a purchase may exist');

  check('the provider call is OUTSIDE every transaction',
    /await provider\.purchase\(\{/.test(dispatch)
    && occursBefore(dispatch, 'await provider.purchase({',
      'const winner = await conn.transaction(async (tx) =>')
    && occursBefore(dispatch, 'await provider.purchase({',
      'return conn.transaction(async (tx) =>'),
    'holding a transaction or lock across the network pins a connection and rolls back the intent');

  check('drift is re-resolved before the claim AND after dispatch',
    (code.match(/findFrozenLineDrift\(/g) || []).length >= 2,
    'a line can move while the network call is in flight');

  check('post-dispatch drift PRESERVES the label and reviews',
    /reviewReason: 'original_order_line_drift',\s*\n\s*eventType: 'replacement_label_purchased_into_review'/.test(code)
    && at('replacement_label_purchased_into_review') > at('provider.purchase('),
    'the label is real and paid for; never discard it and never repurchase');

  // PS-502 item 11. This path's review write matched on id ALONE — no expected status, no
  // expected version, no row-count check — while the other two copies carried all three. It is
  // delegated now, and this is what stops it being re-inlined.
  check('the post-dispatch review delegates to the ONE guarded review writer',
    (code.match(/await enterReplacementReview\(tx, before\.replacement, \{/g) || []).length === 2
    && !/status: 'review'/.test(code)
    && (code.match(/\.update\(replacements\)/g) || []).length === 2,
    'money failure and drift both delegate; the only direct updates preserve an AC-16 hold or move to label_created, both with optimistic predicates');

  check('an unknown provider outcome is held, never retried',
    /reconcile_required/.test(code)
    && /will NOT|never be repurchased|not be repurchased/i.test(buy),
    'a retry after an unseen success buys a second label');

  check('an unresolved intent BLOCKS a further dispatch',
    // The guard CLAUSE, not the error code: the code also appears in the type union above and
    // in the timeout path, so its position proved nothing about whether anything checks it.
    code.includes('if (unresolved) {')
    && at('if (unresolved) {') < at('provider.purchase('),
    'a missing local receipt is not proof that no purchase happened');

  check('the provider identity is replacement-scoped, never the order key',
    /'replacement', input\.replacementId/.test(code)
    && !/orderId/.test(code.slice(at('export function replacementProviderIdempotencyKey'), at('function createStableHash'))),
    'two replacements on one order must never share a purchase identity');

  // Hermes, 2026-08-19: this fell through to the application-main key and a NULL-client
  // replacement could reach the provider. `requestedClientId` was accepted and never read, so
  // an empty credential set (exactly what a NULL client produces) selected scope 'main' and
  // froze it as though an operator had chosen to buy that postage on the house account. The
  // integration test missed it because the harness never configured the main key, so the
  // fallback it was meant to disprove was switched off. Ordering matters as much as presence:
  // the refusal must come BEFORE any credential is considered.
  {
    const authority = read('src/services/replacement-provider-credential-authority.ts');
    check('a NULL replacement client selects NO provider credential authority',
      authority.length > 0
      && /if \(clientScope\(input\.requestedClientId\) === null\) return null;/.test(authority)
      && occursBefore(authority,
        'if (clientScope(input.requestedClientId) === null) return null;',
        'normalizedCredential(input.mainApiKeyV2)'),
      'the application-main key is not authority to buy postage for a replacement nobody owns');
  }

  check('it never reuses createLabelV2 or the ordinary purchase intent API',
    !/createLabelV2|assertNoUnresolvedLabelPurchaseIntent|createLabelPurchaseIntent/.test(code));

  check('it never notifies a marketplace or a customer',
    !/marketplace|confirmFulfillment|notifyCustomer|shopify|walmart|ebay/i.test(code),
    'decision 4 is unfrozen; the only safe behaviour is none');

  check('it never writes the original order status',
    !/\.update\(orders\)|orderStatus:/.test(code));

  check('it moves no inventory, packaging or billing',
    !/\.insert\(billingLineItems\)|\.insert\(inventory|packageLedger|deductInventory/.test(code));

  check('the customer money tuple is frozen onto real shipment columns',
    /cost: String\(receipt\.shipmentCost\)/.test(code)
    && /selectedRateCost: String\(/.test(code)
    && !/shipmentCost: String\(/.test(code),
    'an earlier draft wrote a shipmentCost column that does not exist');
}

// ── Purchase inputs are resolved, never invented ─────────────────────────────
//
// Executed, not grepped. DJ decisions 1-3 are unfrozen, and the failure mode this guards is
// silent: a default chosen here would ship, operators would rely on it, and the eventual
// ruling would be ratifying whatever this file happened to do.
//
// NOTE ON SHAPE. `check` in this file takes (name, BOOLEAN). The first version of this
// section passed an arrow function instead — which is truthy — so all seventeen checks
// passed unconditionally. The mutation matrix caught it: five mutations survived at once,
// which is what a vacuous block looks like from the outside.
console.log('\npurchase input resolution');

{
  const ADDRESS = {
    name: 'Jane Roe', line1: '1 Test Way', city: 'Springfield', state: 'IL',
    postalCode: '62704', country: 'us',
  };
  const CARRIER = { carrierCode: 'ups', serviceCode: 'ups_ground', providerAccountId: 7 };
  const PACKAGE = { packageId: 'box-a', weightOz: 32, dimsL: 10, dimsW: 8, dimsH: 6 };
  const override = (value: unknown) => ({
    value, source: 'operator_override' as const,
    chosenBy: 'lead@example.test', reason: 'customer confirmed',
  });
  const base = {
    replacementId: 1, replacementShipmentId: 2, replacementReference: '1321-REPLACE',
    address: override(ADDRESS), carrier: override(CARRIER), package: override(PACKAGE),
  } as never;

  /** True when the call refuses with exactly this code. */
  const refuses = (build: () => unknown, code: string): boolean => {
    try { build(); return false; } catch (e) {
      return e instanceof ReplacementPurchaseRequestError && e.code === code;
    }
  };
  const resolved = resolveReplacementPurchaseRequest(base);

  check('a fully attributed request resolves',
    resolved.carrier.serviceCode === 'ups_ground'
    && resolved.address.country === 'US'
    && resolved.provenance.address.source === 'operator_override'
    && resolved.provenance.address.chosenBy === 'lead@example.test',
    'country must be canonicalised and provenance recorded');

  check('every DJ decision governing a default is still UNFROZEN',
    FROZEN_DECISIONS.address === false
    && FROZEN_DECISIONS.carrierService === false
    && FROZEN_DECISIONS.package === false,
    'freezing a decision in code rather than on the card is the inversion this prevents');

  for (const field of ['address', 'carrier', 'package'] as const) {
    check(`a POLICY DEFAULT for ${field} is refused while its decision is unfrozen`,
      refuses(
        () => resolveReplacementPurchaseRequest({
          ...(base as never as Record<string, unknown>), [field]: { value: (base as never as Record<string, { value: unknown }>)[field].value, source: 'policy_default' },
        } as never),
        'REPLACEMENT_PURCHASE_DECISION_UNFROZEN'),
      'a default accepted now becomes policy by default');

    check(`a MISSING ${field} is reported as missing, not as an unfrozen decision`,
      refuses(
        () => resolveReplacementPurchaseRequest({
          ...(base as never as Record<string, unknown>), [field]: undefined,
        } as never),
        'REPLACEMENT_PURCHASE_INPUT_MISSING'),
      'the two send an operator to completely different places');

    check(`an override of ${field} without an ACTOR is refused`,
      refuses(
        () => resolveReplacementPurchaseRequest({
          ...(base as never as Record<string, unknown>),
          [field]: { ...override((base as never as Record<string, { value: unknown }>)[field].value), chosenBy: null },
        } as never),
        'REPLACEMENT_PURCHASE_OVERRIDE_UNATTRIBUTED'),
      'an unattributed override is indistinguishable from an invented default');

    check(`an override of ${field} without a REASON is refused`,
      refuses(
        () => resolveReplacementPurchaseRequest({
          ...(base as never as Record<string, unknown>),
          [field]: { ...override((base as never as Record<string, { value: unknown }>)[field].value), reason: null },
        } as never),
        'REPLACEMENT_PURCHASE_OVERRIDE_UNATTRIBUTED'));
  }

  check('a zero weight is refused rather than treated as a default',
    refuses(
      () => resolveReplacementPurchaseRequest({
        ...(base as never as Record<string, unknown>),
        package: override({ ...PACKAGE, weightOz: 0 }),
      } as never),
      'REPLACEMENT_PURCHASE_INPUT_INVALID'),
    'a zero weight is not a default, it is an unpriceable parcel');

  check('internal cost data cannot travel in a provider request',
    refuses(
      () => resolveReplacementPurchaseRequest({
        ...(base as never as Record<string, unknown>),
        package: override({ ...PACKAGE, labelCost: 9.99 }),
      } as never),
      'REPLACEMENT_PURCHASE_INTERNAL_COST_LEAK'),
    'the resolved request is persisted and sent outward; cost must not ride along');

  check('the fingerprint covers the values a purchase depends on',
    [
      { ...(base as never as Record<string, unknown>), carrier: override({ ...CARRIER, serviceCode: 'ups_2day' }) },
      { ...(base as never as Record<string, unknown>), package: override({ ...PACKAGE, weightOz: 33 }) },
      { ...(base as never as Record<string, unknown>), address: override({ ...ADDRESS, postalCode: '90210' }) },
    ].every((variant) =>
      resolveReplacementPurchaseRequest(variant as never).fingerprint !== resolved.fingerprint),
    'a retry must not be able to buy a different parcel under the same frozen request');

  check('provenance is NOT part of the fingerprint',
    resolveReplacementPurchaseRequest({
      ...(base as never as Record<string, unknown>),
      address: { ...override(ADDRESS), chosenBy: 'someone.else@example.test', reason: 'retry' },
    } as never).fingerprint === resolved.fingerprint,
    'a retry by a different operator is the same purchase');

  check('the fingerprint helper agrees with the resolver',
    fingerprintPurchaseRequest(resolved) === resolved.fingerprint);

  check('the resolver is pure — no db, no provider, no network',
    !/from '\.\.\/db|drizzle-orm|node-fetch|axios/.test(read('src/services/replacement-purchase-request.ts')));
}

// ── The lifecycle command is the ONE transition owner ────────────────────────
console.log('\nlifecycle command (locked path)');

{
  const life = read('src/services/replacement-lifecycle-command.ts');
  const code = life.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const ship = read('src/services/replacement-shipment-command.ts');
  const drift = read('src/services/replacement-drift-resolution.ts');

  check('there is ONE transition primitive, not a transition per command',
    /async function applyTransition\(/.test(code)
    && (code.match(/\.update\(replacements\)/g) || []).length <= 4,
    'three rules repeated per command drift apart immediately');

  check('EVERY update to replacements is guarded on status AND state_version',
    (() => {
      // Presence is not enough: the predicate appears once per writing command, so
      // deleting one leaves the others and a `.test()` stays green while that command
      // silently loses its guard. Each update site is checked on its own.
      const sites = [...code.matchAll(/\.update\(replacements\)/g)].map((m) => m.index ?? 0);
      if (sites.length === 0) return false;
      return sites.every((at) => {
        const window = code.slice(at, at + 700);
        return /eq\(replacements\.status, before\.status\)/.test(window)
          && /eq\(replacements\.stateVersion, before\.stateVersion\)/.test(window)
          && /\.returning\(\)/.test(window);
      });
    })(),
    'one unguarded update is a lost update, and it is the one nobody looks at');

  check('a zero-row transition is a coded 409 and appends NO event',
    /if \(moved\.length === 0\)/.test(code)
    && code.indexOf('if (moved.length === 0)') < code.indexOf('.insert(replacementActivityEvents)'),
    'an append-only log is trusted precisely because it cannot record a move that never happened');

  check('the diagram is asserted before the row is touched',
    /assertReplacementTransition\(from, input\.to\)/.test(code)
    && code.indexOf('assertReplacementTransition') < code.indexOf('.update(replacements)'),
    'a transition the lifecycle never allowed must not depend on a predicate happening to miss');

  check('approval re-resolves drift and COMMITS the review before reporting',
    /findFrozenLineDrift\(tx, before\)/.test(code)
    && code.includes('if (drift) {')
    && code.indexOf('return { reference: before.reference, finding }') < code.indexOf('if (drift) {'),
    'throwing inside the transaction would roll the review back and it would drift forever');

  check('a remap requires the dedicated override capability and a reason',
    // The PREDICATE, not the constant: the constant is also named in the refusal message,
    // so asserting its presence passed cleanly against `if (false)`.
    /!input\.actor\.permissions\.includes\(REPLACEMENT_OVERRIDE_PERMISSION\)/.test(code)
    && /REPLACEMENT_REMAP_REASON_REQUIRED/.test(code),
    'retargeting a replacement is not an ordinary approval');

  check('a remap APPENDS and never rewrites the requested snapshot',
    /\.insert\(replacementItemRemaps\)/.test(code)
    && !/\.update\(replacementItems\)/.test(code),
    'replacement_items is what was REQUESTED; an audit after the fact needs it');

  check('a remap re-runs the allowance against the NEW coordinate',
    /evaluateReplacementAllowance\(/.test(code),
    'remapping is how a line could be over-replaced without any single request exceeding its cap');

  check('the lifecycle command never writes `shipped`',
    !/to: \x27shipped\x27/.test(code),
    'shipped belongs to the atomic command that also owns inventory, packaging and billing');

  check('it writes no shipment, label, inventory or billing row',
    !/\.insert\(shipments\)|createLabelV2|\.insert\(billingLineItems\)|\.insert\(inventory/.test(code));

  check('drift resolution has ONE owner, shared with the shipment command',
    drift.length > 0
    && /findFrozenLineDrift/.test(ship)
    && /findFrozenLineDrift/.test(code),
    'two copies of the comparison would disagree about what counts as drift');

  check('the shared drift reader is READ ONLY',
    !/\.update\(|\.insert\(|\.delete\(/.test(drift),
    'callers persist the review; this only answers the question');
}

// ── Immutable runtime identity is API/worker evidence, not a deploy guess ───
console.log('\nimmutable API/worker runtime identity');

{
  const runtimeVersion = read('src/lib/runtime-version.ts');
  const workerStatus = read('src/services/worker-status.ts');
  const health = read('src/routes/health.ts');
  const workerRoute = read('src/routes/worker.ts');
  const packageJson = read('package.json');
  const concurrencyWorkflow = read('.github/workflows/ps-502-concurrency-pg17.yml');
  const migrationWorkflow = read('.github/workflows/render-one-off-migration-ps502.yml');

  check('runtime evidence accepts only a full immutable Render SHA captured at process boot',
    /const FULL_GIT_SHA = \/\^\[0-9a-f\]\{40\}\$\/i/.test(runtimeVersion)
    && /source\.RENDER_GIT_COMMIT/.test(runtimeVersion)
    && /commitSha \? 'RENDER_GIT_COMMIT' : 'unknown'/.test(runtimeVersion)
    && /export const runtimeVersionIdentity = readRuntimeVersionIdentity\(\);/.test(runtimeVersion),
    'a short, mutable or guessed version cannot prove which reviewed commit a process runs');

  check('API and persisted worker identities are separate and certified in both PS-502 lanes',
    /"test:ps-502-runtime-version": "tsx scripts\/ps-502-runtime-version-guard\.ts"/.test(packageJson)
    && (workerStatus.match(/runtime: runtimeVersionIdentity/g) ?? []).length >= 2
    && (health.match(/runtime: runtimeVersionIdentity/g) ?? []).length >= 2
    && /api: getApiRuntimeStatus\(\),[\s\S]*worker,/.test(workerRoute)
    && /npm run test:ps-502-runtime-version/.test(concurrencyWorkflow)
    && /npm run test:ps-502-runtime-version/.test(migrationWorkflow),
    'an API SHA cannot stand in for a separately running worker, or vice versa');
}

// ── The genuine-concurrency lane must stay genuine ───────────────────────────
//
// AC-12 says CONCURRENT. The PGlite lane cannot satisfy it — a single backend means two
// transactions never overlap and the advisory lock is trivially held — so the PG17 lane is
// the only evidence for it. Every check below defends a way that lane could quietly stop
// proving anything while still reporting green.
console.log('\ngenuine-concurrency lane');

{
  const pg17 = read('scripts/ps-502-replacement-concurrency-pg17.ts');
  const workflow = read('.github/workflows/ps-502-concurrency-pg17.yml');
  const sharedSchema = read('scripts/lib/ps-502-test-schema.ts');
  const pglite = read('scripts/ps-502-replacement-integration.ts');

  check('the PG17 concurrency suite exists', pg17.length > 0);

  check('it FAILS rather than skips without a server',
    /process\.exit\(1\)/.test(pg17) && /unskippable/i.test(pg17),
    'a suite that skips silently reports green while proving nothing');

  check('it refuses any non-loopback host',
    /'127\.0\.0\.1', 'localhost', '::1', 'postgres'/.test(pg17)
    && /refusing non-ephemeral host/.test(pg17),
    'this creates and drops databases; it must never reach a real server');

  check('the pool opens MULTIPLE backends',
    /max: [2-9]\d*/.test(pg17),
    'with max: 1 the callers queue and the suite proves nothing PGlite does not already prove');

  check('assertions count PERSISTED ROWS, not resolved promises',
    /exactly ONE shipment row exists/.test(pg17)
    && /exactly one replacement persisted/.test(pg17),
    'two callers can both succeed and still leave two rows behind');

  check('both lanes build on ONE shared schema',
    /PS_502_PREREQUISITE_DDL/.test(pg17) && /PS_502_PREREQUISITE_DDL/.test(pglite)
    && sharedSchema.length > 0,
    'a behaviour proven against one schema says nothing about the other');

  check('the shared schema applies the PS-502 migrations verbatim',
    /0096_ps502_replacements\.sql/.test(sharedSchema)
    && /0099_ps502_replacement_request_signature\.sql/.test(sharedSchema)
    && /0025_order_items_sync_trigger\.sql/.test(sharedSchema));

  check('CI runs the concurrency lane on a real postgres:17 service',
    /image: postgres:17/.test(workflow)
    && /test:ps-502-concurrency-pg17/.test(workflow));

  check('CI proves the pool really opened more than one backend',
    /distinct backends observed|concurrency proofs would be vacuous/.test(workflow),
    'if the server ever handed out one backend the assertions would pass vacuously');
}

// ── The production migration lane must deploy every PS-502 migration ─────────
//
// Hermes found this lane stale at 8d0dcc5c: it applied only 0096/0097 while the create
// command already depended on 0099 (request_signature) and the RESTRICT contract in 0098.
// A deploy would have produced a schema the shipped code cannot run against — and nothing
// would have said so until a route 500ed in production.
//
// Discovered from the directory rather than from the runner. 0102 has a reporting-owned
// filename but is part of this operator lane; later ps502-named migrations are picked up too.
console.log('\nproduction migration lane');

{
  const applier = read('scripts/apply-ps-502-replacement-schema.ts');
  const workflow = read('.github/workflows/render-one-off-migration-ps502.yml');
  // The two places that DECIDE what ships, isolated from the verification prose that names
  // every migration regardless. Searching the whole file let the archive sit at 0096/0097
  // for four migrations while this guard stayed green — the defect Hermes found twice.
  const archiveStart = workflow.indexOf('files=(');
  const workflowArchive = workflow.slice(archiveStart, workflow.indexOf(')', archiveStart));
  const workflowRunArgs = workflow.slice(
    workflow.indexOf('run_args="'),
    workflow.indexOf('\n', workflow.indexOf('run_args="')),
  );
  const ps502Migrations = readdirSync('drizzle')
    .filter((name) => /ps502.*\.sql$/.test(name)
      || name === '0102_billing_summary_metrics_replacement_totals.sql')
    .sort();

  check('the operator lane contains the complete 0096-0103 sequence',
    ps502Migrations.length >= 8
    && ps502Migrations[0]?.startsWith('0096_')
    && ps502Migrations.slice(-1)[0]?.startsWith('0103_')
    && ps502Migrations.includes('0102_billing_summary_metrics_replacement_totals.sql'),
    `found: ${ps502Migrations.join(", ")}`);

  for (const migration of ps502Migrations) {
    check(`the runner applies ${migration}`, applier.includes(migration),
      'the official deploy path must apply every migration the code depends on');
    // Anchored on the two things that DECIDE what ships: the archive array and the argument
    // string. The previous form searched the whole file, and every migration also appears in
    // the digest-verification step — which hashes the GitHub runner's own checkout, not the
    // tarball that travels. So the check passed for four migrations that were never shipped.
    const digestArg = `--digest${Number(migration.slice(0, 4))}=`;
    check(`the workflow SHIPS and pins ${migration}`,
      workflowArchive.includes(migration) && workflowRunArgs.includes(digestArg),
      'a migration named only in the digest step is verified on the runner and then left behind; the archive and the arguments are what reach the server');
  }

  check('every pinned digest is LF-normalised',
    /replace\(\/\\r\\n\/g, '\\n'\)/.test(applier),
    'core.autocrlf=true, so raw bytes vary by checkout and a digest over them is not reproducible');

  check('every migration digest is mandatory, including 0102 and 0103',
    /file: SQL_0102, expected: EXPECTED_0102, argName: 'digest102'/.test(applier)
    && /file: SQL_0103, expected: EXPECTED_0103, argName: 'digest103'/.test(applier)
    && /for \(const \{ file, expected, argName \} of REVIEWED_MIGRATIONS\)/.test(applier)
    && /if \(supplied !== expected\)/.test(applier),
    'an omitted argument must stop before a connection opens, not silently accept the runner checkout');

  check('the migrations apply in ONE transaction',
    /await sql\.begin\(async \(tx\) =>/.test(applier)
    && /for \(const migration of pendingMigrations\)/.test(applier)
    && /await tx\.unsafe\(readFileSync\(migration\.file, 'utf8'\)\)/.test(applier)
    && occursBefore(applier, 'const pendingMigrations = REVIEWED_MIGRATIONS.filter(',
      'await sql.begin(async (tx) =>'),
    'a partial apply leaves a schema the code cannot run against');

  check('the runner reads back 0103 columns, indexes, constraints, FKs and RLS',
    /replacement_financial_actions is absent/.test(applier)
    && /replacement_financial_actions_due_idx/.test(applier)
    && /replacement_financial_actions_completion_check/.test(applier)
    && /replacement_financial_actions_replacement_id_fkey/.test(applier)
    && /\['clients', 'replacement_financial_actions_client_id_fkey'\]/.test(applier)
    && /financialRls/.test(applier),
    'running SQL without verifying the durable obligation shape is not a certified operator lane');

  // ── The five states the lane can meet, and what it does in each ────────────
  //
  // Pinned at the decision level, not executed. main() runs at module load and opens a real
  // connection, so importing detectReviewedPrefix to drive synthetic snapshots is not possible
  // without restructuring a certified operator lane; executing the five states for real needs
  // a live PostgreSQL, which is the PG17 lane. What is pinned here is what actually decides
  // each state — the stage arithmetic and, above all, the ORDER: every refusal and every
  // no-op must be settled BEFORE the first write.
  const applyBegin = 'await sql.begin(async (tx) =>';

  check('a WHOLLY ABSENT lane is stage 0 and installs the entire reviewed sequence',
    applier.includes('let stage = 0;')
    && applier.includes('while (stage < 8 && complete[stage + 1]) stage += 1;')
    && applier.includes('(migration) => migration.stage > beforePrefix.stage,'),
    'stage 0 must leave every reviewed migration pending, not silently skip the first');

  check('an EXACT REVIEWED PREFIX applies only the missing suffix',
    applier.includes('const pendingMigrations = REVIEWED_MIGRATIONS.filter(')
    && applier.includes('(migration) => migration.stage > beforePrefix.stage,')
    && occursBefore(applier, 'const pendingMigrations = REVIEWED_MIGRATIONS.filter(', applyBegin),
    'replaying an installed prefix re-runs 0098 FK hardening and takes needless locks on live billing');

  check('the 0096-0102-then-0103 state is a real stage, so only 0103 remains pending',
    /snapshot\.tables\.financial_actions && rlsMarkers\.length === 7/.test(applier)
    && /holdMarkers\.every\(Boolean\)/.test(applier)
    && /metricMarkers\.every\(Boolean\)/.test(applier),
    '0103 must be its own completeness stage or an installed 0096-0102 lane reads as fully exact');

  check('a FULLY EXACT REPLAY writes nothing at all',
    applier.includes('if (beforePrefix.stage === 8) {')
    && applier.includes('Already exact through 0103 — APPLY replay is a no-op. Nothing was written.')
    && occursBefore(applier, 'if (beforePrefix.stage === 8) {', applyBegin),
    'a replay that reaches sql.begin has already decided to write on an exact lane');

  check('a MALFORMED or PARTIAL lane is refused BEFORE the first write, in both modes',
    applier.includes('STOP: INSPECT found schema drift from the reviewed 0096-0103 shape (nothing was written)')
    && applier.includes('STOP: APPLY target is partially present or drifted; nothing was written')
    && occursBefore(applier, 'STOP: APPLY target is partially present or drifted', applyBegin)
    && applier.includes('PS-502 schema is not a contiguous reviewed prefix: stage ')
    && occursBefore(applier, 'if (highestPresent > stage) {', 'problems.push(...validateReplacementSchema(snapshot, stage));'),
    'IF NOT EXISTS would preserve a malformed object and commit additive statements on top of it');

  check('the non-contiguous case is drift, not an installable prefix',
    /const highestPresent = present\.reduce\(/.test(applier)
    && /if \(highestPresent > stage\) \{/.test(applier),
    'a later stage present while an earlier one is incomplete must never read as installable');
}

// ── The create command — the ORDER of its steps is the contract ──────────────
//
// Source-level, because the command needs a database and this guard is offline. What is
// pinned is ordering and absence, which is where this command can silently break: every step
// below individually "works" in the wrong order, and the failure only appears under
// concurrency or on a retry.
console.log('\ncreate command (locked path)');

{
  const createSource = read('src/services/replacement-create-command.ts');
  const code = createSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const at = (needle: string | RegExp) =>
    typeof needle === 'string' ? code.indexOf(needle) : (needle.exec(code)?.index ?? -1);

  const lockAt = at('pg_advisory_xact_lock');
  const idempotentReadAt = at('replacements.requestIdempotencyKey');
  const orderReadAt = at('.from(orders)');
  const allowanceAt = at('evaluateReplacementAllowance(');
  const billabilityAt = at('evaluateBillabilityChange(');
  const referenceAt = at('nextReplacementReference(');
  const insertAt = at('.insert(replacements)');

  check('the command exists and is transactional',
    // `conn.transaction`, not `db.transaction`: the command takes an injected connection so
    // it can be executed against an embedded Postgres. Defaulting to the real pool keeps
    // production callers unchanged.
    createSource.length > 0 && /conn\.transaction\(/.test(code)
    && /conn: Pick<typeof db, 'transaction'> = db/.test(createSource));

  check('an order-scoped advisory lock is taken FIRST',
    lockAt !== -1 && lockAt < idempotentReadAt && lockAt < orderReadAt,
    'outside the lock, two concurrent creates both read the same allowance and both succeed');

  check('the lock class is distinct from billing\'s',
    /REPLACEMENT_ORDER_LOCK_CLASS = 36423/.test(createSource)
    && !/36421|36422/.test(code),
    'sharing a lock id with an unrelated resource serialises for no reason and deadlocks for subtle ones');

  check('idempotency is checked INSIDE the lock, before anything is created',
    idempotentReadAt !== -1 && lockAt < idempotentReadAt && idempotentReadAt < insertAt,
    'outside it, a retry inserts and only the UNIQUE index stops it — a safe retry becomes a 500');

  // Anchored on the PROPERTY, not on the expression shape. The first version pinned
  // `if (existing) return {...}` as one line and broke the moment idempotency became
  // payload-bound — a guard that trips on a legitimate refactor teaches people to delete it.
  check('a matching repeated key returns the EXISTING replacement rather than erroring',
    /return \{ replacement: existing, created: false \}/.test(code)
    && at('return { replacement: existing, created: false }') < at('.insert(replacements)'));

  check('the allowance is evaluated BEFORE the insert',
    allowanceAt !== -1 && allowanceAt < insertAt);

  check('billability is evaluated BEFORE the insert',
    billabilityAt !== -1 && billabilityAt < insertAt);

  check('the reference is ALLOCATED, never string-built',
    referenceAt !== -1 && referenceAt < insertAt
    && !/-REPLACE/.test(code),
    'the card bans string-building ${orderNumber}-REPLACE at use sites');

  check('the fingerprint is frozen by the shared builder',
    /buildReplacementSourceLineFingerprint\(/.test(code));

  check('only a SHIPPED original is replaceable, and a cancelled one has its own path',
    /REPLACEABLE_ORDER_STATUS = 'shipped'/.test(createSource)
    && /REPLACEMENT_ORDER_CANCELLED/.test(code));

  // The create command commits nothing physical. If it ever does, the whole "an operator may
  // create one and a reviewer may reject it" property is gone.
  for (const forbidden of ['shipments', 'billingLineItems', 'billingCreditNotes', 'inventory']) {
    check(`create writes NO ${forbidden} row`,
      !new RegExp(`\\.insert\\(${forbidden}\\)|update\\(${forbidden}\\)`).test(code));
  }
  // ── Hermes correctness findings 1, 2, 3, 5, 6 ──────────────────────────────
  check('a fractional or non-positive quantity is a coded 400, not a database CHECK error',
    /Number\.isInteger\(item\.quantity\) \|\| item\.quantity <= 0/.test(code)
    && at('REPLACEMENT_ITEM_INVALID') < at('conn.transaction('),
    'truncating turned 1.9 into 1 — one unit ships and it reads as a picking error');

  check('duplicate line coordinates are rejected before the transaction',
    /seenIndexes\.has\(item\.orderLineIndex\)/.test(code)
    && at('seenIndexes') < at('conn.transaction('),
    'two entries for one line were each allowed, then collided on the unique index');

  check('the frozen reason vocabulary is enforced server-side',
    /REPLACEMENT_REASONS = \['damaged', 'wrong_item', 'lost_in_transit', 'other'\]/.test(createSource)
    // The PREDICATE, not merely the constant and the error code. Asserting that the
    // vocabulary is declared says nothing about whether anything consults it — the first
    // version of this check passed against `if (false)`.
    && /!REPLACEMENT_REASONS\.includes\(input\.reason/.test(code)
    && at('REPLACEMENT_REASON_INVALID') < at('conn.transaction('),
    'a UI is not the only caller');

  check('idempotency binds the WHOLE request, not just its items',
    // Comparing only order id and items let one key be retried with the same lines but a
    // different reason, liability owner or billability and silently return the earlier
    // replacement, so the caller believed its new intent had been recorded.
    /const requestSignature = canonicalRequestSignature\(input\)/.test(code)
    && /existing\.requestSignature !== requestSignature/.test(code)
    && /requestSignature,/.test(code),
    'the caller would believe its new intent had been recorded when nothing changed');

  check('the signature covers every behaviourally significant field',
    ['orderId', 'reason', 'liabilityOwner', 'requestedBillable', 'billabilityReason', 'overrideReason']
      .every((field) => new RegExp(`${field}:`).test(createSource)),
    'a field left out is a field a retry may silently change');

  check('a row with no stored signature cannot pass as equivalent',
    /pre-0099 row/.test(createSource),
    'unprovable equivalence must conflict — the safe direction for a money-bearing command');

  check('a reordered item array is the SAME request, not a conflict',
    /\.sort\(\(a, b\) => a\[0\] - b\[0\]/.test(createSource));

  check('the billability reason is RECORDED, not just validated',
    /eventType: 'replacement_billability_set'/.test(code) && /detail: input\.billabilityReason/.test(code),
    'decision 7 requires a reason and an event; recording that money was charged and not why is worse');

  check('an authorized client-liability decision is recorded whether TRUE or FALSE',
    // Gating on `billability.billable` discarded the reason behind an authorized `false` —
    // exactly the justification an auditor would look for. Operator-liability forced-false
    // is a policy RESULT rather than a decision, and needs no privileged event.
    /if \(input\.liabilityOwner === 'client'\) \{/.test(code)
    && !/if \(billability\.billable\) \{/.test(code));

  check('an audited override records its reason on the event',
    /detail: usedOverride \? \(input\.override\?\.reason \?\? null\) : null/.test(code));

  check('create purchases no label',
    !/createLabelV2|purchaseLabel|buyLabel/.test(code),
    'the card requires a replacement-specific command over lower-level primitives');
}

// ── Shipment insertion — the first command that writes shipped data ──────────
console.log('\nshipment insertion (locked path)');

{
  const shipSource = read('src/services/replacement-shipment-command.ts');
  const code = shipSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const at = (needle: string) => code.indexOf(needle);

  // PS-502 item 11 moved this command's review write into enterReplacementReview. The checks
  // below that used to read an inline update in THIS file now read THAT function — scoped with
  // functionBody, because three writers in the lifecycle file contain lines of identical text
  // and a file-wide presence check would let a neighbour answer for the one under test.
  const reviewWriter = functionBody(
    read('src/services/replacement-lifecycle-command.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    'enterReplacementReview',
  );

  check('it inserts a shipment and links it to the replacement',
    /\.insert\(shipments\)/.test(code) && /replacementShipmentId: shipment\.id/.test(code));

  check('drift is re-resolved BEFORE the shipment is inserted',
    at('findFrozenLineDrift(') !== -1
    && at('findFrozenLineDrift(') < at('.insert(shipments)'),
    'the card requires re-resolution before label purchase, and this is the last cheap place');

  // RE-ANCHORED (PS-502 item 11). The predicate this section used to read inline now lives in
  // enterReplacementReview, so the check follows the write rather than the file: this command
  // must CALL the one writer, must hand-roll no review of its own, and that writer must still
  // carry both terms of the predicate on adjacent lines.
  //
  // The retired check was named 'the drift review is guarded by expected STATUS as well as
  // version'. Its property is not dropped — it is asserted per update site, for EVERY site, by
  // 'EVERY update to replacements is guarded on status AND state_version' in the lifecycle
  // section above, which is strictly stronger than the single-file regex it replaces.
  check('the drift review delegates to the ONE guarded review writer',
    /await enterReplacementReview\(tx, replacement, \{/.test(code)
    && !/status: 'review'/.test(code)
    && /eq\(replacements\.status, before\.status\),\s*\n\s*eq\(replacements\.stateVersion, before\.stateVersion\),/.test(reviewWriter),
    're-inlining a copy is exactly how the label-purchase path lost its predicate');

  check('a drift review is COMMITTED, then reported',
    // The update to review must not sit in the transaction that the throw aborts, or the
    // operator gets a 409 while the replacement stays approved and drifts again forever.
    /await enterReplacementReview\(/.test(code)
    && /return \{ drifted: true/.test(code)
    && at("return { drifted: true") < at('throw new ReplacementShipmentError(\n      REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED'),
    'the review has to commit while the operation fails');

  check('no shipment is inserted on the drift path',
    at('.insert(shipments)') > at('if (outcome.drifted)'),
    'the card requires no label/inventory/package/billing effect on a mismatch');

  // Hermes ruling A, the two details required before label purchase stacks on this.
  // RE-ANCHORED (PS-502 item 11): the row-count check moved into the shared writer with the
  // update it guards. Presence FIRST, then position — indexOf returns -1 when the text is gone
  // and -1 < anything is true, which is how deleting the thing under test used to pass.
  check('a lost drift race appends NO event',
    /if \(reviewed\.length === 0\)/.test(reviewWriter)
    && reviewWriter.indexOf('if (reviewed.length === 0)')
      < reviewWriter.indexOf('.insert(replacementActivityEvents)')
    && /await enterReplacementReview\(tx, replacement, \{/.test(code),
    'a false entry in an append-only audit log is worse than a missing one, because it is trusted');

  check('the already-attached fast path is documented as skipping re-resolution',
    /THIS PATH SKIPS DRIFT RE-RESOLUTION/.test(shipSource),
    'the label command must re-resolve itself rather than assume this one did');

  check('the link is guarded by status AND state_version',
    /eq\(replacements\.status, before\.status\)/.test(code)
    && /eq\(replacements\.stateVersion, before\.stateVersion\)/.test(code),
    'the two transactions leave a gap; optimistic concurrency is what closes it');

  check('a lost link rolls the orphan shipment back',
    /if \(linked\.length === 0\)/.test(code) && /throw new ReplacementShipmentError/.test(code));

  check('an already-attached replacement returns its existing shipment',
    /existingShipmentId != null/.test(code) && /created: false/.test(code),
    'a retry must not mint a second shipment for one replacement');

  check('the shipment carries the REPLACEMENT reference, not the original order number',
    /orderNumber: before\.reference/.test(code),
    'two rows both claiming "1321" read as a duplicate label on the original');

  check('a replacement is outbound — isReturn is never set',
    !/isReturn:\s*true/.test(code),
    'conflating the two inverts its direction in every report');

  check('it never reuses createLabelV2 or buys a label',
    !/createLabelV2|purchaseLabel|buyLabel/.test(code),
    'shipping-safety blocks a second label on a shipped order, which is fatal here');

  check('it never mutates the original order or its status',
    !/\.update\(orders\)/.test(code) && !/orderStatus:/.test(code));

  check('it writes no inventory, package or billing row',
    !/\.insert\(billingLineItems\)|\.insert\(inventory|\.insert\(packageLedger/.test(code));
}

{
  const sources = [
    'src/services/replacement-source-line-fingerprint.ts',
    'src/services/replacement-reference.ts',
    'src/services/replacement-allowance.ts',
    'src/services/replacement-billability.ts',
  ].map(read).join('\n');
  check('every new module is pure (no db, no network)',
    !/from '\.\.\/db|drizzle-orm|node-fetch|axios/.test(sources));
}

// ── Ordinary readers must never adopt a replacement-owned shipment ──────────
//
// A replacement shipment is deliberately shaped like an orphan: order_id IS NULL,
// source = 'replacement', order_number = the replacement reference rather than an order
// number. Every reader below is an ORDINARY order-number / tracking / billing /
// reconciliation fallback whose entire job is to find shipments that look unattached and
// repair them. Without the exclusion they re-link a replacement to an order, re-bill its
// postage against the original, or reconcile it away as a ShipStation orphan.
console.log('\nordinary readers exclude source = replacement');

{
  const GENERIC_FALLBACK_READERS = [
    'src/services/shipment-unattributed-audit-loader.ts',
    'src/services/shipment-sync-watchdog.ts',
    'src/services/shipstation-deleted-awaiting-reconciliation.ts',
    'src/services/shipment-label-url-enrich.ts',
    'src/services/labels.ts',
    'src/services/billing.ts',
    'src/services/order-sync.ts',
    'src/routes/orders.ts',
    'src/routes/shipments.ts',
    'scripts/reconcile-orphan-shipstation-shipments.ts',
    'scripts/reconcile-shipstation-awaiting.ts',
    'scripts/reconcile-external-shipped-orders.ts',
    'scripts/repair-billing-shipment-linkage.ts',
  ];

  // ── The list above is NOT the authority; this sweep is ────────────────────
  //
  // A hand-picked list is green by construction the moment someone adds a reader to it — and
  // that is exactly what happened. This guard asserted "13 readers exclude replacements",
  // which was true and read like completeness, while src/routes/analysis.ts,
  // src/services/shipping-margin-analytics.ts and src/services/hugrab-billing-shipping-floor.ts
  // were never in the list at all. Hermes found all three on 2026-08-19. So: DISCOVER every
  // production reader of the shipments table mechanically, and require each one to be
  // classified. A new reader that is neither excluded nor consciously acknowledged fails here.
  // TWO null-safe spellings are in use and both are correct: `is distinct from 'replacement'`
  // and `coalesce(source, '') <> 'replacement'`. Accepting both is deliberate — demanding a
  // single spelling would make this guard a reason to rewrite correct SQL, which is how a
  // regex guard starts dictating production instead of defending it.
  const NULL_SAFE = /is distinct from\s+'replacement'|coalesce\([^)]*\)\s*<>\s*'replacement'/i;

  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  // Discovery is per-OCCURRENCE, not per-file, and that distinction is the whole lesson.
  // The previous version asked "does this file contain an exclusion?", so ONE excluded query
  // vouched for every other read in the same file — which is precisely how the
  // provider_account_names subquery in shipping-margin-analytics.ts kept leaking replacement
  // nicknames onto ordinary margin rows twelve lines below an exclusion I had just added.
  //
  // Aliased imports also defeated the old matcher: Hermes passed 443/443 with a probe file
  // doing `import { shipments as vessel }`. Symbols are now resolved per file, and the raw
  // forms are matched case-insensitively.
  const tableSymbols = (source: string): string[] => [
    'shipments',
    ...[...source.matchAll(/import\s*\{[^}]*\bshipments\s+as\s+(\w+)/g)].map((m) => m[1]!),
  ];

  const occurrenceRegex = (symbol: string): RegExp => new RegExp(
    [
      `(?:from|join)\\s*\\(\\s*${symbol}\\s*[),]`,   // drizzle .from(x) / .leftJoin(x, ...)
      `(?:from|join)\\s+\\$\\{\\s*${symbol}\\s*\\}`, // sql`... from ${x}`
      `(?:from|join)\\s+${symbol}\\b`,               // raw SQL, any case
      `update\\s*\\(\\s*${symbol}\\s*\\)`,           // drizzle .update(x)
    ].join('|'),
    'gi',
  );

  // How far past a read to look for its exclusion. A predicate lives in the same statement;
  // 1500 characters covers the long analytic SELECTs in this codebase without letting the NEXT
  // query's exclusion answer for this one.
  const PREDICATE_WINDOW = 1500;

  // A replacement vessel is created with order_id IS NULL — that is the whole isolation design.
  // So a read bound to an order, or to one shipment id, PROVABLY cannot return one, and needs
  // no source predicate. This is a derived proof rather than a written excuse, which matters:
  // the two acknowledgement rationales that turned out to be false were both written from a
  // glance instead of from the query. `order_id is null` is deliberately NOT accepted as a
  // binding — a reader hunting order-less shipments is the orphan sweep this all exists for.
  // The optional `}` matters: interpolated SQL writes `${shipments.orderId} = ${orders.id}`,
  // and without it store-order-import.ts read as unbound when it is order-joined.
  // The trailing alternative matters: a join writes `o.id = s.order_id`, with the binding on
  // the RIGHT of the operator, and ref-rates-fetch.ts read as unbound without it.
  const ORDER_OR_ID_BOUND =
    /order_?[Ii]d\}?\s*(?:=|,|\))(?![^;]{0,40}is\s+null)|(?:eq|inArray)\(\s*shipments\.(?:id|orderId)|shipments\.id\}?\s*=|\bs\.id\s*=|=\s*[\w.${}]*order_?[Ii]d/;

  // Acknowledged: these read shipments but cannot adopt a replacement vessel, or legitimately
  // see one. A replacement vessel has order_id IS NULL, so any reader bound to an order — or
  // to one shipment id — provably cannot reach it. Each entry states why, so a future reader
  // cannot be waved through by adding a bare path.
  const ACKNOWLEDGED_NO_EXCLUSION: Readonly<Record<string, { sites: number; why: string }>> = {
    // CORRECTED 2026-08-19. The previous reason — "manifest membership is order-bound" — was
    // simply false: loadManifest selects on voided/carrier/client/scope with no order join and
    // no order_id predicate, so a replacement vessel reaches it. It is listed because a
    // replacement parcel PHYSICALLY exists and plausibly belongs on a carrier manifest, not
    // because it is unreachable. ⚠ OPEN DECISION for DJ: confirm replacement parcels belong on
    // physical manifests, and whether a null order_id renders acceptably there.
    'src/routes/manifests.ts': {
      sites: 1,
      why: 'NOT order-bound — a replacement vessel is reachable; physical-manifest inclusion is an open decision',
    },
    // Order-bound by proof, but through a LOCAL predicate rather than a named helper, so the
    // derived rules cannot see it: every read is scoped by
    // liveOutbound = and(eq(shipments.orderId, orderId), ...), and the sibling count differs
    // from the self read only by ne(shipments.id, shipmentId) within that same order.
    'src/services/fulfillment/sole-outbound-shipment.ts': {
      sites: 1,
      why: 'every read is scoped by the local liveOutbound = and(eq(shipments.orderId, orderId), ...)',
    },
    // The replacement-aware sync owner. Its unbound reads were each READ before being listed:
    // a provider-identity collision check bound by label_shipment_id; a label-id lookup that
    // SELECTS source and branches on `existing.source === 'replacement'` further down than any
    // window reaches; and `select count(*) from shipments` for the sync-status readout.
    // ⚠ That last one genuinely counts replacement vessels. It is a diagnostic row count rather
    // than a business metric, so it is accepted instead of filtered — revisit the moment it is
    // surfaced to anyone as "shipments shipped".
    'src/services/shipment-sync.ts': {
      sites: 3,
      why: 'replacement-aware sync owner; identity/label-bound reads plus a diagnostic total row count',
    },
    // The one genuine judgement call: client-scoped, NOT order-bound, so it DOES see
    // replacement vessels. It gathers evidence of which package dimensions a client actually
    // used, and a replacement really did consume that package — so including it is correct
    // rather than a leak. Revisit if this ever feeds an order count or a per-order average.
    'src/services/billing-client-package-pricing.ts': {
      sites: 1,
      why: 'client-scoped package-dimension evidence; a replacement genuinely consumed that package',
    },
  };

  // A THIRD legitimate spelling exists and this sweep found it the hard way: some owners
  // exclude replacements in TypeScript rather than SQL — `row.source === 'replacement'` then
  // return null (customer-shipping-money), `vessel.source !== 'replacement'` (shipment-sync).
  // Those are real exclusions; a SQL-only classifier reported them as unreviewed readers.
  const EXCLUDES_ANY = new RegExp(
    `${NULL_SAFE.source}|source\\s*[!=]==\\s*'replacement'`,
    'i',
  );

  // Comments are stripped before ANY of this runs. orders-read-model.ts was reported as an
  // unexcluded reader on the strength of the prose "guessing from shipments[0]" inside a `//`
  // comment — a guard that fails on prose teaches people to reword comments, not to fix code.
  const stripComments = (source: string): string => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const readers = walk('src').flatMap((path) => {
    const source = stripComments(read(path));
    const sites = tableSymbols(source)
      .flatMap((symbol) => [...source.matchAll(occurrenceRegex(symbol))].map((m) => m.index ?? 0));
    return sites.length > 0 ? [{ path, source, sites }] : [];
  });

  // Exclusions are legitimately FACTORED in this codebase — analysis.ts carries one inside
  // analysisShipmentScopePredicate(), shared by every reader in the file. A site whose window
  // invokes such a helper is covered by it. Without this, the guard would demand an inlined
  // copy of the predicate beside every read, i.e. dictate worse production code to satisfy
  // itself. A helper counts only if its own body actually carries the exclusion.
  // ONLY exclusion-carrying helpers count, and only when their name says what they are.
  //
  // A "binding helper" rule was tried here and removed: treating any const whose body happened
  // to contain an order/id binding as a guard cleared manifests.ts through a local named `rows`
  // and shipment-sync.ts through one named `c`. Names that generic occur in nearly every
  // window, so the rule silently vouched for whole files — it made this guard GREENER while
  // defending strictly less, which is the failure it exists to prevent. A reader whose binding
  // lives in an unnamed local is acknowledged explicitly instead, where it can be read.
  const guardedHelpers = (source: string): string[] =>
    [...source.matchAll(/(?:function|const)\s+(\w+)/g)]
      .filter((match) => EXCLUDES_ANY.test(source.slice(match.index ?? 0, (match.index ?? 0) + 2000)))
      .map((match) => match[1]!)
      .filter((name) => /Predicate|Sql|Scope|Filter|Clause|Exclusion|Where/i.test(name));

  // Counted ONCE, so the pass/fail check, the count check and the rot check all read the same
  // measurement and cannot drift apart from each other.
  const bareByPath = new Map<string, number>();
  for (const { path, source, sites } of readers) {
    if (/replacement/.test(path)) continue;                        // replacement-owned
    const helpers = guardedHelpers(source);
    bareByPath.set(path, sites.filter((index) => {
      const window = source.slice(index, index + PREDICATE_WINDOW);
      return !EXCLUDES_ANY.test(window)
        && !helpers.some((name) => window.includes(name))
        && !ORDER_OR_ID_BOUND.test(window);
    }).length);
  }

  // An acknowledgement excuses a STATED NUMBER of unexcluded sites, never a whole file.
  // Blanket file-level permission is what let the provider_account_names subquery leak beside
  // an exclusion, and it would have waved the next unexcluded read into shipment-sync.ts or
  // manifests.ts through just as quietly. Adding one now moves the count and fails here.
  const unexcluded: string[] = [];
  for (const [path, bare] of bareByPath) {
    if (bare === 0) continue;
    const acknowledged = ACKNOWLEDGED_NO_EXCLUSION[path];
    if (acknowledged === undefined) {
      unexcluded.push(`${path} (${bare} unexcluded, unacknowledged)`);
    } else if (acknowledged.sites !== bare) {
      unexcluded.push(`${path} acknowledges ${acknowledged.sites} but has ${bare}`);
    }
  }

  const siteCount = readers.reduce((total, reader) => total + reader.sites.length, 0);

  check('every shipments READ SITE is excluded, replacement-owned, or acknowledged',
    readers.length > 0 && unexcluded.length === 0,
    `${readers.length} files / ${siteCount} read sites; ${unexcluded.join(' | ')}`);

  // An acknowledgement with nothing left to excuse is permission that outlived its reason —
  // and two of these turned out to be factually wrong. Once the derived rules cover a file,
  // the entry must go, so the proof stands on its own rather than behind stale prose.
  const unnecessary = Object.keys(ACKNOWLEDGED_NO_EXCLUSION)
    .filter((path) => bareByPath.get(path) === 0);
  check('no acknowledgement excuses a file that no longer needs one',
    unnecessary.length === 0,
    `now covered by exclusion/helper/binding — delete: ${unnecessary.join(', ')}`);

  // An acknowledgement that outlives its reader is permission nobody re-derived — and two of
  // these were found to be factually wrong on 2026-08-19 (manifests.ts was not order-bound at
  // all; ref-rates-fetch.ts described an inert limit(0) query). Stale entries rot the same way.
  const staleAcknowledgements = Object.keys(ACKNOWLEDGED_NO_EXCLUSION)
    .filter((path) => !readers.some((reader) => reader.path === path));
  check('no acknowledgement outlives the reader it excuses',
    staleAcknowledgements.length === 0,
    `stale: ${staleAcknowledgements.join(', ')}`);

  // ⚠ HEURISTIC, deliberately named as one. This is textual discovery, not AST analysis, and
  // it is stated here rather than implied so no future reader mistakes it for exhaustive:
  // a read hidden behind a helper that takes the table as a parameter, or assembled from
  // dynamically concatenated SQL, is still invisible to it. It resolves direct references,
  // aliased imports and interpolated table references, in any case, at every read site.

  const unsafe: string[] = [];
  for (const path of GENERIC_FALLBACK_READERS) {
    const source = read(path);
    // read() returns '' for a path that no longer exists, which would make the absence
    // check below pass vacuously on a renamed file. Prove the file was actually read.
    check(`${path} is readable`, source.length > 0,
      'a renamed or deleted reader must fail loudly, not silently stop being checked');
    check(`${path} excludes replacement-owned shipments`,
      NULL_SAFE.test(source),
      'this reader treats an order-less shipment as repairable, and a replacement shipment is exactly that');

    for (const line of source.split('\n')) {
      if (/(<>|!=)\s*'replacement'/.test(line) && !/coalesce/i.test(line)) {
        unsafe.push(`${path}: ${line.trim().slice(0, 90)}`);
      }
    }
  }

  // `source <> 'replacement'` evaluates to UNKNOWN when source IS NULL, so it silently drops
  // every legacy NULL-source shipment from the very sweep written to find it. That failure is
  // invisible: the query still runs, still returns rows, and just quietly misses a class.
  check('no ordinary reader uses a NULL-UNSAFE replacement exclusion',
    unsafe.length === 0,
    `use \`is distinct from\` or \`coalesce(...)\`: ${unsafe.join(' | ')}`);
}

console.log(`\n${failures === 0 ? 'PS-502 replacement contract guard passed.' : `PS-502 replacement contract guard FAILED with ${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
