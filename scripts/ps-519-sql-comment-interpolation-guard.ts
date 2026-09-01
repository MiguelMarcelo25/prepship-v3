#!/usr/bin/env tsx
/**
 * PS-519 — never interpolate into a `--` comment inside a sql`` template.
 *
 * PS-513 wrote this, inside billingInvoiceData's query, meaning it as documentation:
 *
 *     -- ${detailAmount} keeps replacement money on a cancelled original (...)
 *
 * `${detailAmount}` is LIVE interpolation, not prose. It renders to a THIRTEEN-line `case`
 * expression, so the leading `--` commented out only its first line (`-- case`) and the
 * remaining twelve lines spilled into the select list as bare SQL beginning with `when (`.
 * `when` cannot open a select-list expression, so the whole statement stopped parsing and
 * GET /invoice, /invoice.xlsx and /invoice.csv failed for every client until PS-519 fixed it.
 *
 * Why nothing caught it: typecheck cannot see inside a template's SQL, and no guard executes
 * billingInvoiceData's query — the invoice guards feed the renderers a fixture DTO, and the
 * ps-433 integration exercises a different owner (billingInvoiceHeaderTotals). Every lane was
 * green while a customer-facing endpoint was down.
 *
 * SCOPE: only lines INSIDE a sql`` template are checked. An earlier version scanned every line
 * and flagged CLI help text (`--days <n> ... ${DEFAULT_LOOKBACK_DAYS}`), which is not SQL at
 * all. A guard that reports work it has not proven wrong gets switched off, so this one finds
 * the template regions first and looks only there.
 *
 * Offline/pure: source inspection only. No DB, network, provider call, or postage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The [start, end) source offsets of every sql`` template body in `source`.
 *
 * Walks characters so that a `${...}` holding its own nested template cannot end the scan
 * early: template depth is tracked, and a backtick only closes the region at depth 0.
 */
function sqlTemplateRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opener = /\bsql\s*`/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const bodyStart = match.index + match[0].length;
    let i = bodyStart;
    let exprDepth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }
      if (exprDepth === 0 && ch === '`') break;
      if (ch === '$' && source[i + 1] === '{') { exprDepth += 1; i += 2; continue; }
      if (exprDepth > 0 && ch === '}') exprDepth -= 1;
      i += 1;
    }
    ranges.push([bodyStart, i]);
    opener.lastIndex = i;
  }
  return ranges;
}

/** A SQL line comment carrying an interpolation, anchored so a mid-expression `--` is ignored. */
const SQL_COMMENT_INTERPOLATION = /^[ \t]*--[^\n]*\$\{/;

console.log('PS-519 sql`` comment interpolation');

let scanned = 0;
for (const root of ['src', 'scripts']) {
  for (const file of walk(root)) {
    scanned += 1;
    const source = readFileSync(file, 'utf8');
    if (!source.includes('sql`')) continue;

    // Offset -> line number, computed once per file.
    const lineStarts = [0];
    for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (offset: number): number => {
      let lo = 0; let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    };

    for (const [start, end] of sqlTemplateRanges(source)) {
      const body = source.slice(start, end);
      let cursor = start;
      for (const line of body.split('\n')) {
        if (SQL_COMMENT_INTERPOLATION.test(line)) {
          failures += 1;
          console.error(
            `  FAIL ${file.replace(/\\/g, '/')}:${lineOf(cursor)} interpolates into a SQL "--" comment.\n`
            + `       ${line.trim().slice(0, 110)}\n`
            + '       A multi-line fragment ends the comment at its first newline and spills the\n'
            + '       rest into the statement. Write the identifier as plain words instead.',
          );
        }
        cursor += line.length + 1;
      }
    }
  }
}

if (failures === 0) {
  console.log(`  PASS no sql\`\` line comment interpolates a fragment (${scanned} files scanned)`);
}
console.log(
  failures === 0
    ? '\nPASS PS-519 sql comment interpolation guard'
    : `\nFAIL PS-519 — ${failures} SQL comment(s) interpolate a fragment`,
);
if (failures > 0) process.exit(1);
