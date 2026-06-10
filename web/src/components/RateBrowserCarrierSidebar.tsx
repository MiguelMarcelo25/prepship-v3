// PS-157: pure-presentation middle carrier-account column extracted verbatim from
// RateBrowserModal's main render. State (selectedPid/viewMode) and the blocked-rate
// decision stay in the parent: selection is delegated via onSelectCarrier, blocked
// math via the isBlockedRate prop, and the de-duped sidebar label via the
// formatSidebarAccountDisplay prop. This component owns NO state and NO policy.
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import CarrierBadge from './CarrierBadge';
import {
  type RateRow,
  type RbOrderSummaryDto,
  type RbCarrierAccountDto,
  type CarrierRateStatus,
} from './RateBrowserModal';

type RateShippingOptions = {
  insuranceProvider?: string | null;
  insuredValue?: number | string | null;
};

type RateBrowserCarrierSidebarProps = {
  rateShippingAccounts: RbCarrierAccountDto[];
  testMode: boolean;
  scopedAccountsLoading: boolean;
  scopedAccountsError: string | null;
  selectedPid: number | null;
  ratesByPid: Record<string, RateRow[]>;
  rateErrorsByPid: Record<string, string>;
  carrierStatusByPid: Record<string, CarrierRateStatus>;
  hideUnavail: boolean;
  pendingPids: Set<number>;
  order: RbOrderSummaryDto | null;
  currentRateShippingOptions: RateShippingOptions;
  isBlockedRate: (
    rate: RateRow,
    order: RbOrderSummaryDto | null,
    shippingOptions?: RateShippingOptions,
  ) => boolean;
  formatSidebarAccountDisplay: (account: RbCarrierAccountDto) => string;
  onSelectCarrier: (shippingProviderId: number) => void;
};

export default function RateBrowserCarrierSidebar({
  rateShippingAccounts,
  testMode,
  scopedAccountsLoading,
  scopedAccountsError,
  selectedPid,
  ratesByPid,
  rateErrorsByPid,
  carrierStatusByPid,
  hideUnavail,
  pendingPids,
  order,
  currentRateShippingOptions,
  isBlockedRate,
  formatSidebarAccountDisplay,
  onSelectCarrier,
}: RateBrowserCarrierSidebarProps): ReactNode {
  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        overflowY: 'auto',
        background: 'var(--surface2)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: 'var(--text3)',
          textTransform: 'uppercase',
          letterSpacing: '.5px',
          padding: '8px 12px 6px',
        }}
      >
        Carrier Accounts
      </div>
      {!testMode && scopedAccountsLoading && rateShippingAccounts.length === 0 ? (
        <div style={{ padding: '12px', fontSize: 11, color: 'var(--text3)' }}>
          Loading accounts...
        </div>
      ) : null}
      {!testMode && !scopedAccountsLoading && rateShippingAccounts.length === 0 ? (
        <div style={{ padding: '12px', fontSize: 11, color: 'var(--text3)' }}>
          {scopedAccountsError || 'No carrier accounts for this order'}
        </div>
      ) : null}
      {rateShippingAccounts.map((c) => {
        const isSel = c.shippingProviderId === selectedPid;
        const rates = ratesByPid[String(c.shippingProviderId)];
        const carrierError = rateErrorsByPid[String(c.shippingProviderId)];
        const carrierStatus = carrierStatusByPid[String(c.shippingProviderId)];
        const count =
          rates != null
            ? hideUnavail
              ? rates.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions)).length
              : rates.length
            : null;
        const pending = pendingPids.has(c.shippingProviderId);
        return (
          <div
            key={c.shippingProviderId}
            onClick={() => {
              onSelectCarrier(c.shippingProviderId);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 12px',
              cursor: 'pointer',
              background: isSel ? 'var(--ss-blue)' : 'transparent',
              color: isSel ? '#fff' : 'var(--text)',
              borderLeft: `3px solid ${isSel ? 'var(--ss-blue)' : 'transparent'}`,
              transition: 'background .1s',
            }}
          >
            {c.code === 'prepship_test' ? (
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: '#0f766e',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <img src="/prepship-test-logo.svg" alt="" style={{ width: 20, height: 20, display: 'block' }} />
              </span>
            ) : (
              <CarrierBadge code={c.code ?? ''} size="sm" />
            )}
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                // PS: show the full carrier/account nickname (no ellipsis
                // clamp); long names wrap within the wider column.
                whiteSpace: 'normal',
                overflowWrap: 'anywhere',
                lineHeight: 1.25,
              }}
            >
              {formatSidebarAccountDisplay(c)}
            </span>
            {carrierError ? (
              <span
                title={carrierError}
                style={{
                  background: isSel ? 'rgba(255,255,255,.3)' : 'var(--red)',
                  color: '#fff',
                  borderRadius: 10,
                  padding: '1px 7px',
                  fontSize: 10,
                  fontWeight: 800,
                  minWidth: 22,
                  textAlign: 'center',
                }}
              >
                !
              </span>
            ) : count != null ? (
              <span
                style={{
                  background: isSel ? 'rgba(255,255,255,.3)' : 'var(--ss-blue)',
                  color: '#fff',
                  borderRadius: 10,
                  padding: '1px 8px',
                  fontSize: 10,
                  fontWeight: 700,
                  minWidth: 22,
                  textAlign: 'center',
                }}
              >
                {count}
              </span>
            ) : (
              <span
                style={{
                  borderRadius: 10,
                  padding: '1px 8px',
                  fontSize: 10,
                  color: isSel ? 'rgba(255,255,255,.7)' : 'var(--text3)',
                }}
              >
                {pending ? (
                  <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-label="Fetching rates" />
                ) : carrierStatus === 'unavailable' ? (
                  '—'
                ) : carrierStatus === 'cached' ? (
                  'C'
                ) : carrierStatus === 'live' ? (
                  'L'
                ) : (
                  '…'
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
