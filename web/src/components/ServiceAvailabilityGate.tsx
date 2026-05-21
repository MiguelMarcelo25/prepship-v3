import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { API_BASE } from '../lib/api-base';
import MaintenanceModePage from './MaintenanceModePage';

const HEALTH_PATH = '/health/ready';
const PROBE_TIMEOUT_MS = 4_500;
const RETRY_INTERVAL_MS = 15_000;
const INITIAL_FAILURES_BEFORE_MAINTENANCE = 3;

type Availability = 'checking' | 'online' | 'offline';

function buildHealthUrl(): string {
  return `${API_BASE}${HEALTH_PATH}`;
}

async function probeApiHealth(): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(buildHealthUrl(), {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Prepship-Health-Probe': '1',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
  } finally {
    window.clearTimeout(timer);
  }
}

function getMaintenanceDetail(error: string | null): string | null {
  if (!error) return null;
  if (/aborted|abort/i.test(error)) {
    return 'The health check timed out while waiting for the API to respond.';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(error)) {
    return 'The API is not reachable from this browser right now.';
  }
  return error;
}

export default function ServiceAvailabilityGate({ children }: { children: ReactNode }) {
  const [availability, setAvailability] = useState<Availability>('checking');
  const [lastError, setLastError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [bypassMaintenance, setBypassMaintenance] = useState(false);
  const failureCountRef = useRef(0);
  const availabilityRef = useRef<Availability>('checking');

  const setNextAvailability = useCallback((next: Availability) => {
    availabilityRef.current = next;
    setAvailability(next);
  }, []);

  const check = useCallback(
    async (manual = false) => {
      if (manual) setRetrying(true);
      try {
        await probeApiHealth();
        failureCountRef.current = 0;
        setLastError(null);
        setBypassMaintenance(false);
        setNextAvailability('online');
      } catch (error) {
        failureCountRef.current += 1;
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);

        // First load waits for several failed probes before showing maintenance.
        // Render can report a deploy "live" before HTTP is actually responsive,
        // and a single slow start should not permanently trap the operator.
        // After a healthy app is already visible, require two failed probes so
        // one transient network hiccup does not replace the operator workspace.
        const isHttpUnhealthy = /^Health check returned \d+/.test(message);
        const threshold = isHttpUnhealthy
          ? 1
          : availabilityRef.current === 'online'
            ? 2
            : INITIAL_FAILURES_BEFORE_MAINTENANCE;
        if (failureCountRef.current >= threshold) {
          setNextAvailability('offline');
        }
      } finally {
        if (manual) setRetrying(false);
      }
    },
    [setNextAvailability],
  );

  useEffect(() => {
    let active = true;

    const run = () => {
      if (!active || document.visibilityState !== 'visible') return;
      void check(false);
    };

    run();
    const interval = window.setInterval(run, RETRY_INTERVAL_MS);
    const onVisibility = () => run();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [check]);

  if ((availability === 'offline' || (availability === 'checking' && lastError)) && !bypassMaintenance) {
    return (
      <MaintenanceModePage
        mode="api"
        detail={getMaintenanceDetail(lastError)}
        onRetry={() => void check(true)}
        onContinue={() => {
          setBypassMaintenance(true);
          setNextAvailability('online');
        }}
        retrying={retrying}
      />
    );
  }

  return <>{children}</>;
}
