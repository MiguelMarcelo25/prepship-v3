export type OrdersRefetchCoordinatorStats = {
  inFlight: boolean;
  queued: boolean;
  runCount: number;
  lastReason: string | null;
};

export type OrdersRefetchCoordinator = {
  request: (reason?: string) => Promise<void>;
  getStats: () => OrdersRefetchCoordinatorStats;
};

type RefetchRunner = (reason?: string) => Promise<void> | void;

function normalizeReason(reason: string | undefined): string | null {
  const text = String(reason ?? '').trim();
  return text || null;
}

export function createOrdersRefetchCoordinator(run: RefetchRunner): OrdersRefetchCoordinator {
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let queuedReasons: string[] = [];
  let runCount = 0;
  let lastReason: string | null = null;

  const drain = async (initialReason: string | null): Promise<void> => {
    let nextReason = initialReason;

    try {
      for (;;) {
        queued = false;
        queuedReasons = [];
        runCount += 1;
        lastReason = nextReason;
        await run(nextReason ?? undefined);

        if (!queued) break;
        nextReason = queuedReasons.at(-1) ?? 'coalesced';
      }
    } finally {
      inFlight = null;
      queued = false;
      queuedReasons = [];
    }
  };

  return {
    request(reason?: string) {
      const normalizedReason = normalizeReason(reason);
      if (inFlight) {
        queued = true;
        if (normalizedReason) queuedReasons.push(normalizedReason);
        return inFlight;
      }

      inFlight = drain(normalizedReason);
      return inFlight;
    },
    getStats() {
      return {
        inFlight: inFlight != null,
        queued,
        runCount,
        lastReason,
      };
    },
  };
}
