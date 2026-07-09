import { Activity } from 'lucide-react';

export type RateBrowserProviderDiagnostic = {
  carrierId: string;
  accountId?: string;
  carrierName?: string;
  carrierCode?: string;
  source: 'shipstation' | 'direct' | 'unknown';
  status: string;
  outcome?: string;
  rateCount: number;
  durationMs?: number;
  limiterWaitMs?: number;
  attempts?: number;
  retryable?: boolean;
  error?: string;
};

export type RateBrowserTimingDiagnostics = {
  totalDurationMs?: number;
  carriers?: RateBrowserProviderDiagnostic[];
  rateEngineLimiter?: {
    limiterBefore?: Record<string, unknown>;
    limiterAfter?: Record<string, unknown>;
  };
};

export type RateBrowserFailureDiagnostic = {
  code?: string;
  message?: string;
};

type Props = {
  timing: RateBrowserTimingDiagnostics | null;
  failure: RateBrowserFailureDiagnostic | null;
};

function milliseconds(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '-';
  if (amount < 1_000) return `${Math.round(amount)}ms`;
  return `${(amount / 1_000).toFixed(amount < 10_000 ? 1 : 0)}s`;
}

function limiterNumber(snapshot: Record<string, unknown>, key: string): number {
  const amount = Number(snapshot[key]);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : 0;
}

function outcomeTone(outcome: string): string {
  if (outcome === 'ok' || outcome === 'cached') return 'bg-ok/10 text-ok';
  if (outcome === 'timeout' || outcome === 'failed') return 'bg-danger/10 text-danger';
  if (outcome === 'loading') return 'bg-brand/10 text-brand';
  return 'bg-warn/10 text-warn';
}

export default function RateBrowserDiagnosticsPanel({ timing, failure }: Props) {
  const carriers = Array.isArray(timing?.carriers) ? timing.carriers : [];
  if (!failure?.message && carriers.length === 0) return null;

  const limiter = timing?.rateEngineLimiter?.limiterAfter ?? {};
  const active = limiterNumber(limiter, 'activeRateFetches');
  const waiting = limiterNumber(limiter, 'interactiveWaiters') + limiterNumber(limiter, 'backgroundWaiters');
  const budgetUsed = limiterNumber(limiter, 'shipStationBudgetUsed');

  return (
    <div className="shrink-0 border-b border-line bg-surface">
      {failure?.message ? (
        <div role="alert" className="border-b border-danger/20 bg-danger/10 px-[18px] py-2 text-[11.5px] font-semibold text-danger">
          {failure.message}
        </div>
      ) : null}
      <details className="group" open={Boolean(failure?.message)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-[18px] py-2 text-[11.5px] font-bold text-ink marker:hidden">
          <Activity size={13} aria-hidden="true" />
          <span>Provider diagnostics</span>
          <span className="font-medium text-ink-3">
            {carriers.length} accounts | {milliseconds(timing?.totalDurationMs)} | {active} active | {waiting} waiting | budget {budgetUsed}
          </span>
        </summary>
        <div className="max-h-44 overflow-auto border-t border-line">
          <table className="w-full table-fixed border-collapse text-left text-[11px]">
            <thead className="sticky top-0 bg-surface-2 text-ink-3">
              <tr>
                <th className="w-[32%] px-[18px] py-1.5 font-bold">Account</th>
                <th className="w-[14%] px-2 py-1.5 font-bold">Source</th>
                <th className="w-[16%] px-2 py-1.5 font-bold">Status</th>
                <th className="w-[10%] px-2 py-1.5 text-right font-bold">Rates</th>
                <th className="w-[14%] px-2 py-1.5 text-right font-bold">Duration</th>
                <th className="w-[14%] px-[18px] py-1.5 text-right font-bold">Queue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {carriers.map((carrier) => {
                const outcome = carrier.outcome || carrier.status || 'failed';
                const name = carrier.carrierName || carrier.carrierCode || carrier.carrierId;
                return (
                  <tr key={`${carrier.source}:${carrier.accountId || carrier.carrierId}`} className="text-ink">
                    <td className="truncate px-[18px] py-1.5 font-semibold" title={name}>{name}</td>
                    <td className="px-2 py-1.5 text-ink-3">{carrier.source}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-flex rounded px-1.5 py-0.5 font-bold ${outcomeTone(outcome)}`} title={carrier.error}>
                        {outcome}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{carrier.rateCount}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{milliseconds(carrier.durationMs)}</td>
                    <td className="px-[18px] py-1.5 text-right tabular-nums">{milliseconds(carrier.limiterWaitMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
