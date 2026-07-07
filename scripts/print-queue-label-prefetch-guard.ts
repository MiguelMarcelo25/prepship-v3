/**
 * Guard: print-queue label prefetch pool (batch-print pipeline design).
 *
 * Behavioral: pool cap respected; results keyed per id regardless of completion
 * order; http/network mapping; unknown id → materialized network error.
 * Real-runtime smoke (exceljs lesson — no fake-object-only guards on library
 * boundaries): real node:http server + real global fetch + real pdf-lib load
 * of the returned bytes, including a 404 and a timeout.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startLabelPrefetch } from '../src/services/print-queue-label-prefetch';

const MINIMAL_PDF = Buffer.from(
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+Cg==',
  'base64',
);

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}:`, err instanceof Error ? err.message : err);
  }
}

async function main() {
  await check('pool cap: never more than `concurrency` fetches in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fakeFetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, url: `http://x/${i}` }));
    const prefetch = startLabelPrefetch(items, { concurrency: 3, timeoutMs: 1000, fetchImpl: fakeFetch });
    const results = await Promise.all(items.map((item) => prefetch(item.id)));
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);
  });

  await check('results keyed per id regardless of completion order', async () => {
    const delays = new Map([['a', 60], ['b', 5]]);
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const key = String(input).slice(-1);
      await new Promise((resolve) => setTimeout(resolve, delays.get(key) ?? 0));
      return new Response(new TextEncoder().encode(key), { status: 200 });
    }) as unknown as typeof fetch;
    const prefetch = startLabelPrefetch(
      [{ id: 'a', url: 'http://x/a' }, { id: 'b', url: 'http://x/b' }],
      { concurrency: 2, timeoutMs: 1000, fetchImpl: fakeFetch },
    );
    const [ra, rb] = await Promise.all([prefetch('a'), prefetch('b')]);
    assert.ok(ra.ok && new TextDecoder().decode(ra.bytes) === 'a');
    assert.ok(rb.ok && new TextDecoder().decode(rb.bytes) === 'b');
  });

  await check('unknown id → materialized network error (never a rejection)', async () => {
    const prefetch = startLabelPrefetch([], { concurrency: 1, timeoutMs: 100 });
    const result = await prefetch('nope');
    assert.ok(!result.ok && result.kind === 'network');
  });

  await check('real-runtime smoke: http server + real fetch + real pdf-lib', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/ok.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(MINIMAL_PDF);
        return;
      }
      if (req.url === '/missing.pdf') {
        res.writeHead(404);
        res.end();
        return;
      }
      // /slow.pdf: never respond — exercises AbortSignal.timeout.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    try {
      const prefetch = startLabelPrefetch(
        [
          { id: 'ok', url: `${base}/ok.pdf` },
          { id: 'missing', url: `${base}/missing.pdf` },
          { id: 'slow', url: `${base}/slow.pdf` },
        ],
        { concurrency: 3, timeoutMs: 500 },
      );
      const [ok, missing, slow] = await Promise.all([prefetch('ok'), prefetch('missing'), prefetch('slow')]);
      assert.ok(ok.ok, 'ok.pdf should fetch');
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(ok.ok ? ok.bytes : new Uint8Array());
      assert.equal(doc.getPageCount(), 1);
      assert.ok(!missing.ok && missing.kind === 'http' && missing.status === 404, 'missing.pdf should map to http 404');
      assert.ok(!slow.ok && slow.kind === 'network', 'slow.pdf should time out as a network result');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll print-queue-label-prefetch checks passed.');
}

void main();
