/**
 * SyncStatusChip
 * --------------
 * Small "live data" indicator for dashboards. Shows:
 *   • A green pulsing dot when sync is healthy
 *   • The cron cadence ("every 3 min")
 *   • Time since last sync ("synced 47s ago")
 *
 * Click the chip to expand a popover with the full sync schedule
 * across all scheduled jobs (orders, shipments, rate backfill,
 * inventory enrichment, product catalog).
 *
 * The cadence numbers come from /orders/sync/status →
 * { cadenceMinutes: { orders, shipments, rateBackfill, ... } }
 * — single source of truth shared with src/services/sync-scheduler.ts.
 * Hardcoded fallbacks here only kick in if the API returns nothing.
 *
 * Auto-updates the "synced X ago" label every 15 seconds. Second-
 * precision updates feel jittery to humans (47s → 48s → 49s reads
 * as flickering), so we snap to natural-language buckets:
 *   < 60s   → "just now"
 *   1-9 min → "5 min ago"
 *   10-59 min→ "23 min ago"
 *   ≥ 60 min→ "2h 15m ago"
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw } from 'lucide-react'

type CadenceMap = {
  orders?: number
  shipments?: number
  rateBackfill?: number
  inventoryFromOrders?: number
  productCatalog?: number
}

export type SyncStatusChipData = {
  /** Unix ms timestamp of the last successful sync, or null. */
  lastSync: number | null
  /** Map of job → minutes between runs. */
  cadenceMinutes?: CadenceMap
  /** Hint string surfaced on hover ("orders + shipments syncing", etc.). */
  status?: 'idle' | 'syncing' | 'done' | 'error'
}

type Props = {
  data: SyncStatusChipData
  className?: string
}

const DEFAULT_CADENCE: Required<CadenceMap> = {
  orders: 3,
  shipments: 3,
  rateBackfill: 3,
  inventoryFromOrders: 30,
  productCatalog: 60,
}

// Format human-readable "time ago" with natural-language buckets
// so the chip doesn't flicker second-by-second.
function timeAgo(ms: number | null, now: number): string {
  if (!ms) return 'no sync yet'
  const diff = Math.max(0, now - ms)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`
}

export function SyncStatusChip({ data, className }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Refresh "now" every 15s so the "X ago" label stays roughly
  // accurate without flickering second-by-second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  // Click-outside + Esc to close the popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const cadence: Required<CadenceMap> = useMemo(() => ({
    orders: data.cadenceMinutes?.orders ?? DEFAULT_CADENCE.orders,
    shipments: data.cadenceMinutes?.shipments ?? DEFAULT_CADENCE.shipments,
    rateBackfill: data.cadenceMinutes?.rateBackfill ?? DEFAULT_CADENCE.rateBackfill,
    inventoryFromOrders: data.cadenceMinutes?.inventoryFromOrders ?? DEFAULT_CADENCE.inventoryFromOrders,
    productCatalog: data.cadenceMinutes?.productCatalog ?? DEFAULT_CADENCE.productCatalog,
  }), [data.cadenceMinutes])

  const ago = timeAgo(data.lastSync, now)
  const healthy = data.lastSync && (now - data.lastSync) < 10 * 60 * 1000
  const syncing = data.status === 'syncing'

  // Visual lookups — green when fresh, amber when stale (>10min),
  // grey when no sync yet. Pulses when actively syncing.
  const dotClass = syncing
    ? 'bg-brand animate-pulse'
    : healthy
    ? 'bg-emerald-500'
    : data.lastSync
    ? 'bg-amber-500'
    : 'bg-ink-3'

  const statusLabel = syncing ? 'Syncing now' : healthy ? 'Live' : data.lastSync ? 'Stale' : 'Idle'

  // Pick the shortest cadence to surface in the chip — that's the
  // operator-relevant "how fresh is the data really" number.
  const primaryCadence = Math.min(cadence.orders, cadence.shipments)

  return (
    <div className={`relative inline-block ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-10 items-center gap-2 rounded-card border border-line bg-surface px-3 text-sm2 font-semibold text-ink shadow-sm transition hover:bg-surface-2 ${
          open ? 'border-brand ring-2 ring-brand/30' : ''
        }`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Click for full sync schedule"
      >
        <span className="relative grid place-items-center">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
          {healthy && !syncing ? (
            <span className="absolute inset-0 -m-1 animate-ping rounded-full bg-emerald-500/30" aria-hidden="true" />
          ) : null}
        </span>
        <span className="font-extrabold">{statusLabel}</span>
        <span className="hidden text-2xs font-medium text-ink-3 sm:inline">
          · every {primaryCadence} min · synced {ago}
        </span>
        <span className="text-2xs font-medium text-ink-3 sm:hidden">
          · {ago}
        </span>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Sync schedule details"
          className="absolute right-0 top-12 z-40 w-80 overflow-hidden rounded-card border border-line bg-surface shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <span className={`h-2.5 w-2.5 rounded-full ${dotClass} flex-shrink-0`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-extrabold text-ink">{statusLabel} data</div>
              <div className="text-2xs font-semibold text-ink-3">
                {data.lastSync ? `Last synced ${ago}` : 'Waiting for first sync'}
              </div>
            </div>
            {data.status === 'syncing' ? (
              <RefreshCw size={14} className="animate-spin text-brand" strokeWidth={2.25} />
            ) : data.lastSync ? (
              <CheckCircle2 size={16} className="text-emerald-500" strokeWidth={2.25} />
            ) : null}
          </div>

          {/* Cadence table — every scheduled job + how often it runs */}
          <div className="divide-y divide-line">
            <CadenceRow label="Orders" minutes={cadence.orders} hint="ShipStation orders → DB" />
            <CadenceRow label="Shipments" minutes={cadence.shipments} hint="Shipment / label updates" />
            <CadenceRow label="Rate backfill" minutes={cadence.rateBackfill} hint="Best-rate cache fill" />
            <CadenceRow label="Inventory from orders" minutes={cadence.inventoryFromOrders} hint="New-SKU seed" />
            <CadenceRow label="Product catalog" minutes={cadence.productCatalog} hint="ShipStation products → DB" />
          </div>

          {/* Footer note */}
          <div className="border-t border-line bg-surface-2/40 px-4 py-3 text-2xs text-ink-3">
            Incremental syncs run automatically on the schedule above.
            Data on this dashboard reflects the most recent successful run.
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CadenceRow({ label, minutes, hint }: { label: string; minutes: number; hint: string }): JSX.Element {
  // Format "30 → 30 min" or "60 → 1 hour" for natural reading.
  const display = minutes >= 60
    ? `every ${Math.round(minutes / 60)}h`
    : `every ${minutes} min`
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-tiny font-semibold text-ink">{label}</div>
        <div className="truncate text-2xs text-ink-3">{hint}</div>
      </div>
      <span className="flex-shrink-0 rounded-full bg-brand/10 px-2 py-0.5 font-mono text-2xs font-extrabold tabular-nums text-brand">
        {display}
      </span>
    </div>
  )
}
