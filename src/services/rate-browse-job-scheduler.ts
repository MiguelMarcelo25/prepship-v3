export function scheduleDetachedRateBrowseJob(
  run: () => Promise<void>,
  onError: (error: unknown) => void = (error) => console.error('[rate-browse-workflow] detached job failed:', error),
): void {
  queueMicrotask(() => {
    void run().catch(onError);
  });
}
