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

check('the route is ADMIN-gated, not merely permission-gated', () => {
  // This guard previously pinned `requirePermission('financials:write')` alone and
  // called that the gate. It is not one: PS-246 grants financials:write to
  // `operator` so operators can run billing, so a non-admin operator could reach
  // this mutation while the handler asserts isAdmin: true to the decision service.
  // AC-6 says only admins may correct a return's billing date, so requireAdmin
  // must come FIRST and the comment-proof position assertion below now pins both.
  assert.match(
    block,
    /^'\/returns\/:returnId\/billing-date',[\s\S]{0,600}?requireAdmin,\s*requirePermission\('financials:write'\),\s*zValidator\(/,
    'requireAdmin must precede requirePermission in the middleware list',
  );
});

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
    /^'\/returns\/:returnId\/billing-date',[\s\S]{0,600}?requirePermission\('financials:write'\),\s*zValidator\(/,
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
  // The affected-row read joined this transaction in PS-488 M2. It must stay inside it:
  // rows gathered outside could describe a different set than the correction moved.
  const tx = applyService.indexOf('db.transaction(async (tx) => {');
  const affected = applyService.indexOf('.from(billingLineItems)');
  const update = applyService.indexOf('.update(returns)');
  const event = applyService.indexOf('.insert(returnActivityEvents)');
  assert.ok(tx >= 0, 'the write must be in a transaction');
  assert.ok(affected > tx, 'affected-row evidence must be gathered inside the transaction');
  assert.ok(update > tx && event > update,
    'a correction applied without its audit row would defeat AC-7');
});

check('the audit event is the canonical append-only type', () => {
  assert.match(applyService, /eventType: RETURN_BILLING_DATE_CORRECTED_EVENT/);
  // Persists the SUPERSET, not the bare decision audit: the detail must carry the
  // affected billing rows, otherwise AC-7 records the decision but not what it touched.
  assert.match(applyService, /detail: JSON\.stringify\(persisted\)/);
  assert.match(applyService, /\.\.\.input\.audit,/, 'the decision audit must be carried through intact');
});

check('AC-7 affected rows are RELATIONAL, never inferred', () => {
  // The whole point of PS-488 M1/M2. Parsing the event key out of `description`, or
  // matching order_id + line_type, mis-attributes as soon as an order has two returns.
  assert.match(
    applyService,
    /affectedBillingLineItemIds: affected\.map\(\(row\) => row\.id\)/,
    'affected rows must come from the query result',
  );
  assert.match(
    applyService,
    /\.where\(eq\(billingLineItems\.returnId, input\.returnId\)\)/,
    'affected rows must be selected by return_id',
  );
  assert.doesNotMatch(
    applyService,
    /affectedBillingLineItemIds[\s\S]{0,200}description/,
    'affected rows must not be derived from the description key',
  );
});

check('an incomplete affected-row list is admitted, not hidden', () => {
  // Every line written before M2 carries return_id NULL, so an empty list can mean
  // "cannot attribute" rather than "nothing affected". Recording the gap is what stops
  // a partial list reading as a complete one.
  assert.match(applyService, /unattributedLegacyReturnLines/);
  assert.match(applyService, /isNull\(billingLineItems\.returnId\)/,
    'the gap count must look for unattributed rows');
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
