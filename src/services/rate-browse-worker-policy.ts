export const RATE_BROWSE_MAX_EXECUTION_GENERATIONS = 3;
export const RATE_BROWSE_INTERACTIVE_QUEUE_PRIORITY = 10;
export const RATE_BROWSE_RECOVERY_QUEUE_PRIORITY = 0;

export function rateBrowseWorkerQueuePriority(recovery: boolean): number {
  return recovery
    ? RATE_BROWSE_RECOVERY_QUEUE_PRIORITY
    : RATE_BROWSE_INTERACTIVE_QUEUE_PRIORITY;
}
