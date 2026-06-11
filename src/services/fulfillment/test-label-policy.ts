// PS-186 — Canonical owner of the "may this label be a TEST (offline-mock) label?" decision.
//
// The only authority for test-label mode is the backend `clients.isTest` flag:
//   - isTest client  -> ALWAYS mock (forced, regardless of what the UI sent) — a test row can
//     never spend real postage.
//   - real client    -> a requested `testLabel: true` is REJECTED with a structured 409
//     (TEST_LABEL_REJECTED). Before PS-186 the service honored the flag for ANY client, so a
//     frontend heuristic misfire could silently give a REAL customer order a fake label +
//     fake tracking, mark it shipped, deduct inventory, and skip the selected-rate proof
//     assert entirely. The frontend may no longer decide test-ness for money paths.
//
// Architecture (same shape as the sibling shipping-safety owner): the pure `decideTestLabel`
// is unit-testable with no DB/network; `resolveEffectiveTestLabel` gathers the live client
// flag and applies it. Routes/UI are thin consumers.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { clients } from '../../db/schema/clients';

export type TestLabelDecision =
  | { testLabel: boolean; rejected?: false }
  | { testLabel: false; rejected: true; reason: string };

export class TestLabelRejectedError extends Error {
  code = 'TEST_LABEL_REJECTED' as const;
  /** Safe 4xx-style client error (operator-actionable), not a 500. */
  status = 409;
  details: { clientId: number | null; orderId: number | null; entryPoint: string };
  constructor(details: { clientId: number | null; orderId: number | null; entryPoint: string }) {
    super(
      "Test label rejected: this order's client is not flagged isTest — real orders cannot receive mock labels.",
    );
    this.name = 'TestLabelRejectedError';
    this.details = details;
  }
}

/**
 * PURE policy. No DB/network — deterministic and unit-testable.
 *   (isTest=true,  requested=*)     -> testLabel: true   (forced mock; never real postage)
 *   (isTest=false, requested=true)  -> rejected           (real order must not get a mock label)
 *   (isTest=false, requested=false) -> testLabel: false   (normal real purchase path)
 */
export function decideTestLabel(input: {
  clientIsTest: boolean;
  requestedTestLabel: boolean;
}): TestLabelDecision {
  if (input.clientIsTest) return { testLabel: true };
  if (input.requestedTestLabel) {
    return {
      testLabel: false,
      rejected: true,
      reason: 'testLabel requested for a non-test client',
    };
  }
  return { testLabel: false };
}

/** The single canonical `clients.isTest` lookup. Unknown/absent client -> false (never mock). */
export async function loadClientIsTest(clientId: number | null | undefined): Promise<boolean> {
  if (clientId == null || !Number.isFinite(clientId)) return false;
  const [row] = await db
    .select({ isTest: clients.isTest })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return row?.isTest === true;
}

/**
 * Resolve the effective testLabel for a label side effect. Throws TestLabelRejectedError
 * (409) when a non-test client requested a mock label. Call BEFORE any consumption of the
 * flag — rate-limit skip, weight defaults, and especially the offline-mock branch.
 */
export async function resolveEffectiveTestLabel(input: {
  clientId: number | null | undefined;
  requestedTestLabel: boolean;
  orderId: number | null | undefined;
  entryPoint: string;
}): Promise<boolean> {
  const clientIsTest = await loadClientIsTest(input.clientId);
  const decision = decideTestLabel({ clientIsTest, requestedTestLabel: input.requestedTestLabel });
  if (decision.rejected) {
    throw new TestLabelRejectedError({
      clientId: input.clientId ?? null,
      orderId: input.orderId ?? null,
      entryPoint: input.entryPoint,
    });
  }
  return decision.testLabel;
}
