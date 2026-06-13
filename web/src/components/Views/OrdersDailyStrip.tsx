// PS-166 (Wave 3, JSX-safe form): the daily-stats strip, extracted from
// OrdersView.tsx with BYTE-IDENTICAL markup. This is a PRESENTATIONAL slice,
// NOT a hook extraction — all daily-stats state, effects, and the rollover
// timer stay in OrdersView (React execution model unchanged); only the
// rendering moves. The whole <AnimatePresence> is moved together so its sole
// motion.div child keeps its enter/exit animation exactly (wrapping the
// motion.div in a child component would have silently broken AnimatePresence).
// Strict component: every prop is the value the inline JSX read. The
// daily-strip-progress guard + orders-daily-strip-resilience e2e pin this DOM
// (#daily-strip, dailyStripProgress fields) — unchanged.
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, Calendar, Package, RefreshCcw, Truck } from 'lucide-react'
import type { OrdersDailyStatsDto } from '../../types/api'
import type { DailyStripProgress } from './orders-parity'

export type OrdersDailyStripProps = {
  shouldShowDailyStrip: boolean
  dailyStatsForStrip: OrdersDailyStatsDto | null
  dailyStripProgress: DailyStripProgress | null
  dailyStatsFromLabel: string
  dailyStatsToLabel: string
  dailyStatsLoadingWithoutData: boolean
  dailyStatsRefreshFailedWithData: boolean
  dailyStatsErroredWithoutData: boolean
  dailyStatsError: string | null
  loadDailyStats: () => void | Promise<void>
}

