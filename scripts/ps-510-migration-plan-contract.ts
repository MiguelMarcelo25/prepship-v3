/**
 * PS-510 — behavioural contract for the canonical migration execution plan.
 *
 * Pure. No database. Runs anywhere, including plain CI.
 *
 * The load-bearing test is MUTATION 1: restoring the historical UNIQUE-blind regex must turn
 * this suite RED. If a future change narrows concurrency detection back to
 * `/CREATE\s+INDEX\s+CONCURRENTLY/`, 0104's two UNIQUE indexes silently return to the
 * transactional batch, fail, and — with a bare catch anywhere downstream — vanish again.
 * That is the exact defect the hosted pre-fix reproduction observed as ABSENT/COMPROMISED.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTolerancePolicy,
  classifyStatement,
  planExecutionRuns,
  planMigrations,
  splitStatements,
  splitTopLevelCommands,
} from './lib/migration-execution-plan.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIZZLE = path.join(REPO_ROOT, 'drizzle');

let checks = 0;
const ok = (label: string) => { checks += 1; console.log(`ok   ${label}`); };

// The historical applier, reproduced verbatim so the mutation is a real comparison and not a
// paraphrase of one. Every one of the eleven callers carried this.
const HISTORICAL_UNIQUE_BLIND = (stmt: string): string =>
  stmt
    .replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX')
    .replace(/DROP\s+INDEX\s+CONCURRENTLY/gi, 'DROP INDEX');

// --- 1. concurrency is detected regardless of modifiers -----------------------------------

for (const [sql, label] of [
  ['CREATE INDEX CONCURRENTLY IF NOT EXISTS x ON t (a)', 'CREATE INDEX CONCURRENTLY'],
  ['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS x ON t (a)', 'CREATE UNIQUE INDEX CONCURRENTLY'],
  ['DROP INDEX CONCURRENTLY IF EXISTS x', 'DROP INDEX CONCURRENTLY'],
  ['REINDEX INDEX CONCURRENTLY x', 'REINDEX CONCURRENTLY'],
] as const) {
  assert.equal(
    classifyStatement(sql).phase,
    'autocommit-required',
    `${label} must be planned into the autocommit phase`,
  );
}
ok('concurrency is detected regardless of what sits between the verb and the keyword');

// --- 2. THE MUTATION. The historical regex must be provably blind. ------------------------

const UNIQUE_CONCURRENT = 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS u ON t (a)';
assert.equal(
  HISTORICAL_UNIQUE_BLIND(UNIQUE_CONCURRENT),
  UNIQUE_CONCURRENT,
  'the historical regex must leave CREATE UNIQUE INDEX CONCURRENTLY untouched — if this ever '
  + 'changes, the premise of PS-510 has changed and the whole contract needs re-deriving',
);
assert.notEqual(
  HISTORICAL_UNIQUE_BLIND('CREATE INDEX CONCURRENTLY IF NOT EXISTS n ON t (a)'),
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS n ON t (a)',
  'the historical regex did rewrite the non-UNIQUE form, which is why the defect was invisible',
);
ok('MUTATION: the historical regex rewrites the plain form but is blind to the UNIQUE form');

// --- 3. the real 0104 statements land in the autocommit phase ------------------------------

const planned = planMigrations({ dir: DRIZZLE });
const zero104 = planned.filter((s) => s.file.startsWith('0104'));
assert.ok(zero104.length > 0, '0104 must be present in the chain');

for (const name of [
  'fulfillment_line_claims_occ_line_dir_unq',
  'fulfillment_line_claims_reverse_original_unq',
]) {
  const statement = zero104.find((s) => s.sql.includes(name) && /\bCONCURRENTLY\b/i.test(s.sql));
  assert.ok(statement, `0104 must contain a CONCURRENTLY statement creating ${name}`);
  assert.equal(
    statement.phase,
    'autocommit-required',
    `${name} must be planned outside a transaction, not rewritten into the batch`,
  );
  // The correction is phase routing, NOT rewriting. The SQL must survive verbatim.
  assert.match(statement.sql, /\bCONCURRENTLY\b/i, `${name} statement must not have CONCURRENTLY stripped`);
}
ok("0104's UNIQUE CONCURRENTLY indexes are planned into autocommit, and kept verbatim");

// --- 4. no statement is ever rewritten -----------------------------------------------------

// Compared against the statements re-read from disk — NOT against the planner's own output,
// which would be a tautology that can never fail.
let compared = 0;
for (const file of [...new Set(planned.map((s) => s.file))]) {
  const fromDisk = splitStatements(fs.readFileSync(path.join(DRIZZLE, file), 'utf8'));
  const fromPlan = planned.filter((s) => s.file === file).map((s) => s.sql);
  assert.deepEqual(fromPlan, fromDisk, `planner mutated statement text in ${file}`);
  compared += fromDisk.length;
}
assert.ok(compared > 0, 'the comparison must actually have examined statements');
ok(`the planner rewrites nothing — ${compared} statements byte-identical to disk`);

// --- 5. exactly three phases, none invented ------------------------------------------------

const phases = new Set(planned.map((s) => s.phase));
for (const phase of phases) {
  assert.ok(
    ['transactional-batch', 'standalone-transactional', 'autocommit-required'].includes(phase),
    `unexpected execution phase ${phase} — the three phases are frozen`,
  );
}
ok(`only frozen phases are produced (${[...phases].sort().join(', ')})`);

// --- 6. tolerance policy cannot become a bare catch ----------------------------------------

for (const [rule, why] of [
  [{ file: '*', sqlstate: '42P07', reason: 'anything at all' }, 'wildcard file'],
  [{ file: '', sqlstate: '42P07', reason: 'anything at all' }, 'empty file'],
  [{ file: '0104.sql', sqlstate: '', reason: 'anything at all' }, 'empty sqlstate'],
  [{ file: '0104.sql', sqlstate: 'nope', reason: 'anything at all' }, 'malformed sqlstate'],
  [{ file: '0104.sql', sqlstate: '42P07', reason: 'x' }, 'reason too short to be a reason'],
] as const) {
  assert.throws(
    () => assertTolerancePolicy([rule]),
    `tolerance policy must reject ${why} — that is how a bare catch grows back`,
  );
}
assertTolerancePolicy([
  { file: '0090_x.sql', sqlstate: '42710', reason: 'supabase-owned role already exists in hosted CI' },
]);
ok('tolerance requires exact file + SQLSTATE + human reason; wildcards are rejected');

// --- 7. statement splitting is on the breakpoint marker only -------------------------------

assert.deepEqual(
  splitStatements('SELECT 1;\n--> statement-breakpoint\n  \n--> statement-breakpoint\nSELECT 2;'),
  ['SELECT 1;', 'SELECT 2;'],
  'blank segments are dropped and no generic splitting on semicolons occurs',
);
assert.deepEqual(
  splitStatements("SELECT 'a; b';"),
  ["SELECT 'a; b';"],
  'a semicolon inside a literal must not split the statement',
);
ok('splitting uses the breakpoint marker only — no generic regex splitting');

// --- 8. comments cannot drive phase selection ----------------------------------------------

assert.equal(
  classifyStatement('-- this mentions CONCURRENTLY\nCREATE INDEX x ON t (a)').phase,
  'transactional-batch',
  'a keyword inside a comment must not route the statement',
);
assert.equal(
  classifyStatement('/* CONCURRENTLY */ CREATE INDEX x ON t (a)').phase,
  'transactional-batch',
  'a keyword inside a block comment must not route the statement',
);
ok('comments are stripped before phase selection');

