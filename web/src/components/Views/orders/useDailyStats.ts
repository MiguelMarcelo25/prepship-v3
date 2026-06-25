// PS-317: the daily-stats strip data, pulled out of OrdersView. Handles the fetch, the 10-min
// auto-refresh, the day-rollover timer, and a refetch when the tab becomes visible. Only runs on the
// Awaiting + Shipped tabs. Returns the stats + load status; OrdersView builds the strip display from them.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../../api/client';
import { getMsUntilNextDailyStatsRollover } from '../daily-stats-rollover';
import { scheduleNonCriticalOrdersWork } from '../orders-non-critical-scheduler';
import type { OrdersDailyStatsDto } from '../../../types/api';

type DailyStatsStatus = 'idle' | 'loading' | 'success' | 'error';

export function useDailyStats(currentStatus: string) {
  const [dailyStats, setDailyStats] = useState<OrdersDailyStatsDto | null>(null);
  const [dailyStatsStatus, setDailyStatsStatus] = useState<DailyStatsStatus>('idle');
  const [dailyStatsError, setDailyStatsError] = useState<string | null>(null);
  const dailyStatsEnabledRef = useRef(false);

  const loadDailyStats = useCallback(async (options: { skipHidden?: boolean } = {}) => {
    if (!dailyStatsEnabledRef.current) return;
    if (options.skipHidden && document.visibilityState !== 'visible') {
      setDailyStatsStatus((status) => (status === 'idle' ? 'loading' : status));
      return;
    }

    setDailyStatsStatus('loading');
    setDailyStatsError(null);
    try {
      const payload = await apiClient.fetchDailyStats();
      if (!dailyStatsEnabledRef.current) return;
      setDailyStats(payload);
      setDailyStatsStatus('success');
      setDailyStatsError(null);
    } catch (err) {
      if (!dailyStatsEnabledRef.current) return;
      setDailyStatsStatus('error');
      setDailyStatsError(err instanceof Error ? err.message : 'Daily stats failed');
    }
  }, []);

  useEffect(() => {
    dailyStatsEnabledRef.current = currentStatus === 'awaiting_shipment' || currentStatus === 'shipped';
    if (!dailyStatsEnabledRef.current) {
      setDailyStats(null);
      setDailyStatsStatus('idle');
      setDailyStatsError(null);
      return;
    }

    setDailyStatsStatus((status) => (status === 'idle' ? 'loading' : status));

    let rolloverTimer: number | null = null;

    const scheduleRolloverRefresh = () => {
      if (rolloverTimer !== null) window.clearTimeout(rolloverTimer);
      rolloverTimer = window.setTimeout(() => {
        void loadDailyStats({ skipHidden: true });
        scheduleRolloverRefresh();
      }, getMsUntilNextDailyStatsRollover());
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadDailyStats();
      }
    };

    const cancelInitialLoad = scheduleNonCriticalOrdersWork(() => {
      void loadDailyStats();
    }, 3000);
    scheduleRolloverRefresh();
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(() => {
      void loadDailyStats({ skipHidden: true });
    }, 10 * 60 * 1000);

    return () => {
      dailyStatsEnabledRef.current = false;
      cancelInitialLoad();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
      if (rolloverTimer !== null) window.clearTimeout(rolloverTimer);
    };
  }, [currentStatus, loadDailyStats]);

  return { dailyStats, dailyStatsStatus, dailyStatsError, loadDailyStats };
}
