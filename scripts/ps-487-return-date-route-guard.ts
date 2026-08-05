/**
 * PS-487 AC-4/AC-7 — the admin correction ROUTE.
 *
 * Static/offline: no DB, no network, no mutation. The rule itself is proven by
 * ps-487-return-date-correction; this pins that the route stays thin, gated, scoped,
 * and audited, and that it never grows its own money logic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const route = readFileSync('src/routes/billing.ts', 'utf8');
const start = route.indexOf("'/returns/:returnId/billing-date'");
if (start < 0) {
  console.error('FAIL the return billing-date route is missing from src/routes/billing.ts');
  process.exit(1);
}
// Bound the block at the next top-level app.<verb>( so assertions cannot drift into
// neighbouring routes.
const rest = route.slice(start);
const endRel = rest.search(/\napp\.(get|post|patch|put|delete)\(/);
const block = endRel > 0 ? rest.slice(0, endRel) : rest;

check('the route is permission-gated (client users cannot reach it)', () => {
  // Assert the MIDDLEWARE POSITION, not the mere presence of the string.
  //
  // The first version of this check was `assert.match(block, /requirePermission(...)/)`
  // and it had no teeth: the route body contains a comment mentioning
  // requirePermission('financials:write'), so deleting the actual middleware left the
  // prose behind and the assertion still passed. A positive assertion is as vulnerable
  // to explanatory comments as a negative one.
  //
  // The gate must sit in the argument list — between the path and the validator.
  assert.match(
    block,
    /^'\/returns\/:returnId\/billing-date',\s*requirePermission\('financials:write'\),\s*zValidator\(/,
    'the permission gate must be middleware between the path and the validator',
  );
});

check('an unauthenticated actor is refused before anything is written', () => {
  assert.match(block, /if \(!actor\.actorId\) \{[\s\S]{0,120}?401/);
});

check('an out-of-scope client gets the SAME 404 as a missing return', () => {
  // Distinguishing the two would let an out-of-scope caller probe which returns exist.
  assert.match(block, /canAccessBillingClient\(row\.clientId, scope\)/);
  const notFound = block.match(/'Return not found'/g) ?? [];
  assert.ok(notFound.length >= 2, 'missing and out-of-scope must both answer "Return not found"');
});

check('the DECISION comes from the canonical rule, not from the route', () => {
  assert.match(block, /resolveReturnDateCorrection\(\{/);
  // No inline finalized/approval branching of its own.
  assert.doesNotMatch(
    block,
    /if \([^)]*djApprovalReference[^)]*\)\s*\{/,
    'approval logic belongs to resolveReturnDateCorrection',
  );
});

check('a rejected decision writes NOTHING', () => {
  const reject = block.indexOf("decision.kind === 'rejected'");
  const persist = block.indexOf('await applyReturnBillingDateCorrection(');
  assert.ok(reject >= 0 && persist > reject, 'the rejection must return before any write');
});

const applyService = readFileSync('src/services/billing-return-date-correction-apply.ts', 'utf8');

check('the route DELEGATES persistence instead of writing inline', () => {
  // PS-464's architecture ratchet caught the first version of this route doing its own
  // db.transaction. Routes stay thin: validate -> call service -> answer.
  assert.match(block, /await applyReturnBillingDateCorrection\(\{/);
  assert.doesNotMatch(block, /db\.transaction\(/, 'the write belongs to the service');
  assert.doesNotMatch(block, /\.update\(returns\)|insert\(returnActivityEvents\)/);
});

check('the service writes the override and its audit event in ONE transaction', () => {
  const tx = applyService.indexOf('await db.transaction(async (tx) => {');
  const update = applyService.indexOf('.update(returns)');
  const event = applyService.indexOf('.insert(returnActivityEvents)');
  assert.ok(tx >= 0 && update > tx && event > update,
    'a correction applied without its audit row would defeat AC-7');
});

check('the audit event is the canonical append-only type', () => {
  assert.match(applyService, /eventType: RETURN_BILLING_DATE_CORRECTED_EVENT/);
  assert.match(applyService, /detail: JSON\.stringify\(input\.audit\)/);
});

check('the original created_at is never overwritten', () => {
  // The only createdAt written is the audit EVENT's own timestamp; returns.created_at is
  // never in the update set, because AC-7 needs it as evidence.
  //
  // Slice the .set({...}) argument exactly rather than regexing across it — a lazy
  // [\s\S]*? runs straight past the closing brace and matches the createdAt in the
  // insert() below, which made the first version of this check fail on correct code.
  const setStart = applyService.indexOf('.set({');
  assert.ok(setStart >= 0, 'the update must have a set clause');
  const setBlock = applyService.slice(setStart, applyService.indexOf('})', setStart));
  assert.doesNotMatch(setBlock, /createdAt/,
    'returns.created_at must never appear in the update set');
  assert.match(setBlock, /billingDateOverride: new Date\(/);
});

check('the route posts NO adjustment of its own', () => {
  assert.doesNotMatch(
    block,
    /createBillingCreditNote|billingCreditNotes|adjustmentKind/,
    'the delta is posted by PS-449 reconciliation on the next regeneration',
  );
  assert.match(block, /adjustmentPending: decision\.kind === 'adjustment_required'/);
});

check('a finalized-period correction answers 409, not a silent success', () => {
  assert.match(block, /'dj_approval_required'[\s\S]{0,80}?409/);
});

if (failures > 0) {
  console.error(`\nFAIL PS-487 return date route guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-487 return date route guard');
