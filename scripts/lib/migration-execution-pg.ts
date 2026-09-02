/**
 * PS-510 — real-PostgreSQL execution adapter for the canonical migration plan.
 *
 * Executes what `migration-execution-plan.ts` planned, honouring the three frozen phases,
 * and fails on any error not covered by an explicit filename + SQLSTATE + reason rule.
 *
 * The behaviour this replaces swallowed every error from every file silently. The rule here
 * is the inverse: an unregistered error is fatal and names itself.
 */
import postgres from 'postgres';
import {
  assertTolerancePolicy,
  emptyReport,
  formatReport,
  planExecutionRuns,
  planMigrations,
  splitTopLevelCommands,
  type ExecutionReport,
  type PlanOptions,
  type PlannedStatement,
  type ToleranceRule,
} from './migration-execution-plan.js';

export interface ApplyOptions extends PlanOptions {
  sql: postgres.Sql;
  /** Explicit, narrow tolerance. Empty by default — nothing is tolerated unless named. */
  tolerate?: ToleranceRule[];
  /** Print the execution report on success. Default true. */
  report?: boolean;
}

function sqlstateOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (/^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return 'UNKNOWN';
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n', 1)[0] ?? '').slice(0, 200);
}

function untolerated(statement: PlannedStatement, sqlstate: string, error: unknown): Error {
  return new Error(
    `migration failed and no tolerance rule covers it\n`
    + `  file     : ${statement.file}\n`
    + `  statement: #${statement.index}\n`
    + `  phase    : ${statement.phase} (${statement.reason})\n`
    + `  sqlstate : ${sqlstate}\n`
    + `  error    : ${firstLine(error)}\n`
    + `  sql      : ${statement.sql.slice(0, 300)}`,
    { cause: error },
  );
}

/**
 * Run one statement OUTSIDE any transaction. Tolerating a failure here is simple: nothing
 * else is in flight to be poisoned.
 */
async function runAutocommit(
  sql: postgres.Sql,
  statement: PlannedStatement,
  tolerate: ToleranceRule[],
  report: ExecutionReport,
): Promise<void> {
  try {
    await sql.unsafe(statement.sql);
    report.applied.push(statement);
    report.phaseCounts[statement.phase] += 1;
  } catch (error) {
    const sqlstate = sqlstateOf(error);
    const rule = tolerate.find((r) => r.file === statement.file && r.sqlstate === sqlstate);
    if (!rule) throw untolerated(statement, sqlstate, error);
    report.tolerated.push({ statement, sqlstate, rule });
  }
}

/**
 * Run one statement INSIDE the batch transaction, wrapped in a SAVEPOINT.
 *
 * This is load-bearing, not defensive coding. PostgreSQL aborts the entire transaction on any
 * error: every subsequent statement then fails with 25P02 `current transaction is aborted`.
 * Catching the original error does NOT undo that. Without a savepoint, "tolerate this one
 * statement" is impossible inside a batch — the first tolerated failure kills every migration
 * after it, and the run dies on a cascade of 25P02s that name the wrong file.
 *
 * Measured: hosted run 33133840353 failed on 0038 with 25P02 because 0037 had been tolerated
 * moments earlier. The reported file was innocent; the real cause was three statements back.
 */
async function runInBatch(
  tx: postgres.TransactionSql,
  statement: PlannedStatement,
  tolerate: ToleranceRule[],
  report: ExecutionReport,
): Promise<void> {
  try {
    await tx.savepoint(async (sp) => { await sp.unsafe(statement.sql); });
    report.applied.push(statement);
    report.phaseCounts[statement.phase] += 1;
  } catch (error) {
    const sqlstate = sqlstateOf(error);
    const rule = tolerate.find((r) => r.file === statement.file && r.sqlstate === sqlstate);
    // The savepoint has already rolled back, so the transaction is usable again either way.
    if (!rule) throw untolerated(statement, sqlstate, error);
    report.tolerated.push({ statement, sqlstate, rule });
  }
}

/**
 * Apply the migration chain. Transactional-batch statements share one transaction;
 * autocommit-required statements (CONCURRENTLY, VALIDATE CONSTRAINT) run outside it, which
 * is the correction — they are executed as written, never rewritten.
 */
export async function applyMigrations(options: ApplyOptions): Promise<ExecutionReport> {
  const tolerate = options.tolerate ?? [];
  assertTolerancePolicy(tolerate);

  const planned = planMigrations({ dir: options.dir, only: options.only });
  const report = emptyReport();

  // ORDER IS PRESERVED. Statements execute in plan order; the transaction context opens and
  // closes around them as their phase requires.
  //
  // An earlier version grouped by phase and ran every batch statement, then every standalone,
  // then every autocommit. That silently reordered the chain across files and broke
  // dependencies: 0097 adds billing_line_items.replacement_id in one autocommit statement and
  // 0098 adds the foreign key referencing it in one batch statement, so 0098 ran FIRST and
  // failed with 42703 'column "replacement_id" referenced in foreign key constraint does not
  // exist' (hosted runs 33134034592 / 33134036509). Migrations are ordered by construction;
  // an executor that reorders them is not applying the chain.
  // The grouping is done by planExecutionRuns, which is pure and directly under contract test
  // (ps-510-migration-plan-contract.ts checks it preserves order and that 0097 precedes 0098).
  // The executor must not re-derive it — a tested function the executor ignores proves nothing.
  for (const run of planExecutionRuns(planned)) {
    if (run.kind === 'autocommit') {
      // Outside any transaction. This is why CONCURRENTLY is never rewritten.
      for (const statement of run.statements) {
        // A multi-command simple query is wrapped in an IMPLICIT transaction by PostgreSQL,
        // so CONCURRENTLY still fails 25001 even out here. Files with no Drizzle breakpoint
        // (0018e) arrive as one statement holding several commands; each must be sent alone.
        const commands = splitTopLevelCommands(statement.sql);
        if (commands.length <= 1) {
          await runAutocommit(options.sql, statement, tolerate, report);
          continue;
        }
        for (const [offset, sql] of commands.entries()) {
          await runAutocommit(
            options.sql,
            { ...statement, sql, index: statement.index + offset / 1000 },
            tolerate,
            report,
          );
        }
      }
      continue;
    }
    await options.sql.begin(async (tx) => {
      for (const statement of run.statements) await runInBatch(tx, statement, tolerate, report);
    });
  }

  if (options.report !== false) console.log(formatReport(report));
  return report;
}

