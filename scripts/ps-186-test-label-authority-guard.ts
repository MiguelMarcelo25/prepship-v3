/**
 * PS-186 guard — backend-owned test-label authority.
 *
 * THE BUG THIS PINS CLOSED: the FE `isTestOrder` heuristic (TESTING- prefix, client-name match,
 * SKU sniff, raw.test flags) could send `testLabel: true` for ANY client, and createLabelV2
 * honored it — silently minting a FAKE label + fake tracking on a REAL customer order, marking
 * it shipped, deducting inventory, and skipping assertLabelPurchaseRateSelection entirely.
 *
 * Pins:
 *   1. The canonical owner exists (test-label-policy.ts): pure decideTestLabel + the
 *      TEST_LABEL_REJECTED 409 error + the single loadClientIsTest lookup.
 *   2. createLabelV2 resolves the effective testLabel through the owner BEFORE the offline-mock
 *      branch, and no inline clients.isTest load remains in labels.ts (all deduped).
 *   3. The route surfaces TEST_LABEL_REJECTED as a structured 409 and still DECLARES testLabel
 *      in both zod bodies (rejection is semantic — dropping the field would silently ignore it).
 *   4. FE money paths read ONLY backend facts (isBackendTestOrder); no money-path local is
 *      derived from the heuristic isTestOrder, and no testLabel line calls it directly.
 *   5. /orders stamps the backend-owned `isTest` row fact (clients.isTest).
 *   6. BEHAVIOR (pure, no DB): the decideTestLabel matrix — isTest client always forced to mock;
 *      real client + requested mock => rejected; real client default => real path.
 *
 *   npx tsx scripts/ps-186-test-label-authority-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideTestLabel } from '../src/services/fulfillment/test-label-policy';

const policy = readFileSync('src/services/fulfillment/test-label-policy.ts', 'utf8');
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. Canonical owner ─────────────────────────────────────────────────────────
check('policy exports pure decideTestLabel', /export function decideTestLabel\(/.test(policy));
check('policy exports resolveEffectiveTestLabel', /export async function resolveEffectiveTestLabel\(/.test(policy));
check('policy exports the single loadClientIsTest lookup', /export async function loadClientIsTest\(/.test(policy));
check('policy error carries code TEST_LABEL_REJECTED + status 409',
  /TEST_LABEL_REJECTED/.test(policy) && /status = 409/.test(policy));

// ── 2. createLabelV2 wiring ────────────────────────────────────────────────────
const resolveAt = labelsService.indexOf('resolveEffectiveTestLabel(');
const mockBranchAt = labelsService.indexOf('if (body.testLabel === true)');
check('createLabelV2 resolves testLabel through the canonical owner', resolveAt >= 0);
check('the resolution runs BEFORE the offline-mock branch',
  resolveAt >= 0 && mockBranchAt > resolveAt,
  `resolve@${resolveAt} mock@${mockBranchAt}`);
check('no inline clients.isTest load remains in labels.ts (deduped into the owner)',
  !/isTest:\s*clients\.isTest/.test(labelsService));
check('batch failures surface structured codes', /code: \(err as \{ code: string \}\)\.code/.test(labelsService));

// ── 3. Route: structured 409 + schema intact ──────────────────────────────────
check('route maps TEST_LABEL_REJECTED to a structured 409',
  /TEST_LABEL_REJECTED/.test(labelsRoute) && /code: e\.code, \.\.\.details \}, 409\)/.test(labelsRoute));
check('createBody/batchBody still DECLARE testLabel (semantic rejection, not silent drop)',
  (labelsRoute.match(/testLabel: z\.boolean\(\)\.optional\(\)/g) ?? []).length >= 2);

// ── 4. FE money paths read backend facts only ─────────────────────────────────
check('isBackendTestOrder reader exists (backend facts only)',
  /function isBackendTestOrder\(/.test(ordersView));
check('no money-path local is derived from the heuristic (const orderIsTest/isTest = isTestOrder)',
  !/const (orderIsTest|isTest)\s*=\s*isTestOrder\(/.test(ordersView));
check('no testLabel line calls the heuristic directly',
  !/testLabel:[^,\n]*\bisTestOrder\(/.test(ordersView));
check('money-path locals come from isBackendTestOrder',
  (ordersView.match(/=\s*isBackendTestOrder\(order\)/g) ?? []).length >= 4);

// ── 5. /orders stamps the backend-owned isTest fact ───────────────────────────
check('orders list loads the test-client set', /testClientIds = new Set<number>\(\)/.test(ordersRoute));
check('orders rows carry isTest from clients.isTest',
  /isTest: r\.order\.clientId != null && testClientIds\.has\(r\.order\.clientId\)/.test(ordersRoute));
check('order detail mirrors isTest via the canonical lookup',
  (ordersRoute.match(/isTest: await loadClientIsTest\(order\.clientId\)/g) ?? []).length >= 2);

// ── 6. BEHAVIOR: the pure decision matrix (no DB) ─────────────────────────────
check('isTest client + requested mock -> forced mock',
  decideTestLabel({ clientIsTest: true, requestedTestLabel: true }).testLabel === true);
check('isTest client + no request -> STILL forced mock (test row never spends postage)',
  decideTestLabel({ clientIsTest: true, requestedTestLabel: false }).testLabel === true);
const rejected = decideTestLabel({ clientIsTest: false, requestedTestLabel: true });
check('REAL client + requested mock -> REJECTED (the PS-186 bug, closed)',
  rejected.rejected === true && rejected.testLabel === false);
check('REAL client + no request -> real purchase path',
  decideTestLabel({ clientIsTest: false, requestedTestLabel: false }).testLabel === false &&
    !decideTestLabel({ clientIsTest: false, requestedTestLabel: false }).rejected);

console.log(failures === 0 ? '\nPASS PS-186 test-label authority guard' : `\nFAIL PS-186 test-label authority guard (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
