import type { SemanticAuthorityRule } from './lib/architecture-boundary-analyzer';

export type DebtOwner = {
  ownerCard: `PS-${number}`;
  reason: string;
};

export type FrontendImportException = DebtOwner & {
  sourcePath: string;
  targetPath: string;
};

export type RoutePersistenceException = DebtOwner & {
  sourcePath: string;
  maxDirectWrites: number;
  routeSites: Record<string, number>;
};

export type FrontendSemanticException = DebtOwner & {
  sourcePath: string;
  site: string;
  rule: SemanticAuthorityRule;
};

/**
 * Reviewed debt only. New entries require a named removal owner and a lower or
 * equal ratchet elsewhere; this file is not a generic suppression list.
 */
export const FRONTEND_IMPORT_EXCEPTIONS: readonly FrontendImportException[] = [
  {
    sourcePath: 'web/src/components/RateBrowserModal.tsx',
    targetPath: 'src/lib/shipping-options',
    ownerCard: 'PS-441',
    reason: 'Move the remaining rate request display options into a public contract owned by the backend migration.',
  },
  {
    sourcePath: 'web/src/components/RateBrowserModal.tsx',
    targetPath: 'src/lib/shipping-service-eligibility',
    ownerCard: 'PS-441',
    reason: 'Replace the frontend eligibility dependency with the backend-issued workflow DTO.',
  },
  {
    sourcePath: 'web/src/components/Views/AutomationAvailabilityPanel.tsx',
    targetPath: 'src/lib/shipping-service-eligibility',
    ownerCard: 'PS-441',
    reason: 'Render backend eligibility facts through a public DTO instead of importing backend policy.',
  },
  ...[
    'src/lib/analytics-provenance',
    'src/lib/inventory-stock-status',
    'src/lib/kpi-delta',
    'src/lib/sales-heatmap-deviation',
    'src/lib/sku-units',
  ].map((targetPath) => ({
    sourcePath: 'web/src/components/Views/DashboardView.tsx',
    targetPath,
    ownerCard: 'PS-433' as const,
    reason: 'Move dashboard analytics and inventory display facts behind a backend read-model contract.',
  })),
  ...[
    'web/src/components/Views/orders-panel-state.ts',
    'web/src/components/Views/orders/best-rate/rate-display-predicates.ts',
    'web/src/components/Views/orders/best-rate/rate-helpers.ts',
    'web/src/components/Views/orders/best-rate/rate-proof.ts',
    'web/src/components/Views/orders/best-rate/rate-request.ts',
    'web/src/components/Views/OrdersView.tsx',
    'web/src/components/Views/SettingsView.tsx',
  ].map((sourcePath) => ({
    sourcePath,
    targetPath: 'src/lib/shipping-service-eligibility',
    ownerCard: 'PS-441' as const,
    reason: 'Replace direct backend policy consumption with the backend-issued order or settings DTO.',
  })),
  {
    sourcePath: 'web/src/components/Views/orders-rate-input.ts',
    targetPath: 'src/lib/shipping-options',
    ownerCard: 'PS-441',
    reason: 'Publish rate request option types through the public contract boundary.',
  },
  {
    sourcePath: 'web/src/lib/v2-apiClient.ts',
    targetPath: 'src/lib/analytics-provenance',
    ownerCard: 'PS-320',
    reason: 'Move the API transport provenance type into the public DTO contract layer.',
  },
];

