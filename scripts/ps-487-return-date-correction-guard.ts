/**
 * PS-487 AC-4/AC-7 guard — the return billing-date correction decision.
 *
 * Offline/pure: no DB, no network, no billing regeneration, no production mutation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RETURN_BILLING_DATE_CORRECTED_EVENT,
  resolveReturnDateCorrection,
  type ReturnDateCorrectionContext,
} from '../src/services/billing-return-date-correction';

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

const admin = { isAdmin: true, actorId: 'u-admin', actorEmail: 'dj@drprepperusa.com' };
const client = { isAdmin: false, actorId: 'u-client', actorEmail: 'c@example.com' };
const req = (o: Record<string, unknown> = {}) => ({
  returnId: 12, newBillingDay: '2026-09-02', reason: 'Corrected receipt date', ...o,
} as never);
const ctx = (o: Partial<ReturnDateCorrectionContext> = {}): ReturnDateCorrectionContext => ({
  systemCreatedDay: '2026-08-10',
  currentBillingDay: '2026-08-10',
  currentPeriodFinalized: false,
  targetPeriodFinalized: false,
  ...o,
});

// ── AC-4: admin only, reason required, any past OR future day ────────────────
check('a client user is refused', () => {
  const d = resolveReturnDateCorrection({ actor: client, request: req(), context: ctx() });
  assert.equal(d.kind, 'rejected');
  assert.equal((d as never as { code: string }).code, 'not_admin');
});

check('a reason is mandatory', () => {
  for (const reason of ['', '  ', 'ab']) {
    const d = resolveReturnDateCorrection({ actor: admin, request: req({ reason }), context: ctx() });
    assert.equal((d as never as { code: string }).code, 'reason_required', String(reason));
  }
});

check('a malformed day is refused', () => {
  // 2026-13-40 and 2026-02-31 pass a shape-only regex but are not real days; Date
  // coercion would silently roll them into another month and bill the wrong period.
  for (const newBillingDay of ['', 'yesterday', '2026-13-40', '2026-02-31', '09/02/2026']) {
    const d = resolveReturnDateCorrection({ actor: admin, request: req({ newBillingDay }), context: ctx() });
    assert.equal((d as never as { code: string }).code, 'invalid_date', String(newBillingDay));
  }
});

check('an open-period move is allowed BOTH backwards and forwards', () => {
  const forward = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-09-02' }), context: ctx(),
  });
  const backward = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-06-30' }), context: ctx(),
  });
  assert.equal(forward.kind, 'move');
  assert.equal(backward.kind, 'move');
});

check('correcting to the day it already bills is a NOOP, not a silent success', () => {
  const d = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-08-10' }), context: ctx(),
  });
  assert.equal(d.kind, 'noop');
});

// ── AC-6: finalized periods need DJ-approved override evidence ───────────────
check('moving OUT of a finalized period without approval is blocked', () => {
  const d = resolveReturnDateCorrection({
    actor: admin, request: req(), context: ctx({ currentPeriodFinalized: true }),
  });
  assert.equal((d as never as { code: string }).code, 'dj_approval_required');
});

check('moving INTO a finalized period without approval is blocked', () => {
  const d = resolveReturnDateCorrection({
    actor: admin, request: req(), context: ctx({ targetPeriodFinalized: true }),
  });
  assert.equal((d as never as { code: string }).code, 'dj_approval_required');
});

check('with approval, a finalized correction becomes an ADJUSTMENT, never a move', () => {
  const d = resolveReturnDateCorrection({
    actor: admin,
    request: req({ djApprovalReference: 'DJ-2026-08-05-01' }),
    context: ctx({ currentPeriodFinalized: true }),
  });
  assert.equal(d.kind, 'adjustment_required',
    'a frozen invoice must never be rewritten — the delta is appended elsewhere');
  assert.deepEqual((d as never as { finalized: unknown }).finalized, { current: true, target: false });
});

check('a blank approval reference does not count as approval', () => {
  const d = resolveReturnDateCorrection({
    actor: admin,
    request: req({ djApprovalReference: '   ' }),
    context: ctx({ currentPeriodFinalized: true }),
  });
  assert.equal((d as never as { code: string }).code, 'dj_approval_required');
});

// ── AC-7: evidence ───────────────────────────────────────────────────────────
check('every change carries full audit evidence', () => {
  const d = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-09-02' }), context: ctx(),
  }) as never as { audit: Record<string, unknown> };
  assert.deepEqual(d.audit, {
    returnId: 12,
    oldBillingDay: '2026-08-10',
    newBillingDay: '2026-09-02',
    systemCreatedDay: '2026-08-10',
    actorId: 'u-admin',
    actorEmail: 'dj@drprepperusa.com',
    reason: 'Corrected receipt date',
    djApprovalReference: null,
    // AC-7 affected periods. deepEqual is deliberate here: it fails when a field is ADDED
    // as well as changed, so audit evidence cannot grow or shrink without being read.
    fromPeriod: '2026-08',
    toPeriod: '2026-09',
    adjustmentRequired: false,
  });
});

check('AC-7: the affected periods are recorded, not left to be re-derived', () => {
  // "Which periods did this touch" is the first question an auditor asks. Recording only
  // the days makes every reader re-derive it, and a reader using a different month
  // boundary gets a different answer from the same evidence.
  const d = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-09-02' }), context: ctx(),
  }) as never as { audit: { fromPeriod: string; toPeriod: string } };
  assert.equal(d.audit.fromPeriod, '2026-08', 'the period the return moves OUT of');
  assert.equal(d.audit.toPeriod, '2026-09', 'the period it moves INTO');
});

check('AC-7: a within-period correction records the SAME period on both sides', () => {
  // Not a no-op — the day changed. The periods matching is the evidence that no money
  // crossed a period boundary, which is a different fact from "nothing happened".
  const d = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-08-27' }), context: ctx(),
  }) as never as { audit: { fromPeriod: string; toPeriod: string; adjustmentRequired: boolean } };
  assert.equal(d.audit.fromPeriod, '2026-08');
  assert.equal(d.audit.toPeriod, '2026-08');
  assert.equal(d.audit.adjustmentRequired, false);
});

check('AC-7: adjustmentRequired is recorded on EVERY outcome, not only when true', () => {
  // An absent field would be ambiguous between "no adjustment" and "nobody checked".
  const move = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-09-02' }), context: ctx(),
  }) as never as { audit: { adjustmentRequired: boolean } };
  assert.equal(move.audit.adjustmentRequired, false);
});

check('AC-7: the adjustment ID is NOT claimed at decision time', () => {
  // PS-449 mints it when the next open period is reconciled, which has not happened yet.
  // Recording an id we have never seen would be worse evidence than an honest pending
  // linkage — it would read as a verified reference to something that does not exist.
  const d = resolveReturnDateCorrection({
    actor: admin, request: req({ newBillingDay: '2026-09-02' }), context: ctx(),
  }) as never as { audit: Record<string, unknown> };
  for (const forbidden of ['adjustmentId', 'billingAdjustmentId', 'creditNoteId']) {
    assert.ok(!(forbidden in d.audit), `${forbidden} cannot be known at decision time`);
  }
});

check('the ORIGINAL system-created day survives a second correction', () => {
  // AC-7 wants the real creation timestamp as evidence, distinct from whatever a prior
  // correction moved the billing day to. Collapsing them would lose the fact that the
  // return actually entered the system in August.
  const d = resolveReturnDateCorrection({
    actor: admin,
    request: req({ newBillingDay: '2026-10-01' }),
    context: ctx({ systemCreatedDay: '2026-08-10', currentBillingDay: '2026-09-02' }),
  }) as never as { audit: Record<string, unknown> };
  assert.equal(d.audit.systemCreatedDay, '2026-08-10');
  assert.equal(d.audit.oldBillingDay, '2026-09-02');
});

check('rejections carry NO audit payload (nothing happened to record)', () => {
  const d = resolveReturnDateCorrection({ actor: client, request: req(), context: ctx() });
  assert.ok(!('audit' in d));
});

// ── placement ────────────────────────────────────────────────────────────────
check('the decision owner computes no adjustment amount of its own', () => {
  const src = readFileSync('src/services/billing-return-date-correction.ts', 'utf8');
  assert.doesNotMatch(src, /creditNote|adjustmentKind|centsMoney|moneyCents/,
    'posting an adjustment belongs to PS-449 — this owner only decides that one is required');
  assert.ok(RETURN_BILLING_DATE_CORRECTED_EVENT === 'billing_date_corrected');
});

if (failures > 0) {
  console.error(`\nFAIL PS-487 return date correction guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-487 return date correction guard');
