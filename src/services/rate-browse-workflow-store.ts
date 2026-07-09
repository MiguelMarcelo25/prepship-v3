import { getJsonSetting, setJsonSettings } from './settings-json';
import {
  getRateBrowseJobRecord,
  persistRateBrowseJobRecord,
  reserveRateBrowseJobRecord,
  type RateBrowseJobPriority,
  type RateBrowseJobReservation,
} from './rate-browse-job-store';
import type { RateBrowseWorkflowSnapshot } from './rate-browse-workflow-types';

export const RATE_BROWSE_WORKFLOW_LATEST_KEY = 'rate_browse_workflow.latest';
export const RATE_BROWSE_WORKFLOW_JOB_PREFIX = 'rate_browse_workflow.job.';

export function rateBrowseWorkflowJobKey(jobId: string): string {
  const normalized = String(jobId ?? '').trim();
  if (!normalized) throw new Error('rate browse workflow jobId is required');
  return `${RATE_BROWSE_WORKFLOW_JOB_PREFIX}${normalized}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durableFallbackSnapshot(
  snapshot: RateBrowseWorkflowSnapshot,
  error: unknown,
): RateBrowseWorkflowSnapshot {
  return {
    ...snapshot,
    diagnostics: {
      ...snapshot.diagnostics,
      durableStore: 'fallback',
      durableStoreError: errorMessage(error),
    },
  };
}

export async function persistRateBrowseWorkflowSnapshot(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority } = {},
): Promise<void> {
  let durableSnapshot = snapshot;
  try {
    await persistRateBrowseJobRecord(snapshot, options);
  } catch (error) {
    durableSnapshot = durableFallbackSnapshot(snapshot, error);
    console.warn(
      '[rate-browse-workflow-store] durable persist failed; falling back to settings snapshot:',
      errorMessage(error),
    );
  }
  await setJsonSettings([
    { key: RATE_BROWSE_WORKFLOW_LATEST_KEY, value: durableSnapshot },
    { key: rateBrowseWorkflowJobKey(durableSnapshot.jobId), value: durableSnapshot },
  ]);
}

export async function reserveRateBrowseWorkflowSnapshot(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority } = {},
): Promise<RateBrowseJobReservation> {
  let reservation: RateBrowseJobReservation;
  try {
    reservation = await reserveRateBrowseJobRecord(snapshot, options);
  } catch (error) {
    reservation = { snapshot: durableFallbackSnapshot(snapshot, error), created: true };
    console.warn(
      '[rate-browse-workflow-store] durable reservation failed; falling back to settings snapshot:',
      errorMessage(error),
    );
  }
  if (reservation.created) {
    await setJsonSettings([
      { key: RATE_BROWSE_WORKFLOW_LATEST_KEY, value: reservation.snapshot },
      { key: rateBrowseWorkflowJobKey(reservation.snapshot.jobId), value: reservation.snapshot },
    ]);
  }
  return reservation;
}

async function getLegacyRateBrowseWorkflowSnapshot(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  return getJsonSetting<RateBrowseWorkflowSnapshot>(rateBrowseWorkflowJobKey(jobId));
}

export async function getRateBrowseWorkflowSnapshot(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  const durable = await getRateBrowseJobRecord(jobId);
  if (durable) return durable;
  return getLegacyRateBrowseWorkflowSnapshot(jobId);
}
