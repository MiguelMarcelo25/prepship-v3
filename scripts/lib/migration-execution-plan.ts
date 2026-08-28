/**
 * PS-510 — canonical migration execution plan. THE source of truth for how a migration
 * chain is turned into ordered, phase-correct statements.
 *
 * WHY THIS EXISTS
 *
 * Eleven real-PostgreSQL callers each carried their own copy of a migration applier. Every
 * copy rewrote concurrency with the same regex:
 *
 *     .replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX')
 *
 * That pattern is UNIQUE-blind. `CREATE UNIQUE INDEX CONCURRENTLY` does not match it, because
 * `UNIQUE` sits between `CREATE` and `INDEX`. Migration 0104 creates two such indexes
 * (`fulfillment_line_claims_occ_line_dir_unq`, `fulfillment_line_claims_reverse_original_unq`).
 * They therefore stayed CONCURRENTLY, failed, and were swallowed by:
 *
 *     try { await sql.unsafe(stmt); } catch { /* supabase artefacts non-fatal *\/ }
 *
 * Hosted reproduction on disposable PG17 (run 33121719782) read the catalog back and returned
 * ABSENT/COMPROMISED. The lanes asserted real behaviour against a schema-fidelity-compromised
 * database.
 *
 * THE CORRECTION IS NOT A BETTER REGEX.
 *
 * Concurrency is not rewritten away at all. A CONCURRENTLY statement is *planned into the
 * autocommit phase* and executed outside any transaction, which is what Postgres actually
 * requires. The three execution phases are frozen and this module does not invent a fourth:
 *
 *   transactional-batch      ordinary DDL/DML, applied together in one transaction
 *   standalone-transactional statements needing their own transaction boundary
 *   autocommit-required      CONCURRENTLY / VALIDATE CONSTRAINT — no enclosing transaction
 *
 * NO sentinel backfill. NO historical migration edit. NO CONCURRENTLY removal. NO generic
 * regex splitting.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ExecutionPhase =
  | 'transactional-batch'
  | 'standalone-transactional'
  | 'autocommit-required';

export interface PlannedStatement {
  /** Migration file this statement came from, e.g. `0104_ps497_fulfillment_occurrences.sql`. */
  file: string;
  /** 0-based index of the statement within its file, after breakpoint splitting. */
  index: number;
  /** The statement exactly as written. Never rewritten. */
  sql: string;
  phase: ExecutionPhase;
  /** Why the planner assigned this phase — carried into the execution report. */
  reason: string;
}

/**
 * A tolerated failure must name all three of: the migration file, the SQLSTATE, and a
 * human reason. A policy that omits any of them is rejected by `assertTolerancePolicy`.
 *
 * This replaces the bare catch. A bare catch tolerates every error from every file for no
 * stated reason, which is how a UNIQUE index went missing for months without a red lane.
 */
export interface ToleranceRule {
  file: string;
  sqlstate: string;
  reason: string;
}

export interface ExecutionReport {
  applied: PlannedStatement[];
  tolerated: Array<{ statement: PlannedStatement; sqlstate: string; rule: ToleranceRule }>;
  phaseCounts: Record<ExecutionPhase, number>;
}

const BREAKPOINT = '--> statement-breakpoint';

/**
 * Detects concurrency in any position, which is the whole point. Matches
 * CREATE INDEX CONCURRENTLY, CREATE UNIQUE INDEX CONCURRENTLY, DROP INDEX CONCURRENTLY,
 * and REINDEX ... CONCURRENTLY, without caring what modifiers appear between the verb and
 * the keyword.
 *
 * Deliberately NOT `/CREATE\s+INDEX\s+CONCURRENTLY/` — that is the defect this module exists
 * to remove. Any narrowing of this pattern must turn the planner mutation test red.
 */
const CONCURRENTLY = /\bCONCURRENTLY\b/i;

