/**
 * Tracking Modal — port of v2's showTrackingModal (apps/web/public/js/orders.js:1338).
 * Opens a 960×680 modal with the carrier's tracking page embedded in an iframe.
 * Most major carriers (UPS, FedEx, USPS, Stamps, DHL) block embedding for security,
 * so for those we show a fallback bar with "Open in new tab" button right away.
 *
 * Used by the Tracking # column cell — click a tracking number to see where the
 * package is without leaving v4.
 */

import { useEffect } from 'react';

const CARRIER_NAMES: Record<string, string> = {
  usps: 'USPS',
  stamps_com: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx',
  dhl: 'DHL',
  dhl_walleted: 'DHL',
};

// Carriers that force X-Frame-Options: DENY / Content-Security-Policy: frame-ancestors 'none'.
// Trying to load them in an iframe produces a blank frame, so skip it and show the
// fallback bar immediately.
const BLOCKS_EMBED = new Set([
  'ups',
  'ups_walleted',
  'fedex',
  'fedex_walleted',
  'usps',
  'stamps_com',
]);

export function carrierTrackingUrl(
  tracking: string,
  carrierCode: string | null | undefined
): string {
  const t = encodeURIComponent(tracking);
  const cc = (carrierCode ?? '').toLowerCase();
  if (cc === 'ups' || cc === 'ups_walleted') {
    return `https://www.ups.com/track?tracknum=${t}`;
  }
  if (cc === 'fedex' || cc === 'fedex_walleted') {
    return `https://www.fedex.com/fedextrack/?tracknumbers=${t}`;
  }
  if (cc === 'usps' || cc === 'stamps_com') {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  }
  if (cc === 'dhl' || cc === 'dhl_walleted') {
    return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${t}`;
  }
  // Fallback — Google tracking lookup
  return `https://www.google.com/search?q=${t}+tracking`;
}

export type TrackingModalProps = {
  open: boolean;
  trackingNumber: string | null;
  carrierCode: string | null | undefined;
  onClose: () => void;
};

export default function TrackingModal({
  open,
  trackingNumber,
  carrierCode,
  onClose,
}: TrackingModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open || !trackingNumber) return null;

  const cc = (carrierCode ?? '').toLowerCase();
  const carrierName = CARRIER_NAMES[cc] ?? (cc ? cc.toUpperCase() : 'Carrier');
  const url = carrierTrackingUrl(trackingNumber, cc);
  const blocksEmbed = BLOCKS_EMBED.has(cc);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          width: 'min(960px, 94vw)',
          height: 'min(680px, 90vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.45)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid #e5e7eb',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111', flex: 1 }}>
            📦 Track Package
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 2,
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: '.05em',
              }}
            >
              {carrierName}
            </span>
            <span
              style={{
                fontSize: 12,
                fontFamily: 'monospace',
                color: '#374151',
                fontWeight: 600,
              }}
            >
              {trackingNumber}
            </span>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 12px',
              background: '#0ea5e9',
              color: '#fff',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              marginLeft: 8,
            }}
          >
            Open in new tab ↗
          </a>
          <button
            type="button"
            onClick={onClose}
            style={{
              marginLeft: 4,
              width: 30,
              height: 30,
              border: 'none',
              background: '#f3f4f6',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#374151',
            }}
          >
            ×
          </button>
        </div>

        {/* Fallback bar (major carriers block iframe embedding) */}
        {blocksEmbed ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '10px 18px',
              background: '#fef9c3',
              borderBottom: '1px solid #fde68a',
              fontSize: 12,
              color: '#92400e',
              flexShrink: 0,
            }}
          >
            <span>
              ⚠️ {carrierName} blocks embedding — use the button above to open the
              tracking page.
            </span>
          </div>
        ) : null}

        {/* Iframe (tries to load; for blocked carriers it'll be empty — the
            fallback bar above directs users to the new-tab button) */}
        {blocksEmbed ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6b7280',
              fontSize: 13,
              padding: 40,
              textAlign: 'center',
            }}
          >
            <div>
              Tracking page can't be embedded.
              <br />
              Click "Open in new tab ↗" above to view on {carrierName}'s site.
            </div>
          </div>
        ) : (
          <iframe
            src={url}
            title={`${carrierName} tracking for ${trackingNumber}`}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            referrerPolicy="no-referrer"
            style={{ flex: 1, border: 'none', width: '100%' }}
          />
        )}
      </div>
    </div>
  );
}
