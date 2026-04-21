import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search as SearchIcon, X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { Skeleton } from './ui/Skeleton';

type Carrier = {
  carrier_id: string;
  carrier_code: string;
  carrier_nickname?: string;
  friendly_name?: string;
};

type CarriersResponse = { carriers: Carrier[] };

type Rate = {
  rate_id: string;
  carrier_id: string;
  carrier_code: string;
  service_type: string;
  service_code: string;
  shipping_amount: { amount: number; currency: string };
  delivery_days?: number | null;
  estimated_delivery_date?: string | null;
};

type BrowseResult = {
  rates: Rate[];
  bestRate: Rate | null;
  cached: boolean;
  cacheKey: string;
  fetchedAt: string;
};

type BrowseInput = {
  weightOz: number;
  toZip: string;
  toCountry?: string;
  toState?: string;
  toCity?: string;
  toAddress?: string;
  toName?: string;
  residential?: boolean;
  dimsL?: number;
  dimsW?: number;
  dimsH?: number;
  carrierId: string;
  forceRefresh?: boolean;
};

export default function RateBrowserModal({
  baseInput,
  onClose,
  onSelectRate,
}: {
  baseInput: Omit<BrowseInput, 'carrierId' | 'forceRefresh'>;
  onClose: () => void;
  onSelectRate: (rate: Rate) => void;
}) {
  const [carrierId, setCarrierId] = useState<string>('');

  const carriers = useQuery({
    queryKey: ['rates-carriers'],
    queryFn: () => api.get<CarriersResponse>('/rates/carriers'),
    staleTime: 5 * 60_000,
  });

  const browse = useMutation({
    mutationFn: (forceRefresh: boolean) =>
      api.post<BrowseResult>('/rates/browse', {
        ...baseInput,
        carrierId,
        forceRefresh,
      }),
  });

  const sortedRates = useMemo(
    () =>
      (browse.data?.rates ?? [])
        .slice()
        .sort((a, b) => a.shipping_amount.amount - b.shipping_amount.amount),
    [browse.data]
  );

  const onPick = (carrier: string) => {
    setCarrierId(carrier);
    if (carrier) {
      browse.reset();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-white w-[640px] max-w-[95vw] max-h-[85vh] rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <SearchIcon size={14} className="text-brand" />
          <div className="flex-1 text-sm2 font-bold text-ink">Browse rates</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-3 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-line flex items-center gap-3">
          <span className="text-tiny text-ink-2 font-semibold">Carrier:</span>
          <div className="flex-1">
            <Select
              value={carrierId}
              onChange={(e) => onPick(e.target.value)}
              disabled={carriers.isLoading}
            >
              <option value="">— select a carrier —</option>
              {(carriers.data?.carriers ?? []).map((c) => (
                <option key={c.carrier_id} value={c.carrier_id}>
                  {c.friendly_name ??
                    c.carrier_nickname ??
                    c.carrier_code.toUpperCase()}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={!carrierId || browse.isPending}
            onClick={() => browse.mutate(false)}
          >
            {browse.isPending ? 'Fetching…' : 'Fetch rates'}
          </Button>
          {browse.data && (
            <Button
              variant="outline"
              size="sm"
              disabled={browse.isPending}
              onClick={() => browse.mutate(true)}
              title="Bypass cache"
            >
              Refresh
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!carrierId && (
            <div className="px-4 py-12 text-center text-ink-3 text-sm2">
              Pick a carrier above to see all of its available services for this
              shipment.
            </div>
          )}
          {carrierId && !browse.data && !browse.isPending && !browse.isError && (
            <div className="px-4 py-12 text-center text-ink-3 text-sm2">
              Click <span className="font-semibold">Fetch rates</span> to load
              services for this carrier.
            </div>
          )}
          {browse.isPending && (
            <div className="p-4 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {browse.isError && (
            <div className="px-4 py-6 text-center text-danger text-sm2">
              {(browse.error as Error).message}
            </div>
          )}
          {browse.data && (
            <div className="divide-y divide-line">
              {sortedRates.map((rate) => (
                <div
                  key={rate.rate_id}
                  className="px-4 py-2.5 flex items-center gap-3 hover:bg-surface-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm2 font-semibold text-ink">
                      {rate.service_type}
                    </div>
                    <div className="text-tiny text-ink-3 mt-0.5">
                      {rate.delivery_days
                        ? `~${rate.delivery_days} transit day${rate.delivery_days === 1 ? '' : 's'}`
                        : 'Transit time varies'}
                    </div>
                  </div>
                  <div className="text-sm2 font-bold font-mono text-ink shrink-0 w-16 text-right">
                    ${rate.shipping_amount.amount.toFixed(2)}
                  </div>
                  <Button
                    variant="green"
                    size="xs"
                    onClick={() => {
                      onSelectRate(rate);
                      onClose();
                    }}
                  >
                    Use
                  </Button>
                </div>
              ))}
              {sortedRates.length === 0 && (
                <div className="px-4 py-12 text-center text-ink-3 text-sm2">
                  No rates returned for this carrier.
                </div>
              )}
            </div>
          )}
        </div>

        {browse.data && (
          <div className="px-4 py-2 border-t border-line bg-surface-2 text-tiny text-ink-3 flex items-center gap-2">
            <span>{browse.data.cached ? 'From cache' : 'Live'}</span>
            <span>·</span>
            <span>
              {sortedRates.length} rate{sortedRates.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
