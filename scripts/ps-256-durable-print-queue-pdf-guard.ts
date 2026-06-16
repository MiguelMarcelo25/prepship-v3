/**
 * PS-256 (durable runtime state) guard — RESTART-SAFE PRINT-QUEUE MERGED PDF.
 *
 * The merged batch-label PDF lives only in process memory (MergeJob.mergedPdfBase64); the durable
 * MergeJobSnapshot is metadata-only, so a restart 404s the view/download/signed-url routes. This
 * slice persists the immutable PDF bytes to a durable print_queue_merged_pdfs side-store and
 * rehydrates them on an in-memory miss. ENV-GATED, default OFF (DURABLE_PRINT_QUEUE_PDF); the OFF
 * path is a TRUE no-op — no DB, no schema ensure.
 *
 * BEHAVIORAL: with the flag OFF, persistMergedPdf resolves (no throw) WITHOUT touching the DB, and
 * getMergedPdfBase64 returns null. We point DATABASE_URL at a bogus host first, so if the OFF path
 * wrongly issued a query it would error/hang — a clean resolve + null proves the no-op without a
 * live DB.
 * STATIC: the store runtime-ensures the table (additive, 500-safe) + RLS + env gate + best-effort
 * try/catch; print-queue.ts persists after merge completion AND rehydrates via getMergedPdfBase64
 * on a miss + cites the override; env.ts declares the flag default OFF. LOCKDOWN: no
 * UPDATE/DELETE on orders/shipments was introduced by this slice.
 *
 *   npx tsx scripts/ps-256-durable-print-queue-pdf-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: flag OFF => true no-op (no DB), persist resolves + get returns null ─────────────
// Force the flag off and make any accidental DB use fail loudly before importing the module.
process.env.DURABLE_PRINT_QUEUE_PDF = 'false';
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/ps256_pdf_guard_should_not_connect';

const mod = await import('../src/services/print-queue-pdf-store.js');

check('flag defaults OFF (durablePrintQueuePdfEnabled() === false)',
  mod.durablePrintQueuePdfEnabled() === false);

let persistThrew = false;
const persistStart = Date.now();
try {
  await mod.persistMergedPdf('ps256-guard-job', 'batch.pdf', Buffer.from('%PDF-1.4 guard').toString('base64'));
} catch {
  persistThrew = true;
}
check('persistMergedPdf resolves without throwing when OFF', !persistThrew);
check('persistMergedPdf is a fast no-op when OFF (no DB connect)', Date.now() - persistStart < 500);

let getThrew = false;
let getResult: unknown = 'unset';
const getStart = Date.now();
try {
  getResult = await mod.getMergedPdfBase64('ps256-guard-job');
} catch {
  getThrew = true;
}
check('getMergedPdfBase64 resolves without throwing when OFF', !getThrew);
check('getMergedPdfBase64 returns null when OFF (no DB touched)', getResult === null);
check('getMergedPdfBase64 is a fast no-op when OFF (no DB connect)', Date.now() - getStart < 500);

let cleanupThrew = false;
try {
  await mod.cleanupOldMergedPdfs(60_000);
} catch {
  cleanupThrew = true;
}
check('cleanupOldMergedPdfs resolves without throwing when OFF (no-op)', !cleanupThrew);

// ── static: durable store — runtime DDL + RLS + env gate + best-effort + bytea ──────────────────
const store = readFileSync('src/services/print-queue-pdf-store.ts', 'utf8');
check('runtime-ensures print_queue_merged_pdfs (500-safe additive table)',
  /CREATE TABLE IF NOT EXISTS print_queue_merged_pdfs/.test(store) && /ensurePrintQueuePdfSchema/.test(store));
check('stores the PDF as bytea (binary, not bloated base64 text)',
  /pdf_bytes bytea/.test(store));
check('enables RLS on the additive table',
  /ALTER TABLE print_queue_merged_pdfs ENABLE ROW LEVEL SECURITY/.test(store));
check('env-gated via durablePrintQueuePdfEnabled() + DURABLE_PRINT_QUEUE_PDF',
  /durablePrintQueuePdfEnabled/.test(store) && /env\.DURABLE_PRINT_QUEUE_PDF/.test(store));
check('persistMergedPdf returns early (no-op) when the flag is OFF',
  /export async function persistMergedPdf[\s\S]*if \(!durablePrintQueuePdfEnabled\(\)\) return/.test(store));
check('getMergedPdfBase64 returns null when the flag is OFF',
  /export async function getMergedPdfBase64[\s\S]*if \(!durablePrintQueuePdfEnabled\(\)\) return null/.test(store));
check('persist UPSERTs (immutable PDF, ON CONFLICT (job_id) DO UPDATE)',
  /INSERT INTO print_queue_merged_pdfs[\s\S]*ON CONFLICT \(job_id\) DO UPDATE/.test(store));
check('persist is best-effort (try/catch, never throws into the merge hot path)',
  /try \{[\s\S]*INSERT INTO print_queue_merged_pdfs[\s\S]*\} catch/.test(store));
check('read is best-effort (try/catch, never throws into the serve hot path)',
  /try \{[\s\S]*SELECT pdf_bytes[\s\S]*\} catch/.test(store));
check('cleanupOldMergedPdfs deletes ONLY the new side-store table, flag-gated',
  /export async function cleanupOldMergedPdfs[\s\S]*if \(!durablePrintQueuePdfEnabled\(\)\) return[\s\S]*DELETE FROM print_queue_merged_pdfs WHERE created_at </.test(store));

// ── static: print-queue.ts persists after merge completion + rehydrates on miss ─────────────────
const svc = readFileSync('src/services/print-queue.ts', 'utf8');
check('print-queue imports the durable store helpers',
  /persistMergedPdf[\s\S]*getMergedPdfBase64[\s\S]*cleanupOldMergedPdfs[\s\S]*from '\.\/print-queue-pdf-store'/.test(svc));
check('persists the merged PDF after the job is marked done',
  /job\.status = 'done'[\s\S]*persistMergedPdf\(jobId, job\.fileName \?\? null, job\.mergedPdfBase64\)/.test(svc));
check('rehydrates via getMergedPdfBase64 on an in-memory miss (getMergeJobForServe)',
  /export async function getMergeJobForServe[\s\S]*getMergedPdfBase64\(jobId\)/.test(svc));
check('keeps the in-memory path as the fast default (returns inMemory when bytes present)',
  /if \(inMemory && inMemory\.status === 'done' && inMemory\.mergedPdfBase64\)[\s\S]*return inMemory/.test(svc));
check('wires cleanup into the existing cleanOldJobs path',
  /function cleanOldJobs\(\)[\s\S]*cleanupOldMergedPdfs\(DURABLE_PDF_RETENTION_MS\)/.test(svc));
check('durable PDF retention is longer than the 30-min in-memory job retention',
  /DURABLE_PDF_RETENTION_MS = 4 \* 60 \* 60 \* 1000/.test(svc));

// ── static: routes serve via the durable-aware accessor ─────────────────────────────────────────
const route = readFileSync('src/routes/print-queue.ts', 'utf8');
check('routes import getMergeJobForServe',
  /getMergeJobForServe/.test(route) && /from '\.\.\/services\/print-queue'/.test(route));
check('serveMergedPdf uses the durable-aware accessor',
  /async function serveMergedPdf[\s\S]*await getMergeJobForServe\(jobId\)/.test(route));

// ── static: override citation in the locked files ───────────────────────────────────────────────
check('print-queue.ts cites the unlock override for PS-256',
  /Per user override unlock shipped data on 2026-06-16/.test(svc));

// ── static: env.ts declares the flag (default OFF) ─────────────────────────────────────────────
const envSrc = readFileSync('src/lib/env.ts', 'utf8');
check('env.ts declares DURABLE_PRINT_QUEUE_PDF default OFF',
  /DURABLE_PRINT_QUEUE_PDF: booleanFlag\(false\)/.test(envSrc));

// ── LOCKDOWN: this slice introduces NO orders/shipments mutation ────────────────────────────────
const noOrderMutation = (src: string) =>
  !/UPDATE\s+orders\b/i.test(src) &&
  !/DELETE\s+FROM\s+orders\b/i.test(src) &&
  !/UPDATE\s+shipments\b/i.test(src) &&
  !/DELETE\s+FROM\s+shipments\b/i.test(src);
check('new store introduces NO UPDATE/DELETE on orders/shipments', noOrderMutation(store));
check('guard script introduces NO UPDATE/DELETE on orders/shipments', noOrderMutation(readFileSync('scripts/ps-256-durable-print-queue-pdf-guard.ts', 'utf8')));

// ── package.json wires the guard ────────────────────────────────────────────────────────────────
check('package.json wires test:ps-256-durable-print-queue-pdf',
  /test:ps-256-durable-print-queue-pdf/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-256 durable print-queue PDF guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-256 durable print-queue PDF guard');
