// PS-155: the Settings → Markups panel extracted verbatim from SettingsView.tsx (behavior-preserving).
// The markup rows/groups + the change handler stay OWNED by SettingsView and are passed in as props,
// so markup values can never drift — this is a thin presentational section.
import { ChevronDown } from 'lucide-react'
import type { MarkupType } from '../../types/markups'
import { getSettingsMarkupEmptyMessage, type SettingsMarkupGroup } from './settings-parity'
import { SkeletonStack, StatusLine } from './settings-ui'

export function MarkupsSection({
  accountsLoading,
  markupsLoading,
  markupGroups,
  collapsedGroups,
  accountsError,
  toggleGroup,
  handleMarkupChange,
}: {
  accountsLoading: boolean
  markupsLoading: boolean
  markupGroups: SettingsMarkupGroup[]
  collapsedGroups: Record<string, boolean>
  accountsError: { message: string } | null
  toggleGroup: (key: string) => void
  handleMarkupChange: (shippingProviderId: number, nextType: MarkupType, nextValue: string) => void
}) {
  return (
    <div>
      {accountsLoading || markupsLoading ? (
        <SkeletonStack rows={5} />
      ) : markupGroups.length === 0 ? (
        <div className="text-[13px] text-ink-3 italic px-1 py-2">
          {getSettingsMarkupEmptyMessage()}
        </div>
      ) : (
        <div className="space-y-2">
          {markupGroups.map((group) => {
            const collapsed = !!collapsedGroups[group.key]
            return (
              <div key={group.key} className="rounded-xl ring-1 ring-line bg-surface overflow-hidden shadow-sm">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!collapsed}
                  aria-controls={`markup-group-${group.key}`}
                  className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-line/40 transition text-left"
                >
                  <ChevronDown
                    size={13}
                    strokeWidth={2.5}
                    className={`text-ink-3 transition-transform duration-150 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
                  />
                  <span className="flex-1 text-[13px] font-bold text-ink">{group.label}</span>
                  <span className="text-[11px] text-ink-3 tabular-nums">
                    {group.rows.length} {group.rows.length === 1 ? 'carrier' : 'carriers'}
                  </span>
                </button>
                {!collapsed ? (
                  <div id={`markup-group-${group.key}`} className="divide-y divide-line">
                    {group.rows.length === 0 ? (
                      <div className="px-3 py-2.5 text-[11.5px] text-ink-3 italic bg-amber-50/50 border-t border-amber-200/60">
                        ℹ No carriers yet — backend fan-out for this account is pending.
                      </div>
                    ) : null}
                    {group.rows.map((row) => (
                      <div
                        key={row.shippingProviderId}
                        className="flex items-center gap-2 px-4 py-2 hover:bg-brand-bg/30 transition"
                      >
                        <span className="flex-1 text-[12.5px] text-ink truncate" title={row.label}>
                          {row.label}
                        </span>
                        <select
                          value={row.type}
                          onChange={(event) => handleMarkupChange(row.shippingProviderId, event.target.value as MarkupType, row.inputValue)}
                          className="h-7 px-1.5 rounded ring-1 ring-line bg-surface text-[12px] text-ink focus:ring-brand/40 focus:ring-2 outline-none transition"
                          aria-label={`${row.label} markup type`}
                        >
                          <option value="flat">$</option>
                          <option value="pct">%</option>
                        </select>
                        <input
                          type="number"
                          min="0"
                          step="0.25"
                          value={row.inputValue}
                          placeholder="0"
                          onChange={(event) => handleMarkupChange(row.shippingProviderId, row.type, event.target.value)}
                          aria-label={`${row.label} markup value`}
                          className="w-[70px] h-7 px-2 text-center rounded ring-1 ring-line bg-surface text-[12px] tabular-nums text-ink focus:ring-brand/40 focus:ring-2 outline-none transition [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <span className="text-[12px] font-bold text-emerald-600 tabular-nums min-w-[80px] text-right">
                          {row.preview}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      {accountsError ? (
        <StatusLine kind="error" message={`Unable to refresh carrier accounts: ${accountsError.message}`} />
      ) : null}
    </div>
  )
}
