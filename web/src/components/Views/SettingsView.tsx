// @ts-nocheck
/**
 * SettingsView — refined "Calm Command Center" aesthetic.
 *
 * Five sections, each a card with a 4px vertical gradient accent strip
 * on the left edge color-coded by section type:
 *   Markup Settings   — brand blue   (primary configuration)
 *   Carrier Accounts  — emerald      (managed via separate card)
 *   Pending Clients   — amber        (managed via separate card)
 *   Sandbox / Test    — red/rose     (destructive actions, danger zone)
 *   Cache Management  — violet       (system-level operations)
 *
 * UX contract
 *   - Staggered fade-in on mount (each card .08s after the previous)
 *   - Loading: skeleton shimmer rows while lists fetch
 *   - Buttons: in-button spinner (lucide Loader2 + animate-spin) while
 *     async ops run, NOT just the previous "disabled+50% opacity"
 *   - Status lines under destructive actions show the last-op result
 *     for ~5s then auto-clear
 *
 * All styling is Tailwind — drops the legacy `.markup-card` CSS class
 * pattern and the long inline-style blocks. Responsive: stacked on
 * mobile, max-width cap on desktop so settings pages don't sprawl
 * across ultra-wide displays.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Settings as SettingsIcon,
  ChevronDown,
  Loader2,
  Sparkles,
  AlertTriangle,
  RefreshCcw,
  Beaker,
  Database,
  CheckCircle2,
  XCircle,
  Trash2,
  Plus,
} from 'lucide-react'
import { apiClient } from '../../api/client'
import { api } from '../../lib/api'
import { useShippingAccounts, useClients } from '../../hooks'
import { ToastContext } from '../../contexts/ToastContext'
import { useMarkups } from '../../contexts/MarkupsContext'
import type { MarkupType } from '../../types/markups'
import {
  buildSettingsMarkupRows,
  buildSettingsRefetchStatus,
  getSettingsMarkupEmptyMessage,
  getSettingsMarkupSavedToastMessage,
  groupSettingsMarkupRows,
  type SettingsRefetchState,
  parseSettingsMarkupInput,
} from './settings-parity'
import { CarrierIntegrationsCard } from '../Settings/CarrierIntegrationsCard'
import { PendingClientIntegrationsCard } from '../Settings/PendingClientIntegrationsCard'

const COLLAPSE_STORAGE_KEY = 'settings:carrier-groups:collapsed'

function readCollapsedGroups(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeCollapsedGroups(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* localStorage full or blocked — non-fatal */
  }
}

// ─── Section card ────────────────────────────────────────────────
// Reusable section wrapper. The accent strip is a 4px gradient bar
// on the left edge — gives each section type a glanceable color
// signature without being decorative-for-its-own-sake. Used by every
// top-level card on this page.
type AccentTone = 'brand' | 'emerald' | 'amber' | 'rose' | 'violet'

const ACCENT_GRADIENT: Record<AccentTone, string> = {
  brand: 'from-brand to-indigo-600',
  emerald: 'from-emerald-500 to-emerald-600',
  amber: 'from-amber-500 to-amber-600',
  rose: 'from-rose-500 to-rose-600',
  violet: 'from-violet-500 to-violet-600',
}

const ACCENT_ICON_BG: Record<AccentTone, string> = {
  brand: 'from-brand/15 to-brand/5 ring-brand/30',
  emerald: 'from-emerald-500/15 to-emerald-500/5 ring-emerald-500/30',
  amber: 'from-amber-500/15 to-amber-500/5 ring-amber-500/30',
  rose: 'from-rose-500/15 to-rose-500/5 ring-rose-500/30',
  violet: 'from-violet-500/15 to-violet-500/5 ring-violet-500/30',
}

const ACCENT_ICON_COLOR: Record<AccentTone, string> = {
  brand: 'text-brand',
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  rose: 'text-rose-600',
  violet: 'text-violet-600',
}

