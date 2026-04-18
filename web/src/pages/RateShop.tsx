import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { RefreshCw, DollarSign } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { api } from '../lib/api';

type Rate = {
  rate_id: string;
  carrier_code: string;
  carrier_nickname?: string;
  service_type: string;
  service_code: string;
  shipping_amount: { amount: number; currency: string };
  delivery_days?: number | null;
  estimated_delivery_date?: string | null;
};

type RatesResult = {
  rates: Rate[];
  bestRate: Rate | null;
  cached: boolean;
  cacheKey: string;
  fetchedAt: string;
};

type Residential = '' | 'yes' | 'no' | 'unknown';

type Body = {
  weightOz: number;
  toZip: string;
  toState?: string;
  toCity?: string;
  toCountry?: string;
  residential?: boolean;
  dimsL?: number;
  dimsW?: number;
  dimsH?: number;
  forceRefresh?: boolean;
};

function numOrUndef(v: string): number | undefined {
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export default function RateShop() {
  const [weight, setWeight] = useState('16');
  const [zip, setZip] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('US');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [residential, setResidential] = useState<Residential>('unknown');

  const mutation = useMutation({
    mutationFn: (body: Body) => api.post<RatesResult>('/rates', body),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) return;
    if (!zip.trim()) return;
    mutation.mutate({
      weightOz: w,
      toZip: zip.trim(),
      toState: state.trim() || undefined,
      toCity: city.trim() || undefined,
      toCountry: country.trim() || undefined,
      residential:
        residential === 'yes'
          ? true
          : residential === 'no'
            ? false
            : undefined,
      dimsL: numOrUndef(length),
      dimsW: numOrUndef(width),
      dimsH: numOrUndef(height),
    });
  };

  const sorted = (mutation.data?.rates ?? [])
    .slice()
    .sort((a, b) => a.shipping_amount.amount - b.shipping_amount.amount);
  const best = sorted[0];

  return (
    <>
      <Topbar title="Rate Shop" />

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        <Card title="Quote a shipment">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-[120px_140px_100px_1fr] gap-2">
              <div>
                <label className="section-label block mb-1">
                  Weight (oz) <span className="text-danger">*</span>
                </label>
                <Input
                  type="number"
                  step="0.1"
                  min={0.1}
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="section-label block mb-1">
                  To zip <span className="text-danger">*</span>
                </label>
                <Input
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  placeholder="10001"
                  required
                />
              </div>
              <div>
                <label className="section-label block mb-1">State</label>
                <Input
                  value={state}
                  onChange={(e) => setState(e.target.value.toUpperCase())}
                  placeholder="NY"
                  maxLength={3}
                />
              </div>
              <div>
                <label className="section-label block mb-1">City</label>
                <Input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="grid grid-cols-[100px_70px_70px_70px_1fr_160px] gap-2 items-end">
              <div>
                <label className="section-label block mb-1">Country</label>
                <Input
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  maxLength={2}
                />
              </div>
              <div>
                <label className="section-label block mb-1">L (in)</label>
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                />
              </div>
              <div>
                <label className="section-label block mb-1">W</label>
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                />
              </div>
              <div>
                <label className="section-label block mb-1">H</label>
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                />
              </div>
              <div>
                <label className="section-label block mb-1">Residential</label>
                <Select
                  value={residential}
                  onChange={(e) =>
                    setResidential(e.target.value as Residential)
                  }
                >
                  <option value="unknown">Unknown</option>
                  <option value="yes">Yes</option>
                  <option value="no">No (commercial)</option>
                </Select>
              </div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={mutation.isPending || !zip.trim()}
              >
                {mutation.isPending ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" />
                    Fetching…
                  </>
                ) : (
                  <>
                    <DollarSign size={12} />
                    Fetch rates
                  </>
                )}
              </Button>
            </div>

            {mutation.isError && (
              <div className="text-danger text-tiny">
                {(mutation.error as Error).message}
              </div>
            )}
          </form>
        </Card>

        {mutation.data && (
          <Card
            title={`Results (${sorted.length})`}
            actions={
              <span className="text-tiny text-ink-3">
                {mutation.data.cached ? 'From cache' : 'Live'} ·{' '}
                {new Date(mutation.data.fetchedAt).toLocaleTimeString()}
              </span>
            }
            bodyClassName=""
          >
            {sorted.length === 0 ? (
              <div className="p-6 text-center text-ink-3 text-sm2">
                No rates returned.
              </div>
            ) : (
              <table className="w-full text-sm2 border-collapse">
                <thead className="bg-surface-2">
                  <tr>
                    <Th>Carrier</Th>
                    <Th>Service</Th>
                    <Th className="text-right">Transit</Th>
                    <Th className="text-right">Cost</Th>
                    <Th className="w-16"></Th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const isBest = best?.rate_id === r.rate_id;
                    return (
                      <tr
                        key={r.rate_id}
                        className={`border-b border-line ${isBest ? 'bg-ok-bg' : ''}`}
                      >
                        <Td className="uppercase font-semibold">
                          {r.carrier_code}
                        </Td>
                        <Td>{r.service_type}</Td>
                        <Td className="text-right text-ink-2">
                          {r.delivery_days
                            ? `~${r.delivery_days} day${r.delivery_days === 1 ? '' : 's'}`
                            : '—'}
                        </Td>
                        <Td className="text-right font-mono font-bold">
                          ${r.shipping_amount.amount.toFixed(2)}
                        </Td>
                        <Td>
                          {isBest && (
                            <span className="text-2xs font-bold text-ok-dark">
                              BEST
                            </span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}
