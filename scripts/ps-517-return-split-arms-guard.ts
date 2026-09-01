#!/usr/bin/env tsx
/**
 * PS-517 r3 — the invoice's return POSTAGE/PROCESSING split really is the canonical vocabulary.
 *
 * WHY THIS IS NOT A SOURCE-REGEX GUARD.
 *
 * r2 checked the same property by reading src/routes/billing.ts: count the fragment uses, reject
 * inline spellings. Review defeated it with one mutation:
 *
 *   - keep `${returnPostageLineTypesSql}` alive in a COMMENT, so the occurrence count still reads 2
 *   - move the live bool_or arm to a hand-spelled, DOUBLE-QUOTED list
 *   - change one member to 'return_postage_typo'
 *
 * Everything stayed green — typecheck, ps-501, ps-488 — while the invoice's presence flag stopped
 * matching canonical `return_postage`, which is a customer-visible absent-versus-zero regression.
 * A guard that reads text can always be satisfied by text.
 *
 * So this one RENDERS the arms through the real PgDialect and inspects the bound parameters. The
 * vocabulary is read off the compiled SQL, not off the source, so a hand-spelled list or a typo'd
 * member cannot hide behind a comment: it either reaches the parameters or it does not.
 *
 * The remaining source check is comment-STRIPPED and quote-style-agnostic, because its only job is
 * "billing.ts must consume these arms rather than build its own".
 *
 * Offline/pure: renders SQL and inspects source. No DB, network, provider call, or postage.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://ps517:offline@127.0.0.1:1/ps517';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_ANON_KEY = 'offline';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline';
process.env.SUPABASE_JWT_SECRET = 'offline';

const { sql } = await import('drizzle-orm');
const { PgDialect } = await import('drizzle-orm/pg-core');
const { billingReturnSplitInvoiceArms } = await import('../src/services/billing-return-split-arms.js');
const {
  BILLING_RETURN_POSTAGE_LINE_TYPES,
  BILLING_RETURN_PROCESSING_LINE_TYPES,
  BILLING_RETURN_LINE_TYPES,
} = await import('../src/services/billing-row-status.js');

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const dialect = new PgDialect();
// The caller's real amount expression is irrelevant to the vocabulary, so a marker keeps the
// rendered output readable and proves the arm threads the caller's expression rather than
// rebuilding one.
const detailAmount = sql`AMOUNT_MARKER`;
const arms = billingReturnSplitInvoiceArms(detailAmount);
const render = (fragment: typeof arms.postageAmount) => dialect.sqlToQuery(fragment);

console.log('PS-517 return split arms — rendered, not grepped');

// ── The vocabulary as the DATABASE will actually receive it ──────────────────
for (const [label, arm, expected] of [
  ['postage amount', arms.postageAmount, BILLING_RETURN_POSTAGE_LINE_TYPES],
  ['processing amount', arms.processingAmount, BILLING_RETURN_PROCESSING_LINE_TYPES],
  ['postage presence', arms.hasPostageLine, BILLING_RETURN_POSTAGE_LINE_TYPES],
  ['processing presence', arms.hasProcessingLine, BILLING_RETURN_PROCESSING_LINE_TYPES],
] as const) {
  check(`${label}: bound params ARE the canonical vocabulary`, () => {
    const { params } = render(arm);
    assert.deepEqual(
      params,
      [...expected],
      'the rendered arm must bind exactly the canonical spellings, in order — a hand-spelled '
      + 'list or a typo reaches the database here even when the source text looks right',
    );
  });
  check(`${label}: renders one parenthesised bound list, no inline literal`, () => {
    const { sql: text } = render(arm);
    assert.match(text, /in \(\$\d+(?:, \$\d+)+\)/, 'must be a bound-parameter IN list');
    for (const spelling of BILLING_RETURN_LINE_TYPES) {
      assert.ok(!text.includes(`'${spelling}'`), `rendered SQL must not inline '${spelling}'`);
    }
  });
}

check('the amount arms thread the CALLER\'s amount expression', () => {
  assert.match(render(arms.postageAmount).sql, /AMOUNT_MARKER/);
  assert.match(render(arms.processingAmount).sql, /AMOUNT_MARKER/);
});

check('the PRESENCE arms are bool_or and carry NO amount', () => {
  // Presence must not depend on the amount expression: that conflation is what made a
  // processing-only return export postage as 0.00 (PS-488 M3).
  for (const arm of [arms.hasPostageLine, arms.hasProcessingLine]) {
    const { sql: text } = render(arm);
    assert.match(text, /^bool_or\(/);
    assert.ok(!text.includes('AMOUNT_MARKER'), 'a presence flag must not read the amount');
  }
});

check('postage and processing bind DIFFERENT vocabularies', () => {
  assert.notDeepEqual(render(arms.postageAmount).params, render(arms.processingAmount).params);
});

check('every bound spelling is also in the aggregate return vocabulary', () => {
  const bound = [...render(arms.postageAmount).params, ...render(arms.processingAmount).params];
  for (const spelling of bound) {
    assert.ok(
      (BILLING_RETURN_LINE_TYPES as readonly string[]).includes(String(spelling)),
      `'${String(spelling)}' is billed as return money but is not in BILLING_RETURN_LINE_TYPES, `
      + 'so it would fund a named part while dropping out of the return total',
    );
  }
});

// ── billing.ts must CONSUME the arms, not rebuild them ───────────────────────
//
// Comment-stripped, because the defeating mutation kept the canonical token alive in a comment.
// Quote-style-agnostic, because it used double quotes to dodge a single-quote regex.
{
  const raw = readFileSync('src/routes/billing.ts', 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^[ \t]*--.*$/gm, '');

  check('the invoice detail query consumes all FOUR arms from the owner', () => {
    for (const arm of ['postageAmount', 'processingAmount', 'hasPostageLine', 'hasProcessingLine']) {
      assert.ok(
        new RegExp(`\\$\\{returnSplitArms\\.${arm}\\}`).test(code),
        `the query must render returnSplitArms.${arm} rather than building that arm itself`,
      );
    }
    assert.match(code, /billingReturnSplitInvoiceArms\(detailAmount\)/);
  });

  check('billing.ts re-spells NO return line type, in ANY quote style', () => {
    for (const spelling of BILLING_RETURN_LINE_TYPES) {
      for (const quoted of [`'${spelling}'`, `"${spelling}"`, `\`${spelling}\``]) {
        assert.ok(
          !code.includes(quoted),
          `billing.ts hand-spells ${quoted}; the vocabulary has one owner`,
        );
      }
    }
  });

  check('each split alias is produced exactly once', () => {
    for (const alias of [
      'as return_postage_amt', 'as return_processing_amt',
      'as has_return_postage_line', 'as has_return_processing_line',
    ]) {
      const count = code.split(alias).length - 1;
      assert.equal(count, 1, `${alias} appears ${count} times; expected exactly 1`);
    }
  });
}

console.log(
  failures === 0
    ? '\nPASS PS-517 return split arms guard'
    : `\nFAIL PS-517 — ${failures} check(s) failed`,
);
if (failures > 0) process.exit(1);