// ---------------------------------------------------------------------------
// Catalog gate
// ---------------------------------------------------------------------------

export interface ExpectedIndex {
  name: string;
  /** Require indisvalid. A CONCURRENTLY index can exist but be invalid. */
  mustBeValid?: boolean;
  /** Substring that must appear in the normalized index definition, e.g. the predicate. */
  definitionContains?: string;
}

export interface ExpectedCheck {
  name: string;
  /** Require convalidated. A NOT VALID constraint exists but proves nothing yet. */
  mustBeValidated?: boolean;
  definitionContains?: string;
}

export interface CatalogExpectation {
  label: string;
  indexes?: ExpectedIndex[];
  checks?: ExpectedCheck[];
}

export interface CatalogFinding {
  kind: 'index' | 'check';
  name: string;
  problem: string;
}

/**
 * Post-apply catalog assertion for governed migrations. Reads pg_catalog and reports what is
 * missing, invalid, unvalidated, or wrong. Business tests run only after this passes — a
 * behaviour suite on a compromised schema is what PS-510 exists to prevent.
 */
export async function assertCatalog(
  sql: postgres.Sql,
  expectation: CatalogExpectation,
): Promise<CatalogFinding[]> {
  const findings: CatalogFinding[] = [];

  for (const expected of expectation.indexes ?? []) {
    const rows = await sql<{ indisvalid: boolean; indexdef: string }[]>`
      select i.indisvalid, pg_get_indexdef(i.indexrelid) as indexdef
      from pg_class c join pg_index i on i.indexrelid = c.oid
      where c.relname = ${expected.name}`;
    const row = rows[0];
    if (!row) {
      findings.push({ kind: 'index', name: expected.name, problem: 'missing entirely' });
      continue;
    }
    if (expected.mustBeValid !== false && !row.indisvalid) {
      findings.push({ kind: 'index', name: expected.name, problem: 'exists but indisvalid = false' });
    }
    if (expected.definitionContains
      && !row.indexdef.toLowerCase().includes(expected.definitionContains.toLowerCase())) {
      findings.push({
        kind: 'index',
        name: expected.name,
        problem: `definition does not contain ${JSON.stringify(expected.definitionContains)}: ${row.indexdef}`,
      });
    }
  }

  for (const expected of expectation.checks ?? []) {
    const rows = await sql<{ convalidated: boolean; def: string }[]>`
      select con.convalidated, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      where con.conname = ${expected.name} and con.contype = 'c'`;
    const row = rows[0];
    if (!row) {
      findings.push({ kind: 'check', name: expected.name, problem: 'missing entirely' });
      continue;
    }
    if (expected.mustBeValidated !== false && !row.convalidated) {
      findings.push({ kind: 'check', name: expected.name, problem: 'exists but convalidated = false' });
    }
    if (expected.definitionContains
      && !row.def.toLowerCase().includes(expected.definitionContains.toLowerCase())) {
      findings.push({
        kind: 'check',
        name: expected.name,
        problem: `definition does not contain ${JSON.stringify(expected.definitionContains)}: ${row.def}`,
      });
    }
  }

  return findings;
}

/** Throw with a readable report if the catalog gate finds anything. */
export async function requireCatalog(
  sql: postgres.Sql,
  expectation: CatalogExpectation,
): Promise<void> {
  const findings = await assertCatalog(sql, expectation);
  if (findings.length === 0) {
    console.log(`ok   catalog gate: ${expectation.label} — all expected objects present and valid`);
    return;
  }
  const detail = findings.map((f) => `  ${f.kind} ${f.name}: ${f.problem}`).join('\n');
  throw new Error(
    `CATALOG GATE FAILED (${expectation.label}) — the schema is not in its intended state, so any\n`
    + `behaviour assertion below this point would be evidence about a compromised database.\n${detail}`,
  );
}

/**
 * The governed expectation for migration 0104. This is the object set the pre-fix
 * reproduction found ABSENT/COMPROMISED.
 */
export const PS497_0104_CATALOG: CatalogExpectation = {
  label: '0104 occurrence identity',
  indexes: [
    { name: 'fulfillment_line_claims_occ_line_dir_unq', mustBeValid: true },
    { name: 'fulfillment_line_claims_reverse_original_unq', mustBeValid: true },
    { name: 'fulfillment_occurrences_key_unq', mustBeValid: true },
    { name: 'fulfillment_occurrences_shipment_unq', mustBeValid: true },
  ],
  checks: [
    { name: 'fulfillment_line_claims_occ_identity_present_chk', mustBeValidated: true },
    { name: 'fulfillment_line_claims_supply_chk', mustBeValidated: true },
  ],
};

// Re-exported for the scripts that call applyMigrations and type their own tolerance list.
export type { ToleranceRule };
