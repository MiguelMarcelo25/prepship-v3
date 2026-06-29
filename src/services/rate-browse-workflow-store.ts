import { getJsonSetting, setJsonSettings } from './settings-json';
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
): Promise<void> {
  await setJsonSettings([
    { key: RATE_BROWSE_WORKFLOW_LATEST_KEY, value: snapshot },
    { key: rateBrowseWorkflowJobKey(snapshot.jobId), value: snapshot },
  ]);
}

export async function getRateBrowseWorkflowSnapshot(jobId: string): Promise<RateBrowseWorkflowSnapshot | null> {
  return getJsonSetting<RateBrowseWorkflowSnapshot>(rateBrowseWorkflowJobKey(jobId));
}
