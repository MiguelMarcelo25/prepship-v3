import type { CarrierRateStatus } from './RateBrowserModal';

const TERMINAL_RATE_BROWSER_STATUSES: ReadonlySet<CarrierRateStatus> = new Set([
  'cached',
  'live',
  'unavailable',
  'error',
  'uncached',
]);

export function rateBrowserCarrierStatusIsTerminal(status: CarrierRateStatus | undefined): boolean {
  return status != null && TERMINAL_RATE_BROWSER_STATUSES.has(status);
}

export function nextRateBrowserPendingPidsAfterPartial(input: {
  pendingPids: ReadonlySet<number>;
  ratesByPid: Record<string, readonly unknown[]>;
  statusByPid: Record<string, CarrierRateStatus>;
}): Set<number> {
  const next = new Set(input.pendingPids);
  for (const pid of input.pendingPids) {
    const key = String(pid);
    const hasRates = (input.ratesByPid[key]?.length ?? 0) > 0;
    if (hasRates || rateBrowserCarrierStatusIsTerminal(input.statusByPid[key])) {
      next.delete(pid);
    }
  }
  return next;
}