function SectionCard({
  tone,
  icon,
  title,
  subtitle,
  actions,
  children,
  delay = 0,
}: {
  tone: AccentTone
  icon: React.ReactNode
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  delay?: number
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -1 }}
      className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line shadow-sm hover:shadow-md transition-shadow duration-200 mb-4 group"
    >
      {/* Left-edge accent strip — animated growth on mount + subtle
          pulse when section first appears. Gives the page a feeling
          of "controls coming online" rather than "static form". */}
      <motion.div
        aria-hidden
        initial={{ scaleY: 0, transformOrigin: 'top' }}
        animate={{ scaleY: 1 }}
        transition={{ duration: 0.5, delay: delay + 0.1, ease: [0.22, 1, 0.36, 1] }}
        className={`absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b ${ACCENT_GRADIENT[tone]}`}
      />
      <header className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20, delay: delay + 0.15 }}
          className={`w-9 h-9 rounded-lg bg-gradient-to-br ${ACCENT_ICON_BG[tone]} ring-1 flex items-center justify-center flex-shrink-0`}
        >
          <span className={ACCENT_ICON_COLOR[tone]}>{icon}</span>
        </motion.div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-extrabold text-ink tracking-tight font-display m-0">
            {title}
          </h3>
          {subtitle ? (
            <p className="text-tiny text-ink-3 mt-0.5 leading-snug">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2 flex-shrink-0">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </motion.section>
  )
}

// ─── Loading primitives ──────────────────────────────────────────
// Single shimmer rule shared across all skeleton variants; defined
// once below so the visual stays consistent. Avoids the previous
// "disabled+0.5 opacity" pattern as the only loading signal —
// skeletons read as "loading" much more clearly than greyed buttons.
function SkeletonRow({ width = 'full' }: { width?: 'full' | 'sm' | 'md' }) {
  const w = width === 'full' ? 'w-full' : width === 'md' ? 'w-2/3' : 'w-1/3'
  return (
    <div className={`h-7 rounded-md bg-gradient-to-r from-surface-2 via-line/60 to-surface-2 bg-[length:200%_100%] animate-shimmer ${w}`} />
  )
}

function SkeletonStack({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} width={i % 3 === 0 ? 'full' : i % 3 === 1 ? 'md' : 'sm'} />
      ))}
    </div>
  )
}

function ButtonSpinner() {
  return <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />
}

// ─── Status line ──────────────────────────────────────────────────
// Thin colored row under destructive actions that shows the last op
// result. Matches OrdersView's success/error toast aesthetic so
// settings feels native to the rest of the app.
function StatusLine({
  kind,
  message,
}: {
  kind: 'success' | 'error' | 'info'
  message: string
}) {
  const cfg = {
    success: { icon: <CheckCircle2 size={13} strokeWidth={2.5} />, text: 'text-emerald-700', ring: 'ring-emerald-200', bg: 'bg-emerald-50' },
    error: { icon: <XCircle size={13} strokeWidth={2.5} />, text: 'text-rose-700', ring: 'ring-rose-200', bg: 'bg-rose-50' },
    info: { icon: <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />, text: 'text-ink-2', ring: 'ring-line', bg: 'bg-surface-2' },
  }[kind]
  return (
    <div className={`mt-3 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11.5px] font-medium ring-1 ${cfg.text} ${cfg.ring} ${cfg.bg}`}>
      {cfg.icon}
      <span>{message}</span>
    </div>
  )
}

