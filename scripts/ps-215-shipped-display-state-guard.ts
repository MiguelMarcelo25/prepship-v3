/**
 * PS-215 guard — shipped rows show External Label or an ACTIONABLE sync
 * error; the raw "Missing shipment sync" resting badge is gone.
 *
 * DJ invariant (2026-06-12): the operator-facing Shipped table must never
 * rest on raw "Missing shipment sync". Display states:
 *   local_label    — local shipment/label data renders normally
 *   external_label — persisted external flag → Ext. Label (PS-036: NEVER
 *                    inferred from missing local data — rule unchanged)
 *   sync_error     — neither → "Shipment sync error" actionable badge,
 *                    drained by the PS-056 classifier + runbook
 *
 * Also pins the operational layer: the classifier env flags are visible on
 * /health (a silently-disabled deploy is the failure mode that produced the
 * 10 unflagged-external rows on 2026-06-12), and the remediation runbook
 * exists.
 */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const e2eSpec = read('web/e2e/orders-column-integrity.spec.js');
const health = read('src/routes/health.ts');
const envTs = read('src/lib/env.ts');
const scheduler = read('src/services/sync-scheduler.ts');

// ── The raw phrase is no longer any operator-facing resting badge ───────────
assert.ok(!rowDisplay.includes('>\n      Missing shipment sync') &&
  !/Missing shipment sync\s*<\/span>/.test(rowDisplay),
  'orders-row-display must not render the raw Missing shipment sync badge');
assert.ok(!/Missing shipment sync/.test(ordersView),
  'OrdersView must not surface the raw Missing shipment sync phrase');
assert.ok(rowDisplay.includes('Shipment sync error'),
  'the actionable Shipment sync error badge must exist');
assert.ok(rowDisplay.includes('export function renderShipmentSyncErrorBadge'),
  'the sync-error badge renderer must be the shared owner');
assert.ok(!rowDisplay.includes('renderMissingShipmentSyncBadge'),
  'the old badge renderer must stay deleted');

// The badge is ACTIONABLE: its tooltip routes the operator (sync → classifier
// → runbook), not a dead end.
assert.ok(/title="Shipment sync error:[^"]*Re-run ShipStation sync[^"]*runbook/.test(rowDisplay),
  'the sync-error badge tooltip must give the remediation path');

// ── PS-036 safety rule unchanged: external is a persisted flag, never an
// inference from absence ─────────────────────────────────────────────────────
// PS-166/PS-306/PS-258 (Wave 2): the three shipped display cells (Best Rate /
// Carrier / Shipping Account) moved VERBATIM from OrdersView into
// ./orders/cells/order-cells; the external-before-sync precedence invariant
// follows the code to its new home (renderTableCell stays a thin dispatcher).
const orderCells = read('web/src/components/Views/orders/cells/order-cells.tsx');
assert.ok(/getIsExternallyFulfilled\(displayOrder\)/.test(orderCells),
  'external rendering must come from the canonical persisted-flag predicate');
assert.ok(/getIsMissingShipmentSync\(displayOrder\)/.test(orderCells),
  'sync-gap rendering must come from the canonical predicate');
const badgeDecisions = orderCells.split('renderShipmentSyncErrorBadge()').length - 1;
assert.equal(badgeDecisions, 3,
  `all three shipped columns route through the shared renderer (found ${badgeDecisions})`);
// External always checked BEFORE the sync-error fallback at every site (the
// carrier column uses its column-specific shouldShowCarrierExtLabel wrapper
// around the same persisted-flag truth).
const decisionPattern = /(?:getIsExternallyFulfilled|shouldShowCarrierExtLabel)\(displayOrder\)\) \{\s*return renderExtLabelBadge\(\)\s*\}\s*if \(getIsMissingShipmentSync\(displayOrder\)\) \{\s*return renderShipmentSyncErrorBadge\(\)/g;
assert.equal((orderCells.match(decisionPattern) ?? []).length, 3,
  'external-flag check must precede the sync-error fallback in all three columns');

// ── E2E coverage renders each state distinctly ──────────────────────────────
assert.ok(e2eSpec.includes('Shipment sync error') && !e2eSpec.includes('Missing shipment sync'),
  'the orders column-integrity E2E must assert the new badge text');
assert.ok(/contains: 'Shipment sync error', notContains: 'Ext\. Label'/.test(e2eSpec),
  'E2E must still prove a no-flag/no-data row is NOT shown as Ext. Label');

// ── Operational visibility: flags on /health, runbook exists ────────────────
assert.ok(health.includes('externalShippedClassifier') &&
  health.includes('ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER') &&
  health.includes('ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY'),
  '/health must expose the classifier env-flag state');
assert.ok(envTs.includes('ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER') &&
  envTs.includes('ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY'),
  'the classifier env flags must stay defined');
assert.ok(scheduler.includes('external-shipped classifier disabled'),
  'the scheduler must keep logging when the classifier is disabled');
assert.ok(existsSync('docs/runbooks/ps-215-external-shipped-remediation.md'),
  'the PS-215 remediation runbook must exist');
const runbook = read('docs/runbooks/ps-215-external-shipped-remediation.md');
assert.ok(runbook.includes('certify:external-shipped') && runbook.includes('/health/deep'),
  'the runbook must cover the dry-run command and the health check');

console.log('PASS ps-215 shipped display state guard');
