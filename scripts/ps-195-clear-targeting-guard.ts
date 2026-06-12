/**
 * PS-195 guard — print-queue clears are explicitly targeted and never touch
 * in-flight merges.
 *
 * Pre-PS-195, POST /print-queue/clear deleted EVERY queued entry for the
 * client with no per-entry targeting — a stale UI could wipe a queue it was
 * not looking at, including entries mid-merge in someone else's print job.
 *
 * Delta vs the card: there is no deletable "jobs" store (merge jobs live
 * in-memory + a single durable last-run snapshot), so the card's
 * jobIds/successfulEntryIds gate maps onto the REAL clear surface as:
 *   - the endpoint requires explicit queue_entry_ids (schema-rejected
 *     without them; no blanket clear-all),
 *   - the service deletes only the named ids, status='queued', within
 *     client/scope,
 *   - entries inside a PENDING/RUNNING merge job (the PS-194 job record now
 *     carries its entryIds) are refused and reported (blocked_in_flight).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const route = read('src/routes/print-queue.ts');
const svc = read('src/services/print-queue.ts');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const drawer = read('web/src/components/Views/OrdersPrintQueueDrawer.tsx');
const pkg = read('package.json');

// ── Endpoint: explicit ids are REQUIRED ─────────────────────────────────────
const clearRouteStart = route.indexOf("'/clear'");
assert.ok(clearRouteStart > 0, '/clear route must exist');
const clearRoute = route.slice(clearRouteStart, clearRouteStart + 1600);
assert.ok(/queue_entry_ids: z\.array\(z\.string\(\)\.min\(1\)\)\.min\(1\)/.test(clearRoute),
  'the clear schema must require at least one explicit entry id');
assert.ok(clearRoute.includes("confirmation: z.literal('REMOVE_UNPRINTED_LABELS')"),
  'the typed confirmation literal stays required');
assert.ok(clearRoute.includes('entryIds: body.queue_entry_ids'),
  'the route must pass the explicit ids to the service');
assert.ok(clearRoute.includes('blocked_in_flight'),
  'the response must report entries refused for being mid-merge');

// ── Service: bounded deletion + in-flight refusal ───────────────────────────
assert.ok(/export async function clearQueue\(input: \{\s*entryIds: string\[\];/.test(svc),
  'clearQueue must take explicit entry ids');
const clearFnStart = svc.indexOf('export async function clearQueue');
const clearFn = svc.slice(clearFnStart, svc.indexOf('export async function', clearFnStart + 10));
assert.ok(clearFn.includes('inArray(printQueue.id, clearable)'),
  'deletion must be bounded to the named ids');
assert.ok(clearFn.includes("eq(printQueue.status, 'queued')"),
  'deletion stays bounded to queued entries (printed/delivered untouchable)');
assert.ok(clearFn.includes('printQueueScopePredicate'),
  'client/store scope stays enforced on clears');
assert.ok(clearFn.includes('inFlightMergeEntryIds()'),
  'clears must consult the in-flight merge set');
assert.ok(/if \(!input\.entryIds\.length\) return \{ cleared: 0, blockedInFlight: 0 \}/.test(clearFn),
  'an empty id list clears NOTHING (no blanket fallback)');
// The in-flight set derives from live merge jobs.
assert.ok(/function inFlightMergeEntryIds\(\)[\s\S]{0,400}job\.status !== 'pending' && job\.status !== 'running'/.test(svc),
  'in-flight protection must cover pending and running merge jobs');
assert.ok(/entryIds: string\[\];\s*createdAt: number;/.test(svc),
  'MergeJob must carry its entryIds (the PS-195 in-flight source)');
assert.ok(svc.includes('entryIds: entries.map((entry) => entry.id)'),
  'merge jobs must record their entry ids at start');

// ── FE: every clear names exactly what it removes ───────────────────────────
assert.ok(/clearQueue\(clientId: number, entryIds: string\[\]\)/.test(apiClient),
  'apiClient.clearQueue must take explicit entry ids');
assert.ok(apiClient.includes('queue_entry_ids: entryIds'),
  'apiClient must send the ids');
assert.ok(drawer.includes('queuedEntries.map((entry) => entry.queue_entry_id)') &&
  /clearQueue\(queueClientId, queuedEntries\.map/.test(drawer),
  'the drawer Clear must pass the listed entry ids — no blanket clear');
assert.ok(drawer.includes('blocked_in_flight'),
  'the drawer must surface the in-flight refusal count');

// npm wiring.
assert.ok(pkg.includes('"test:ps-195-clear-targeting"'),
  'guard must be wired into package.json');

console.log('PASS ps-195 clear targeting guard');
