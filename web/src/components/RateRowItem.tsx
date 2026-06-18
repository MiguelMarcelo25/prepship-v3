// PS-157: pure-presentation rate row extracted verbatim from RateBrowserModal's
// renderRateRow. All money/blocked/total decision logic STAYS in the parent and is
// passed in as functions (rateBlockedReason / rateBaseTotal / rateDisplayTotal) so
// behavior is byte-for-byte identical. This component owns NO state and NO policy —
// it receives values + a single onRateClick callback and renders the row.
import type { ReactNode } from 'react';
import type { Markup } from '../contexts/MarkupsContext';
import {
  type RateRow,
  type RbOrderSummaryDto,
  type RbCarrierAccountDto,
  SERVICE_NAMES,
  carrierBadgeLarge,
  formatCarrierDisplay,
  formatEta,
  getModalRateSourceLabel,
  priceDisplay,
  formatInsuranceProviderLabel,
  formatInsuranceCertaintyTag,
  rbInsuranceCertaintyTone,
} from './RateBrowserModal';
// PS-290 (slice 2): render the HUGRAB $100-insurance coverage badge with the SAME backend-owned
// reader + renderer the Awaiting column uses — TRUE parity by construction, not a forked copy.
// getRowInsuranceCoverage is a PURE pass-through of the backend verdict (insuranceCoverageStatus /
// insuranceBadgeLabel / insuranceBadgeTone, owned by order-rate-dto -> resolveInsuranceCoverageStatus);
// the Rate Browser row never recomputes the coverage verdict. Returns null for non-HUGRAB rows
// (status 'not_required') or rows the backend has not stamped, so the row renders EXACTLY as before
// unless the backend asserted a HUGRAB coverage status.
import {
  getRowInsuranceCoverage,
  renderInsuranceCoverageBadge,
  renderHouseBadge,
  // PS-261 (display slice): the HUGRAB label-PURCHASE-GATE verdict for this rate, read with the
  // SAME backend-owned pass-through the Awaiting column owns. getRowHugrabPurchaseGate is a PURE
  // reader of the backend hugrabPurchaseAllowed / hugrabPurchaseBlockReason fields (owned by
  // order-rate-dto -> resolveHugrabLabelPurchaseGate over the PS-290 coverage status); the Rate
  // Browser row never recomputes the purchase verdict. Returns null unless the backend asserted a
  // pre-purchase BLOCK, so allowed / non-HUGRAB / unstamped rates render EXACTLY as before.
  getRowHugrabPurchaseGate,
  renderHugrabPurchaseGateBadge,
} from './Views/orders-row-display';

type RateShippingOptions = {
  insuranceProvider?: string | null;
  insuredValue?: number | string | null;
};

type RateRowItemProps = {
  r: RateRow;
  index: number;
  showCarrier: boolean;
  isRecommended: boolean;
  order: RbOrderSummaryDto | null;
  markups: Record<string, Markup>;
  rateShippingAccounts: RbCarrierAccountDto[];
  currentRateShippingOptions: RateShippingOptions;
  onRateClick: (r: RateRow) => void;
  // Decision logic stays in the parent (single source of truth). Passed as
  // functions so the row never re-derives blocked/total math.
  rateBlockedReason: (
    rate: RateRow,
    order: RbOrderSummaryDto | null,
    shippingOptions?: RateShippingOptions,
  ) => string | null;
  rateBaseTotal: (rate: RateRow) => number;
  rateDisplayTotal: (rate: RateRow, markups: Record<string, Markup>) => number;
  // PS-292: backend-owned SHIPP house tuple for the recommended row — { drpCost, customerRate }
  // (computed by the parent from the canonical bestRate). null on every other row / non-house /
  // redacted-for-non-financial. When present the row shows customer_rate over drp_cost + HOUSE badge.
  houseTuple?: { drpCost: number; customerRate: number } | null;
};

