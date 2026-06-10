// PS-157: pure-presentation rates display extracted verbatim from
// RateBrowserModal's renderRatesBody / renderAllRatesView / renderCarrierView.
// All rate math, filtering, blocked decisions, and combinedAll stay in the parent
// (single source of truth) and are passed in as props/callbacks. The actual row
// rendering is delegated back to the parent via the renderRateRow callback so the
// row markup remains identical. This component owns NO state and NO policy.
import type { ReactNode } from 'react';
import {
  type RateRow,
  type RbOrderSummaryDto,
  type RbCarrierAccountDto,
  RateLoadingSpinner,
  formatAccountDisplay,
} from './RateBrowserModal';

type RateShippingOptions = {
  insuranceProvider?: string | null;
  insuredValue?: number | string | null;
};

type RateRowsViewProps = {
  // Display flags / values (computed in parent)
  hasWeight: boolean;
  hasDims: boolean;
  browsing: boolean;
  hasAnyRateRows: boolean;
  anyFetched: boolean;
  zip: string;
  viewMode: 'all' | 'carriers';
  hideUnavail: boolean;
  selectedPid: number | null;
  combinedAll: RateRow[];
  order: RbOrderSummaryDto | null;
  currentRateShippingOptions: RateShippingOptions;
  rateShippingAccounts: RbCarrierAccountDto[];
  ratesByPid: Record<string, RateRow[]>;
  rateErrorsByPid: Record<string, string>;
  rateMetaByPid: Record<string, Record<string, unknown>>;
  // Callbacks / functions kept in the parent (single source of truth)
  filterBySvcClass: (rates: RateRow[]) => RateRow[];
  isBlockedRate: (
    rate: RateRow,
    order: RbOrderSummaryDto | null,
    shippingOptions?: RateShippingOptions,
  ) => boolean;
  renderRateRow: (
    r: RateRow,
    index: number,
    showCarrier: boolean,
    isRecommended: boolean,
  ) => ReactNode;
};

