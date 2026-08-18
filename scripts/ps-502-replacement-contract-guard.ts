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

const read = (path: string) => {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
};

const replacementsSql = read('drizzle/0096_ps502_replacements.sql');
const billingSql = read('drizzle/0097_ps502_replacement_billing.sql');
// Hermes ruling C: replacement financial attribution became RESTRICT in a forward migration.
const restrictSql = read('drizzle/0098_ps502_replacement_financial_restrict.sql');
// Hermes re-audit correction 1: idempotency binds to the whole request, stored by 0099.
const signatureSql = read('drizzle/0099_ps502_replacement_request_signature.sql');

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
    for (const m of body.matchAll(/^\s{4}(\w+):\s*(?:serial|integer|text|boolean|timestamp)\(\s*(?:'([^']+)')?/gm)) {
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
    const start = replacementsSql.indexOf(`create table if not exists ${table} (`);
    if (start !== -1) {
      const body = replacementsSql.slice(start, replacementsSql.indexOf('\n);', start));
      for (const m of body.matchAll(/^\s{2}(\w+)\s+(serial|integer|text|boolean|timestamptz)\b/gm)) {
        if (m[1] !== 'constraint') found.add(m[1]!);
      }
    }
    for (const sql of [replacementsSql, billingSql, restrictSql, signatureSql]) {
      const pattern = new RegExp(
        `alter table ${table}\\s+add column(?: if not exists)? (\\w+)`,
        'gi',
      );
      for (const m of sql.matchAll(pattern)) found.add(m[1]!);
    }
    return found;
  };

  for (const table of ['replacements', 'replacement_items', 'replacement_activity_events']) {
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
}

// ── Void is DESTRUCTIVE, so nothing is inferred ──────────────────────────────
console.log('\nlabel void and reconciliation (locked path)');

{
  const v = read('src/services/replacement-label-void-command.ts');
  const code = v.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const at = (needle: string) => code.indexOf(needle);

  check('the void command exists and is gated by the feature flag',
    v.length > 0 && /assertReplacementLabelEnabled\(\)/.test(code)
    && at('assertReplacementLabelEnabled()') < at('conn.transaction'));

  check('BOTH provider-reaching commands require the label capability and a reason',
    // Counted, not merely present: void and reconcile each reach a provider, and replacing
    // one check left the other while a `.test()` stayed green — the same multi-occurrence
    // weakness M47 exposed on the lifecycle command.
    (code.match(/includes\(REPLACEMENT_LABEL_PERMISSION\)/g) || []).length === 2
    && (code.match(/requireReason\(input\.reason\)/g) || []).length === 2,
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
    && at('if (!result.voided) {') < at("voidState: 'voided'"),
    'a local voided row with a live label is worse than no row at all');

  check('an already-voided label sends no second destructive call',
    code.includes("intent.voidState === 'voided'")
    && at("intent.voidState === 'voided'") < at('await provider.voidLabel({'),
    'a repeated destructive call can cancel a label a later attempt bought');

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

  check('the feature flag is server-authoritative and DEFAULT OFF',
    /REPLACEMENTS_LABEL_ENABLED: booleanFlag\(false\)/.test(envSource),
    'dark deployment means the code ships and does nothing');

  check('the gate runs BEFORE any transaction or provider access',
    at('assertReplacementLabelEnabled();') !== -1
    && at('assertReplacementLabelEnabled();') < at('claimPurchase(input, conn)')
    && at('assertReplacementLabelEnabled();') < at('provider.purchase('),
    'a disabled feature must not write a durable intent or contact a provider');

  check('the durable intent is committed BEFORE dispatch',
    // Presence FIRST: indexOf returns -1 when the text is gone, and -1 < anything is true, so
    // deleting the very thing under test made the bare position check pass.
    at('.insert(replacementLabelPurchaseIntents)') !== -1
    && at('.insert(replacementLabelPurchaseIntents)') < at('provider.purchase('),
    'a crash between dispatch and persistence must leave proof a purchase may exist');

  check('the provider call is OUTSIDE every transaction',
    (() => {
      // The dispatch must not sit inside a conn.transaction callback. Checked by position:
      // the claim transaction closes before it and the persist transaction opens after.
      const dispatch = at('await provider.purchase({');
      const claimEnds = at('const claim = await claimPurchase(input, conn);');
      const persistBegins = code.lastIndexOf('return conn.transaction(async (tx) => {');
      return dispatch > claimEnds && dispatch < persistBegins;
    })(),
    'holding a transaction or lock across the network pins a connection and rolls back the intent');

  check('drift is re-resolved before the claim AND after dispatch',
    (code.match(/findFrozenLineDrift\(/g) || []).length >= 2,
    'a line can move while the network call is in flight');

  check('post-dispatch drift PRESERVES the label and reviews',
    /replacement_label_purchased_into_review/.test(code)
    && at('replacement_label_purchased_into_review') > at('provider.purchase('),
    'the label is real and paid for; never discard it and never repurchase');

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
// Discovered from the directory rather than from a list, so the NEXT PS-502 migration
// fails this check on the day it is added instead of the day it is deployed.
console.log('\nproduction migration lane');

{
  const applier = read('scripts/apply-ps-502-replacement-schema.ts');
  const workflow = read('.github/workflows/render-one-off-migration-ps502.yml');
  const ps502Migrations = readdirSync('drizzle')
    .filter((name) => /ps502.*\.sql$/.test(name))
    .sort();

  check('there are PS-502 migrations to deploy', ps502Migrations.length >= 4,
    `found: ${ps502Migrations.join(", ")}`);

  for (const migration of ps502Migrations) {
    check(`the runner applies ${migration}`, applier.includes(migration),
      'the official deploy path must apply every migration the code depends on');
    check(`the workflow pins a digest for ${migration}`, workflow.includes(migration),
      'an unpinned migration can be swapped between review and deploy');
  }

  check('every pinned digest is LF-normalised',
    /replace\(\/\\r\\n\/g, '\\n'\)/.test(applier),
    'core.autocrlf=true, so raw bytes vary by checkout and a digest over them is not reproducible');

  check('the migrations apply in ONE transaction',
    /await conn\.begin|sql\.begin|tx\.unsafe/.test(applier)
    && (applier.match(/tx\.unsafe\(readFileSync\(SQL_/g) || []).length === ps502Migrations.length,
    'a partial apply leaves a schema the code cannot run against');
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

  check('it inserts a shipment and links it to the replacement',
    /\.insert\(shipments\)/.test(code) && /replacementShipmentId: shipment\.id/.test(code));

  check('drift is re-resolved BEFORE the shipment is inserted',
    at('findFrozenLineDrift(') !== -1
    && at('findFrozenLineDrift(') < at('.insert(shipments)'),
    'the card requires re-resolution before label purchase, and this is the last cheap place');

  check('a drift review is COMMITTED, then reported',
    // The update to review must not sit in the transaction that the throw aborts, or the
    // operator gets a 409 while the replacement stays approved and drifts again forever.
    /status: 'review'/.test(code)
    && /return \{ drifted: true/.test(code)
    && at("return { drifted: true") < at('throw new ReplacementShipmentError(\n      REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED'),
    'the review has to commit while the operation fails');

  check('no shipment is inserted on the drift path',
    at('.insert(shipments)') > at('if (outcome.drifted)'),
    'the card requires no label/inventory/package/billing effect on a mismatch');

  // Hermes ruling A, the two details required before label purchase stacks on this.
  check('the drift review is guarded by expected STATUS as well as version',
    /eq\(replacements\.status, replacement\.status\),\s*\n\s*eq\(replacements\.stateVersion, replacement\.stateVersion\),/.test(code),
    'version alone lets a concurrent transition slip past the predicate');

  check('a lost drift race appends NO event',
    /if \(reviewed\.length === 0\)/.test(code)
    && at('if (reviewed.length === 0)') < at("eventType: 'replacement_source_line_drift'"),
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

console.log(`\n${failures === 0 ? 'PS-502 replacement contract guard passed.' : `PS-502 replacement contract guard FAILED with ${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
