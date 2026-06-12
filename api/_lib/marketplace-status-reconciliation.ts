// PS-200 S6: relocated to src/services/marketplace-status-reconciliation.ts
// (the v4 tree owns shared services; the legacy Vercel pullers consume it
// through this compatibility re-export until S8 deletes the api/ directory).
export {
  normalizeMarketplaceOrderStatus,
  aggregateMarketplaceOrderStatus,
  shouldUpdateMarketplaceOrderStatus,
  hasExistingMarketplaceOrderRow,
  reconcileMarketplaceOrderStatuses,
  type MarketplaceProvider,
  type PrepShipOrderStatus,
  type MarketplaceSql,
  type MarketplaceReconciliationCandidate,
  type MarketplaceReconciliationResult,
} from '../../src/services/marketplace-status-reconciliation.js';