export default function RateRowsView({
  hasWeight,
  hasDims,
  browsing,
  hasAnyRateRows,
  anyFetched,
  zip,
  viewMode,
  hideUnavail,
  selectedPid,
  combinedAll,
  order,
  currentRateShippingOptions,
  rateShippingAccounts,
  ratesByPid,
  rateErrorsByPid,
  rateMetaByPid,
  filterBySvcClass,
  isBlockedRate,
  renderRateRow,
}: RateRowsViewProps): ReactNode {
  function renderAllRatesView(): ReactNode {
    const displayed = hideUnavail
      ? combinedAll.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions))
      : combinedAll;
    const allCount = combinedAll.length;
    const hiddenCount = allCount - displayed.length;
    const countLabel =
      hideUnavail && hiddenCount > 0
        ? `${displayed.length} shown, ${hiddenCount} hidden`
        : `${allCount} total, sorted cheapest first`;

    if (!displayed.length) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          No rates available — click Browse Rates
        </div>
      );
    }

    const firstOk = displayed.findIndex((r) => !isBlockedRate(r, order, currentRateShippingOptions));
    return (
      <>
        <div
          style={{
            padding: '14px 18px 10px',
            borderBottom: '2px solid var(--border)',
            background: 'var(--surface2)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              All Rates
            </span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{countLabel}</span>
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 16 }}>
          {displayed.map((r, i) => renderRateRow(r, i, true, i === firstOk))}
        </div>
      </>
    );
  }

  function renderCarrierView(): ReactNode {
    if (selectedPid == null) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          Select a carrier account
        </div>
      );
    }
    const acct = rateShippingAccounts.find((c) => c.shippingProviderId === selectedPid);
    const carrierError = rateErrorsByPid[String(selectedPid)];
    const carrierMeta = rateMetaByPid[String(selectedPid)] ?? null;
    // Resolution-source hint for direct carriers (Walmart / Amazon / eBay
    // shipping). The backend sets `purchaseOrderSource` to one of:
    //   'body.purchaseOrderId' / 'body.externalOrderId' → quote scoped to
    //     the operator's actual order.
    //   'store_orders lookup' → matched the order via the marketplace
    //     pull table — also scoped correctly.
    //   'walmart_marketplace_api' → Fix 4 path: backend asked Walmart to
    //     translate the customer order number to a purchaseOrderId on
    //     the fly. Best-effort and slightly slower, but accurate.
    //   'store_orders fallback (settings demo)' → DEMO-ONLY: the quote
    //     is for an UNRELATED Walmart order. Operators must know this.
    const purchaseOrderSource = carrierMeta && typeof carrierMeta.purchaseOrderSource === 'string'
      ? (carrierMeta.purchaseOrderSource as string)
      : null;
    const sourceLabel = (() => {
      if (!purchaseOrderSource || purchaseOrderSource === 'none') return null;
      if (purchaseOrderSource === 'body.purchaseOrderId') return { text: 'Scoped to this order (purchaseOrderId)', danger: false };
      if (purchaseOrderSource === 'body.externalOrderId') return { text: 'Scoped to this order', danger: false };
      if (purchaseOrderSource === 'store_orders lookup') return { text: 'Scoped via Walmart Marketplace pull', danger: false };
      if (purchaseOrderSource === 'walmart_marketplace_api') return { text: 'Resolved on-the-fly via Walmart Marketplace API', danger: false };
      if (purchaseOrderSource.includes('settings demo')) return { text: 'DEMO RATES — borrowed from an unrelated Walmart order', danger: true };
      return { text: `Source: ${purchaseOrderSource}`, danger: false };
    })();
    const all = ratesByPid[String(selectedPid)] ?? [];
    const filtered = filterBySvcClass(all);
    const displayed = hideUnavail
      ? filtered.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions))
      : filtered;
    const hiddenCount = filtered.length - displayed.length;
    const countLabel =
      hideUnavail && hiddenCount > 0
        ? `${displayed.length} shown, ${hiddenCount} hidden`
        : `${filtered.length} rate${filtered.length !== 1 ? 's' : ''} available`;

    if (!all.length) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          No rates available for <b>{formatAccountDisplay(acct, 'this account')}</b>
          {carrierError ? (
            <div
              style={{
                maxWidth: 520,
                margin: '10px auto 0',
                color: 'var(--red)',
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              {carrierError}
            </div>
          ) : null}
          {sourceLabel ? (
            <div
              style={{
                maxWidth: 520,
                margin: '8px auto 0',
                color: sourceLabel.danger ? 'var(--red)' : 'var(--text3)',
                fontSize: 10.5,
                fontStyle: 'italic',
                lineHeight: 1.4,
              }}
              title="purchaseOrderSource from the backend rate response"
            >
              {sourceLabel.text}
            </div>
          ) : null}
        </div>
      );
    }

    const firstOk = displayed.findIndex((r) => !isBlockedRate(r, order, currentRateShippingOptions));
    return (
      <>
        <div
          style={{
            padding: '14px 18px 10px',
            borderBottom: '2px solid var(--border)',
            background: 'var(--surface2)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {formatAccountDisplay(acct)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{countLabel}</span>
          </div>
          {sourceLabel ? (
            <div
              style={{
                marginTop: 4,
                color: sourceLabel.danger ? 'var(--red)' : 'var(--text3)',
                fontSize: 10.5,
                fontStyle: sourceLabel.danger ? 'normal' : 'italic',
                fontWeight: sourceLabel.danger ? 700 : 400,
                lineHeight: 1.4,
              }}
              title="purchaseOrderSource from the backend rate response"
            >
              {sourceLabel.text}
            </div>
          ) : null}
        </div>
        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 16 }}>
          {displayed.map((r, i) => renderRateRow(r, i, false, i === firstOk))}
        </div>
      </>
    );
  }

  if (!hasWeight || !hasDims) {
    const missing =
      !hasWeight && !hasDims
        ? 'weight and dims'
        : !hasWeight
          ? 'weight'
          : 'dims (L × W × H)';
    return (
      <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text3)' }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>📏</div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text2)',
            marginBottom: 6,
          }}
        >
          Enter {missing} to fetch rates
        </div>
        <div style={{ fontSize: 12 }}>
          Fill in the fields on the left panel, then click Browse Rates.
        </div>
      </div>
    );
  }
  if (browsing && !hasAnyRateRows) {
    return (
      <div
        style={{
          color: 'var(--text3)',
          fontSize: 12.5,
          textAlign: 'center',
          marginTop: 80,
        }}
      >
        <RateLoadingSpinner />
        <div style={{ marginTop: 8 }}>Checking carriers...</div>
      </div>
    );
  }
  if (!anyFetched) {
    // Once auto-fetch is armed, the button is redundant — show a status
    // that reflects what the modal is doing.
    const missing =
      !hasWeight && !hasDims
        ? 'weight and dims'
        : !hasWeight
          ? 'weight'
          : !hasDims
            ? 'dims (L × W × H)'
            : !zip || zip.length < 5
              ? 'a 5-digit ZIP'
              : null;
    return (
      <div
        style={{
          color: 'var(--text3)',
          fontSize: 12.5,
          textAlign: 'center',
          marginTop: 80,
          lineHeight: 1.8,
        }}
      >
        {browsing ? (
          <RateLoadingSpinner />
        ) : missing ? (
          <>
            📏
            <br />
            Enter {missing} to fetch rates
          </>
        ) : (
          <>
            No live rates loaded yet
            <br />
            Click Browse Rates to refresh carrier quotes.
          </>
        )}
      </div>
    );
  }

  if (viewMode === 'all') return renderAllRatesView();
  return renderCarrierView();
}
