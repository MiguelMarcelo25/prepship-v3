#!/usr/bin/env tsx
/**
 * PS-521 — the return line-type vocabulary has ONE owner, and it is a leaf.
 *
 * Hermetic: file reads plus one import of the leaf. No database, no network.
 *
 * WHAT IT HOLDS.
 *  1. The leaf (src/services/billing-return-line-types.ts) imports nothing from this codebase,
 *     so any module can import it without a cycle — that cycle is why private copies existed.
 *  2. Membership cannot drift between the aggregate and the split buckets: executed set
 *     equality, aggregate = postage ∪ processing ∪ bare, buckets disjoint. (The aggregate stays
 *     a LITERAL list for the portal's scraper and for SQL order; this is what makes that safe.)
 *  3. The former owners delegate: billing-row-status.ts declares no vocabulary of its own and
 *     re-exports the leaf's; billing-return-date-correction-apply.ts imports the aggregate
 *     instead of assembling a list; billing-return-event-contract.ts derives its legacy
 *     read-only list from the leaf.
 *  4. RATCHET: the only hand-spelled copy left in src/ is the one in the shipped-lockdown file
 *     billing-cancelled-no-charge.ts, which needs DJ's fresh `unlock shipped data` before it can
 *     be migrated. The allow-list below names it so its debt is visible on every run, and so a
 *     NEW copy anywhere else fails the pack. When it is migrated, delete it from the allow-list
 *     and this guard tightens to "no copies at all".
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  BILLING_RETURN_BARE_LINE_TYPES,
  BILLING_RETURN_LINE_TYPES,
  BILLING_RETURN_POSTAGE_LINE_TYPES,
  BILLING_RETURN_PROCESSING_LINE_TYPES,
  isBillingReturnLineType,
  isBillingReturnPostageLineType,
  isBillingReturnProcessingLineType,
} from '../src/services/billing-return-line-types';

const LEAF = 'src/services/billing-return-line-types.ts';
const read = (p: string) => readFileSync(p, 'utf8');

let passed = 0;
const failures: string[] = [];
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    failures.push(`${label}\n        ${message}`);
    console.log(`  FAIL  ${label}\n        ${message}`);
  }
};

// ── 1. The leaf is a leaf ────────────────────────────────────────────────────────────────────
check('the leaf imports nothing from this codebase (only drizzle-orm), so it can never be in a cycle', () => {
  const src = read(LEAF);
  const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)';/gm)].map((m) => m[1]!);
  assert.deepEqual(imports, ['drizzle-orm'], `imports: ${imports.join(', ')}`);
});

// ── 2. Membership cannot drift ───────────────────────────────────────────────────────────────
check('aggregate = postage ∪ processing ∪ bare, exactly (executed, not read)', () => {
  const union = new Set<string>([...BILLING_RETURN_POSTAGE_LINE_TYPES, ...BILLING_RETURN_PROCESSING_LINE_TYPES, ...BILLING_RETURN_BARE_LINE_TYPES]);
  const all = new Set<string>(BILLING_RETURN_LINE_TYPES);
  assert.deepEqual([...all].sort(), [...union].sort());
  assert.equal(all.size, BILLING_RETURN_LINE_TYPES.length, 'the aggregate list repeats a spelling');
});
check('postage and processing are disjoint, and neither contains the bare spelling', () => {
  for (const t of BILLING_RETURN_POSTAGE_LINE_TYPES) assert.ok(!(BILLING_RETURN_PROCESSING_LINE_TYPES as readonly string[]).includes(t), `${t} is in both buckets`);
  for (const t of BILLING_RETURN_BARE_LINE_TYPES) {
    assert.ok(!(BILLING_RETURN_POSTAGE_LINE_TYPES as readonly string[]).includes(t) && !(BILLING_RETURN_PROCESSING_LINE_TYPES as readonly string[]).includes(t), `${t} is bucketed`);
  }
});
check('the predicates classify exactly their lists, case-insensitively, and nothing else', () => {
  for (const t of BILLING_RETURN_LINE_TYPES) assert.ok(isBillingReturnLineType(t) && isBillingReturnLineType(t.toUpperCase()), t);
  for (const t of BILLING_RETURN_POSTAGE_LINE_TYPES) assert.ok(isBillingReturnPostageLineType(t) && !isBillingReturnProcessingLineType(t), t);
  for (const t of BILLING_RETURN_PROCESSING_LINE_TYPES) assert.ok(isBillingReturnProcessingLineType(t) && !isBillingReturnPostageLineType(t), t);
  for (const not of ['pick_pack', 'shipping', 'replace_postage', 'returns', '', null, undefined, 42]) {
    assert.ok(!isBillingReturnLineType(not) && !isBillingReturnPostageLineType(not) && !isBillingReturnProcessingLineType(not), String(not));
  }
});

// ── 3. The former owners delegate ────────────────────────────────────────────────────────────
const VOCAB_DECL = /export const BILLING_RETURN_(BARE_|POSTAGE_|PROCESSING_)?LINE_TYPES\s*=\s*\[/;
check('billing-row-status.ts declares no vocabulary of its own and re-exports the leaf', () => {
  const src = read('src/services/billing-row-status.ts');
  assert.ok(!VOCAB_DECL.test(src), 'a vocabulary const is declared in billing-row-status.ts again');
  assert.ok(/export \{[\s\S]*BILLING_RETURN_LINE_TYPES[\s\S]*\} from '\.\/billing-return-line-types'/.test(src), 'no re-export from the leaf');
  assert.ok(/import \{[\s\S]*isBillingReturnLineType[\s\S]*\} from '\.\/billing-return-line-types'/.test(src), 'the status resolver does not use the leaf predicates');
});
check('billing-return-date-correction-apply.ts imports the aggregate from the leaf and assembles no list', () => {
  const src = read('src/services/billing-return-date-correction-apply.ts');
  assert.ok(/import \{ BILLING_RETURN_LINE_TYPES \} from '\.\/billing-return-line-types'/.test(src), 'no import from the leaf');
  assert.ok(/inArray\(billingLineItems\.lineType, \[\.\.\.BILLING_RETURN_LINE_TYPES\]\)/.test(src), 'the gap count does not use the owner');
  assert.ok(!/const RETURN_LINE_TYPES\s*=/.test(src), 'a private RETURN_LINE_TYPES list is back');
});
check('billing-return-event-contract.ts derives its legacy read-only list from the leaf', () => {
  const src = read('src/services/billing-return-event-contract.ts');
  assert.ok(/from '\.\/billing-return-line-types'/.test(src), 'no import from the leaf');
  assert.ok(/LEGACY_RETURN_READ_ONLY_LINE_TYPES\s*=\s*BILLING_RETURN_LINE_TYPES\.filter/.test(src), 'the legacy list is still hand-spelled');
});

// ── 4. Ratchet: hand-spelled copies outside the leaf ─────────────────────────────────────────
// A "copy" is an array literal that lists two or more return spellings. Per-spelling display
// mappings and single-spelling comparisons are not copies. The allow-list is the debt.
const PENDING_UNLOCK = ['src/services/billing-cancelled-no-charge.ts'];
check(`the only hand-spelled copies left in src/ are the allow-listed ones: ${PENDING_UNLOCK.join(', ') || '(none)'}`, () => {
  const spellings = BILLING_RETURN_LINE_TYPES.map((t) => `'${t}'`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (/\.ts$/.test(entry.name) && p !== LEAF) files.push(p);
    }
  };
  walk('src');
  const copies = files.filter((f) => {
    const src = read(f);
    // an array literal or SQL in-list carrying >= 2 return spellings within one bracket pair
    return [...src.matchAll(/[[(]([^[\]()]*?)[\])]/gs)].some((m) => spellings.filter((s) => m[1]!.includes(s)).length >= 2);
  });
  assert.deepEqual(copies.sort(), PENDING_UNLOCK.slice().sort(), `hand-spelled copies: ${copies.join(', ')}`);
});
check('the allow-listed file really does carry the debt (so a migrated file is removed from the list, not forgotten)', () => {
  for (const f of PENDING_UNLOCK) assert.ok(/'return_processing_fee'/.test(read(f)), `${f} no longer spells the vocabulary — remove it from PENDING_UNLOCK`);
});

check('the guard is in the SOT pack and has an npm script', () => {
  assert.ok(read('package.json').includes('"test:ps-521-return-vocabulary-leaf"'), 'missing npm script');
  assert.ok(read('scripts/sot-guard-pack.mjs').includes("'test:ps-521-return-vocabulary-leaf'"), 'not in sot-guard-pack.mjs');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PS-521 return vocabulary leaf guard passed.');
