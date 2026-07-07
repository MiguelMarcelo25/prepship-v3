import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRINT_QUEUE_PDF_CHUNK_SIZE,
  planPrintQueuePdfChunks,
} from '../src/services/print-queue';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

check('PS-403 chunk size is bounded to a safe high-volume PDF size', () => {
  assert.equal(PRINT_QUEUE_PDF_CHUNK_SIZE, 50);
});

check('30 labels stay in one operator PDF chunk', () => {
  const chunks = planPrintQueuePdfChunks(Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.chunkNumber, 1);
  assert.equal(chunks[0]?.items.length, 30);
});

check('100 labels split into two bounded PDF chunks', () => {
  const chunks = planPrintQueuePdfChunks(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.items.length), [50, 50]);
  assert.deepEqual(chunks.map((chunk) => chunk.chunkNumber), [1, 2]);
});

check('1000 synthetic labels split into twenty restart-safe chunks', () => {
  const chunks = planPrintQueuePdfChunks(Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.equal(chunks.length, 20);
  assert.equal(chunks.at(-1)?.items.at(-1), 1000);
});

check('merge snapshots expose durable chunk metadata for status/UI', () => {
  const service = read('src/services/print-queue.ts');
  assert.match(service, /export type MergeJobChunk/);
  assert.match(service, /chunks: MergeJobChunk\[\]/);
  assert.match(service, /export type MergeJobChunkSnapshot/);
  assert.match(service, /chunks: MergeJobChunkSnapshot\[\]/);
  assert.match(service, /chunkNumber/);
  assert.match(service, /labelCount/);
  assert.match(service, /fileSize/);
  assert.match(service, /pdfUrl/);
});

check('durable PDF store has chunk artifact table and metadata helpers', () => {
  const store = read('src/services/print-queue-pdf-store.ts');
  assert.match(store, /print_queue_pdf_chunks/);
  assert.match(store, /chunk_number/);
  assert.match(store, /label_count/);
  assert.match(store, /file_size/);
  assert.match(store, /export async function persistMergedPdfChunk/);
  assert.match(store, /export async function getMergedPdfChunkBase64/);
});

check('routes expose signed chunk URLs and chunk view path', () => {
  const route = read('src/routes/print-queue.ts');
  assert.match(route, /\/print\/view\/:jobId\/chunks\/:chunkNumber/);
  assert.match(route, /chunks: buildSignedMergeChunkDtos/);
});

check('package wires PS-403 chunk proof guard', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  assert.equal(
    pkg.scripts?.['test:ps-403-print-queue-pdf-chunks'],
    'tsx scripts/ps-403-print-queue-pdf-chunks-guard.ts',
  );
});

console.log('PASS PS-403 print queue PDF chunk guard');
