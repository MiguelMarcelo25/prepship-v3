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

console.log(`\n${failures === 0 ? 'PS-502 replacement contract guard passed.' : `PS-502 replacement contract guard FAILED with ${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
