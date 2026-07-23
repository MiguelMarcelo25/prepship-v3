/** Canonical ShipStation transport-admission configuration (Audit 4.2). */
export const SHIPSTATION_RATE_LIMIT_WINDOW_MS = 60_000;

// ShipStation V1 is limited to 40 requests/minute. Keep two requests of
// headroom while sharing the same value across durable and in-memory buckets.
export const SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE = 38;

export const SHIPSTATION_RATE_LIMIT_PER_MINUTE = Math.max(
  1,
  Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_PER_MINUTE ?? '160', 10) || 160,
);

export const SHIPSTATION_RATE_LIMIT_BURST = Math.max(
  1,
  Math.min(
    SHIPSTATION_RATE_LIMIT_PER_MINUTE,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_BURST ?? '20', 10) || 20,
  ),
);

export const SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE = Math.max(
  0,
  Math.min(
    SHIPSTATION_RATE_LIMIT_BURST - 1,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE ?? '8', 10) || 8,
  ),
);

export const SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE = Math.max(
  0,
  Math.min(
    SHIPSTATION_RATE_LIMIT_PER_MINUTE - 1,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE ?? '40', 10) || 40,
  ),
);

// PS-447: batch work (rate backfills/recalculation) may use more of the shared
// budget than background sync/polling, while still preserving the interactive
// reserve for operator quotes and label purchases.
export const SHIPSTATION_RATE_LIMIT_BATCH_BURST_RESERVE = Math.max(
  0,
  Math.min(
    SHIPSTATION_RATE_LIMIT_BURST - SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE - 1,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_BATCH_BURST_RESERVE ?? '4', 10) || 4,
  ),
);

export const SHIPSTATION_RATE_LIMIT_BATCH_PER_MINUTE_RESERVE = Math.max(
  0,
  Math.min(
    SHIPSTATION_RATE_LIMIT_PER_MINUTE - SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE - 1,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_BATCH_PER_MINUTE_RESERVE ?? '20', 10) || 20,
  ),
);
