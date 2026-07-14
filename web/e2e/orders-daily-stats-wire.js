// Exact GET /orders/daily-stats wire shape from src/routes/orders.ts.
// The v2-apiClient parser requires every window label and aggregate field.
export const ORDERS_DAILY_STATS_WIRE = {
  window: {
    from: '2026-06-02T19:00:00.000Z',
    to: '2026-06-03T19:00:00.000Z',
    fromLabel: 'Jun 2, 12pm PT',
    toLabel: 'Jun 3, 12pm PT',
  },
  totalOrders: 63,
  needToShip: 5,
  upcomingOrders: 4,
}