export default function RateRowItem({
  r,
  index,
  showCarrier,
  isRecommended,
  order,
  markups,
  rateShippingAccounts,
  currentRateShippingOptions,
  onRateClick,
  rateBlockedReason,
  rateBaseTotal,
  rateDisplayTotal,
  houseTuple,
}: RateRowItemProps): ReactNode {
  const blockedReason = rateBlockedReason(r, order, currentRateShippingOptions);
  const blocked = blockedReason != null;
  const base = rateBaseTotal(r);
  const pid =
    typeof r.shippingProviderId === 'number'
      ? r.shippingProviderId
      : Number(r.shippingProviderId);
  const marked = rateDisplayTotal(r, markups);
  const svcName =
    r.serviceName ||
    SERVICE_NAMES[r.serviceCode] ||
    (r.serviceCode || '').replace(/_/g, ' ') ||
    '—';
  const acctName = formatCarrierDisplay(r);
  const eta = formatEta(r);
  const primaryText = showCarrier ? acctName : svcName;
  const secondaryText = showCarrier ? svcName : '';
  const sourceText = getModalRateSourceLabel(r, rateShippingAccounts);

  // PS-290 (slice 2): the backend-owned HUGRAB $100-insurance coverage verdict for THIS rate,
  // read with the SAME pure pass-through the Awaiting column uses. The verdict may ride the rate
  // top-level or its raw payload; both are read verbatim (no recompute). null -> renders nothing,
  // so non-HUGRAB / unstamped rates are unchanged.
  const insuranceCoverage = getRowInsuranceCoverage(r) ?? getRowInsuranceCoverage(r.raw);

  // PS-261 (display slice): the backend-owned HUGRAB label-PURCHASE-GATE verdict for THIS rate,
  // read with the SAME pure pass-through as above. The verdict may ride the rate top-level or its
  // raw payload; both are read verbatim (no recompute). null -> renders nothing, so allowed /
  // non-HUGRAB / unstamped rates are unchanged; only a backend-asserted BLOCK shows the indicator.
  const hugrabPurchaseGate = getRowHugrabPurchaseGate(r) ?? getRowHugrabPurchaseGate(r.raw);

  const detailsArr: any[] = (r.raw?.rate_details ?? r.raw?.rateDetails ?? []) as any[];
  const surcharges = detailsArr.filter(
    (d) =>
      d?.rate_detail_type !== 'shipping' &&
      typeof d?.amount?.amount === 'number' &&
      d.amount.amount > 0
  );

  return (
    <div
      key={`${pid}-${r.serviceCode}-${index}`}
      onClick={blocked ? undefined : () => onRateClick(r)}
      title={blocked ? blockedReason ?? 'Not available for current client' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 18px',
        borderBottom: '1px solid var(--border)',
        cursor: blocked ? 'not-allowed' : 'pointer',
        opacity: blocked ? 0.45 : 1,
        transition: 'background .1s',
      }}
      onMouseEnter={(e) => {
        if (!blocked) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface2)';
      }}
      onMouseLeave={(e) => {
        if (!blocked) (e.currentTarget as HTMLDivElement).style.background = '';
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {isRecommended && !blocked && (
          <div
            style={{
              display: 'inline-block',
              background: '#1a5c29',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 8px',
              borderRadius: 3,
              marginBottom: 4,
              letterSpacing: '.3px',
            }}
          >
            Recommended
          </div>
        )}
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--text)',
            lineHeight: 1.3,
            textDecoration: blocked ? 'line-through' : 'none',
          }}
        >
          {primaryText}
          {blocked && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--text3)',
                fontWeight: 400,
                textDecoration: 'none',
                marginLeft: 6,
              }}
            >
              (unavailable)
            </span>
          )}
        </div>
        {secondaryText && (
          <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.4 }}>
            {secondaryText}
          </div>
        )}
        {blockedReason ? (
          <div style={{ fontSize: 10.5, color: 'var(--red)', lineHeight: 1.4, marginTop: 2 }}>
            {blockedReason}
          </div>
        ) : null}
        <div style={{ fontSize: 10.5, color: 'var(--text3)', lineHeight: 1.4 }}>
          Rate Source: {sourceText}
        </div>
        {surcharges.length > 0 && (
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2, lineHeight: 1.5 }}>
            {surcharges.map((d: any, i: number) => (
              <span key={i} style={{ marginRight: 8 }}>
                +${(d.amount.amount as number).toFixed(2)}{' '}
                {d.carrier_description || d.carrierDescription || ''}
              </span>
            ))}
          </div>
        )}
        {(() => {
          // PS-125: surface the per-rate insurance add-on the backend already
          // resolved (insuranceCost meta). Display-only — the premium is owned by
          // the backend and never recomputed here. A $0 add-on is VALID and must be
          // shown as "Insurance incl. +$0.00", not hidden, so the operator can see
          // insurance was requested/applied with no add-on (real cost reconciles at
          // purchase). The line renders only for INSURED rates (those carrying the
          // backend insuranceCost meta) so non-insured rates stay clean.
          const meta = r.raw?.insuranceCost as
            | {
                insuranceProvider?: string;
                insuredValue?: number;
                amount?: number | null;
                confirmed?: boolean;
                unresolved?: boolean;
              }
            | undefined;
          const unresolved =
            r.raw?.insuranceCostUnresolved === true || meta?.unresolved === true;
          const provider = formatInsuranceProviderLabel(meta?.insuranceProvider);

          // Genuinely unresolved (rare under PS-125) — warn instead of pricing.
          if (unresolved) {
            return (
              <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 2, lineHeight: 1.4 }}>
                Insurance: {provider} — premium unresolved (re-rate before selecting)
              </div>
            );
          }

          // Only insured rates carry the backend insuranceCost meta. Non-insured
          // rates have no meta -> no line.
          if (!meta) return null;
          const amount = typeof meta.amount === 'number' ? meta.amount : 0;

          return (
            <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2, lineHeight: 1.4 }}>
              Insurance incl. +${amount.toFixed(2)}
            </div>
          );
        })()}
        {(() => {
          // PS-274: surface the backend-owned insurance-certainty tag so a
          // Shipp-brokered rate reads e.g. "insurance requested (unconfirmed)"
          // instead of implying a confirmed carrier-declared value. Display-only:
          // the certainty state is owned by insurance-certainty.ts and threaded
          // through the rate DTO; the row never recomputes it. Renders only when
          // the backend stamped a certainty tag (null -> nothing, no regression).
          const tag = formatInsuranceCertaintyTag(r.insuranceCertainty);
          if (!tag) return null;
          // tag.label already leads with "Insurance ..." (e.g. "Insurance
          // requested (unconfirmed)") — render it directly, no extra prefix.
          return (
            <div style={{ fontSize: 10.5, color: rbInsuranceCertaintyTone(tag.tone), marginTop: 2, lineHeight: 1.4 }}>
              {tag.label}
            </div>
          );
        })()}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
          textDecoration: blocked ? 'line-through' : 'none',
        }}
      >
        {eta && eta !== '—' && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: '#000',
              whiteSpace: 'nowrap',
              textAlign: 'right',
              marginRight: 15,
            }}
          >
            {eta}
          </div>
        )}
        {carrierBadgeLarge(r.carrierCode)}
        <div style={{ textAlign: 'right', minWidth: 145 }}>
          {/* PS-292: SHIPP house-account recommended row — bold customer_rate (cheapest eligible
              non-SHIPP) over the SHIPP drp_cost, plus the HOUSE badge. Backend-owned (houseTuple is
              the parent's pass-through of the canonical bestRate); the row never computes the margin.
              Falls back to the normal single price for every other row / non-house / redacted view. */}
          {houseTuple && !blocked ? (
            <>
              {priceDisplay(houseTuple.drpCost, houseTuple.customerRate, { mainColor: 'var(--green)' })}
              <div style={{ marginTop: 2 }}>{renderHouseBadge()}</div>
            </>
          ) : (
            priceDisplay(base, marked, {
              mainColor: blocked ? 'var(--text3)' : 'var(--green)',
            })
          )}
          {/* PS-290: HUGRAB $100-insurance coverage badge under the price — same backend
              verdict + renderer as the Awaiting column (parity, not a fork). */}
          {renderInsuranceCoverageBadge(insuranceCoverage)}
          {/* PS-261: pre-purchase HUGRAB label-PURCHASE-GATE indicator — the operator sees a
              backend-asserted coverage BLOCK BEFORE buying (verbatim, no recompute). Renders only
              when the backend blocked the purchase; allowed rows show nothing. */}
          {renderHugrabPurchaseGateBadge(hugrabPurchaseGate)}
        </div>
      </div>
    </div>
  );
}
