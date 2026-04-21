import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Package, RefreshCw, Ruler } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
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

const CARRIER_BADGE: Record<
  string,
  { bg: string; fg: string; label: string }
> = {
  ups: { bg: '#351c15', fg: '#ffb500', label: 'UPS' },
  usps: { bg: '#215eb6', fg: '#ffffff', label: 'USPS' },
  fedex: { bg: '#4d148c', fg: '#ff6200', label: 'FedEx' },
  stamps_com: { bg: '#215eb6', fg: '#ffffff', label: 'USPS' },
  dhl_express: { bg: '#ffcc00', fg: '#d40511', label: 'DHL' },
};

function carrierBadge(code: string): { bg: string; fg: string; label: string } {
  const k = (code || '').toLowerCase();
  const direct = CARRIER_BADGE[k];
  if (direct) return direct;
  for (const key of Object.keys(CARRIER_BADGE)) {
    if (k.includes(key)) return CARRIER_BADGE[key]!;
  }
  return {
    bg: '#c8cdd5',
    fg: '#4a5568',
    label: (code || '?').slice(0, 4).toUpperCase(),
  };
}

function prettyService(s: string) {
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
      <Topbar title="Rate Browser" />

      <div className="flex-1 min-h-0 overflow-hidden flex bg-surface">
        {/* LEFT — Configure */}
        <form
          onSubmit={submit}
          className="w-[260px] shrink-0 border-r border-line flex flex-col overflow-y-auto"
        >
          <div className="px-3.5 pt-3.5 pb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-3">
            Configure Rates
          </div>

          <div className="px-3.5 py-2 flex flex-col gap-3 flex-1">
            {/* Ship To */}
            <div>
              <div className="text-[12px] font-bold text-ink mb-1.5">
                Ship To
              </div>
              <div className="text-[11px] text-ink-3 mb-1">Postal Code</div>
              <Input
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                maxLength={10}
                placeholder="90001"
                required
              />
              <div className="grid grid-cols-2 gap-1.5 mt-2">
                <div>
                  <div className="text-[11px] text-ink-3 mb-1">State</div>
                  <Input
                    value={state}
                    onChange={(e) =>
                      setState(e.target.value.toUpperCase())
                    }
                    maxLength={3}
                    placeholder="CA"
                  />
                </div>
                <div>
                  <div className="text-[11px] text-ink-3 mb-1">Country</div>
                  <Input
                    value={country}
                    onChange={(e) =>
                      setCountry(e.target.value.toUpperCase())
                    }
                    maxLength={2}
                  />
                </div>
              </div>
              <div className="text-[11px] text-ink-3 mt-2 mb-1">City</div>
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Optional"
              />
            </div>

            {/* Shipment Information */}
            <div>
              <div className="text-[12px] font-bold text-ink mb-2">
                Shipment Information
              </div>

              <div className="text-[11px] text-ink-3 mb-1">Weight (oz)</div>
              <Input
                type="number"
                step="0.1"
                min={0.1}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                required
              />

              <div className="text-[11px] text-ink-3 mt-2.5 mb-1">
                Size (L × W × H in)
              </div>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                  className="!w-12 !px-1 text-center"
                />
                <span className="text-[10px] text-ink-3">×</span>
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                  className="!w-12 !px-1 text-center"
                />
                <span className="text-[10px] text-ink-3">×</span>
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  className="!w-12 !px-1 text-center"
                />
              </div>

              <div className="text-[11px] text-ink-3 mt-2.5 mb-1">
                Residential
              </div>
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
          </div>

          <div className="border-t border-line p-3">
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={mutation.isPending || !zip.trim()}
              className="w-full justify-center"
            >
              {mutation.isPending ? (
                <>
                  <RefreshCw size={12} className="animate-spin" />
                  Fetching…
                </>
              ) : (
                'Browse Rates'
              )}
            </Button>
            {mutation.isError && (
              <div className="text-danger text-tiny mt-2">
                {(mutation.error as Error).message}
              </div>
            )}
          </div>
        </form>

        {/* RIGHT — Rates */}
        <div className="flex-1 flex flex-col bg-surface min-w-0">
          <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-line bg-surface-2 shrink-0">
            <span className="text-[14px] font-bold text-ink">Rates</span>
            <span className="text-tiny text-ink-3 flex-1">
              {mutation.data
                ? `${sorted.length} total, sorted cheapest first`
                : ''}
            </span>
            {mutation.data && (
              <span className="text-tiny text-ink-3">
                {mutation.data.cached ? 'From cache' : 'Live'} ·{' '}
                {new Date(mutation.data.fetchedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {!mutation.data && !mutation.isPending && (
              <div className="text-center text-ink-3 mt-20 px-6">
                <Ruler size={28} className="mx-auto mb-3 text-ink-4" />
                <div className="text-[13px] font-semibold text-ink-2">
                  Enter weight and destination
                </div>
                <div className="text-tiny mt-1">
                  Fill in the fields, then click Browse Rates.
                </div>
              </div>
            )}

            {mutation.isPending && (
              <div className="text-center text-ink-3 mt-20">
                <RefreshCw
                  size={20}
                  className="mx-auto mb-3 animate-spin text-ink-3"
                />
                <div className="text-[13px]">Fetching rates…</div>
              </div>
            )}

            {mutation.data && sorted.length === 0 && (
              <div className="text-center text-ink-3 mt-20 px-6">
                <Package size={28} className="mx-auto mb-3 text-ink-4" />
                <div className="text-[13px] font-semibold text-ink-2">
                  No rates returned
                </div>
                <div className="text-tiny mt-1">
                  Try different dimensions or destination.
                </div>
              </div>
            )}

            {sorted.map((r) => {
              const isBest = best?.rate_id === r.rate_id;
              const badge = carrierBadge(r.carrier_code);
              return (
                <div key={r.rate_id} className="relative">
                  {isBest && (
                    <div className="absolute top-1.5 left-3 bg-ok-dark text-white text-2xs font-bold px-1.5 py-px rounded uppercase tracking-wide">
                      Recommended
                    </div>
                  )}
                  <div
                    className={`flex items-center gap-3.5 px-4 py-2.5 border-b border-line ${isBest ? 'pt-5' : ''}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-bold text-ink leading-tight truncate">
                        {prettyService(r.service_type || r.service_code)}
                      </div>
                      {r.carrier_nickname && (
                        <div className="text-[11.5px] text-ink-3 leading-tight mt-0.5 truncate">
                          {r.carrier_nickname}
                        </div>
                      )}
                    </div>
                    {r.delivery_days != null && (
                      <div className="text-[12px] font-bold text-ink whitespace-nowrap">
                        ~{r.delivery_days}d
                      </div>
                    )}
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center font-black text-[10px] tracking-tight shrink-0"
                      style={{
                        backgroundColor: badge.bg,
                        color: badge.fg,
                      }}
                    >
                      {badge.label}
                    </div>
                    <div className="text-right min-w-[65px]">
                      <div
                        className={`font-mono font-bold text-[13px] ${isBest ? 'text-ok-dark' : 'text-ok'}`}
                      >
                        ${r.shipping_amount.amount.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