export function OrdersDailyStrip({
  shouldShowDailyStrip,
  dailyStatsForStrip,
  dailyStripProgress,
  dailyStatsFromLabel,
  dailyStatsToLabel,
  dailyStatsLoadingWithoutData,
  dailyStatsRefreshFailedWithData,
  dailyStatsErroredWithoutData,
  dailyStatsError,
  loadDailyStats,
}: OrdersDailyStripProps) {
  return (
    <AnimatePresence>
      {shouldShowDailyStrip ? (
        // ─────────────────────────────────────────────────────────
        // V2-STYLE COMPACT DAILY STRIP
        //
        // Single-row horizontal layout, matching the v2original
        // boss-approved aesthetic. Replaces the previous 4-card
        // grid (Total / Need to Ship / Upcoming / Progress) which
        // took ~80px of vertical space; this version is ~36px.
        //
        // Information density preserved end-to-end:
        //   [📅 date range]  [📦 X Total Orders]  [🚚 X Need to Ship]
        //   [🔔 X Upcoming]  [X of Y shipped ████ XX%]
        //
        // Color semantics carried over from the prior grid:
        //   • Need to Ship → dailyStripProgress.needToShipColor
        //     (orange when behind, green when caught up)
        //   • Upcoming → dailyStripProgress.upcomingColor
        //   • Progress bar → dailyStripProgress.barColor
        // ─────────────────────────────────────────────────────────
        <motion.div
          id="daily-strip"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          aria-busy={dailyStatsLoadingWithoutData}
          className="bg-surface border-b border-line px-3 sm:px-5 py-2.5 font-sans"
        >
          {/* Daily strip — desktop keeps the original boss-approved
              one-row layout. Mobile (<sm) reflows into:
                Row 1: 📅 date range (compact, no italics)
                Row 2: 3 stat tiles spread evenly across the width
                Row 3: progress bar full-width
              Achieved with `flex-wrap` + per-section `w-full sm:w-auto`
              so the same DOM serves both viewports — no JS branching. */}
          <div className="flex flex-wrap min-h-[50px] items-center gap-y-2 gap-x-4 sm:gap-x-8 text-[12px]">
            {dailyStatsForStrip ? (
              <>
                {/* Date range — full width on mobile so stats can spread below */}
                <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 text-[11.5px] sm:text-[12px] w-full sm:w-auto min-w-0">
                  <span className="text-[14px] sm:text-[15px] leading-none" aria-hidden="true">📅</span>
                  <span className="text-ink-2 font-semibold truncate">{dailyStatsFromLabel}</span>
                  <span className="text-ink-4">→</span>
                  <span className="text-ink-2 font-semibold truncate">{dailyStatsToLabel}</span>
                  <span className="hidden sm:inline text-ink-4 italic text-[11px]">(shifts at 6 PM CA)</span>
                </div>

                <div className="hidden sm:block h-7 w-px shrink-0 bg-line" aria-hidden="true" />

                {/* Stats group — equal-width tiles on mobile so all three
                numbers stay on screen together; collapses to inline
                flex on desktop to preserve the original strip look. */}
                <div className="flex items-center justify-around sm:justify-start gap-3 sm:gap-8 w-full sm:w-auto">
                  {/* Total Orders */}
                  <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 min-w-0">
                    <span className="text-[17px] sm:text-[19px] leading-none" aria-hidden="true">📦</span>
                    <div className="flex flex-col items-start leading-none">
                      <motion.span
                        key={dailyStatsForStrip.totalOrders}
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="font-bold text-ink tabular-nums text-[22px] sm:text-[26px] leading-[20px] sm:leading-[22px] font-mono"
                      >
                        {dailyStatsForStrip.totalOrders}
                      </motion.span>
                      <span className="text-[10px] leading-[11px] text-ink-3 font-medium whitespace-nowrap">Total Orders</span>
                    </div>
                  </div>

                  {/* Need to Ship */}
                  <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 min-w-0">
                    <span className="text-[17px] sm:text-[19px] leading-none" aria-hidden="true">🚚</span>
                    <div className="flex flex-col items-start leading-none">
                      <motion.span
                        key={dailyStatsForStrip.needToShip}
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="font-bold tabular-nums text-[22px] sm:text-[26px] leading-[20px] sm:leading-[22px] font-mono"
                        style={{ color: dailyStripProgress?.needToShipColor }}
                      >
                        {dailyStatsForStrip.needToShip}
                      </motion.span>
                      <span className="text-[10px] leading-[11px] text-ink-3 font-medium whitespace-nowrap">Need to Ship</span>
                    </div>
                  </div>

                  {/* Upcoming */}
                  <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 min-w-0">
                    <span className="text-[17px] sm:text-[19px] leading-none" aria-hidden="true">🔔</span>
                    <div className="flex flex-col items-start leading-none">
                      <motion.span
                        key={dailyStatsForStrip.upcomingOrders}
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="font-bold tabular-nums text-[22px] sm:text-[26px] leading-[20px] sm:leading-[22px] font-mono"
                        style={{ color: dailyStripProgress?.upcomingColor }}
                      >
                        {dailyStatsForStrip.upcomingOrders}
                      </motion.span>
                      <span className="text-[10px] leading-[11px] text-ink-3 font-medium whitespace-nowrap">Upcoming</span>
                    </div>
                  </div>
                </div>

                {/* Progress — full width on mobile (third row), inline
                on desktop with min-w to match prior layout.
                Vertical layout per boss directive 2026-05-08:
                "58 of 63 shipped" sits on top, bar + percentage
                on the bottom row. */}
                <div className="flex flex-col w-full sm:w-auto sm:shrink-0 sm:min-w-[285px]">
                  <span className="text-ink-3 text-[12px] sm:text-[13px] tabular-nums font-medium">
                    {dailyStripProgress?.shipped} of {dailyStatsForStrip.totalOrders} shipped
                  </span>
                  <div className="flex items-center gap-2.5">
                    <div className="flex-1 sm:flex-none sm:w-[210px] h-[9px] bg-line/70 rounded-sm overflow-hidden">
                      <motion.div
                        className="h-full rounded-sm"
                        initial={{ width: 0 }}
                        animate={{ width: `${dailyStripProgress?.barFill ?? 0}%` }}
                        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                        style={{
                          background: `linear-gradient(90deg, ${dailyStripProgress?.barColor}, ${dailyStripProgress?.barColor}dd)`,
                          boxShadow: `0 0 6px ${dailyStripProgress?.barColor}40`,
                        }}
                      />
                    </div>
                    <motion.span
                      key={dailyStripProgress?.pct}
                      initial={{ scale: 0.85, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                      className="font-bold tabular-nums text-[13px] shrink-0 font-mono"
                      style={{ color: dailyStripProgress?.barColor }}
                    >
                      {dailyStripProgress?.pct}%
                    </motion.span>
                  </div>
                  {dailyStatsRefreshFailedWithData ? (
                    <button
                      type="button"
                      onClick={() => void loadDailyStats()}
                      title={dailyStatsError || 'Daily stats unavailable'}
                      className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100"
                    >
                      <RefreshCcw size={10} strokeWidth={2.4} aria-hidden />
                      Refresh failed - retry
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 shrink-0 text-[11.5px] sm:text-[12px] w-full sm:w-auto min-w-0">
                  <Calendar size={15} strokeWidth={2.25} className="text-ink-3 shrink-0" aria-hidden />
                  {dailyStatsErroredWithoutData ? (
                    <button
                      type="button"
                      onClick={() => void loadDailyStats()}
                      title={dailyStatsError || 'Daily stats unavailable'}
                      className="inline-flex items-center gap-1.5 rounded-sm border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-100"
                    >
                      <RefreshCcw size={11} strokeWidth={2.4} aria-hidden />
                      Daily stats unavailable - retry
                    </button>
                  ) : (
                    <>
                      <span className="h-3 w-28 rounded-sm bg-line/70 animate-pulse" />
                      <span className="h-3 w-4 rounded-sm bg-line/50 animate-pulse" />
                      <span className="h-3 w-28 rounded-sm bg-line/70 animate-pulse" />
                      <span className="hidden sm:inline h-3 w-24 rounded-sm bg-line/50 animate-pulse" />
                    </>
                  )}
                </div>

                <div className="hidden sm:block h-7 w-px shrink-0 bg-line" aria-hidden="true" />

                <div className="flex items-center justify-around sm:justify-start gap-3 sm:gap-8 w-full sm:w-auto">
                  {[Package, Truck, Bell].map((Icon, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 sm:gap-2 shrink-0 min-w-0">
                      <Icon size={18} strokeWidth={2.25} className="text-ink-3 shrink-0" aria-hidden />
                      <div className="flex flex-col items-start gap-1">
                        <span className="h-5 w-10 rounded-sm bg-line/70 animate-pulse" />
                        <span className="h-2.5 w-16 rounded-sm bg-line/50 animate-pulse" />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col w-full sm:w-auto sm:shrink-0 sm:min-w-[285px] gap-1">
                  <span className="h-3 w-32 rounded-sm bg-line/60 animate-pulse" />
                  <div className="flex items-center gap-2.5">
                    <div className="flex-1 sm:flex-none sm:w-[210px] h-[9px] bg-line/70 rounded-sm overflow-hidden">
                      <div className="h-full w-1/3 rounded-sm bg-line animate-pulse" />
                    </div>
                    <span className="h-3 w-8 rounded-sm bg-line/60 animate-pulse" />
                  </div>
                </div>
              </>
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
