import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Columns3,
  DollarSign,
  Printer,
  RefreshCw,
  Rows3,
  Tags,
  ZoomIn,
} from 'lucide-react';
import { api } from '../lib/api';
import ColumnsPopover, { type ColumnDef } from './ColumnsPopover';

type SyncStatus = { lastSyncedAt: string | null; orderCount: number };
type BackfillJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  failureSamples?: string[];
};

const ZOOM_LEVELS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
const ZOOM_KEY = 'prepship_zoom';

function applyZoom(level: number) {
  const root = document.documentElement;
  root.style.setProperty('font-size', `${Math.round(level * 100)}%`);
  localStorage.setItem(ZOOM_KEY, String(level));
}

function loadZoom(): number {
  const v = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function timeAgo(iso: string | null) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function OrdersTopbarActions({
  onOpenQueue,
  columns,
  visibleColumns,
  onToggleColumn,
  density,
  onCycleDensity,
}: {
  onOpenQueue: () => void;
  columns: ColumnDef[];
  visibleColumns: Set<string>;
  onToggleColumn: (id: string) => void;
  density: string;
  onCycleDensity: () => void;
}) {
  const queryClient = useQueryClient();
  const [zoom, setZoom] = useState<number>(() => loadZoom());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [backfillJobId, setBackfillJobId] = useState<string | null>(null);

  const backfillStatus = useQuery({
    queryKey: ['backfill-best', backfillJobId],
    queryFn: () =>
      api.get<BackfillJob>(`/rates/backfill-best/status/${backfillJobId}`),
    enabled: backfillJobId !== null,
    refetchInterval: (q) => {
      const d = q.state.data as BackfillJob | undefined;
      if (!d) return 2000;
      return d.status === 'done' || d.status === 'error' ? false : 2000;
    },
  });

  const backfill = useMutation({
    mutationFn: () =>
      api.post<{ job_id: string; status: string }>('/rates/backfill-best', {}),
    onSuccess: (r) => setBackfillJobId(r.job_id),
    onError: (err) => alert(`Backfill failed: ${(err as Error).message}`),
  });

  useEffect(() => {
    if (!backfillStatus.data) return;
    // Refresh the orders list as new best rates come in, not just at the end.
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  }, [backfillStatus.data?.processed, backfillStatus.data?.status, queryClient]);

  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);

  const status = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api.get<SyncStatus>('/sync/status'),
    refetchInterval: 30_000,
  });

  const sync = useMutation({
    mutationFn: (full: boolean) =>
      api.post<{ synced: number; pages: number }>(
        '/sync/orders',
        full ? { fullResync: true } : {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders-count'] });
      queryClient.invalidateQueries({ queryKey: ['sync-status'] });
      queryClient.invalidateQueries({ queryKey: ['clients-order-stats'] });
    },
    onError: (err) => alert(`Sync failed: ${(err as Error).message}`),
  });

  const cycleZoom = () => {
    const idx = ZOOM_LEVELS.indexOf(zoom);
    const next = ZOOM_LEVELS[(idx + 1) % ZOOM_LEVELS.length]!;
    setZoom(next);
  };

  const lastSyncStr = timeAgo(status.data?.lastSyncedAt ?? null);

  return (
    <>
      <div
        className={`inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full text-tiny font-semibold border ${
          sync.isPending
            ? 'bg-warn-bg text-[#92400e] border-warn-border'
            : 'bg-surface-2 text-ink-3 border-line'
        }`}
        title={status.data?.lastSyncedAt ?? 'Never synced'}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            sync.isPending ? 'bg-warn animate-pulse' : 'bg-ok'
          }`}
        />
        <span>Last sync {lastSyncStr}</span>
      </div>

      <button
        type="button"
        onClick={() => sync.mutate(false)}
        disabled={sync.isPending}
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold disabled:opacity-50"
        title="Incremental sync"
      >
        <RefreshCw size={12} className={sync.isPending ? 'animate-spin' : ''} />
      </button>

      <button
        type="button"
        onClick={() => {
          if (
            confirm(
              'Full resync re-pulls 30 days of orders from ShipStation. Continue?'
            )
          ) {
            sync.mutate(true);
          }
        }}
        disabled={sync.isPending}
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold disabled:opacity-50"
      >
        Full
        <RefreshCw size={11} />
      </button>

      <button
        type="button"
        onClick={() => backfill.mutate()}
        disabled={
          backfill.isPending ||
          backfillStatus.data?.status === 'running' ||
          backfillStatus.data?.status === 'pending'
        }
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold disabled:opacity-50"
        title={
          backfillStatus.data
            ? `${backfillStatus.data.message}\n${backfillStatus.data.updated} updated · ${backfillStatus.data.skipped} skipped · ${backfillStatus.data.failed} failed${
                backfillStatus.data.failureSamples?.length
                  ? '\n\nFailures:\n' +
                    backfillStatus.data.failureSamples.join('\n')
                  : ''
              }`
            : 'Fetch cheapest rate for every awaiting order'
        }
      >
        <DollarSign size={12} />
        {backfillStatus.data?.status === 'running' ||
        backfillStatus.data?.status === 'pending'
          ? `${backfillStatus.data.processed}/${backfillStatus.data.total}`
          : 'Best rates'}
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => setColumnsOpen((v) => !v)}
          className={`inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 ${
            columnsOpen ? 'bg-surface-2' : 'bg-white'
          } text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold`}
        >
          <Columns3 size={12} />
          Columns
        </button>
        {columnsOpen && (
          <ColumnsPopover
            columns={columns}
            visible={visibleColumns}
            onToggle={onToggleColumn}
            onClose={() => setColumnsOpen(false)}
          />
        )}
      </div>

      <button
        type="button"
        onClick={onOpenQueue}
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold"
      >
        <Tags size={12} />
        Labels
      </button>

      <button
        type="button"
        onClick={onOpenQueue}
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold"
      >
        <Printer size={12} />
        Print Queue
      </button>

      <button
        type="button"
        onClick={onCycleDensity}
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold font-mono w-[64px] justify-center"
        title="Cycle row density"
      >
        <Rows3 size={12} />
        {density}
      </button>

      <button
        type="button"
        onClick={cycleZoom}
        className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold font-mono w-[78px] justify-center"
        title="Cycle zoom"
      >
        <ZoomIn size={12} />
        {Math.round(zoom * 100)}%
      </button>
    </>
  );
}