export default function SettingsView() {
  const toastContext = useContext(ToastContext)
  const { accounts, isLoading: accountsLoading, error: accountsError } = useShippingAccounts()
  const { clients } = useClients()
  const { markups, loading: markupsLoading, saveMarkup } = useMarkups()
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [refetchState, setRefetchState] = useState<SettingsRefetchState>({ kind: 'idle' })
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refetchResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSaveRequestRef = useRef(0)

  const markupRows = useMemo(
    () => buildSettingsMarkupRows(accounts, markups, drafts),
    [accounts, markups, drafts],
  )
  const clientPlaceholders = useMemo(
    () => clients.filter((c) => c.hasOwnAccount && c.active).map((c) => ({ name: c.name })),
    [clients],
  )
  const markupGroups = useMemo(
    () => groupSettingsMarkupRows(markupRows, clientPlaceholders),
    [markupRows, clientPlaceholders],
  )
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => readCollapsedGroups())
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      writeCollapsedGroups(next)
      return next
    })
  }, [])

  const refetchStatus = buildSettingsRefetchStatus(refetchState)

  useEffect(() => () => {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
    if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
  }, [])

  useEffect(() => {
    if (refetchState.kind !== 'success') return

    if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
    refetchResetTimerRef.current = setTimeout(() => {
      setRefetchState({ kind: 'idle' })
    }, 5000)

    return () => {
      if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
    }
  }, [refetchState])

  function queueMarkupSavedToast() {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
    saveToastTimerRef.current = setTimeout(() => {
      toastContext?.addToast(getSettingsMarkupSavedToastMessage(), 'success')
    }, 600)
  }

  function handleMarkupChange(shippingProviderId: number, nextType: MarkupType, nextValue: string) {
    setDrafts((current) => ({
      ...current,
      [shippingProviderId]: nextValue,
    }))

    latestSaveRequestRef.current += 1
    const requestId = latestSaveRequestRef.current
    queueMarkupSavedToast()

    void saveMarkup(shippingProviderId, nextType, parseSettingsMarkupInput(nextValue)).catch((error) => {
      if (requestId !== latestSaveRequestRef.current) return
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save markup', 'error')
    })
  }

  // ─── Sandbox / test orders ────────────────────────────────────────────────
  const [testClients, setTestClients] = useState<
    Array<{ id: number; name: string; order_count: number }>
  >([])
  const [testClientsLoading, setTestClientsLoading] = useState(true)
  const [sandboxState, setSandboxState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading'; op: 'seed' | 'purge' | 'refresh' }
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [seedCount, setSeedCount] = useState<string>('25')

  const refreshTestClients = useCallback(async () => {
    setTestClientsLoading(true)
    try {
      const res = await api.get<{
        data: Array<{ id: number; name: string; order_count: number }>
      }>('/admin/test-clients')
      setTestClients(res.data ?? [])
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load test clients',
      })
    } finally {
      setTestClientsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshTestClients()
  }, [refreshTestClients])

  async function handleSeedTestOrders() {
    const count = Number.parseInt(seedCount, 10)
    if (!Number.isFinite(count) || count <= 0) {
      toastContext?.addToast('Enter a positive seed count', 'error')
      return
    }
    setSandboxState({ kind: 'loading', op: 'seed' })
    try {
      const res = await api.post<{ seeded: number; clientName: string }>(
        '/admin/seed-test-orders',
        { count }
      )
      setSandboxState({
        kind: 'success',
        message: `Seeded ${res.seeded} test order(s) under "${res.clientName}"`,
      })
      toastContext?.addToast(`✅ Seeded ${res.seeded} test orders`, 'success')
      await refreshTestClients()
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Seed failed',
      })
    }
  }

  async function handlePurgeTestOrders() {
    if (
      !window.confirm(
        'Delete every order under every test-flagged client?\n\n' +
          'This also deletes their shipments, billing lines, and inventory ledger entries. ' +
          'This cannot be undone.'
      )
    ) {
      return
    }
    setSandboxState({ kind: 'loading', op: 'purge' })
    try {
      const res = await api.post<{
        deleted: {
          orders: number
          shipments: number
          ledger: number
          billing: number
        }
      }>('/admin/purge-test-orders', {})
      const d = res.deleted
      setSandboxState({
        kind: 'success',
        message: `Deleted ${d.orders} order(s), ${d.shipments} shipment(s), ${d.ledger} ledger entries, ${d.billing} billing line(s)`,
      })
      toastContext?.addToast(`🧹 Purged ${d.orders} test orders`, 'success')
      await refreshTestClients()
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Purge failed',
      })
    }
  }

  async function handleRefetchAllRates() {
    setRefetchState({ kind: 'loading' })

    try {
      const result = await apiClient.clearAndRefetchAllRates()
      setRefetchState({ kind: 'success', result })
    } catch (error) {
      setRefetchState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const sandboxBusy = sandboxState.kind === 'loading'
  const isSeeding = sandboxBusy && sandboxState.op === 'seed'
  const isPurging = sandboxBusy && sandboxState.op === 'purge'
  const isRefetching = refetchState.kind === 'loading'

  return (
    <div
      id="view-settings"
      className="view-content !p-0 !overflow-y-auto relative"
      style={{
        // Subtle brand-tinted gradient mesh for the page background.
        // Gives the settings surface a "command-deck" feel without
        // shouting. Two soft radial pools (top-left + bottom-right)
        // hint at the brand color without saturating the page.
        background:
          'radial-gradient(900px 500px at 8% 0%, rgb(var(--brand-rgb, 42 91 215) / 0.05), transparent 60%), radial-gradient(700px 400px at 100% 100%, rgb(var(--brand-rgb, 42 91 215) / 0.04), transparent 65%), rgb(var(--bg-rgb, 240 242 245))',
      }}
    >
      <div className="px-5 py-5 w-full">
        {/* Page header — full width banner. Animated drop-in
            announces the page; the content below cascades after. */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="flex items-center gap-3 mb-5"
        >
          <motion.div
            initial={{ rotate: -90, scale: 0.6 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 18, delay: 0.05 }}
            className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand to-indigo-600 flex items-center justify-center shadow-md ring-1 ring-brand/30"
          >
            <SettingsIcon size={20} strokeWidth={2.25} className="text-white" />
          </motion.div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[20px] font-extrabold text-ink font-display tracking-[-0.02em] m-0">
              Settings
            </h2>
            <p className="text-[12px] text-ink-3 mt-0.5 leading-snug">
              Markup rules, carrier integrations, sandbox tools, and cache management.
            </p>
          </div>
        </motion.div>

        {/* ───────────── Markup Settings ───────────── */}
        <SectionCard
          tone="brand"
          delay={0.04}
          icon={<Sparkles size={16} strokeWidth={2.25} />}
          title="Rate Browser — Account Markups"
          subtitle="$ or % markup added per carrier account. Applied to displayed rates in the Rate Browser; useful for billing clients above cost."
        >
          {accountsLoading || markupsLoading ? (
            <SkeletonStack rows={5} />
          ) : markupGroups.length === 0 ? (
            <div className="text-[12px] text-ink-3 italic px-1 py-2">
              {getSettingsMarkupEmptyMessage()}
            </div>
          ) : (
            <div className="space-y-2">
              {markupGroups.map((group) => {
                const collapsed = !!collapsedGroups[group.key]
                return (
                  <div key={group.key} className="rounded-lg ring-1 ring-line bg-surface overflow-hidden">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={!collapsed}
                      aria-controls={`markup-group-${group.key}`}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-surface-2 hover:bg-line/40 transition text-left"
                    >
                      <ChevronDown
                        size={12}
                        strokeWidth={2.5}
                        className={`text-ink-3 transition-transform duration-150 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
                      />
                      <span className="flex-1 text-[12.5px] font-bold text-ink">{group.label}</span>
                      <span className="text-[10.5px] text-ink-3 tabular-nums">
                        {group.rows.length} {group.rows.length === 1 ? 'carrier' : 'carriers'}
                      </span>
                    </button>
                    {!collapsed ? (
                      <div id={`markup-group-${group.key}`} className="divide-y divide-line">
                        {group.rows.length === 0 ? (
                          <div className="px-3 py-2.5 text-[11px] text-ink-3 italic bg-amber-50/50 border-t border-amber-200/60">
                            ℹ No carriers yet — backend fan-out for this account is pending.
                          </div>
                        ) : null}
                        {group.rows.map((row) => (
                          <div
                            key={row.shippingProviderId}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-brand-bg/30 transition"
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
        </SectionCard>

        {/* ───────────── Carrier Integrations (admin) ───────────── */}
        {/* The CarrierIntegrationsCard + PendingClientIntegrationsCard
            are existing self-contained components — they manage their
            own headers and styling. Wrapping them in a div with the
            same staggered animation keeps the page rhythm consistent. */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        >
          <CarrierIntegrationsCard />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
        >
          <PendingClientIntegrationsCard />
        </motion.div>

        {/* ───────────── Sandbox / Test Orders ───────────── */}
        <SectionCard
          tone="rose"
          delay={0.16}
          icon={<Beaker size={16} strokeWidth={2.25} />}
          title="Sandbox — Test Orders"
          subtitle={
            'Clients flagged is_test=true are isolated: their orders never sync from ShipStation, never create real postage, never bill, and never touch inventory.'
          }
        >
          {testClientsLoading ? (
            <SkeletonStack rows={3} />
          ) : testClients.length === 0 ? (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 ring-1 ring-amber-200 mb-4">
              <AlertTriangle size={14} strokeWidth={2.5} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-[11.5px] text-amber-900 leading-relaxed">
                <strong>No test clients found.</strong> Run the purge SQL in the Supabase editor first — see{' '}
                <code className="px-1 py-0.5 rounded bg-amber-100/70 ring-1 ring-amber-200 text-[10.5px] font-mono text-amber-800">
                  drizzle/apply-test-client-purge.sql
                </code>
                .
              </div>
            </div>
          ) : (
            <div className="mb-4">
              <div className="text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-2">
                Active test clients
              </div>
              <ul className="space-y-1">
                {testClients.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-surface-2 ring-1 ring-line"
                  >
                    <span className="text-[12.5px] font-semibold text-ink">{c.name}</span>
                    <span className="text-[10.5px] text-ink-3 tabular-nums">
                      {c.order_count} order{c.order_count === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Action row */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line">
            <label className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2 font-medium">
              Count:
              <input
                type="number"
                min="1"
                max="200"
                value={seedCount}
                onChange={(e) => setSeedCount(e.target.value)}
                className="w-[70px] h-8 px-2 rounded-md ring-1 ring-line bg-surface text-[12.5px] tabular-nums text-ink focus:ring-brand/40 focus:ring-2 outline-none transition"
              />
            </label>

            <button
              type="button"
              onClick={() => void handleSeedTestOrders()}
              disabled={sandboxBusy || testClients.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-semibold text-white bg-amber-600 hover:bg-amber-700 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
            >
              {isSeeding ? <ButtonSpinner /> : <Plus size={13} strokeWidth={2.5} />}
              {isSeeding ? 'Seeding…' : 'Seed Test Orders'}
            </button>

            <button
              type="button"
              onClick={() => void handlePurgeTestOrders()}
              disabled={sandboxBusy || testClients.length === 0}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 ring-1 ring-rose-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
            >
              {isPurging ? <ButtonSpinner /> : <Trash2 size={13} strokeWidth={2.25} />}
              {isPurging ? 'Purging…' : 'Purge Test Orders'}
            </button>
          </div>

          {sandboxState.kind === 'loading' ? (
            <StatusLine kind="info" message={
              sandboxState.op === 'seed' ? 'Seeding test orders…'
              : sandboxState.op === 'purge' ? 'Purging test orders…'
              : 'Working…'
            } />
          ) : sandboxState.kind === 'success' ? (
            <StatusLine kind="success" message={sandboxState.message} />
          ) : sandboxState.kind === 'error' ? (
            <StatusLine kind="error" message={sandboxState.message} />
          ) : null}
        </SectionCard>

        {/* ───────────── Cache Management ───────────── */}
        <SectionCard
          tone="violet"
          delay={0.2}
          icon={<Database size={16} strokeWidth={2.25} />}
          title="Cache Management"
          subtitle="Clear the rate cache and refetch all rates for awaiting_shipment orders. Used after carrier credential changes or markup-rule updates."
        >
          <button
            type="button"
            onClick={() => void handleRefetchAllRates()}
            disabled={isRefetching}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-[12.5px] font-semibold text-white bg-gradient-to-br from-violet-600 to-violet-700 hover:shadow-md active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150"
          >
            {isRefetching ? <ButtonSpinner /> : <RefreshCcw size={13} strokeWidth={2.25} />}
            {isRefetching ? 'Refetching…' : 'Refetch All Rates & Clear Cache'}
          </button>

          {refetchStatus.visible ? (
            <StatusLine
              kind={
                refetchState.kind === 'loading' ? 'info' :
                refetchState.kind === 'error' ? 'error' :
                refetchState.kind === 'success' ? 'success' : 'info'
              }
              message={refetchStatus.text}
            />
          ) : null}
        </SectionCard>

        {/* Bottom breathing room */}
        <div className="h-12" />
      </div>
    </div>
  )
}
