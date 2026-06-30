import { useCallback, useRef, useState } from 'react';
import { apiClient } from '../lib/v2-apiClient';

export type RateBrowseWorkflowStatus = 'queued' | 'cached' | 'running' | 'partial' | 'complete' | 'error';

export type RateBrowseWorkflowSnapshot = {
  job_id: string;
  status: RateBrowseWorkflowStatus;
  progress?: {
    total_carriers?: number;
    completed_carriers?: number;
    successful_carriers?: number;
    failed_carriers?: number;
    rates_count?: number;
  } | null;
  message?: string | null;
  request_key?: string | null;
  order_id?: number | null;
  result?: Record<string, unknown> | null;
  diagnostics?: Record<string, unknown> | null;
  error?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
};

export type RunRateBrowseWorkflowOptions = {
  onSnapshot?: (snapshot: RateBrowseWorkflowSnapshot) => void;
  onPartialResult?: (result: Record<string, unknown>, snapshot: RateBrowseWorkflowSnapshot) => void;
};

const RATE_BROWSE_WORKFLOW_POLL_MS = 750;
const RATE_BROWSE_WORKFLOW_MAX_POLLS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeSnapshot(value: unknown): RateBrowseWorkflowSnapshot {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid rate browse workflow response');
  }
  const snapshot = value as RateBrowseWorkflowSnapshot;
  if (!snapshot.job_id) throw new Error('Rate browse workflow response missing job id');
  return snapshot;
}

export function useRateBrowseWorkflow() {
  const generationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<RateBrowseWorkflowSnapshot | null>(null);

  const reset = useCallback(() => {
    generationRef.current += 1;
    setSnapshot(null);
  }, []);

  const runRateBrowseWorkflow = useCallback(async (
    payload: Record<string, unknown>,
    options: RunRateBrowseWorkflowOptions = {},
  ): Promise<Record<string, unknown>> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const emittedPartialKeys = new Set<string>();
    const publishSnapshot = (nextSnapshot: RateBrowseWorkflowSnapshot) => {
      setSnapshot(nextSnapshot);
      options.onSnapshot?.(nextSnapshot);
      const partialKey = `${nextSnapshot.job_id}:${nextSnapshot.updated_at ?? ''}:${nextSnapshot.status}`;
      if (
        nextSnapshot.status === 'partial' &&
        nextSnapshot.result &&
        !emittedPartialKeys.has(partialKey)
      ) {
        emittedPartialKeys.add(partialKey);
        options.onPartialResult?.(nextSnapshot.result, nextSnapshot);
      }
    };

    let snapshot = normalizeSnapshot(await apiClient.startRateBrowseWorkflow(payload));
    publishSnapshot(snapshot);

    let pollCount = 0;
    while (true) {
      if (pollCount >= RATE_BROWSE_WORKFLOW_MAX_POLLS) break;
      pollCount += 1;
      if (generationRef.current !== generation) {
        throw new Error('Rate browse workflow superseded');
      }
      if (snapshot.status === 'complete') {
        return snapshot.result ?? {};
      }
      if (snapshot.status === 'error') {
        throw new Error(snapshot.error || snapshot.message || 'Rate browse workflow failed');
      }
      await sleep(RATE_BROWSE_WORKFLOW_POLL_MS);
      snapshot = normalizeSnapshot(await apiClient.fetchRateBrowseWorkflow(snapshot.job_id));
      publishSnapshot(snapshot);
    }

    throw new Error('Rate browse workflow timed out');
  }, []);

  return {
    snapshot,
    runRateBrowseWorkflow,
    reset,
  };
}
