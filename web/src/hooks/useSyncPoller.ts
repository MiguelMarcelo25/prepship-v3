// @ts-nocheck
import { useEffect, useCallback, useRef } from "react";

export interface UseSyncPollerOptions {
  interval?: number;
  enabled?: boolean;
  onPoll?: () => Promise<void>;
}

export function useSyncPoller(options?: UseSyncPollerOptions): void {
  const { interval = 30000, enabled = true, onPoll } = options || {};
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(() => {
    if (!enabled || !onPoll) return;

    pollerRef.current = setInterval(async () => {
      try {
        await onPoll();
      } catch (error) {
        console.error("Polling error:", error);
      }
    }, interval);
  }, [enabled, onPoll, interval]);

  const stopPolling = useCallback(() => {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      startPolling();
    }
    return stopPolling;
  }, [enabled, startPolling, stopPolling]);
}