// --- 9. poisoned-transaction and misrouted-concurrency SQLSTATEs are never tolerable --------

for (const [state, why] of [['25001', 'CONCURRENTLY misrouted'], ['25P02', 'poisoned transaction']] as const) {
  assert.throws(
    () => assertTolerancePolicy([{ file: '0037_x.sql', sqlstate: state, reason: 'a plausible sounding reason' }]),
    `SQLSTATE ${state} (${why}) must be rejected — tolerating it hides a plan defect, not an environment difference`,
  );
}
ok('25001 and 25P02 can never be added to a tolerance policy');

console.log(`\nPASS PS-510 migration plan contract — ${checks}/${checks} checks`);

// --- 10. execution runs must NOT reorder the chain ------------------------------------------

const runs = planExecutionRuns(planned);
const flat = runs.flatMap((r) => r.statements);
assert.equal(flat.length, planned.length, 'grouping into runs must not drop or duplicate statements');
for (let i = 0; i < flat.length; i += 1) {
  assert.equal(flat[i], planned[i], `run grouping reordered statement #${i} (${flat[i]?.file})`);
}
ok(`execution runs preserve plan order exactly (${runs.length} runs over ${flat.length} statements)`);

// The concrete regression: 0097 adds billing_line_items.replacement_id, 0098 adds the FK that
// references it. Phase-grouped execution ran 0098 first and failed 42703 in hosted CI.
const i97 = flat.findIndex((s) => s.file.startsWith('0097'));
const i98 = flat.findIndex((s) => s.file.startsWith('0098'));
assert.ok(i97 >= 0 && i98 >= 0, '0097 and 0098 must both be present in the chain');
assert.ok(
  i97 < i98,
  'REGRESSION: 0097 (adds replacement_id) must execute before 0098 (adds the FK referencing it). '
  + 'Phase-grouped execution put 0098 first and failed 42703 in hosted runs 33134034592/33134036509.',
);
ok('0097 executes before 0098 — the FK dependency that phase grouping broke');

