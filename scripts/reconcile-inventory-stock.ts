/** PS-439 retired this legacy cache/order-derived reconciliation entry point. */
console.error(
  'PS439_RECONCILIATION_RETIRED: run `npm run inventory:reconcile:dry-run`; no report or mutation ran.',
);
process.exitCode = 1;
