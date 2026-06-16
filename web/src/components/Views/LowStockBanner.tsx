import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { PackageDto } from '../../types/api'

interface LowStockBannerProps {
  packages: PackageDto[]
  onJumpTo: (packageId: number) => void
  onDismiss: () => void
}

const COLLAPSED_COUNT = 8

function getRatio(pkg: PackageDto): number {
  const stock = Number(pkg.stockQty ?? 0)
  const reorder = Number(pkg.reorderLevel ?? 0)
  if (reorder <= 0) return stock === 0 ? 0 : 1
  return stock / reorder
}

function getSeverity(pkg: PackageDto): 'critical' | 'low' {
  const ratio = getRatio(pkg)
  return ratio <= 0.5 ? 'critical' : 'low'
}

export function LowStockBanner({ packages, onJumpTo, onDismiss }: LowStockBannerProps) {
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Publish the banner's rendered height as a CSS variable so the table's
  // sticky header can offset itself below the banner regardless of expand state.
  useEffect(() => {
    const node = rootRef.current
    if (!node || typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const height = Math.ceil(node.getBoundingClientRect().height)
      document.documentElement.style.setProperty('--lsb-height', `${height}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--lsb-height')
    }
  }, [])

  // Sort by severity (lowest stock/reorder ratio first), then by stock
  const sorted = useMemo(() => {
    return [...packages].sort((a, b) => {
      const ra = getRatio(a)
      const rb = getRatio(b)
      if (ra !== rb) return ra - rb
      return Number(a.stockQty ?? 0) - Number(b.stockQty ?? 0)
    })
  }, [packages])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return sorted
    return sorted.filter((pkg) => String(pkg.name ?? '').toLowerCase().includes(term))
  }, [sorted, search])

  const criticalCount = useMemo(
    () => sorted.filter((pkg) => getSeverity(pkg) === 'critical').length,
    [sorted],
  )

  const visible = expanded ? filtered : filtered.slice(0, COLLAPSED_COUNT)
  const hiddenCount = filtered.length - visible.length

  return (
    <div ref={rootRef} className="lsb-root" role="region" aria-label="Low stock packages">
      <div className="lsb-header">
        <div className="lsb-header-left">
          <span className="lsb-icon-wrap">
            <AlertTriangle size={15} strokeWidth={2.25} />
          </span>
          <div className="lsb-summary">
            <div className="lsb-summary-title">
              <strong>{packages.length}</strong> package{packages.length === 1 ? '' : 's'} at or below reorder level
            </div>
            <div className="lsb-summary-sub">
              {criticalCount > 0 ? (
                <>
                  <span className="lsb-pill lsb-pill-critical">{criticalCount} critical</span>
                  <span className="lsb-pill lsb-pill-low">{packages.length - criticalCount} low</span>
                </>
              ) : (
                <span className="lsb-pill lsb-pill-low">{packages.length} low</span>
              )}
            </div>
          </div>
        </div>
        <div className="lsb-header-right">
          {expanded ? (
            <div className="lsb-search-wrap">
              <Search size={12} strokeWidth={2.25} className="lsb-search-icon" />
              <input
                type="text"
                placeholder="Filter…"
                className="lsb-search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoFocus
              />
            </div>
          ) : null}
          <button
            type="button"
            className="lsb-toggle-btn"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp size={13} strokeWidth={2.25} />
                Show less
              </>
            ) : (
              <>
                <ChevronDown size={13} strokeWidth={2.25} />
                Show all {packages.length}
              </>
            )}
          </button>
          <button
            type="button"
            className="lsb-dismiss-btn"
            aria-label="Dismiss low-stock banner"
            title="Dismiss"
            onClick={onDismiss}
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </div>
      </div>

      <div className={`lsb-body${expanded ? ' is-expanded' : ''}`}>
        {visible.length === 0 ? (
          <div className="lsb-empty">No matches for "{search}"</div>
        ) : (
          <div className="lsb-grid">
            {visible.map((pkg) => {
              const severity = getSeverity(pkg)
              const stock = Number(pkg.stockQty ?? 0)
              const reorder = Number(pkg.reorderLevel ?? 0)
              return (
                <button
                  key={pkg.packageId ?? pkg.id ?? pkg.name}
                  type="button"
                  className={`lsb-chip lsb-chip-${severity}`}
                  onClick={() => onJumpTo(Number(pkg.packageId ?? pkg.id))}
                  title={`Jump to ${pkg.name}`}
                >
                  <span className="lsb-chip-name">{pkg.name}</span>
                  <span className="lsb-chip-counts">
                    <span className="lsb-chip-stock">{stock}</span>
                    <span className="lsb-chip-divider">/</span>
                    <span className="lsb-chip-reorder">{reorder}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {!expanded && hiddenCount > 0 ? (
          <button
            type="button"
            className="lsb-more-btn"
            onClick={() => setExpanded(true)}
          >
            + {hiddenCount} more — click to view
          </button>
        ) : null}
      </div>
    </div>
  )
}
