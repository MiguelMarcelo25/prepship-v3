export type RateBrowseWorkflowPhase = 'queued' | 'cached' | 'running' | 'partial' | 'complete' | 'error';

export type RateBrowseWorkflowSnapshot = {
  jobId: string;
  phase: RateBrowseWorkflowPhase;
  requestKey: string | null;
  orderId: number | null;
  totalCarriers: number;
  completedCarriers: number;
  successfulCarriers: number;
  failedCarriers: number;
  ratesCount: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  message: string;
  result: Record<string, unknown> | null;
  diagnostics: Record<string, unknown>;
  error: string | null;
};
