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

export async function persistRateBrowseWorkflowSnapshot(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority } = {},
): Promise<void> {
  await persistRateBrowseJobRecord(snapshot, options);
  await setJsonSettings([
    { key: RATE_BROWSE_WORKFLOW_LATEST_KEY, value: snapshot },
    { key: rateBrowseWorkflowJobKey(snapshot.jobId), value: snapshot },
  ]);
}

export async function reserveRateBrowseWorkflowSnapshot(
  snapshot: RateBrowseWorkflowSnapshot,
  options: { priority?: RateBrowseJobPriority } = {},
): Promise<RateBrowseJobReservation> {
  const reservation = await reserveRateBrowseJobRecord(snapshot, options);
  if (reservation.created) {
    await setJsonSettings([
      { key: RATE_BROWSE_WORKFLOW_LATEST_KEY, value: snapshot },
      { key: rateBrowseWorkflowJobKey(snapshot.jobId), value: snapshot },
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
