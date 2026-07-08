/**
 * PS-194 guard — Confirm-Printed gating is backend truth that survives a
 * page refresh.
 *
 * Pre-PS-194: the merge job computed successfulEntryIds (the entries that
 * ACTUALLY merged into the batch PDF) and discarded them after the count; the
 * FE gated "Confirm Printed" on a session-only useState Set seeded from the
 * REQUESTED entry ids. A refresh wiped the Set (everything looked
 * unconfirmable), and a mid-merge failure still marked the failed entry
 * print-ready in-session.
 *
 * Now: the job + durable snapshot persist successfulEntryIds; the status DTO
 * and GET /print-queue/print/last expose them; the FE seeds its gate from the
 * DTO fields (merge-done + refresh re-seed) — never from the requested ids.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const svc = read('src/services/print-queue.ts');
const route = read('src/routes/print-queue.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const pkg = read('package.json');

// ── Backend: job record + durable snapshot persist the ids ─────────────────
assert.ok(/export type MergeJob = \{[\s\S]{0,900}successfulEntryIds: string\[\];/.test(svc),
  'MergeJob must carry successfulEntryIds');
assert.ok(/job\.successfulEntryIds = successfulEntryIds/.test(svc),
  'runMergeJob must stamp the live array onto the job (progress + done persists serialize it)');
// PS-403 (9d12ad47) raised the durable-snapshot id cap 500 -> 5000 to cover chunked
// batches; still the job-level toMergeSnapshot persist (the chunk-level slice uses chunk.).
assert.ok(/successfulEntryIds: \(job\.successfulEntryIds \?\? \[\]\)\.slice\(0, 5000\)/.test(svc),
  'toMergeSnapshot must persist the ids into the durable snapshot');
assert.ok(/successfulEntryIds\?: string\[\];/.test(svc),
  'MergeJobSnapshot keeps the field optional for pre-PS-194 snapshots');

// ── Routes: DTOs expose the ids ─────────────────────────────────────────────
const statusOccurrences = route.split('successful_entry_ids').length - 1;
assert.ok(statusOccurrences >= 3,
  `status DTO (both branches) + /print/last must expose successful_entry_ids (found ${statusOccurrences})`);
assert.ok(route.includes("app.get('/print/last'"),
  'GET /print-queue/print/last must exist for refresh re-seeding');
const lastRouteBlock = route.slice(route.indexOf("app.get('/print/last'"), route.indexOf("app.get('/print/last'") + 1200);
assert.ok(lastRouteBlock.includes('canViewMergeSnapshot'),
  '/print/last must scope-check the snapshot before returning it');

// ── FE: the gate is DTO-fed, not session-seeded ─────────────────────────────
assert.ok(!/entryIds\.forEach\(\(entryId\) => next\.add\(entryId\)\)/.test(ordersView),
  'the print-ready set must never be seeded from the REQUESTED entry ids');
assert.ok(/status\.successful_entry_ids/.test(ordersView),
  'merge-done seeding must read the backend successful_entry_ids DTO field');
assert.ok(/mergedEntryIds\.forEach\(\(entryId\) => next\.add\(entryId\)\)/.test(ordersView),
  'the pdfOpened seeding must use the backend-merged ids');
assert.ok(/fetchQueuePrintLastJob/.test(ordersView),
  'OrdersView must re-seed the gate from the last merge job on load (refresh survival)');
assert.ok(/job\.successful_entry_ids/.test(ordersView),
  'the refresh re-seed must read the DTO field');
assert.ok(apiClient.includes("'/print-queue/print/last'"),
  'v2-apiClient must expose fetchQueuePrintLastJob');

// The gate itself still derives from the (now DTO-fed) ready set.
assert.ok(/queueConfirmPrintedReady = queueCount > 0 && queuedEntryIds\.every\(\(entryId\) => queuePrintReadyEntryIds\.has\(entryId\)\)/.test(ordersView),
  'Confirm-Printed gate must require every queued entry to be print-ready');

// npm wiring.
assert.ok(pkg.includes('"test:ps-194-confirm-printed-persistence"'),
  'guard must be wired into package.json');

console.log('PASS ps-194 confirm-printed persistence guard');
