import { reportError } from '../lib/structured-log';

export function scheduleDetachedRateBrowseJob(
  run: () => Promise<void>,
  onError: (error: unknown) => void = (error) => reportError('rate.browse.detached_failed', error),
): void {
  queueMicrotask(() => {
    void run().catch(onError);
  });
}
