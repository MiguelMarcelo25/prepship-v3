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
  });
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
