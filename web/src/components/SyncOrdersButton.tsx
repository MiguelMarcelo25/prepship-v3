import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

type SyncResult = {
  synced: number;
  pages: number;
  lastSyncedAt: string;
  sinceIso: string;
};

export default function SyncOrdersButton() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.post<SyncResult>('/sync/orders', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders-count'] });
    },
  });

  useEffect(() => {
    if (mutation.isSuccess || mutation.isError) {
      const t = setTimeout(() => mutation.reset(), 4000);
      return () => clearTimeout(t);
    }
    return;
  }, [mutation.isSuccess, mutation.isError, mutation]);

  let icon = (
    <RefreshCw
      size={12}
      className={mutation.isPending ? 'animate-spin' : ''}
    />
  );
  let label: string;
  let tone = 'text-ink-2';

  if (mutation.isPending) {
    label = 'Syncing…';
  } else if (mutation.isSuccess) {
    label = `Synced ${mutation.data?.synced ?? 0}`;
    icon = <Check size={12} className="text-ok" />;
    tone = 'text-ok-dark';
  } else if (mutation.isError) {
    label = 'Sync failed';
    icon = <AlertCircle size={12} className="text-danger" />;
    tone = 'text-danger';
  } else {
    label = 'Sync orders';
  }

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      title={
        mutation.isError ? (mutation.error as Error).message : undefined
      }
      className={`w-full flex items-center justify-center gap-1.5 px-2.5 py-[7px] rounded-btn border border-line-2 bg-white ${tone} hover:bg-surface-2 hover:text-ink text-[12px] font-semibold transition-colors disabled:opacity-50`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
