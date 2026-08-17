/**
 * PS-502 — the unlocked slice: replacement schema + lifecycle contract.
 *
 * SCOPE. This guard covers ONLY what the card places outside `unlock shipped data`: the
 * additive tables, the additive billing/credit-note columns, and the pure state machine.
 * It inserts NO shipment fixtures and touches no shipped data — the card's read-only
 * exemption is for analytics and schema, and this stays inside it.
 *
 * BEHAVIOURAL where it can be. The lifecycle is executed, not grepped: a guard that only
 * matched source text would pass against a state machine that allowed
 * `label_failed -> shipped`, which is the transition that would ship without a label.
 *
 * Offline and pure — no database, no network, no mutation.
 */
import { readFileSync } from 'node:fs';
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

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const read = (path: string) => {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
};

const replacementsSql = read('drizzle/0096_ps502_replacements.sql');
const billingSql = read('drizzle/0097_ps502_replacement_billing.sql');

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

console.log(`\n${failures === 0 ? 'PS-502 replacement contract guard passed.' : `PS-502 replacement contract guard FAILED with ${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
