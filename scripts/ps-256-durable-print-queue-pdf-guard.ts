/**
 * PS-256 durable Print Queue PDF guard, superseded by PS-428 mandatory,
 * generation-fenced chunk storage. Offline/static only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const store = read('src/services/print-queue-pdf-store.ts');
const service = read('src/services/print-queue.ts');
const route = read('src/routes/print-queue.ts');
const baseMigration = read('drizzle/0062_runtime_schema_ownership.sql');
const fenceMigration = read('drizzle/0067_durable_worker_execution_fences.sql');

assert.match(baseMigration, /CREATE TABLE IF NOT EXISTS print_queue_merged_pdfs/);
assert.match(baseMigration, /CREATE TABLE IF NOT EXISTS print_queue_pdf_chunks/);
assert.match(baseMigration, /pdf_bytes bytea/);
assert.match(baseMigration, /ALTER TABLE print_queue_pdf_chunks ENABLE ROW LEVEL SECURITY/);
assert.match(fenceMigration, /ALTER TABLE print_queue_pdf_chunks[\s\S]*generation integer NOT NULL DEFAULT 0/);

assert.match(store, /durablePrintQueuePdfEnabled\(\): boolean \{\s*return true/);
assert.doesNotMatch(store, /if \(!durablePrintQueuePdfEnabled\(\)\)/);
assert.match(store, /export async function persistMergedPdfChunk/);
assert.match(store, /ON CONFLICT \(job_id, chunk_number\) DO UPDATE/);
assert.match(store, /WHERE print_queue_pdf_chunks\.generation <= \$\{input\.generation\}/);
assert.match(store, /export async function getMergedPdfChunkBase64/);
assert.match(store, /export async function getMergedPdfChunks/);

assert.match(service, /const durableChunk = await persistMergedPdfChunk/);
assert.match(service, /if \(!durableChunk\)/);
assert.match(service, /delete context\.chunk\.mergedPdfBase64/);
assert.match(service, /const storedChunks = await getMergedPdfChunks\(jobId\)/);
assert.match(service, /export async function getMergeJobForServe/);
assert.match(service, /getMergedPdfChunkBase64\(jobId, chunkNumber\)/);
assert.match(route, /async function serveMergedPdf[\s\S]*await getMergeJobForServe\(jobId\)/);

for (const source of [store, fenceMigration]) {
  assert.doesNotMatch(source, /(?:UPDATE|DELETE\s+FROM)\s+(?:orders|shipments)\b/i);
}

assert.match(read('package.json'), /test:ps-256-durable-print-queue-pdf/);
console.log('PASS PS-256 durable print-queue PDF guard (PS-428 mandatory chunks)');