export const ROUTE_PERSISTENCE_EXCEPTIONS: readonly RoutePersistenceException[] = [
  {
    sourcePath: 'src/routes/admin.ts',
    maxDirectWrites: 17,
    routeSites: {
      'PATCH /clients/:id{[0-9]+}/flag-test': 1,
      'POST /cleanup-stale-queue-entries': 1,
      'POST /purge-test-orders': 11,
      'POST /seed-test-orders': 2,
      'POST /upsert-keyed-client': 2,
    },
    ownerCard: 'PS-454',
    reason: 'Extract admin test-data commands from the route into explicit backend command services.',
  },
  {
    sourcePath: 'src/routes/billing.ts',
    maxDirectWrites: 9,
    routeSites: {
      'PATCH /details/:orderId{[0-9]+}': 7,
      'POST /package-prices/set-default': 1,
      'PUT /package-prices': 1,
    },
    ownerCard: 'PS-462',
    reason: 'Move residual billing and package-price writes to the immutable billing command owner.',
  },
  {
    sourcePath: 'src/routes/clients.ts',
    maxDirectWrites: 6,
    routeSites: {
      'DELETE /:id{[0-9]+}': 1,
      'PATCH /:id{[0-9]+}': 1,
      'POST /': 1,
      'POST /:id{[0-9]+}/backfill-orders': 1,
      'POST /sync-stores': 2,
    },
    ownerCard: 'PS-441',
    reason: 'Extract client and store synchronization persistence behind backend command services.',
  },
  {
    sourcePath: 'src/routes/inventory.ts',
    maxDirectWrites: 11,
    routeSites: {
      '<module-scope>': 1,
      'DELETE /:id{[0-9]+}/parents/:parentSkuId{[0-9]+}': 2,
      'PATCH /:id{[0-9]+}': 1,
      'POST /': 1,
      'POST /:id{[0-9]+}/add-parent': 1,
      'POST /bulk-set-default-package': 1,
      'POST /bulk-update-dims': 1,
      'PUT /:id{[0-9]+}/set-parent': 3,
    },
    ownerCard: 'PS-462',
    reason: 'Move remaining quantity and SKU-parent mutations into the canonical inventory ledger owner.',
  },
  {
    sourcePath: 'src/routes/locations.ts',
    maxDirectWrites: 6,
    routeSites: {
      'DELETE /:id{[0-9]+}': 1,
      'PATCH /:id{[0-9]+}': 1,
      'POST /': 1,
      'POST /sync': 3,
    },
    ownerCard: 'PS-441',
    reason: 'Extract location catalog and synchronization writes into a backend command service.',
  },
  {
    sourcePath: 'src/routes/orders.ts',
    maxDirectWrites: 5,
    routeSites: {
      '<module-scope>': 2,
      'POST /bulk-assign': 1,
      'POST /manual': 2,
    },
    ownerCard: 'PS-454',
    reason: 'Complete the residual Orders route extraction for manual creation and bulk assignment.',
  },
  {
    sourcePath: 'src/routes/packages.ts',
    maxDirectWrites: 12,
    routeSites: {
      'DELETE /:id{[0-9]+}': 1,
      'PATCH /:id{[0-9]+}': 1,
      'PATCH /:id{[0-9]+}/reorder-level': 1,
      'POST /': 1,
      'POST /:id{[0-9]+}/adjust': 2,
      'POST /:id{[0-9]+}/receive': 2,
      'POST /auto-create': 1,
      'POST /backfill-start-date': 1,
      'POST /sync': 1,
      'PUT /:id{[0-9]+}': 1,
    },
    ownerCard: 'PS-462',
    reason: 'Move package stock and ledger mutations to the package and inventory command owners.',
  },
  {
    sourcePath: 'src/routes/parent-skus.ts',
    maxDirectWrites: 3,
    routeSites: {
      'DELETE /:id{[0-9]+}': 1,
      'PATCH /:id{[0-9]+}': 1,
      'POST /': 1,
    },
    ownerCard: 'PS-441',
    reason: 'Move parent-SKU catalog persistence behind the backend product command owner.',
  },
  {
    sourcePath: 'src/routes/products.ts',
    maxDirectWrites: 7,
    routeSites: {
      '<module-scope>': 1,
      'DELETE /:id{[0-9]+}': 1,
      'PATCH /:id{[0-9]+}': 1,
      'POST /': 1,
      'POST /save-defaults': 3,
    },
    ownerCard: 'PS-441',
    reason: 'Move product and default-package persistence behind the backend product command owner.',
  },
  {
    sourcePath: 'src/routes/rates.ts',
    maxDirectWrites: 2,
    routeSites: {
      'DELETE /cache': 1,
      'POST /cache-clear-and-refetch': 1,
    },
    ownerCard: 'PS-458',
    reason: 'Delegate cache invalidation writes to the canonical rate-cache service owner.',
  },
  {
    sourcePath: 'src/routes/settings.ts',
    maxDirectWrites: 2,
    routeSites: {
      'DELETE /:key': 1,
      'PUT /:key': 1,
    },
    ownerCard: 'PS-441',
    reason: 'Move settings persistence behind a backend settings command service.',
  },
];

