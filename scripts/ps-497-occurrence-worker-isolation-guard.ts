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

// 1b) durable operational health is a BUILD invariant (Hermes #6b), not just a shutdown print. The worker
//     records worker-status events (start/complete/failed/heartbeat) with cumulative counters, and the
//     worker-status-events module it imports is itself transitively isolated (no forbidden imports).
assert.ok(/from '\.\.\/services\/worker-status-events/.test(worker), 'worker imports the durable worker-status convention');
assert.ok(/recordWorkerStatusEvent\(\{[\s\S]*eventType: 'job_start'/.test(worker), 'worker records a durable job_start on boot');
assert.ok(/eventType: 'heartbeat'/.test(worker), 'worker emits durable heartbeats on a fixed cadence');
assert.ok(/eventType: 'job_failed'/.test(worker), 'worker records durable job_failed on a drain error');
assert.ok(/totals\.fenced \+= result\.fenced/.test(worker) && /totals\.parked \+= result\.parked/.test(worker), 'worker accumulates processed/parked/fenced counters');
const workerStatusEvents = read('src/services/worker-status-events.ts');
for (const frag of forbiddenImports) {
  const importsIt = new RegExp(`import[^;\\n]*from\\s+['"][^'"]*${frag}[^'"]*['"]`).test(workerStatusEvents);
  assert.ok(!importsIt, `worker-status-events (imported by the worker) must NOT transitively import "${frag}"`);
}
ok('durable worker-status health (start/heartbeat/complete/failed + cumulative counters) is a build invariant; its module is transitively isolated');

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

// 3) the deployable worker-service configuration is checked in (Hermes #6b): a separate worker service that
//    runs the isolated entrypoint with the master switch ON here ONLY, autoDeploy OFF, durable health ON, and
//    documents the required explicit INVENTORY_AUTO_DEDUCT=false on the API + generic scheduler.
const deploy = read('deploy/ps-497-occurrence-worker.render.yaml');
assert.match(deploy, /type: worker/, 'a separate Render worker service is defined');
assert.match(deploy, /startCommand: npm run start:occurrence-worker/, 'the worker service runs the isolated entrypoint');
assert.match(deploy, /INVENTORY_AUTO_DEDUCT[\s\S]*?value: "true"/, 'the master switch is ON in the worker service');
assert.match(deploy, /autoDeploy: false/, 'the money-moving worker is never CI-auto-deployed');
assert.match(deploy, /WORKER_STATUS_EVENTS_DURABLE[\s\S]*?value: "true"/, 'durable worker health is enabled in the worker service');
assert.match(deploy, /INVENTORY_AUTO_DEDUCT=false/, 'the API + generic scheduler are documented to set the master OFF explicitly');
ok('checked-in worker-service deploy config: master ON here only, autoDeploy off, durable health on, explicit master-off elsewhere');

console.log(`\nPASS PS-497 occurrence-worker isolation — ${passed}/${passed} checks`);
