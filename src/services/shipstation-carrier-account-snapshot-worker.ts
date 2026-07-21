import { refreshDueShipStationCarrierAccountSnapshots } from './shipstation-carrier-account-snapshots.js';

let activeRun: Promise<void> | null = null;

async function runRefresh(): Promise<void> {
  // PS-439: sync-job-queue owns cross-process admission through its
  // transaction-scoped sync-lane lock. A session lock here created a second
  // owner whose unlock could be routed to another pooled backend and strand
  // the original lock. Keep only process-local promise coalescing here.
  const startedAt = Date.now();
  const summary = await refreshDueShipStationCarrierAccountSnapshots();
  const { credentialDbError, ...counts } = summary;
  console.log('[carrier-snapshot-worker] refresh complete', {
    ...counts,
    credentialDbError: Boolean(credentialDbError),
    durationMs: Date.now() - startedAt,
  });
}

export function runShipStationCarrierAccountSnapshotTick(): Promise<void> {
  if (activeRun) return activeRun;
  activeRun = runRefresh()
    .finally(() => {
      activeRun = null;
    });
  return activeRun;
}
