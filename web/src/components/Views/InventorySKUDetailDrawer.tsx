// @ts-nocheck
// PS-154 extraction: pure-presentation drawer lifted verbatim out of
// InventoryView.tsx. ALL data loading, sorting, canvas drawing
// (drawSkuSalesChart), and the nested order-drawer logic stay in the
// parent. The canvasRef is created in the parent and passed in so the
// parent keeps owning the chart render effect. @ts-nocheck mirrors the
// parent (phantom DTO types).
import { SortableHeader } from '../SortableTable'
import { formatCaDateLong } from '../../lib/ca-time'

function formatDateOnly(value) {
  return formatCaDateLong(value)
}

export function InventorySKUDetailDrawer({
  skuDrawerOpen,
  skuDrawer,
  skuDrawerTitle,
  skuDrawerLoading,
  skuDrawerError,
  skuOrdersSort,
  sortedSkuOrders,
  onClose,
  onOrderClick,
  onSortChange,
  canvasRef,
}) {
  if (!skuDrawerOpen) return null
  return (
    <div className="inventory-drawer-overlay" onClick={onClose}>
      <div className="inventory-drawer-panel" onClick={(event) => event.stopPropagation()}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{skuDrawerTitle}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'monospace' }}>{skuDrawer?.sku ?? ''}</div>
          </div>
          <button type="button" onClick={onClose} style={{ padding: '5px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>
        <div className="inventory-drawer-body">
          {skuDrawerLoading ? (
            <div className="loading"><div className="spinner" /></div>
          ) : skuDrawerError ? (
            <div style={{ color: 'var(--red)', padding: 16 }}>Failed to load: {skuDrawerError}</div>
          ) : skuDrawer ? (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>30-Day Units Sold</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#e07a00' }}>{skuDrawer.totalUnits.toLocaleString()}</div>
                </div>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Total Orders</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{skuDrawer.orders.length.toLocaleString()}</div>
                </div>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Avg/Day (30d)</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{(skuDrawer.totalUnits / 30).toFixed(1)}</div>
                </div>
              </div>

              <div className="inventory-sku-chart-card" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Units Sold — Last 30 Days</div>
                <canvas ref={canvasRef} className="inventory-sku-chart-canvas" width={620} height={160} />
              </div>

              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Recent Orders ({skuDrawer.orders.length})</div>
              {skuDrawer.orders.length === 0 ? (
                <div style={{ color: 'var(--text3)', fontSize: 12, padding: 16, textAlign: 'center' }}>No orders found for this SKU.</div>
              ) : (
                <div className="inventory-sku-orders-wrap">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                        <SortableHeader sortKey="order" sortState={skuOrdersSort} onSort={onSortChange} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Order #</SortableHeader>
                        <SortableHeader sortKey="customer" sortState={skuOrdersSort} onSort={onSortChange} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Customer</SortableHeader>
                        <SortableHeader sortKey="qty" sortState={skuOrdersSort} onSort={onSortChange} align="center" style={{ padding: '7px 6px', textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Qty</SortableHeader>
                        <SortableHeader sortKey="status" sortState={skuOrdersSort} onSort={onSortChange} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Status</SortableHeader>
                        <SortableHeader sortKey="date" sortState={skuOrdersSort} onSort={onSortChange} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Date</SortableHeader>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSkuOrders.map((order, index) => {
                        const statusColor = order.orderStatus === 'shipped' ? 'var(--green)' : order.orderStatus === 'awaiting_shipment' ? 'var(--ss-blue)' : 'var(--text3)'
                        return (
                          <tr key={order.orderId} style={{ borderTop: '1px solid var(--border)', background: index % 2 === 0 ? '' : 'var(--surface2)' }}>
                            <td style={{ padding: '6px 10px' }}>
                              <button
                                type="button"
                                className="inventory-order-link"
                                disabled={!Number.isFinite(Number(order.orderId)) || Number(order.orderId) <= 0}
                                onClick={() => onOrderClick(order)}
                              >
                                {order.orderNumber || String(order.orderId)}
                              </button>
                            </td>
                            <td style={{ padding: '6px 10px', fontSize: 11.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.shipToName || '—'}</td>
                            <td style={{ padding: '6px 6px', textAlign: 'center', fontWeight: 700 }}>{order.qty || 1}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: statusColor }}>{order.orderStatus || '—'}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text3)' }}>{formatDateOnly(order.orderDate)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default InventorySKUDetailDrawer
