// Batch-print pipeline (docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md):
// bounded prefetch pool for merge-job label PDFs. Pure fetch mechanics — the caller
// (runMergeJob) keeps ownership of ordering, grouping, headers, and every error branch.
// concurrency 1 = at most one fetch in flight, walked in the caller's order (today's
// serial behavior on the wire). Errors are MATERIALIZED results, never rejections, so
// the assembly loop's branch structure stays intact.

export type PrefetchResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network'; message: string };

export type LabelPrefetchItem = { id: string; url: string };

export function startLabelPrefetch(
  items: LabelPrefetchItem[],
  opts: { concurrency: number; timeoutMs: number; fetchImpl?: typeof fetch },
): (id: string) => Promise<PrefetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, Math.min(8, Math.floor(opts.concurrency || 1)));
  const results = new Map<string, Promise<PrefetchResult>>();
  const resolvers = new Map<string, (result: PrefetchResult) => void>();
  for (const item of items) {
    results.set(item.id, new Promise<PrefetchResult>((resolve) => resolvers.set(item.id, resolve)));
  }

  const fetchOne = async (item: LabelPrefetchItem): Promise<PrefetchResult> => {
    try {
      const res = await fetchImpl(item.url, {
        headers: { Accept: 'application/pdf' },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) return { ok: false, kind: 'http', status: res.status };
      return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch (err) {
      return { ok: false, kind: 'network', message: err instanceof Error ? err.message : String(err) };
    }
  };

  let nextIndex = 0;
  let active = 0;
  const pump = () => {
    while (active < concurrency && nextIndex < items.length) {
      const item = items[nextIndex]!;
      nextIndex += 1;
      active += 1;
      void fetchOne(item).then((result) => {
        resolvers.get(item.id)?.(result);
        active -= 1;
        pump();
      });
    }
  };
  pump();

  return (id: string) =>
    results.get(id) ??
    Promise.resolve<PrefetchResult>({ ok: false, kind: 'network', message: 'Label was not scheduled for prefetch' });
}
