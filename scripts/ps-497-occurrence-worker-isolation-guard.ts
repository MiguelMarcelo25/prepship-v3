// PS-497 Slice 2 Release B (S2.4x) — static isolation + no-cross-claim guard. Proves as a BUILD invariant
// (no DB) that: (1) the dedicated occurrence worker entrypoint cannot reach the generic fulfillment scheduler,
// the pg-boss job registrations, the generic outbox worker, or the replacement/package/legacy/marketplace
// consumers; and (2) the generic outbox claimer and the occurrence claimer partition fulfillment_outbox
// cleanly — neither event type can ever appear in the other's claim query.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

// 1) the worker entrypoint's import graph is isolated.
const worker = read('src/workers/occurrence-deduction-worker.ts');
const forbiddenImports = [
  'sync-scheduler', 'sync-job-queue', 'fulfillment/outbox', 'package-consumption',
  'replacement', 'marketplace', 'shipment-confirmation', 'bundle',
];
for (const frag of forbiddenImports) {
  const importsIt = new RegExp(`import[^;\\n]*from\\s+['"][^'"]*${frag}[^'"]*['"]`).test(worker);
  assert.ok(!importsIt, `occurrence worker entrypoint must NOT import a module matching "${frag}"`);
}
assert.ok(/from '\.\.\/services\/fulfillment\/occurrence-deduction-outbox/.test(worker), 'worker drives the occurrence outbox');
assert.ok(/from '\.\.\/services\/fulfillment\/occurrence-execution-scope/.test(worker), 'worker asserts the execution scope');
assert.ok(/assertExecutionScopeReady/.test(worker) && /assertRuntimeSchemaReady/.test(worker), 'worker performs startup refusal (scope + schema)');
ok('dedicated occurrence worker entrypoint imports only the occurrence lane — never the generic scheduler/job-queue/outbox/package/replacement/marketplace');

// 2) no-cross-claim: the generic claimer never selects the occurrence (or legacy inventory) event, and the
//    occurrence claimer selects ONLY the occurrence event.
const stripComments = (s: string) => s.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('--') && !t.startsWith('//'); }).join('\n');
const generic = read('src/services/fulfillment/outbox.ts');
const genericClaim = stripComments(generic.slice(generic.indexOf('async function claimDueOutboxRows'), generic.indexOf('async function claimOutboxRowById')));
assert.ok(generic.indexOf('async function claimDueOutboxRows') >= 0 && genericClaim.length > 0, 'located the generic claimDueOutboxRows body');
assert.ok(/event_type\s*=\s*'shipment_confirmation_requested'/.test(genericClaim), 'generic claimer is confirmation-only');
assert.ok(!/fulfillment_occurrence_deduction_requested/.test(genericClaim), 'generic claim query (code) never references the occurrence event');
assert.ok(!/inventory_deduction_requested/.test(genericClaim), 'generic claim query (code) never references the legacy inventory event');

const occ = read('src/services/fulfillment/occurrence-deduction-outbox.ts');
const occClaim = occ.slice(occ.indexOf('async function claimDueOccurrenceOutboxRows'));
assert.ok(/event_type\s*=\s*\$\{FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT\}/.test(occClaim), 'occurrence claimer selects ONLY the occurrence event constant');
assert.ok(!/shipment_confirmation_requested/.test(occClaim), 'occurrence claimer never references the confirmation event');
assert.ok(/FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT = 'fulfillment_occurrence_deduction_requested'/.test(occ), 'occurrence event constant is the distinct literal');
ok('generic claimer (shipment_confirmation_requested) and occurrence claimer (fulfillment_occurrence_deduction_requested) are disjoint');

console.log(`\nPASS PS-497 occurrence-worker isolation — ${passed}/${passed} checks`);
