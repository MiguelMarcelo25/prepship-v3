import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Columns3,
  Printer,
  RefreshCw,
  Tags,
  ZoomIn,
} from 'lucide-react';
import { api } from '../lib/api';
import ColumnsPopover, { type ColumnDef } from './ColumnsPopover';

type SyncStatus = { lastSyncedAt: string | null; orderCount: number };

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
}: {
  onOpenQueue: () => void;
  columns: ColumnDef[];
  visibleColumns: Set<string>;
  onToggleColumn: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [zoom, setZoom] = useState<number>(() => loadZoom());
  const [columnsOpen, setColumnsOpen] = useState(false);

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