export const FRONTEND_SEMANTIC_EXCEPTIONS: readonly FrontendSemanticException[] = [
  {
    sourcePath: 'web/src/components/NewOrderModal.tsx', site: 'handleSubmit', rule: 'label-provider-selection',
    ownerCard: 'PS-441', reason: 'Reduce new-order submission to intent and consume backend provider selection.',
  },
  {
    sourcePath: 'web/src/components/RateBrowserModal.tsx', site: 'browseRates', rule: 'provider-capability-routing',
    ownerCard: 'PS-313', reason: 'Consume the backend rate universe and provider capability result without local routing.',
  },
  ...[
    ['saveAssignments', 'provider-capability-routing'],
    ['runRename', 'label-provider-selection'],
    ['runApprove', 'label-provider-selection'],
    ['runDelete', 'label-provider-selection'],
    ['handleAdd', 'label-provider-selection'],
    ['renderSavedRow', 'label-provider-selection'],
    ['renderSavedRow', 'provider-capability-routing'],
  ].map(([site, rule]) => ({
    sourcePath: 'web/src/components/Settings/CarrierIntegrationsCard.tsx',
    site: site!,
    rule: rule as SemanticAuthorityRule,
    ownerCard: 'PS-415' as const,
    reason: 'Move carrier/store capability and label-provider decisions to the backend integration registry.',
  })),
  {
    sourcePath: 'web/src/components/Views/AnalysisView.tsx', site: 'AnalysisView', rule: 'label-provider-selection',
    ownerCard: 'PS-433', reason: 'Render backend analytics provider facts without selecting label providers in the view.',
  },
  {
    sourcePath: 'web/src/components/Views/InventoryView.tsx', site: 'InventoryView', rule: 'provider-capability-routing',
    ownerCard: 'PS-462', reason: 'Consume backend inventory/provider capability facts instead of routing them in the view.',
  },
  {
    sourcePath: 'web/src/components/Views/InventoryView.tsx', site: 'handlePurgeTestData', rule: 'inventory-authority',
    ownerCard: 'PS-462', reason: 'Reduce test-data purge UI to intent while the backend inventory owner computes mutations.',
  },
  {
    sourcePath: 'web/src/components/Views/orders/best-rate/rate-proof.ts', site: 'withRateRequestMetadata', rule: 'selected-rate-proof-minting',
    ownerCard: 'PS-313', reason: 'Remove frontend fingerprint construction and pass through only backend-issued selection proof.',
  },
  ...[
    ['voidReasonCopy', 'provider-capability-routing'],
    ['OrdersPanelShippedLabelActions', 'provider-capability-routing'],
  ].map(([site, rule]) => ({
    sourcePath: 'web/src/components/Views/OrdersPanelShippingFields.tsx',
    site: site!,
    rule: rule as SemanticAuthorityRule,
    ownerCard: 'PS-444' as const,
    reason: 'Render backend print/void capability facts without local shipped-label routing authority.',
  })),
  ...[
    ['OrdersView', 'label-provider-selection', 'PS-444', 'Reduce the main Orders view to label intent and backend-issued provider routing.'],
    ['batchReasonLabel', 'provider-capability-routing', 'PS-443', 'Format backend-issued durable rate-batch reason codes for display without choosing provider eligibility, retryability, or workflow routing.'],
    ['savePanelSkuDefaults', 'inventory-authority', 'PS-462', 'Move SKU default inventory mutation facts to the canonical backend inventory owner.'],
    ['buildQueueSendOrderPayload', 'provider-capability-routing', 'PS-408', 'Remove residual Print Queue provider routing from the frontend payload builder.'],
    ['createOrQueueLabel', 'label-provider-selection', 'PS-444', 'Delegate label creation versus queue routing to the backend Print Queue owner.'],
    ['createOrQueueShopifyLabel', 'label-provider-selection', 'PS-444', 'Delegate Shopify label routing and purchase decisions to the backend label owner.'],
    ['refreshPanelBestRate', 'label-provider-selection', 'PS-313', 'Consume backend-selected rate/provider facts during refresh without local selection.'],
    ['renderRateCellFallback', 'provider-capability-routing', 'PS-441', 'Replace frontend provider fallback routing with backend workflow display facts.'],
  ].map(([site, rule, ownerCard, reason]) => ({
    sourcePath: 'web/src/components/Views/OrdersView.tsx',
    site: site!,
    rule: rule as SemanticAuthorityRule,
    ownerCard: ownerCard as `PS-${number}`,
    reason: reason!,
  })),
  {
    sourcePath: 'web/src/components/Views/PackagesView.tsx', site: 'handlePurgeTestData', rule: 'inventory-authority',
    ownerCard: 'PS-462', reason: 'Reduce package purge UI to intent while the backend package ledger computes mutations.',
  },
  {
    sourcePath: 'web/src/components/Views/SettingsView.tsx', site: 'SettingsView', rule: 'provider-capability-routing',
    ownerCard: 'PS-415', reason: 'Consume backend integration capability DTOs instead of routing providers in Settings.',
  },
  {
    sourcePath: 'web/src/components/Views/SettingsView.tsx', site: 'handlePurgeTestOrders', rule: 'inventory-authority',
    ownerCard: 'PS-462', reason: 'Keep purge UI as operator intent while backend inventory services own quantity effects.',
  },
  {
    sourcePath: 'web/src/Home.tsx', site: 'Home', rule: 'provider-capability-routing',
    ownerCard: 'PS-441', reason: 'Replace application-shell provider routing with backend-issued navigation capability facts.',
  },
];
