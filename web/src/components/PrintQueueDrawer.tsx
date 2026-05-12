import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Download,
  Printer,
  Trash2,
  X,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import { API_BASE } from '../lib/api-base';
import { apiClient } from '../lib/v2-apiClient';
import { supabase } from '../lib/supabase';
import { Button } from './ui/Button';

type QueueEntry = {
  queue_entry_id: string;
  order_id: string;
  order_number: string | null;
  client_id: number;
  label_url: string;
  primary_sku: string | null;
  item_description: string | null;
  order_qty: number;
  status: 'queued' | 'printed';
  queued_at: string;
};

type QueueResponse = {
  queuedOrders: QueueEntry[];
  totalOrders: number;
  totalQty: number;
};

type JobStatus = {
  job_id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress: number;
  total: number;
  current: number;
  message: string;
  file_name: string | null;
  error: string | null;
  label_errors: string[];
};

type ClientRow = { id: number; name: string };

async function downloadAuthedPdf(jobId: string, fileName: string) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  const res = await fetch(`${API_BASE}/print-queue/print/download/${jobId}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Download failed: ${msg}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function PrintQueueDrawer({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  // Active client is read from the current URL's `?clientId=` — v4's
  // sidebar navigation puts it there when the user drills into a client's
  // orders. Without a client in scope, the drawer shows an empty-state
  // prompt and disables all destructive actions (prevents cross-tenant
  // queue wipes and accidental fetches that leak queue data between
  // clients).
  const [searchParams] = useSearchParams();
  const rawClientId = searchParams.get('clientId');
  const clientId = (() => {
    if (!rawClientId) return null;
    const n = Number.parseInt(rawClientId, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [autoDownloaded, setAutoDownloaded] = useState<string | null>(null);
  const [mergeHeaders, setMergeHeaders] = useState(true);
  const [historyVisible, setHistoryVisible] = useState(false);

  // Reset any in-flight job state when the active client changes — an old
  // job id from a different client is meaningless here.
  useEffect(() => {
    setActiveJobId(null);
    setAutoDownloaded(null);
  }, [clientId]);

  // Resolve the client's name from the shared clients cache (same query
  // key Sidebar populates). No extra fetch if it's already warm.
  // 2026-05-12: explicit activeOnly=true matches the Sidebar query so
  // both share a cache entry — and never surface disabled clients.
  const clients = useQuery({
    queryKey: ['clients', 'active-only'],
    queryFn: () => api.get<ClientRow[]>('/clients?activeOnly=true'),
    staleTime: 60_000,
  });
  const clientName = useMemo(() => {
    if (clientId == null) return null;
    return (clients.data ?? []).find((c) => c.id === clientId)?.name ?? null;
  }, [clients.data, clientId]);

  const queue = useQuery<QueueResponse>({
    queryKey: ['print-queue', clientId, historyVisible],
    // apiClient.fetchQueue handles auth + query-string params + safe fallback.
    queryFn: () =>
      apiClient.fetchQueue(clientId as number, historyVisible) as Promise<QueueResponse>,
    // Only run once we know which client's queue to fetch.
    enabled: clientId !== null,
    refetchInterval: 5_000,
  });

  const job = useQuery({
    queryKey: ['print-queue-job', activeJobId],
    queryFn: () =>
      api.get<JobStatus>(`/print-queue/print/status/${activeJobId}`),
    enabled: activeJobId !== null,
    refetchInterval: (q) => {
      const data = q.state.data as JobStatus | undefined;
      if (!data) return 1000;
      if (data.status === 'done' || data.status === 'error') return false;
      return 1000;
    },
  });

  const startPrint = useMutation({
    mutationFn: async () => {
      if (clientId == null) throw new Error('No active client');
      const entryIds = (queue.data?.queuedOrders ?? []).map(
        (e) => e.queue_entry_id
      );
      // apiClient.startQueuePrintJob sends client_id + queue_entry_ids +
      // merge_headers (snake_case body per v4 Zod schema).
      return apiClient.startQueuePrintJob(clientId, entryIds, mergeHeaders) as Promise<{
        job_id: string;
        total: number;
      }>;
    },
    onSuccess: (r) => {
      if (r?.job_id) setActiveJobId(r.job_id);
    },
  });

  const removeEntry = useMutation({
    mutationFn: (id: string) => {
      if (clientId == null) return Promise.reject(new Error('No active client'));
      // Routes via the adapter so the Supabase auth header is attached
      // (raw fetch here was 401'ing in prod) and client_id-bound deletes
      // can't accidentally cross tenants.
      return apiClient.removeFromQueue(id, clientId);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['print-queue', clientId, historyVisible],
      }),
  });

  const clearAll = useMutation({
    mutationFn: () => {
      if (clientId == null) return Promise.reject(new Error('No active client'));
      // NEVER clear without a clientId — the backend treats the body as
      // optional and would wipe EVERY client's queue otherwise.
      return apiClient.clearQueue(clientId);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['print-queue', clientId, historyVisible],
      }),
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // When job finishes, refresh queue + auto-download the PDF.
  useEffect(() => {
    if (job.data?.status !== 'done' || !activeJobId || !job.data.file_name) return;
    queryClient.invalidateQueries({
      queryKey: ['print-queue', clientId, historyVisible],
    });
    if (autoDownloaded === activeJobId) return;
    setAutoDownloaded(activeJobId);
    downloadAuthedPdf(activeJobId, job.data.file_name).catch((err) => {
      alert(`Auto-download failed: ${(err as Error).message}`);
    });
  }, [job.data, activeJobId, autoDownloaded, queryClient, clientId, historyVisible]);

  const entries = queue.data?.queuedOrders ?? [];

  const canManualDownload = useMemo(
    () => job.data?.status === 'done' && !!activeJobId && !!job.data.file_name,
    [job.data, activeJobId]
  );

  const hasClient = clientId !== null;
  const jobInFlight =
    !!activeJobId &&
    (job.data?.status === 'pending' || job.data?.status === 'running');

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="flex-1 bg-black/35" onClick={onClose} />
      <aside className="w-drawer max-w-full bg-white shadow-drawer-l flex flex-col">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line bg-surface-2">
          <Printer size={14} className="text-brand" />
          <div className="text-[13px] font-bold text-ink flex-1">Print Queue</div>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </div>

        <div className="px-3.5 py-2.5 border-b border-line bg-white flex items-center gap-2">
          <div className="flex-1 text-[12px] text-ink-2 font-semibold truncate">
            {hasClient
              ? clientName ?? `Client #${clientId}`
              : 'No client selected'}
          </div>
          <label className="flex items-center gap-1 text-tiny text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={historyVisible}
              onChange={(e) => setHistoryVisible(e.target.checked)}
              className="accent-brand"
            />
            History
          </label>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => queue.refetch()}
            disabled={!hasClient || queue.isFetching}
            title="Refresh"
          >
            <RefreshCw
              size={12}
              className={queue.isFetching ? 'animate-spin' : ''}
            />
          </Button>
        </div>

        {/* Job status */}
        {activeJobId && job.data && (
          <div
            className={`px-3.5 py-2 border-b border-line text-tiny ${
              job.data.status === 'done'
                ? 'bg-ok-bg text-ok-dark'
                : job.data.status === 'error'
                  ? 'bg-danger-bg text-[#991b1b]'
                  : 'bg-warn-bg text-[#92400e]'
            }`}
          >
            <div className="flex items-center gap-2">
              {job.data.status === 'running' || job.data.status === 'pending' ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : null}
              <div className="flex-1">{job.data.message}</div>
              <div className="font-mono">{job.data.progress}%</div>
            </div>
            <div className="mt-1 h-1 bg-white/50 rounded">
              <div
                className="h-full bg-current rounded transition-all"
                style={{ width: `${job.data.progress}%` }}
              />
            </div>
            {canManualDownload && (
              <button
                type="button"
                onClick={() => {
                  if (activeJobId && job.data?.file_name) {
                    downloadAuthedPdf(activeJobId, job.data.file_name).catch(
                      (err) => alert(`Download failed: ${(err as Error).message}`)
                    );
                  }
                }}
                className="mt-2 inline-flex items-center gap-1 font-bold hover:underline"
              >
                <Download size={11} />
                Download {job.data?.file_name}
              </button>
            )}
            {job.data.label_errors?.length > 0 && (
              <details className="mt-2 cursor-pointer">
                <summary className="font-semibold">
                  {job.data.label_errors.length} label error
                  {job.data.label_errors.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-1 list-disc list-inside space-y-0.5">
                  {job.data.label_errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* Queue list */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-page">
          {!hasClient && (
            <div className="text-center text-ink-3 py-16 px-4">
              <div className="text-4xl mb-2">🧭</div>
              <div className="font-semibold text-ink-2">No client selected</div>
              <div className="text-tiny mt-1">
                Pick a client from the sidebar to view or print their queue.
              </div>
            </div>
          )}
          {hasClient && queue.isLoading && (
            <div className="text-center text-ink-3 py-10">Loading…</div>
          )}
          {hasClient && !queue.isLoading && entries.length === 0 && (
            <div className="text-center text-ink-3 py-16">
              <div className="text-4xl mb-2">🖨️</div>
              <div className="font-semibold text-ink-2">Queue is empty</div>
              <div className="text-tiny mt-1">
                Buy a label on an order, then click "Send to Queue".
              </div>
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.queue_entry_id}
              className="px-3.5 py-2.5 border-b border-line bg-white flex items-start gap-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm2 font-bold text-brand">
                  {e.order_number ?? `#${e.order_id}`}
                </div>
                <div className="text-tiny text-ink-2 truncate">
                  {e.primary_sku ?? '—'} · qty {e.order_qty}
                </div>
                {e.item_description && (
                  <div className="text-tiny text-ink-3 truncate">
                    {e.item_description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeEntry.mutate(e.queue_entry_id)}
                className="text-ink-3 hover:text-danger p-1"
                title="Remove from queue"
                disabled={removeEntry.isPending || !hasClient}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div className="px-3.5 py-2.5 border-t border-line bg-white flex flex-col gap-2">
          <label className="flex items-center gap-1.5 text-tiny text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={mergeHeaders}
              onChange={(e) => setMergeHeaders(e.target.checked)}
              className="accent-brand"
              disabled={!hasClient}
            />
            Merge header pages into combined PDF
          </label>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!hasClient) return;
                if (confirm(`Clear all ${entries.length} queued labels for ${clientName ?? `client #${clientId}`}?`)) {
                  clearAll.mutate();
                }
              }}
              disabled={!hasClient || !entries.length || clearAll.isPending}
            >
              <Trash2 size={11} />
              Clear
            </Button>
            <div className="flex-1 text-tiny text-ink-3">
              {hasClient ? `${entries.length} queued` : ''}
            </div>
            <Button
              variant="green"
              size="sm"
              onClick={() => startPrint.mutate()}
              disabled={
                !hasClient ||
                !entries.length ||
                startPrint.isPending ||
                jobInFlight
              }
            >
              <Printer size={11} />
              {startPrint.isPending
                ? 'Starting…'
                : hasClient
                  ? `Print ${entries.length}`
                  : 'Print'}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