// A batch run must never contain a statement that cannot share a transaction.
for (const run of runs) {
  if (run.kind !== 'batch') continue;
  for (const s of run.statements) {
    assert.equal(s.phase, 'transactional-batch', `batch run contains a ${s.phase} statement from ${s.file}`);
  }
}
ok('no batch run contains a statement that cannot share its transaction');

console.log(`\nPASS PS-510 migration plan contract — ${checks}/${checks} checks`);

// --- 11. top-level command splitting for breakpoint-less files ------------------------------

assert.deepEqual(
  splitTopLevelCommands("select 'a; b'; select 2;"),
  ["select 'a; b';", 'select 2;'],
  'a semicolon inside a single-quoted literal must not split',
);
assert.deepEqual(
  splitTopLevelCommands('select $$a; b$$; select 2;'),
  ['select $$a; b$$;', 'select 2;'],
  'a semicolon inside a dollar-quoted body must not split',
);
assert.deepEqual(
  splitTopLevelCommands('select $tag$a; b$tag$; select 2;'),
  ['select $tag$a; b$tag$;', 'select 2;'],
  'a semicolon inside a tagged dollar-quoted body must not split',
);
assert.deepEqual(
  splitTopLevelCommands('-- a; comment\nselect 1;'),
  ['-- a; comment\nselect 1;'],
  'a semicolon inside a line comment must not split',
);
assert.deepEqual(
  splitTopLevelCommands('select 1;\n\n;\n'),
  ['select 1;'],
  'empty trailing commands are dropped',
);
assert.deepEqual(splitTopLevelCommands('select 1'), ['select 1'], 'a single unterminated command survives');
ok('top-level splitter respects literals, dollar-quotes and comments');

// The concrete regression: 0018e has NO Drizzle breakpoints and three CONCURRENTLY commands.
// Sent as one multi-command string it is an implicit transaction and fails 25001.
const e018 = planned.filter((s) => s.file.startsWith('0018e'));
assert.equal(e018.length, 1, '0018e has no breakpoints, so it plans as a single statement');
assert.equal(e018[0]!.phase, 'autocommit-required', '0018e must be planned into autocommit');
const cmds018 = splitTopLevelCommands(e018[0]!.sql);
assert.ok(
  cmds018.length > 1,
  'REGRESSION: 0018e must split into individual commands. Sent as one string PostgreSQL wraps '
  + 'it in an implicit transaction and CONCURRENTLY fails 25001 — hosted runs 33134320092, '
  + '33134321684, 33134323939.',
);
for (const c of cmds018.filter((x) => /\bCONCURRENTLY\b/i.test(x))) {
  assert.equal(
    splitTopLevelCommands(c).length, 1,
    'each CONCURRENTLY command must end up alone in its own simple query',
  );
}
ok(`0018e splits into ${cmds018.length} commands, each CONCURRENTLY one sent alone`);

console.log(`\nPASS PS-510 migration plan contract — ${checks}/${checks} checks`);