/** ALTER TABLE ... VALIDATE CONSTRAINT takes a lock that must not sit inside a batch. */
const VALIDATE_CONSTRAINT = /\bALTER\s+TABLE\b[\s\S]*\bVALIDATE\s+CONSTRAINT\b/i;

/** Statements that must own their transaction rather than share the batch. */
const STANDALONE = /\b(CREATE|DROP)\s+DATABASE\b|\bVACUUM\b|\bCREATE\s+TABLESPACE\b/i;

/** Strip comments so a keyword inside a comment cannot drive phase selection. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function classifyStatement(sql: string): { phase: ExecutionPhase; reason: string } {
  const code = stripComments(sql);
  if (CONCURRENTLY.test(code)) {
    return {
      phase: 'autocommit-required',
      reason: 'CONCURRENTLY cannot run inside a transaction block',
    };
  }
  if (VALIDATE_CONSTRAINT.test(code)) {
    return {
      phase: 'autocommit-required',
      reason: 'VALIDATE CONSTRAINT is run outside the batch to keep its lock non-blocking',
    };
  }
  if (STANDALONE.test(code)) {
    return { phase: 'standalone-transactional', reason: 'statement requires its own transaction' };
  }
  return { phase: 'transactional-batch', reason: 'ordinary statement' };
}

/** Split one migration file into statements on Drizzle's breakpoint marker. */
export function splitStatements(body: string): string[] {
  return body
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface PlanOptions {
  /** Absolute path to the migration directory. */
  dir: string;
  /** Apply only these filenames, in the given order. Omit for the full chain. */
  only?: string[];
}

/**
 * Build the ordered execution plan. Pure — reads the filesystem, touches no database.
 * Callers must not re-implement this; a guard forbids local full-chain appliers.
 */
export function planMigrations(options: PlanOptions): PlannedStatement[] {
  const files = options.only
    ? [...options.only]
    : fs.readdirSync(options.dir).filter((f) => f.endsWith('.sql')).sort();

  const planned: PlannedStatement[] = [];
  for (const file of files) {
    const body = fs.readFileSync(path.join(options.dir, file), 'utf8');
    splitStatements(body).forEach((sql, index) => {
      const { phase, reason } = classifyStatement(sql);
      planned.push({ file, index, sql, phase, reason });
    });
  }
  return planned;
}

/**
 * SQLSTATEs that must NEVER be tolerated, because tolerating them hides a defect in the
 * execution plan itself rather than an environmental difference.
 *
 *   25001 active_sql_transaction — a CONCURRENTLY statement ran inside a transaction. That
 *         means phase routing is wrong. It is the exact failure PS-510 removes.
 *   25P02 in_failed_sql_transaction — "current transaction is aborted". This is never the
 *         real error; it is the wake of an earlier one. Tolerating it would silently skip
 *         every remaining statement in the batch and report an innocent file.
 */
export const NEVER_TOLERABLE: Record<string, string> = {
  '25001': 'CONCURRENTLY ran inside a transaction — the execution plan is wrong, not the environment',
  '25P02': 'a poisoned transaction is the wake of an earlier failure, never the cause; fix that instead',
};

/**
 * Split a SQL text into top-level commands, respecting single quotes, double quotes,
 * dollar-quoted bodies ($$ ... $$ / $tag$ ... $tag$), line comments and block comments.
 *
 * THIS IS NOT GENERIC REGEX SPLITTING, and it is deliberately not applied everywhere.
 * It is used ONLY for an autocommit-phase statement that contains more than one command,
 * because PostgreSQL makes that case otherwise unrunnable: a multi-command simple query is
 * wrapped in an IMPLICIT transaction block, so CONCURRENTLY fails with 25001 even when no
 * explicit transaction is open.
 *
 * The concrete case is `0018e_indexes.sql`, a hand-written file with no Drizzle breakpoints
 * and three CREATE INDEX CONCURRENTLY commands. Its own header says: "Paste and Run each
 * statement INDIVIDUALLY (one at a time)... if you paste all 3 at once the editor wraps them
 * and Postgres rejects it." Hosted runs 33134320092/33134321684/33134323939 hit exactly that.
 *
 * Drizzle-generated files keep using the breakpoint marker and never reach this path.
 */
export function splitTopLevelCommands(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // escaped by doubling
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    if (ch === ';') {
      const piece = sql.slice(start, i + 1).trim();
      if (piece.replace(/;$/, '').trim().length > 0) out.push(piece);
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

export interface ExecutionRun {
  kind: 'batch' | 'standalone' | 'autocommit';
  statements: PlannedStatement[];
}

/**
 * Group the plan into ordered execution runs WITHOUT reordering anything.
 *
 * Consecutive transactional-batch statements share one transaction; anything that cannot share
 * it closes the batch and runs on its own, after which a new batch may open.
 *
 * This exists as a pure function because the ordering rule is the part that broke. An earlier
 * executor grouped by phase — all batch, then all standalone, then all autocommit — which
 * reordered the chain across files: 0097 adds `billing_line_items.replacement_id` in an
 * autocommit statement and 0098 adds the foreign key referencing it in a batch statement, so
 * 0098 ran first and failed 42703. Migrations are ordered by construction; an executor that
 * reorders them is not applying the chain.
 */
export function planExecutionRuns(planned: PlannedStatement[]): ExecutionRun[] {
  const runs: ExecutionRun[] = [];
  for (const statement of planned) {
    if (statement.phase === 'transactional-batch') {
      const last = runs[runs.length - 1];
      if (last && last.kind === 'batch') last.statements.push(statement);
      else runs.push({ kind: 'batch', statements: [statement] });
      continue;
    }
    runs.push({
      kind: statement.phase === 'standalone-transactional' ? 'standalone' : 'autocommit',
      statements: [statement],
    });
  }
  return runs;
}

/** Reject a tolerance policy that would reintroduce blanket swallowing. */
export function assertTolerancePolicy(rules: ToleranceRule[]): void {
  for (const rule of rules) {
    const banned = NEVER_TOLERABLE[rule.sqlstate];
    if (banned) {
      throw new Error(`tolerance rule for ${rule.file} names SQLSTATE ${rule.sqlstate}, which must never be tolerated: ${banned}`);
    }
    if (!rule.file || rule.file === '*') {
      throw new Error(`tolerance rule must name an exact migration file, got ${JSON.stringify(rule.file)}`);
    }
    if (!/^[0-9A-Z]{5}$/.test(rule.sqlstate)) {
      throw new Error(`tolerance rule for ${rule.file} must name an exact 5-character SQLSTATE, got ${JSON.stringify(rule.sqlstate)}`);
    }
    if (!rule.reason || rule.reason.trim().length < 8) {
      throw new Error(`tolerance rule for ${rule.file}/${rule.sqlstate} must carry a human reason`);
    }
  }
}

export function emptyReport(): ExecutionReport {
  return {
    applied: [],
    tolerated: [],
    phaseCounts: {
      'transactional-batch': 0,
      'standalone-transactional': 0,
      'autocommit-required': 0,
    },
  };
}

/** Human-readable execution report naming what was applied and what was explicitly tolerated. */
export function formatReport(report: ExecutionReport): string {
  const lines: string[] = [];
  lines.push('migration execution report');
  lines.push(`  applied              : ${report.applied.length}`);
  for (const phase of Object.keys(report.phaseCounts) as ExecutionPhase[]) {
    lines.push(`    ${phase.padEnd(24)}: ${report.phaseCounts[phase]}`);
  }
  lines.push(`  explicitly tolerated : ${report.tolerated.length}`);
  for (const t of report.tolerated) {
    lines.push(`    ${t.statement.file} [${t.sqlstate}] ${t.rule.reason}`);
  }
  return lines.join('\n');
}
